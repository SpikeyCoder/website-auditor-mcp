/**
 * A key that was never one of ours is not a customer losing access.
 *
 * website-auditor-api returns 401 from four different places — no key, a key
 * without the `wa_` prefix, a well-formed key it cannot find, and a key it
 * found and refused — and the MCP client mapped all of them to INVALID_KEY.
 * So `mcp_events.error_code` could not separate someone pasting the wrong
 * string during setup from a paying customer whose key had been revoked.
 *
 * That gap is not academic. On 2026-08-06 six tool calls failed this way in an
 * hour across two installs, and telling them apart needed a latency
 * side-channel (the API answers a bad prefix in 1-4ms because it rejects
 * before touching the database, against 215-657ms for a real lookup) rather
 * than the event stream that exists to answer exactly this.
 *
 * WHAT MUST NOT CHANGE is what the user reads. Both cases still produce the
 * same sentence, led by the API's own wording. Only the code splits.
 */
import { describe, it, expect } from "vitest";
import {
  DefaultSubscriptionProvider,
  API_KEY_PREFIX,
  MALFORMED_KEY_MESSAGE,
} from "../src/auth/entitlements.js";
import { gateProTool } from "../src/tools/context.js";
import { checkUpgradeStatus } from "../src/tools/checkUpgradeStatus.js";
import { makeDeps } from "./helpers.js";
import type { WaConfig } from "../src/config.js";

const cfg = (over: Partial<WaConfig> = {}): WaConfig =>
  ({
    apiKey: undefined,
    apiBaseUrl: "https://api.example.test",
    upgradeUrl: "https://portal.example.test",
    subscriptionCacheTtlMs: 60_000,
    ...over,
  }) as WaConfig;

/** A subscription source that fails the test if it is ever called. */
const neverCalled = () => ({
  getSubscription: async () => {
    throw new Error("the endpoint must not be called for a malformed key");
  },
});

const deps = (apiKey: string) => {
  const config = cfg({ apiKey });
  return {
    config,
    subscriptions: new DefaultSubscriptionProvider(config, neverCalled()),
  } as unknown as Parameters<typeof gateProTool>[0];
};

describe("a key without the wa_ prefix", () => {
  it("is settled locally, without spending a request the API would refuse", async () => {
    const config = cfg({ apiKey: "sk-proj-not-ours" });
    const p = new DefaultSubscriptionProvider(config, neverCalled());
    // neverCalled() throws if the endpoint is reached, so this passing IS the
    // assertion that no round trip happened.
    expect(await p.resolve("sk-proj-not-ours")).toEqual({
      tier: "invalid",
      verified: true,
      rejection: "MALFORMED_KEY",
      message: MALFORMED_KEY_MESSAGE,
    });
  });

  it("reports MALFORMED_KEY, not INVALID_KEY", async () => {
    const result = await gateProTool(deps("sk-proj-not-ours"));
    expect(result?.error?.code).toBe("MALFORMED_KEY");
  });

  it("still reads as the same message a rejected key produces", async () => {
    // The split is for the event stream. A user who pasted the wrong string
    // must still be told what to do, in the API's own words.
    const result = await gateProTool(deps("sk-proj-not-ours"));
    expect(result?.error?.message).toContain(MALFORMED_KEY_MESSAGE);
    expect(result?.error?.message).toContain("portal.example.test");
  });

  it("still carries the upgrade link", async () => {
    // gateProTool passes the portal URL itself, so this survives independently
    // of fromApiError's plan-boundary list — which never sees this code,
    // because a malformed key is settled before any request is made.
    const result = await gateProTool(deps("sk-proj-not-ours"));
    expect(result?.error?.upgrade_url).toBeTruthy();
  });

  it("covers the shapes people actually paste", async () => {
    for (const key of ["your-api-key-here", "sk-proj-abc123", "WA_1234", "wa-1234", " wa_x"]) {
      const result = await gateProTool(deps(key));
      expect(result?.error?.code, `for ${JSON.stringify(key)}`).toBe("MALFORMED_KEY");
    }
  });
});

/**
 * check_upgrade_status does not go through resolve(), so the short-circuit
 * above never covered it — and it is precisely the tool someone with a broken
 * key is meant to reach, so it made the call the others had stopped making.
 *
 * Production bore that out: for a week after 1.0.15 shipped, /api/subscription
 * was the ONLY route in the whole API recording a malformed_key 401.
 */
describe("check_upgrade_status, the tool a broken key is meant to reach", () => {
  const upgradeDeps = (apiKey: string) => makeDeps({ client: neverCalled(), config: { apiKey } });

  it("answers a malformed key without calling the endpoint", async () => {
    // neverCalled() throws if getSubscription is reached, so an ok:false result
    // carrying the API's own wording IS the assertion that nothing was sent.
    const res = await checkUpgradeStatus({}, upgradeDeps("sk-proj-not-ours"));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("MALFORMED_KEY");
    expect(res.error.message).toContain(MALFORMED_KEY_MESSAGE);
  });

  it("still hands back the signup link the 401 used to carry", async () => {
    const res = await checkUpgradeStatus({}, upgradeDeps("sk-proj-not-ours"));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.upgrade_url).toBeTruthy();
  });

  it("covers the shapes people actually paste", async () => {
    for (const key of ["your-api-key-here", "sk-proj-abc123", "WA_1234", "wa-1234", " wa_x"]) {
      const res = await checkUpgradeStatus({}, upgradeDeps(key));
      expect(res.ok, `for ${JSON.stringify(key)}`).toBe(false);
    }
  });

  it("leaves the no-key branch alone — that one is guidance, not an error", async () => {
    // Someone who configured nothing gets the onboarding answer, not a
    // rejection. Sweeping it into MALFORMED_KEY would bury the setup steps
    // behind an error, which is the failure the config placeholder guard
    // already exists to prevent.
    const res = await checkUpgradeStatus({}, makeDeps({ client: neverCalled(), config: { apiKey: undefined } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.tier).toBe("none");
  });

  it("still reaches the API for a well-formed key", async () => {
    // The prefix check is a fast path, not a replacement for the lookup.
    let called = false;
    const res = await checkUpgradeStatus(
      {},
      makeDeps({
        client: {
          getSubscription: async () => {
            called = true;
            return { tier: "pro" as const, status: "active" };
          },
        },
        config: { apiKey: "wa_realish" },
      }),
    );
    expect(called).toBe(true);
    expect(res.ok).toBe(true);
  });
});

describe("the boundaries the split must not cross", () => {
  it("no key at all is still AUTH_REQUIRED, not malformed", async () => {
    // An empty key is a different problem with different advice — it must not
    // be swept into the new bucket.
    const config = cfg({ apiKey: undefined });
    const p = new DefaultSubscriptionProvider(config, neverCalled());
    expect(await p.resolve(undefined)).toEqual({ tier: "none", verified: true });
  });

  it("does not override WA_DEV_TIER, which is routinely set with a placeholder key", async () => {
    // The dev escape hatch never talks to the API, so a prefix check in front
    // of it would break the one workflow that cannot be affected by the thing
    // the check exists to catch.
    const config = cfg({ apiKey: "local-dev-placeholder", devTier: "pro" as const });
    const p = new DefaultSubscriptionProvider(config, neverCalled());
    expect(await p.resolve("local-dev-placeholder")).toEqual({ tier: "pro", verified: true });
  });

  it("a well-formed key still reaches the API", async () => {
    // The prefix check is a fast path, not a replacement for authentication —
    // only the API can say whether a wa_ key is real.
    let called = false;
    const config = cfg({ apiKey: "wa_realish" });
    const p = new DefaultSubscriptionProvider(config, {
      getSubscription: async () => {
        called = true;
        return { tier: "pro" as const, status: "active" };
      },
    });
    await p.resolve("wa_realish");
    expect(called).toBe(true);
  });
});

describe("the duplicated copy", () => {
  it("matches what website-auditor-api answers a bad prefix with", () => {
    // Short-circuiting means this string is written twice, once per repo. If
    // the API rewords its version, this fails and the two get reconciled
    // rather than quietly diverging — which is the whole reason the reader
    // cannot tell which side answered.
    expect(MALFORMED_KEY_MESSAGE).toBe("Invalid API key format. Keys start with wa_.");
    expect(API_KEY_PREFIX).toBe("wa_");
  });
});
