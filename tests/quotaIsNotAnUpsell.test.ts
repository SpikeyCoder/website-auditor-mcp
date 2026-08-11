/**
 * Hitting the daily audit cap is not an upgrade prompt.
 *
 * OVER_QUOTA is the API's 429, raised by middleware/rateLimiter.js enforcing
 * config.rateLimitPerDay = 10 audits/day. That ceiling applies to every
 * subscriber — it is a usage limit, not a plan boundary.
 *
 * And a 429 can ONLY ever reach a subscriber. Since website-auditor-api PR #17
 * there is no free API tier: every key-authed capability requires an
 * active/trialing subscription, and requireSubscription in tools/context.ts
 * blocks the call client-side before a request is even made. Nothing in src/
 * reads freeDailyAuditLimit — there is no free path left that could legitimately
 * run out of quota.
 *
 * So attaching an upgrade link here offers a customer the plan they are already
 * paying for. compareCompetitors went further and told them in words to "upgrade
 * for a higher quota", which describes a product that does not exist — there is
 * one plan at $10/month.
 *
 * The codebase already reasons this through correctly one status code away, at
 * client.ts's 409/LIMIT_REACHED branch: "The caller is already Pro, so this is
 * not an upgrade prompt — the fix is to untrack a domain, surfaced in the
 * message." This is the same rule applied to 429, where the remedy is the reset
 * time rather than a purchase.
 *
 * Not hypothetical: 3 MCP subscribers hit OVER_QUOTA in production (11 events,
 * all inside their trial window). One of them is still paying.
 */
import { describe, it, expect, vi } from "vitest";
import { WaApiClient } from "../src/api/client.js";
import { WaApiError } from "../src/api/errors.js";
import { fromApiError } from "../src/tools/context.js";
import { compareCompetitors } from "../src/tools/compareCompetitors.js";
import { makeDeps, makeQuotaClient, testConfig } from "./helpers.js";
import { reachableReport } from "./fixtures/reports.js";

const cfg = {
  apiBaseUrl: "https://api.website-auditor.io",
  siteUrl: "https://website-auditor.io",
  apiKey: "wa_valid_key",
  upgradeUrl: "https://api.website-auditor.io/admin_portal/",
  freeDailyAuditLimit: 3,
  freeMaxDomains: 1,
  requestTimeoutMs: 120000,
};

const UPGRADE = "admin_portal";

describe("OVER_QUOTA carries no upgrade prompt", () => {
  it("the 429 branch does not attach an upgrade URL to the error", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: "Rate limit exceeded. You can make 10 requests per day.",
            rate_limit: { limit: 5, remaining: 0, resets_at: "2026-08-05T00:00:00Z" },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new WaApiClient(cfg, { fetch: fetchMock as unknown as typeof fetch });
    const e = await client.runAudit({ domain: "example.com" }).catch((err) => err);
    expect(e).toBeInstanceOf(WaApiError);
    expect(e.code).toBe("OVER_QUOTA");
    expect(e.upgradeUrl).toBeUndefined();
  });

  it("still carries the quota details, so the caller can say when it resets", async () => {
    // Removing the upsell must not remove the remedy. resets_at is the only
    // actionable thing about a rate limit.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: "Rate limit exceeded.",
            rate_limit: { limit: 5, remaining: 0, resets_at: "2026-08-05T00:00:00Z" },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new WaApiClient(cfg, { fetch: fetchMock as unknown as typeof fetch });
    const e = await client.runAudit({ domain: "example.com" }).catch((err) => err);
    expect(e.details).toMatchObject({ resets_at: "2026-08-05T00:00:00Z" });
  });

  it("renders the reset time into the message, not only into details", async () => {
    // `details` is machine-readable and does reach the model, but `message` is
    // the line a client shows the customer and the only part most agents quote.
    // "Rate limit exceeded. You can make 10 requests per day." tells them they
    // are blocked without telling them until when — and now that the upsell is
    // gone, the reset time is the only remedy left to offer. compare_competitors
    // already answers this way; the direct 429 should not be worse.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: "Rate limit exceeded. You can make 10 requests per day.",
            rate_limit: { limit: 10, remaining: 0, resets_at: "2026-08-05T23:59:59.999Z" },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new WaApiClient(cfg, { fetch: fetchMock as unknown as typeof fetch });
    const e = await client.runAudit({ domain: "example.com" }).catch((err) => err);
    expect(e.message).toContain("Rate limit exceeded. You can make 10 requests per day.");
    expect(e.message).toContain("2026-08-05T23:59:59.999Z");
    expect(e.message).toMatch(/re-?run|try again/i);
    // Still no purchase in the remedy.
    expect(e.message).not.toMatch(/upgrade|subscribe/i);
  });

  it("omits the reset clause when the 429 carries no rate_limit block", async () => {
    // Never render "resets at undefined". The API always sends rate_limit on a
    // 429 today, but a proxy or a future error shape may not.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false, error: "Rate limit exceeded." }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new WaApiClient(cfg, { fetch: fetchMock as unknown as typeof fetch });
    const e = await client.runAudit({ domain: "example.com" }).catch((err) => err);
    expect(e.code).toBe("OVER_QUOTA");
    expect(e.message).toBe("Rate limit exceeded.");
    expect(e.message).not.toMatch(/undefined|null|resets at/i);
  });

  it("fromApiError does not synthesise an upgrade URL for OVER_QUOTA", () => {
    const res = fromApiError(new WaApiError("OVER_QUOTA", "Rate limit exceeded."), testConfig());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("OVER_QUOTA");
    expect(res.error.upgrade_url).toBeUndefined();
  });

  it("but PRO_REQUIRED and INVALID_KEY still get one — those ARE plan boundaries", () => {
    for (const code of ["PRO_REQUIRED", "INVALID_KEY"] as const) {
      const res = fromApiError(new WaApiError(code, "nope"), testConfig());
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.upgrade_url).toContain(UPGRADE);
    }
  });

  it("compare_competitors does not offer a higher quota that does not exist", async () => {
    const client = makeQuotaClient({ start: 0, report: reachableReport });
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com"] },
      makeDeps({ tier: "pro", client }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("OVER_QUOTA");
    expect(res.error.upgrade_url).toBeUndefined();
    // There is one plan at $10/month. "upgrade for a higher quota" describes a
    // product that cannot be bought.
    expect(res.error.message).not.toMatch(/upgrade/i);
  });

  it("compare_competitors still tells the customer what to actually do", async () => {
    const client = makeQuotaClient({ start: 0, report: reachableReport });
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com"] },
      makeDeps({ tier: "pro", client }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toMatch(/quota|reset|re-run/i);
  });
});
