import { describe, it, expect } from "vitest";
import {
  toAiVisibility,
  toAuditSummary,
  detectUnreachable,
  topCompetitor,
  computeChanges,
  computeTrend,
} from "../../src/api/mappers.js";
import { reachableReport, unreachableReport, partialOutageReport } from "../fixtures/reports.js";

describe("detectUnreachable", () => {
  it("returns true when no page could be loaded (connection-level failures only)", () => {
    expect(detectUnreachable(unreachableReport())).toBe(true);
  });

  it("returns false for a reachable site", () => {
    expect(detectUnreachable(reachableReport())).toBe(false);
  });

  it("returns false when the homepage loaded but a sub-page failed", () => {
    expect(detectUnreachable(partialOutageReport())).toBe(false);
  });

  it("returns false for a 404-heavy site that still served pages", () => {
    const r = reachableReport();
    // reachableReport has a passed homepage load + a 404 link; not a connection failure
    expect(detectUnreachable(r)).toBe(false);
  });
});

describe("toAiVisibility", () => {
  it("maps overall score and per-engine breakdown with lowercase engine keys", () => {
    const av = toAiVisibility(reachableReport());
    expect(av.score).toBe(62);
    expect(av.by_engine).toEqual({ chatgpt: 75, perplexity: 62, claude: 50, gemini: 62 });
  });

  it("derives the most common competitor as top_competitor", () => {
    const av = toAiVisibility(reachableReport());
    // "Globex" appears in every platform's competitor list; "Initech" fewer.
    expect(av.top_competitor).toBe("Globex");
  });

  it("includes a human-readable summary string", () => {
    const av = toAiVisibility(reachableReport());
    expect(typeof av.summary).toBe("string");
    expect(av.summary.length).toBeGreaterThan(0);
  });

  it("marks each engine's appearance from the per-engine client_appears signal", () => {
    // reachableReport: every engine has appearances > 0.
    const av = toAiVisibility(reachableReport());
    expect(av.appears_by_engine).toEqual({ chatgpt: true, perplexity: true, claude: true, gemini: true });
  });

  it("reports an engine as not appearing when the site was recommended zero times", () => {
    const r = reachableReport();
    r.ai_visibility.platform_scores!.Claude!.appearances = 0;
    expect(toAiVisibility(r).appears_by_engine.claude).toBe(false);
  });

  it("falls back to results' client_appears when the appearances count is absent", () => {
    const r = reachableReport();
    // Gemini's only result has client_appears: true.
    delete (r.ai_visibility.platform_scores!.Gemini as { appearances?: number }).appearances;
    expect(toAiVisibility(r).appears_by_engine.gemini).toBe(true);
  });
});

describe("topCompetitor", () => {
  it("returns null when there are no competitors", () => {
    const r = reachableReport();
    for (const key of Object.keys(r.ai_visibility.platform_scores!)) {
      r.ai_visibility.platform_scores![key]!.results.forEach((x) => (x.competitors = []));
    }
    expect(topCompetitor(r.ai_visibility)).toBeNull();
  });
});

describe("toAuditSummary", () => {
  it("maps category scores, top issues and a report url", () => {
    const report = reachableReport();
    const out = toAuditSummary(report, { siteUrl: "https://website-auditor.io" });
    expect(out.scores.ai_visibility).toBe(62);
    // security score derived from security-module pass rate (0 of 1 passed -> 0)
    expect(out.scores.security).toBe(0);
    expect(typeof out.scores.seo).toBe("number");
    expect(typeof out.scores.performance).toBe("number");
    // report_url built from siteUrl + run_id
    expect(out.report_url).toBe("https://website-auditor.io/report/abc123def456");
    // top_issues surfaces the high/critical findings first
    expect(out.top_issues.length).toBeGreaterThan(0);
    expect(out.top_issues[0]).toHaveProperty("severity");
    expect(out.top_issues[0]).toHaveProperty("name");
  });

  it("ranks critical issues above high issues", () => {
    const report = reachableReport();
    report.results.push({
      test_id: "zz99",
      module: "availability",
      name: "500 error",
      description: "",
      status: "failed",
      severity: "critical",
      url: "https://example.com/boom",
      details: "HTTP 500",
      recommendation: "Investigate server logs immediately.",
    });
    const out = toAuditSummary(report, { siteUrl: "https://website-auditor.io" });
    expect(out.top_issues[0]!.severity).toBe("critical");
  });
});

describe("computeChanges (delta logic, ready for the pending endpoint)", () => {
  it("computes score movement and engine changes between two AI-visibility snapshots", () => {
    const previous = { score: 50, by_engine: { chatgpt: 40, perplexity: 60, claude: 50, gemini: 50 } };
    const current = { score: 62, by_engine: { chatgpt: 75, perplexity: 62, claude: 50, gemini: 62 } };
    const delta = computeChanges(current, previous);
    expect(delta.score_delta).toBe(12);
    // engines that moved
    const chatgpt = delta.engine_changes.find((e) => e.engine === "chatgpt");
    expect(chatgpt).toEqual({ engine: "chatgpt", from: 40, to: 75, delta: 35 });
    // claude unchanged -> not reported
    expect(delta.engine_changes.find((e) => e.engine === "claude")).toBeUndefined();
  });
});

describe("computeTrend — 7/30-day windows over a snapshot series", () => {
  const NOW = new Date("2026-07-26T12:00:00Z");
  const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  const snap = (daysAgo: number, score: number, is_simulated = false) => ({
    captured_at: at(daysAgo),
    score,
    by_engine: { chatgpt: score },
    is_simulated,
  });

  it("fewer than two snapshots -> null (no fabricated trend)", () => {
    expect(computeTrend([], NOW)).toBeNull();
    expect(computeTrend([snap(1, 50)], NOW)).toBeNull();
  });

  it("windows compare newest vs oldest-in-window; sparse 7d window is null while 30d works", () => {
    const trend = computeTrend([snap(25, 40), snap(10, 45), snap(1, 60)], NOW)!;
    expect(trend.change_7d).toBeNull(); // only one snapshot inside 7 days
    expect(trend.change_30d).toEqual(
      expect.objectContaining({ window_days: 30, from_score: 40, to_score: 60, score_delta: 20, snapshots: 3 }),
    );
    expect(trend.snapshots_analyzed).toBe(3);
    expect(trend.latest_captured_at).toBe(at(1));
    expect(trend.includes_simulated).toBe(false);
  });

  it("both windows populated when history is dense; engine deltas ride along", () => {
    const trend = computeTrend([snap(20, 40), snap(6, 50), snap(2, 55), snap(1, 60)], NOW)!;
    expect(trend.change_7d).toEqual(
      expect.objectContaining({ from_score: 50, to_score: 60, score_delta: 10, snapshots: 3 }),
    );
    expect(trend.change_30d!.score_delta).toBe(20);
    expect(trend.change_7d!.engine_changes).toEqual([{ engine: "chatgpt", from: 50, to: 60, delta: 10 }]);
  });

  it("flags simulated data anywhere in the series", () => {
    const trend = computeTrend([snap(5, 40, true), snap(1, 60)], NOW)!;
    expect(trend.includes_simulated).toBe(true);
  });
});
