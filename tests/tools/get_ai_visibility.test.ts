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
    specs.map(([captured_at, score]) => ({
      captured_at,
      score,
      by_engine: { chatgpt: score, perplexity: score, claude: score, gemini: score },
      is_simulated: false,
    }));

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
    expect(res.data.trend_note).toContain("at least two snapshots");
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
});
