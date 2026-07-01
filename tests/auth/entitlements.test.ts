import { describe, it, expect, vi } from "vitest";
import { DefaultSubscriptionProvider, isPro } from "../../src/auth/entitlements.js";
import type { SubscriptionSource } from "../../src/auth/entitlements.js";
import { WaApiError } from "../../src/api/errors.js";
import type { SubscriptionInfo } from "../../src/api/client.js";

const cfg = (over: Record<string, unknown> = {}) => ({
  apiBaseUrl: "https://api.website-auditor.io",
  siteUrl: "https://website-auditor.io",
  upgradeUrl: "https://website-auditor.io/admin_portal",
  freeDailyAuditLimit: 3,
  freeMaxDomains: 1,
  requestTimeoutMs: 120000,
  auditCacheTtlMs: 24 * 60 * 60 * 1000,
  subscriptionCacheTtlMs: 60_000,
  metricsEnabled: true,
  ...over,
});

/** A stub subscription source (client.getSubscription seam). */
function source(impl: () => Promise<Partial<SubscriptionInfo>>): SubscriptionSource {
  return { getSubscription: vi.fn(impl as () => Promise<SubscriptionInfo>) };
}

/** A controllable monotonic clock for TTL tests. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms: number) => {
    t += ms;
  };
  return now;
}

describe("DefaultSubscriptionProvider.resolve — no live lookup needed", () => {
  it("returns verified 'none' when no API key is configured (and never calls the endpoint)", async () => {
    const src = source(async () => ({ tier: "pro", status: "active" }));
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: undefined }), src);
    expect(await p.resolve()).toEqual({ tier: "none", verified: true });
    expect(src.getSubscription).not.toHaveBeenCalled();
  });

  it("honors WA_DEV_TIER as an explicit override (verified, no endpoint call)", async () => {
    const src = source(async () => ({ tier: "free", status: "none" }));
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: "wa_key", devTier: "pro" }), src);
    expect(await p.resolve("wa_key")).toEqual({ tier: "pro", verified: true });
    expect(src.getSubscription).not.toHaveBeenCalled();
  });

  it("does not grant a tier from the dev override when no key is present", async () => {
    const src = source(async () => ({ tier: "pro", status: "active" }));
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: undefined, devTier: "pro" }), src);
    expect(await p.resolve()).toEqual({ tier: "none", verified: true });
  });
});

describe("DefaultSubscriptionProvider.resolve — live subscription lookup", () => {
  it("maps an active subscription to verified Pro", async () => {
    const src = source(async () => ({ tier: "pro", status: "active" }));
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: "wa_key" }), src);
    expect(await p.resolve("wa_key")).toEqual({ tier: "pro", verified: true });
  });

  it("maps a trialing subscription to verified Pro", async () => {
    const src = source(async () => ({ tier: "pro", status: "trialing" }));
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: "wa_key" }), src);
    expect(await p.resolve("wa_key")).toEqual({ tier: "pro", verified: true });
  });

  it("maps 'no subscription' (status none) to verified free", async () => {
    const src = source(async () => ({ tier: "free", status: "none" }));
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: "wa_key" }), src);
    expect(await p.resolve("wa_key")).toEqual({ tier: "free", verified: true });
  });

  it("maps a lapsed (canceled) subscription to verified free", async () => {
    const src = source(async () => ({ tier: "free", status: "canceled" }));
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: "wa_key" }), src);
    expect(await p.resolve("wa_key")).toEqual({ tier: "free", verified: true });
  });
});

describe("DefaultSubscriptionProvider.resolve — caching + TTL", () => {
  it("caches within the TTL: a second resolve does not re-hit the endpoint", async () => {
    const src = source(async () => ({ tier: "pro", status: "active" }));
    const clock = fakeClock();
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: "wa_key" }), src, clock);

    await p.resolve("wa_key");
    clock.advance(59_000); // still inside the 60s TTL
    await p.resolve("wa_key");

    expect(src.getSubscription).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the TTL expires and reflects a downgrade", async () => {
    let tier: "free" | "pro" = "pro";
    const src = source(async () => ({ tier, status: tier === "pro" ? "active" : "canceled" }));
    const clock = fakeClock();
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: "wa_key" }), src, clock);

    expect(await p.resolve("wa_key")).toEqual({ tier: "pro", verified: true });
    tier = "free"; // the user cancels
    clock.advance(61_000); // past the TTL
    expect(await p.resolve("wa_key")).toEqual({ tier: "free", verified: true });
    expect(src.getSubscription).toHaveBeenCalledTimes(2);
  });

  it("keys the cache per API key (one key's tier never leaks to another)", async () => {
    const src: SubscriptionSource = {
      getSubscription: vi.fn(async () => ({ tier: "pro", status: "active" }) as SubscriptionInfo),
    };
    // Distinguish the two keys by returning different tiers per call.
    (src.getSubscription as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ tier: "pro", status: "active" } as SubscriptionInfo)
      .mockResolvedValueOnce({ tier: "free", status: "none" } as SubscriptionInfo);
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: "wa_pro" }), src);

    expect(await p.resolve("wa_pro")).toEqual({ tier: "pro", verified: true });
    expect(await p.resolve("wa_free")).toEqual({ tier: "free", verified: true });
    // Each key resolved once — the pro result was not served for the free key.
    expect(src.getSubscription).toHaveBeenCalledTimes(2);
  });
});

describe("DefaultSubscriptionProvider.resolve — failure handling", () => {
  it("prefers the last-known cached tier when the endpoint errors (warm cache)", async () => {
    let fail = false;
    const src = source(async () => {
      if (fail) throw new WaApiError("UPSTREAM_ERROR", "subscription service down");
      return { tier: "pro", status: "active" };
    });
    const clock = fakeClock();
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: "wa_key" }), src, clock);

    // Warm the cache with a Pro result.
    expect(await p.resolve("wa_key")).toEqual({ tier: "pro", verified: true });

    // The endpoint goes down and the cache expires — last-known Pro is honored.
    fail = true;
    clock.advance(61_000);
    expect(await p.resolve("wa_key")).toEqual({ tier: "pro", verified: true });
  });

  it("defaults to FREE but flags it UNVERIFIED on a transient error with a cold cache (never fail-open to Pro, never a false 'not subscribed')", async () => {
    const src = source(async () => {
      throw new WaApiError("UPSTREAM_ERROR", "subscription service unreachable");
    });
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: "wa_key" }), src);
    expect(await p.resolve("wa_key")).toEqual({ tier: "free", verified: false });
  });

  it("treats an outright-rejected key (INVALID_KEY) as a definitive verified free, not a retryable outage", async () => {
    const src = source(async () => {
      throw new WaApiError("INVALID_KEY", "Invalid API key.");
    });
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: "wa_bad" }), src);
    expect(await p.resolve("wa_bad")).toEqual({ tier: "free", verified: true });
  });

  it("wraps an unexpected (non-WaApiError) throw as UNVERIFIED free when cold", async () => {
    const src = source(async () => {
      throw new TypeError("boom");
    });
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: "wa_key" }), src);
    expect(await p.resolve("wa_key")).toEqual({ tier: "free", verified: false });
  });
});

describe("isPro", () => {
  it("is true only for the pro tier", () => {
    expect(isPro("pro")).toBe(true);
    expect(isPro("free")).toBe(false);
    expect(isPro("none")).toBe(false);
  });
});
