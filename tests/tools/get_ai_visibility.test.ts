import { describe, it, expect, vi } from "vitest";
import { getAiVisibility } from "../../src/tools/getAiVisibility.js";
import { makeDeps, fixedResolution } from "../helpers.js";
import { WaApiError } from "../../src/api/errors.js";
import { unreachableReport } from "../fixtures/reports.js";

describe("get_ai_visibility [Subscription]", () => {
  it("happy path (subscriber): returns score, per-engine breakdown and top competitor", async () => {
    const res = await getAiVisibility({ domain: "example.com" }, makeDeps({ tier: "pro" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.score).toBe(62);
    expect(res.data.by_engine).toEqual({ chatgpt: 75, perplexity: 62, claude: 50, gemini: 62 });
    expect(res.data.top_competitor).toBe("Globex");
  });

  it("free tier (no subscription) -> PRO_REQUIRED pre-flight; no API call, no token spend", async () => {
    const runAudit = vi.fn();
    const res = await getAiVisibility({ domain: "example.com" }, makeDeps({ tier: "free", client: { runAudit } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(res.error.upgrade_url).toContain("website-auditor.io");
    expect(runAudit).not.toHaveBeenCalled();
  });

  it("no key -> AUTH_REQUIRED with an upgrade URL (backend requires a key)", async () => {
    const res = await getAiVisibility({ domain: "example.com" }, makeDeps({ tier: "none" }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("AUTH_REQUIRED");
    expect(res.error.upgrade_url).toContain("website-auditor.io");
  });

  it("unverified tier (subscription-service outage) -> SUBSCRIPTION_UNVERIFIED, retryable, never an upsell", async () => {
    const res = await getAiVisibility(
      { domain: "example.com" },
      makeDeps({ subscriptions: fixedResolution({ tier: "free", verified: false }) }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("SUBSCRIPTION_UNVERIFIED");
  });

  it("unreachable domain -> UNREACHABLE_DOMAIN, never a fabricated score", async () => {
    const client = {
      runAudit: vi.fn(async () => ({ runId: "x", report: unreachableReport(), raw: {} })),
    };
    const res = await getAiVisibility({ domain: "not-a-real-domain-zzz.example" }, makeDeps({ tier: "pro", client }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("UNREACHABLE_DOMAIN");
    expect(JSON.stringify(res)).not.toContain('"score"');
  });

  it("propagates an invalid-key error from the API", async () => {
    const client = {
      runAudit: vi.fn(async () => {
        throw new WaApiError("INVALID_KEY", "Invalid API key.");
      }),
    };
    const res = await getAiVisibility({ domain: "example.com" }, makeDeps({ tier: "pro", client }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_KEY");
  });
});

describe("get_ai_visibility trend", () => {
  const snaps = (specs: Array<[string, number]>) =>
    specs.map(([captured_at, score], i) => ({
      captured_at,
      // The newest is the audit just run (runAudit's mock run): the trend ends at its snapshot.
      run_id: i === specs.length - 1 ? "abc123def456" : `earlier-${i}`,
      score,
      by_engine: { chatgpt: score, perplexity: score, claude: score, gemini: score },
      is_simulated: false,
      // One question throughout: the trend compares only snapshots that asked the same one.
      question: {
        key: "q-example", business_name: "Example", name_source: "detected",
        business_location: "", market_scope: "global", queries: ["best example"],
      },
    }));
  // snaps() scores every engine as the whole, so every engine moves with it.
  const everyEngine = (from: number, to: number) =>
    ["chatgpt", "perplexity", "claude", "gemini"].map((engine) => ({ engine, from, to, delta: to - from }));

  it("subscriber with history -> trend windows computed, audit result untouched", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const getAiVisibilityHistory = vi.fn(async () =>
      snaps([
        [new Date(now - 20 * day).toISOString(), 40],
        [new Date(now - 5 * day).toISOString(), 50],
        [new Date(now - 1 * day).toISOString(), 60],
      ]),
    );
    const res = await getAiVisibility(
      { domain: "example.com" },
      makeDeps({ tier: "pro", client: { getAiVisibilityHistory } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.score).toBe(62); // fresh audit score, not history
    expect(res.data.trend).not.toBeNull();
    expect(res.data.trend!.change_7d!.score_delta).toBe(10); // 60 vs 50
    expect(res.data.trend!.change_30d!.score_delta).toBe(20); // 60 vs 40
    expect(res.data.trend!.snapshots_analyzed).toBe(3);
    expect(res.data.trend_note).toBeUndefined();
    expect(getAiVisibilityHistory).toHaveBeenCalledWith({ domain: "example.com" });
  });

  it("single snapshot -> trend null + not-enough-history note", async () => {
    const getAiVisibilityHistory = vi.fn(async () => snaps([[new Date().toISOString(), 50]]));
    const res = await getAiVisibility(
      { domain: "example.com" },
      makeDeps({ tier: "pro", client: { getAiVisibilityHistory } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.trend).toBeNull();
    expect(res.data.trend_note).toContain("at least two measured snapshots");
  });

  it("a change of question leaves no trend, and the note says when and what", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const [before, after] = snaps([
      [new Date(now - 6 * day).toISOString(), 40],
      [new Date(now - day).toISOString(), 90],
    ]);
    const renamed = { ...after!, question: { ...after!.question, key: "q-roasters", business_name: "Example Roasters" } };
    const getAiVisibilityHistory = vi.fn(async () => [before!, renamed]);
    const res = await getAiVisibility(
      { domain: "example.com" },
      makeDeps({ tier: "pro", client: { getAiVisibilityHistory } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.trend!.change_7d).toBeNull();
    expect(res.data.trend!.change_30d).toBeNull();
    expect(res.data.trend!.question_note).toMatch(
      /^No earlier snapshot asked the question the latest one, on \d{4}-\d{2}-\d{2}, asked\. It asked about the business name "Example Roasters" rather than "Example"/);
  });

  it("history endpoint failure never fails the tool -> trend null + soft note", async () => {
    const getAiVisibilityHistory = vi.fn(async () => {
      throw new WaApiError("UPSTREAM_ERROR", "boom");
    });
    const res = await getAiVisibility(
      { domain: "example.com" },
      makeDeps({ tier: "pro", client: { getAiVisibilityHistory } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.score).toBe(62);
    expect(res.data.trend).toBeNull();
    expect(res.data.trend_note).toContain("could not be loaded");
  });

  it("an audit that stored no measured snapshot gets no trend, however much history there is", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const history = snaps([
      [new Date(now - 20 * day).toISOString(), 40],
      [new Date(now - 5 * day).toISOString(), 50],
      [new Date(now - 1 * day).toISOString(), 60],
    ]);
    const last = history.length - 1;
    // No score stored: the client drops the audit's row, so the newest is another audit's.
    const unscored = history.map((s, i) => (i === last ? { ...s, run_id: "another-audit" } : s));
    // Simulated: the row is there, and measured nothing.
    const simulated = history.map((s, i) => (i === last ? { ...s, is_simulated: true } : s));
    for (const snapshots of [unscored, simulated]) {
      const res = await getAiVisibility(
        { domain: "example.com" },
        makeDeps({ tier: "pro", client: { getAiVisibilityHistory: vi.fn(async () => snapshots) } }),
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.trend).toBeNull();
      expect(res.data.trend_note).toMatch(/^No trend for this audit: it stored no measured AI-visibility snapshot/);
    }
  });

  it("an audit that scored 0 stored a measured snapshot, and gets its trend", async () => {
    // A zero is a score. Read as none, this audit would get the note for one that stored no measured snapshot,
    // and a window would drop each engine's 0 from its change.
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const history = snaps([
      [new Date(now - 20 * day).toISOString(), 40],
      [new Date(now - 5 * day).toISOString(), 50],
      [new Date(now - 1 * day).toISOString(), 0],
    ]);
    const res = await getAiVisibility(
      { domain: "example.com" },
      makeDeps({ tier: "pro", client: { getAiVisibilityHistory: vi.fn(async () => history) } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.trend_note).toBeUndefined();
    expect(res.data.trend!.change_7d!.score_delta).toBe(-50); // 0 vs 50
    expect(res.data.trend!.change_7d!.engine_changes).toEqual(everyEngine(50, 0));
    expect(res.data.trend!.change_30d!.score_delta).toBe(-40); // 0 vs 40
  });

  it("a window that starts at a snapshot that scored 0 reports the rise from it, every engine's included", async () => {
    // The other end of a window. Read as none, an engine's 0 at the oldest snapshot would drop it from the change.
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const history = snaps([
      [new Date(now - 20 * day).toISOString(), 40],
      [new Date(now - 5 * day).toISOString(), 0],
      [new Date(now - 1 * day).toISOString(), 50],
    ]);
    const res = await getAiVisibility(
      { domain: "example.com" },
      makeDeps({ tier: "pro", client: { getAiVisibilityHistory: vi.fn(async () => history) } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.trend!.change_7d!.score_delta).toBe(50); // 50 vs 0
    expect(res.data.trend!.change_7d!.engine_changes).toEqual(everyEngine(0, 50));
  });

  it("the trend ends at this audit's snapshot, not a newer one", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const history = snaps([
      [new Date(now - 20 * day).toISOString(), 40],
      [new Date(now - 5 * day).toISOString(), 50],
      [new Date(now - 2 * day).toISOString(), 60],
    ]);
    const newer = {
      ...history[1]!, run_id: "a-weekly-re-audit", captured_at: new Date(now - day).toISOString(), score: 99,
      by_engine: { chatgpt: 99, perplexity: 99, claude: 99, gemini: 99 },
    };
    const res = await getAiVisibility(
      { domain: "example.com" },
      makeDeps({ tier: "pro", client: { getAiVisibilityHistory: vi.fn(async () => [...history, newer]) } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.trend!.latest_captured_at).toBe(history[2]!.captured_at);
    expect(res.data.trend!.change_7d!.score_delta).toBe(10);
  });
});

describe("get_ai_visibility cited sources", () => {
  it("returns the ranked cited-sources evidence alongside the score", async () => {
    const res = await getAiVisibility({ domain: "example.com" }, makeDeps({ tier: "pro" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Array.isArray(res.data.sources)).toBe(true);
    // Ownership is what makes the list actionable: a `competitor` row is a
    // trap, not a placement target — the tool must relay it, not strip it.
    const ownerships = res.data.sources!.map((s) => s.ownership);
    expect(ownerships).toContain("third_party");
    expect(ownerships).toContain("competitor");
    expect(ownerships).toContain("yours");
  });
});
