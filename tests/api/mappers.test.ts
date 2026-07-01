import { describe, it, expect } from "vitest";
import {
  toAiVisibility,
  toAuditSummary,
  detectUnreachable,
  topCompetitor,
  computeChanges,
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
