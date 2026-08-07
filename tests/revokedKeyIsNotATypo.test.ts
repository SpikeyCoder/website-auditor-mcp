/**
 * The other half of the split: what only the API can tell us.
 *
 * A missing `wa_` prefix is decidable here, so MALFORMED_KEY needed no help
 * from the server. Unknown-versus-revoked is not — both are well-formed keys
 * and only the API knows which one it holds. It now says so in the 401 body
 * (`reason`, website-auditor-api PR #44) instead of only in prose.
 *
 * The distinction is the whole point of the exercise: a revoked key usually
 * belongs to somebody who is paying and whose access just stopped, while an
 * unknown one is almost always a typo. They were the same event.
 *
 * SHIPS BEFORE THE API DOES, so every assertion about a missing `reason` is
 * load-bearing rather than defensive.
 */
import { describe, it, expect } from "vitest";
import {
  WaApiError,
  isKeyRejection,
  keyRejectionFromReason,
  type ErrorCode,
} from "../src/api/errors.js";
import { DefaultSubscriptionProvider } from "../src/auth/entitlements.js";
import { gateProTool, fromApiError } from "../src/tools/context.js";
import type { WaConfig } from "../src/config.js";

const cfg = (over: Partial<WaConfig> = {}): WaConfig =>
  ({
    apiKey: "wa_wellformed",
    apiBaseUrl: "https://api.example.test",
    upgradeUrl: "https://portal.example.test",
    subscriptionCacheTtlMs: 60_000,
    ...over,
  }) as WaConfig;

/** A subscription source that fails the way the API would for `reason`. */
const rejecting = (code: ErrorCode, message = "nope") => ({
  getSubscription: async () => {
    throw new WaApiError(code, message);
  },
});

const depsFor = (code: ErrorCode, message?: string) => {
  const config = cfg();
  return {
    config,
    subscriptions: new DefaultSubscriptionProvider(config, rejecting(code, message)),
  } as unknown as Parameters<typeof gateProTool>[0];
};

describe("mapping the API's reason", () => {
  it("names each cause the API can report", () => {
    expect(keyRejectionFromReason("malformed_key")).toBe("MALFORMED_KEY");
    expect(keyRejectionFromReason("unknown_key")).toBe("UNKNOWN_KEY");
    expect(keyRejectionFromReason("revoked_key")).toBe("REVOKED_KEY");
  });

  it("falls back to INVALID_KEY when the API says nothing", () => {
    // The API that is deployed right now. This must keep behaving exactly as
    // it did before the field existed.
    expect(keyRejectionFromReason(undefined)).toBe("INVALID_KEY");
    expect(keyRejectionFromReason(null)).toBe("INVALID_KEY");
  });

  it("falls back for a reason we do not recognise", () => {
    // A fifth cause added upstream must degrade, not throw or mislabel.
    expect(keyRejectionFromReason("some_future_reason")).toBe("INVALID_KEY");
    expect(keyRejectionFromReason(42)).toBe("INVALID_KEY");
    expect(keyRejectionFromReason({})).toBe("INVALID_KEY");
  });

  it("does not map missing_key", () => {
    // Nothing here calls the API without a key — resolve() and
    // check_upgrade_status both answer that locally — so a mapping would imply
    // a path that does not exist.
    expect(keyRejectionFromReason("missing_key")).toBe("INVALID_KEY");
  });
});

describe("every rejection code is treated as a rejection", () => {
  const codes: ErrorCode[] = ["INVALID_KEY", "MALFORMED_KEY", "UNKNOWN_KEY", "REVOKED_KEY"];

  it.each(codes)("%s resolves to invalid, not to a retryable outage", async (code) => {
    // THE REGRESSION THIS GUARDS. Matching the single old code would drop a
    // revoked key into the transient branch and answer "try again in a
    // moment" — the 1.0.8 bug, reintroduced by making the codes finer.
    const p = new DefaultSubscriptionProvider(cfg(), rejecting(code));
    const r = await p.resolve("wa_wellformed");
    expect(r).toMatchObject({ tier: "invalid", verified: true, rejection: code });
  });

  it.each(codes)("%s still carries the upgrade link through fromApiError", (code) => {
    const result = fromApiError(new WaApiError(code, "nope"), "https://portal.example.test");
    expect(result.error?.upgrade_url, code).toBeTruthy();
  });

  it("isKeyRejection covers exactly the auth failures", () => {
    for (const code of codes) expect(isKeyRejection(code), code).toBe(true);
    for (const code of ["PRO_REQUIRED", "OVER_QUOTA", "TIMEOUT", "AUTH_REQUIRED"] as ErrorCode[]) {
      expect(isKeyRejection(code), code).toBe(false);
    }
  });
});

describe("what the gate reports", () => {
  it("a revoked key is REVOKED_KEY, not INVALID_KEY", async () => {
    const result = await gateProTool(depsFor("REVOKED_KEY", "This API key has been revoked."));
    expect(result?.error?.code).toBe("REVOKED_KEY");
  });

  it("an unknown key is UNKNOWN_KEY", async () => {
    const result = await gateProTool(depsFor("UNKNOWN_KEY", "Invalid API key."));
    expect(result?.error?.code).toBe("UNKNOWN_KEY");
  });

  it("an unnamed rejection stays INVALID_KEY", async () => {
    const result = await gateProTool(depsFor("INVALID_KEY", "Invalid API key."));
    expect(result?.error?.code).toBe("INVALID_KEY");
  });

  it("still leads with the API's own sentence, whichever code it is", async () => {
    // The split is for the event stream. What the user reads is unchanged, and
    // it is the API's wording that tells them what to actually do.
    for (const [code, msg] of [
      ["REVOKED_KEY", "This API key has been revoked."],
      ["UNKNOWN_KEY", "Invalid API key. Check that your key is correct."],
    ] as const) {
      const result = await gateProTool(depsFor(code, msg));
      expect(result?.error?.message, code).toContain(msg);
      expect(result?.error?.upgrade_url, code).toBeTruthy();
    }
  });
});
