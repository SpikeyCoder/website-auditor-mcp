import { describe, it, expect } from "vitest";
import {
  toAiVisibility,
  toAuditSummary,
  detectUnreachable,
  topCompetitor,
  computeChanges,
  computeTrend,
  measuredRun,
} from "../../src/api/mappers.js";
import { isGap } from "../../src/tools/compareCompetitors.js";
import { mapEngines } from "../../src/tools/getMonitoringStatus.js";
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

/**
 * TWO DIFFERENT ZEROES.
 *
 * Reported by a customer: "get_ai_visibility reports claude:0 as if tested, but
 * the report page says 'Claude didn't return an answer - this score covers 3
 * platforms'. An API error is being recorded as a 0 score, not untested."
 *
 * Upstream ships the discriminator and always has: `total` is what the provider
 * ANSWERED (the score's denominator) and `asked` is what it was SENT. The
 * report page has read it correctly for months; this surface did not.
 *
 * Run b546b7ccd0c5 (newparadigm.org) is the reported shape, reproduced below:
 * Claude asked 8 / answered 0, the other three answered 8 each and scored 0.
 */
describe("toAiVisibility: an engine that did not answer", () => {
  function silentClaude() {
    const r = reachableReport();
    const claude = r.ai_visibility.platform_scores!.Claude as Record<string, unknown>;
    claude.total = 0;        // answered nothing
    claude.asked = 8;        // but was asked
    claude.appearances = 0;
    claude.score = 0;        // upstream stores 0 for both cases — the bug's root
    return r;
  }

  it("reports no score rather than a zero", () => {
    const av = toAiVisibility(silentClaude());
    expect(av.by_engine.claude).toBeNull();
    expect(av.engine_status.claude).toBe("unanswered");
  });

  it("still reports a real zero as a zero", () => {
    // The other three answered 8 queries and never named the business. That IS
    // a measurement, and suppressing it would trade one wrong answer for another.
    const av = toAiVisibility(silentClaude());
    expect(av.engine_status.chatgpt).toBe("scored");
    expect(typeof av.by_engine.chatgpt).toBe("number");
  });

  it("does not assert the engine failed to name the business", () => {
    // `false` is that assertion, and compare_competitors turns it into a
    // reported gap — so a silent Claude fabricated a "claude" gap against every
    // competitor Claude did answer about.
    expect(toAiVisibility(silentClaude()).appears_by_engine.claude).toBeNull();
  });

  it("names the engine in the summary the model actually reads", () => {
    const av = toAiVisibility(silentClaude());
    expect(av.coverage_note).toContain("Claude");
    expect(av.coverage_note).toContain("did not return an answer");
    expect(av.summary).toContain("Claude");
  });

  it("never claims a timeout it cannot attribute", () => {
    // unobserved_reasons is a whole-run tally, so a per-engine cause cannot be
    // established; calling an empty 200 a timeout is a lie the reader cannot check.
    const av = toAiVisibility(silentClaude());
    expect(av.coverage_note).not.toContain("in time");
    expect(av.coverage_note).not.toContain("timeout");
  });

  it("counts the engines the score actually covers", () => {
    expect(toAiVisibility(silentClaude()).coverage_note).toContain("3 engines");
  });

  it("says nothing when every engine answered", () => {
    const av = toAiVisibility(reachableReport());
    expect(av.coverage_note).toBeUndefined();
    expect(av.summary).not.toContain("did not return an answer");
    expect(Object.values(av.engine_status)).toEqual(
      ["scored", "scored", "scored", "scored"]);
  });

  it("distinguishes an engine never asked from one that stayed silent", () => {
    // A deliberately narrow run must not accuse itself of an outage, so an
    // absent engine is `not_asked` and is NOT named in the prose.
    const r = reachableReport();
    delete r.ai_visibility.platform_scores!.Claude;
    const av = toAiVisibility(r);
    expect(av.engine_status.claude).toBe("not_asked");
    expect(av.by_engine.claude).toBeNull();
    expect(av.coverage_note).toBeUndefined();
  });
});

describe("compareCompetitors: an unmeasured engine is not a gap", () => {
  // THE TEST THAT WOULD HAVE CAUGHT IT. The first version of this change
  // asserted only that appears_by_engine.claude became null, and claimed that
  // fixed the fabricated gap. It did not: the gap loop reads
  // `!primaryAv.appears_by_engine[engine]`, and `!null` is `true` exactly as
  // `!false` was. Asserting at the field and never at the consumer is what let
  // that ship.
  it("reports a gap when the primary genuinely did not appear", () => {
    expect(isGap(false, true)).toBe(true);
  });

  it("reports NO gap when the primary engine was never measured", () => {
    expect(isGap(null, true)).toBe(false);
  });

  it("reports no gap when the competitor is also unmeasured", () => {
    expect(isGap(false, null)).toBe(false);
  });

  it("reports no gap when both sides appeared", () => {
    expect(isGap(true, true)).toBe(false);
  });
});

describe("toAiVisibility: a run where no engine answered", () => {
  it("does not pair a score with an admission that nothing was measured", () => {
    const r = reachableReport();
    for (const key of ["ChatGPT", "Perplexity", "Claude", "Gemini"]) {
      const ps = r.ai_visibility.platform_scores![key] as Record<string, unknown>;
      ps.total = 0; ps.asked = 8; ps.score = 0; ps.appearances = 0;
      ps.results = [];
    }
    const av = toAiVisibility(r);
    expect(av.summary).not.toContain("/100");
    expect(av.summary).not.toContain("no engines");
    expect(av.summary).toContain("no AI-visibility score");
  });
});

describe("mapEngines: the monitoring path must not re-coerce", () => {
  // The one path that routed around computeChanges' new guard. It used to
  // `num()` each score to zero BEFORE computeChanges saw it, so by then both
  // sides were numbers and the skip never fired — a Claude outage in a
  // scheduled snapshot still published a 55-point crash that did not happen.
  //
  // Exported and driven directly rather than re-implemented here: a test that
  // copies the code it is checking passes when the code is reverted, which is
  // exactly how the first version of this change shipped a false claim.
  it("preserves a null rather than reporting it as zero", () => {
    expect(mapEngines({ chatgpt: 60, perplexity: null, claude: null, gemini: 40 }))
      .toEqual({ chatgpt: 60, perplexity: null, claude: null, gemini: 40 });
  });

  it("feeds computeChanges values it will actually skip", () => {
    const current = mapEngines({ chatgpt: 60, perplexity: null, claude: null, gemini: 40 });
    const previous = mapEngines({ chatgpt: 60, perplexity: 50, claude: 55, gemini: 40 });
    const changes = computeChanges({ score: 60, by_engine: current },
                                   { score: 60, by_engine: previous });
    expect(changes.engine_changes).toEqual([]);
  });
});

describe("computeChanges: an unmeasured engine is not a crash", () => {
  it("skips an engine that has no score on one side", () => {
    // `?? 0` published {from: 55, to: 0, delta: -55} for a Claude outage — a
    // 55-point drop that did not happen, in a weekly monitoring snapshot.
    const changes = computeChanges(
      { score: 60, by_engine: { claude: null as unknown as number, chatgpt: 60 } },
      { score: 60, by_engine: { claude: 55, chatgpt: 60 } },
    );
    expect(changes.engine_changes).toEqual([]);
  });

  it("still reports a real movement", () => {
    const changes = computeChanges(
      { score: 60, by_engine: { chatgpt: 60 } },
      { score: 50, by_engine: { chatgpt: 50 } },
    );
    expect(changes.engine_changes).toEqual([
      { engine: "chatgpt", from: 50, to: 60, delta: 10 },
    ]);
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
  // Every snapshot asks the same question unless a test says otherwise: a window
  // only compares snapshots whose question keys match.
  const ASKED = {
    key: "q-widgets", business_name: "Example Co", name_source: "detected",
    business_location: "", market_scope: "global", queries: ["best widget shop"],
  };
  const snap = (daysAgo: number, score: number, is_simulated = false, question: typeof ASKED | null = ASKED) => ({
    captured_at: at(daysAgo),
    score,
    by_engine: { chatgpt: score },
    is_simulated,
    question,
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

  it("engine deltas cover only engines measured at BOTH window endpoints (no from-0 fabrication, no silent drops)", () => {
    const oldest = { captured_at: at(5), score: 50, by_engine: { chatgpt: 50, perplexity: 45 }, is_simulated: false, question: ASKED };
    const latest = { captured_at: at(1), score: 60, by_engine: { chatgpt: 60, gemini: 60 }, is_simulated: false, question: ASKED };
    const trend = computeTrend([oldest, latest], NOW)!;
    const engines = trend.change_7d!.engine_changes.map((c) => c.engine);
    // gemini was unmeasured at the start -> must NOT appear as a +60 gain;
    // perplexity became unmeasured -> must not fabricate a drop either.
    expect(engines).toEqual(["chatgpt"]);
    expect(trend.change_7d!.engine_changes[0]).toEqual({ engine: "chatgpt", from: 50, to: 60, delta: 10 });
  });

  it("leaves simulated snapshots out: they measured nothing to move from", () => {
    expect(computeTrend([snap(5, 40, true), snap(1, 60)], NOW)).toBeNull();
    const trend = computeTrend([snap(10, 40), snap(5, 90, true), snap(1, 60)], NOW)!;
    expect(trend.change_30d).toEqual(expect.objectContaining({ from_score: 40, to_score: 60, snapshots: 2 }));
    expect(trend.snapshots_analyzed).toBe(2);
    expect(trend.includes_simulated).toBe(false);
  });

  // ── only snapshots that asked the same question are compared ──────────
  // A hand audit in another market, a name detection read differently, a
  // change of category: each is a different question, and subtracting across
  // one reports a change of subject as movement.
  const ELSEWHERE = {
    ...ASKED, key: "q-honolulu", business_location: "Honolulu, HI", queries: ["best widget shop in Honolulu, HI"],
  };

  it("a window compares with the OLDEST snapshot in it that asked the latest's question", () => {
    const trend = computeTrend([snap(25, 40), snap(20, 90, false, ELSEWHERE), snap(10, 45), snap(1, 60)], NOW)!;
    expect(trend.change_30d).toEqual(expect.objectContaining({
      from_score: 40, to_score: 60, score_delta: 20, snapshots: 4, from_captured_at: at(25), skipped_snapshots: 1,
    }));
    expect(trend.question_note).toBe(
      "Only snapshots that asked the same question as the latest are compared. Not compared, from the last 30 days: "
      + "1 snapshot that asked a different question. The most recent that asked a different one, on "
      + `${at(20).slice(0, 10)}, asked about the market "Honolulu, HI" rather than none.`);
  });

  it("a change of question has no window, and a note saying when and what", () => {
    const trend = computeTrend([snap(20, 40), snap(6, 50), snap(1, 90, false, ELSEWHERE)], NOW)!;
    expect(trend.change_7d).toBeNull();
    expect(trend.change_30d).toBeNull();
    expect(trend.question_note).toBe(
      `No earlier snapshot asked the question the latest one, on ${at(1).slice(0, 10)}, asked. It asked about the `
      + `market "Honolulu, HI" rather than none, compared with the snapshot on ${at(6).slice(0, 10)}, so there is `
      + "no trend for it yet.");
  });

  it("a snapshot that recorded no question is compared with nothing, on either side", () => {
    const unrecordedLatest = computeTrend([snap(6, 50), snap(1, 60, false, null)], NOW)!;
    expect(unrecordedLatest.change_7d).toBeNull();
    expect(unrecordedLatest.question_note).toMatch(/^The latest snapshot does not record what it asked/);

    const unrecordedBefore = computeTrend([snap(6, 50, false, null), snap(1, 60)], NOW)!;
    expect(unrecordedBefore.change_7d).toBeNull();
    expect(unrecordedBefore.question_note)
      .toMatch(/^The snapshots before the latest one, on \d{4}-\d{2}-\d{2}, do not record what they asked/);
  });

  it("says nothing about questions when every snapshot asked the same one", () => {
    const trend = computeTrend([snap(20, 40), snap(6, 50), snap(1, 60)], NOW)!;
    expect(trend).not.toHaveProperty("question_note");
    expect(trend.change_7d!.skipped_snapshots).toBe(0);
    expect(trend.change_7d!.from_captured_at).toBe(at(6));
  });

  it("a window whose first snapshot asked another question starts at the oldest that asked the latest's", () => {
    const trend = computeTrend([snap(25, 90, false, ELSEWHERE), snap(20, 40), snap(1, 60)], NOW)!;
    expect(trend.change_30d).toEqual(expect.objectContaining({
      from_score: 40, to_score: 60, score_delta: 20, from_captured_at: at(20), skipped_snapshots: 1,
    }));
  });

  it("does not mention a different question from before the 30 days", () => {
    const trend = computeTrend([snap(40, 90, false, ELSEWHERE), snap(20, 40), snap(1, 60)], NOW)!;
    expect(trend.change_30d!.score_delta).toBe(20);
    expect(trend).not.toHaveProperty("question_note");
  });

  it("names a snapshot that recorded nothing as that, not as a different question", () => {
    const trend = computeTrend([snap(20, 40), snap(10, 50, false, null), snap(1, 60)], NOW)!;
    expect(trend.question_note).toBe(
      "Only snapshots that asked the same question as the latest are compared. Not compared, from the last 30 days: "
      + "1 snapshot that does not record what it asked.");
  });

  it("explains a re-baseline against the newest snapshot that recorded its question", () => {
    const trend = computeTrend([snap(20, 40), snap(6, 50, false, null), snap(1, 90, false, ELSEWHERE)], NOW)!;
    expect(trend.question_note).toContain(`rather than none, compared with the snapshot on ${at(20).slice(0, 10)},`);
  });

  it("follows the question the newest snapshot asked, whoever wrote it, as the audit it sits under", () => {
    const weekly = (daysAgo: number, score: number, question: typeof ASKED = ASKED) =>
      ({ ...snap(daysAgo, score, false, question), source: "scheduled" });
    // The audit just run, in another market beside a weekly series: the trend is
    // that market's, not the weekly re-audits' (get_changes reports those).
    const byHand = computeTrend([
      weekly(10, 50), weekly(3, 55),
      { ...snap(2, 70, false, ELSEWHERE), source: null }, { ...snap(1, 80, false, ELSEWHERE), source: null },
    ], NOW)!;
    expect(byHand.latest_captured_at).toBe(at(1));
    expect(byHand.change_7d).toEqual(
      expect.objectContaining({ from_score: 70, to_score: 80, score_delta: 10, skipped_snapshots: 1 }));

    // One that asked the weekly question is the newer measurement of it.
    const sameAsked = computeTrend([weekly(20, 40), weekly(6, 50), snap(1, 80)], NOW)!;
    expect(sameAsked.latest_captured_at).toBe(at(1));
    expect(sameAsked.change_7d).toEqual(expect.objectContaining({ from_score: 50, to_score: 80 }));

    // A weekly re-audit that measured nothing of the business is no part of it.
    const unmeasured = computeTrend(
      [weekly(20, 40), weekly(6, 50), { ...snap(1, 25), source: "scheduled_unmeasured" }], NOW)!;
    expect(unmeasured.latest_captured_at).toBe(at(6));
    expect(unmeasured).not.toHaveProperty("question_note");
  });

  it("counts only what it analyzed, leaving a simulated snapshot out", () => {
    const weekly = (daysAgo: number, score: number, question: typeof ASKED = ASKED) =>
      ({ ...snap(daysAgo, score, false, question), source: "scheduled" });
    const trend = computeTrend(
      [weekly(20, 40), weekly(6, 50), { ...snap(1, 90, true, ELSEWHERE), source: "extension" }], NOW)!;
    expect(trend.snapshots_analyzed).toBe(2);
    expect(trend.includes_simulated).toBe(false);
  });

  it("ends at the audit it sits under, named by its run", () => {
    const run = (daysAgo: number, score: number, run_id: string, question: typeof ASKED = ASKED) =>
      ({ ...snap(daysAgo, score, false, question), run_id });
    const history = [run(20, 40, "a"), run(6, 50, "b"), run(3, 70, "audit"), run(1, 90, "later", ELSEWHERE)];
    // A snapshot written after the audit, in another market, is not what the audit asked.
    const trend = computeTrend(history, NOW, "audit")!;
    expect(trend.latest_captured_at).toBe(at(3));
    expect(trend.change_7d).toEqual(expect.objectContaining({ from_score: 50, to_score: 70 }));
    expect(trend.snapshots_analyzed).toBe(3);
    // Without a run, the newest measured snapshot.
    expect(computeTrend(history, NOW)!.latest_captured_at).toBe(at(1));
    // A run that left no measured snapshot has no trend to end at.
    expect(computeTrend(history, NOW, "missing")).toBeNull();
  });

  it("says whether a run left a measured snapshot", () => {
    const run = (run_id: string | null, over: object = {}) => ({ ...snap(1, 50), run_id, ...over });
    expect(measuredRun([run("audit")], "audit")).toBe(true);
    expect(measuredRun([run("other")], "audit")).toBe(false);
    expect(measuredRun([run(null)], "audit")).toBe(false);
    expect(measuredRun([run("audit", { is_simulated: true })], "audit")).toBe(false);
    expect(measuredRun([run("audit", { source: "scheduled_unmeasured" })], "audit")).toBe(false);
  });

  it("ends at the audit in every part of the trend", () => {
    const run = (daysAgo: number, score: number, run_id: string, question: typeof ASKED = ASKED, is_simulated = false) =>
      ({ ...snap(daysAgo, score, is_simulated, question), run_id });
    // A simulated snapshot before the audit does not move where the trend ends.
    const simulatedFirst = computeTrend(
      [run(20, 10, "sim", ASKED, true), run(10, 40, "a"), run(3, 70, "audit"), run(1, 90, "later")], NOW, "audit")!;
    expect(simulatedFirst.latest_captured_at).toBe(at(3));
    expect(simulatedFirst.snapshots_analyzed).toBe(2);
    // Its windows end there: nothing else in the last 7 days asked its question before it.
    const windows = computeTrend([run(20, 40, "a"), run(3, 70, "audit"), run(1, 90, "later")], NOW, "audit")!;
    expect(windows.change_7d).toBeNull();
    expect(windows.change_30d).toEqual(expect.objectContaining({ from_score: 40, to_score: 70, snapshots: 2 }));
    // And so does its note: a newer snapshot of its question is no earlier one.
    const note = computeTrend([run(20, 40, "a", ELSEWHERE), run(3, 70, "audit"), run(1, 90, "later")], NOW, "audit")!;
    expect(note.question_note).toMatch(/^No earlier snapshot asked the question the latest one, on /);
  });

  it("finds an earlier snapshot of the latest's question from before the 30 days", () => {
    const trend = computeTrend([snap(40, 40), snap(20, 90, false, ELSEWHERE), snap(1, 60)], NOW)!;
    expect(trend.change_30d).toBeNull();
    expect(trend.question_note).toMatch(
      /^Only snapshots that asked the same question as the latest are compared\. Not compared, from the last 30 days: 1 snapshot that asked a different question\./);
  });
});

/**
 * chaos_tester #447 added `ai_visibility.sources` — the ranked cited-documents
 * list — to the report JSON, and the state of the key is tri-state BY CONTRACT:
 * an array is the ranked evidence, null means the recorded answers cited
 * nothing attributable, and an ABSENT key means no readable citation records
 * exist at all (budget-deferred audit, a build predating citation capture, or
 * a server-side ranking failure). The mapper must preserve all three states —
 * collapsing absent into null would turn "never measured" into a positive
 * "the answers cited nothing" claim.
 */
describe("toAiVisibility: cited sources", () => {
  it("carries the ranked sources list through the whitelist", () => {
    const av = toAiVisibility(reachableReport());
    expect(Array.isArray(av.sources)).toBe(true);
    expect(av.sources![0]).toEqual({
      domain: "techreview.example",
      answers: 4,
      platforms: ["ChatGPT", "Perplexity", "Claude"],
      ownership: "third_party",
      url: "https://www.techreview.example/best-tech-companies-seattle/",
      title: "Best Tech Companies In Seattle 2026",
    });
  });

  it("preserves null — the recorded answers cited nothing attributable", () => {
    const r = reachableReport();
    r.ai_visibility.sources = null;
    expect(toAiVisibility(r).sources).toBeNull();
  });

  it("omits the key when upstream omitted it — 'never recorded' is not 'cited nothing'", () => {
    const r = reachableReport();
    delete r.ai_visibility.sources;
    expect("sources" in toAiVisibility(r)).toBe(false);
  });

  it("empty ai_visibility (the budget-deferral signature) -> no sources key", () => {
    const av = toAiVisibility(reachableReport({ ai_visibility: {} }));
    expect("sources" in av).toBe(false);
  });

  it("garbled sources (neither array nor null) reads as absent, never a crash", () => {
    const r = reachableReport();
    (r.ai_visibility as Record<string, unknown>).sources = '[{"domain":"x"}]';
    expect("sources" in toAiVisibility(r)).toBe(false);
  });

  it("drops malformed rows, keeps well-formed ones, fabricates nothing", () => {
    const r = reachableReport();
    (r.ai_visibility as Record<string, unknown>).sources = [
      null,
      "junk",
      { answers: 3 }, // no domain — nothing to attribute the row to
      { domain: "forbes.com", answers: 2, platforms: ["ChatGPT"], ownership: "third_party", url: null, title: "" },
    ];
    expect(toAiVisibility(r).sources).toEqual([
      { domain: "forbes.com", answers: 2, platforms: ["ChatGPT"], ownership: "third_party", url: null, title: "" },
    ]);
  });

  it("a non-empty array whose rows are ALL malformed reads as absent — never a fabricated empty list", () => {
    // Upstream never emits []: it serves null, a non-empty list, or strips the
    // key. So an array that ranks to nothing here is a schema break, and
    // `sources: []` would read as the positive "cited nothing" claim the
    // tri-state forbids.
    const r = reachableReport();
    (r.ai_visibility as Record<string, unknown>).sources = [{ answer_count: 4 }, "junk", null];
    expect("sources" in toAiVisibility(r)).toBe(false);
  });

  it("a literal upstream [] also reads as absent — it is a state no producer emits", () => {
    const r = reachableReport();
    (r.ai_visibility as Record<string, unknown>).sources = [];
    expect("sources" in toAiVisibility(r)).toBe(false);
  });

  it("enforces the documented top-ten cap client-side", () => {
    const r = reachableReport();
    (r.ai_visibility as Record<string, unknown>).sources = Array.from({ length: 12 }, (_, i) => ({
      domain: `d${i}.example`,
      answers: 1,
      platforms: ["ChatGPT"],
      ownership: "third_party",
      url: null,
      title: "",
    }));
    expect(toAiVisibility(r).sources).toHaveLength(10);
  });
});
