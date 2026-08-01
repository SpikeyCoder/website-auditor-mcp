import { describe, it, expect } from "vitest";
import { getSampleAudit } from "../../src/tools/sampleAudit.js";
import { testConfig } from "../helpers.js";
import type { ToolDeps } from "../../src/tools/context.js";
import type { WaApiClientLike } from "../../src/api/client.js";
import type { SubscriptionProvider } from "../../src/auth/entitlements.js";
import type { AuditCache } from "../../src/auth/auditCache.js";
import { NoopEventSink } from "../../src/telemetry/events.js";

/**
 * get_sample_audit is the only tool a developer with no key can call, so its
 * whole value rests on working when nothing else does — no key, no
 * subscription, no network, API down.
 *
 * "Doesn't call the network" is exactly the kind of claim a test can appear to
 * cover while asserting nothing, so the client and subscription provider are
 * booby-trapped rather than mocked: every method throws. If the tool reaches
 * for either, these tests fail loudly instead of passing for the wrong reason.
 */
function explodingDeps(over: Partial<ToolDeps> = {}): ToolDeps {
  const boom = (what: string) => () => {
    throw new Error(`get_sample_audit must not touch ${what} — it has to work with no key and no network`);
  };
  const client = new Proxy({} as WaApiClientLike, { get: (_t, prop) => boom(`the API client (.${String(prop)})`) });
  const subscriptions = new Proxy({} as SubscriptionProvider, { get: (_t, prop) => boom(`the subscription provider (.${String(prop)})`) });
  const cache = new Proxy({} as AuditCache, { get: (_t, prop) => boom(`the audit cache (.${String(prop)})`) });
  return {
    config: testConfig({ apiKey: undefined }),
    client,
    subscriptions,
    cache,
    events: new NoopEventSink(),
    ...over,
  };
}

describe("get_sample_audit [Free, no key]", () => {
  it("succeeds with no API key configured", async () => {
    const res = await getSampleAudit({}, explodingDeps());
    expect(res.ok).toBe(true);
  });

  it("succeeds with an invalid key, without validating it", async () => {
    // A bad key must not degrade the demo — the point is to show the product
    // before anyone has a good key at all.
    const res = await getSampleAudit({}, explodingDeps({ config: testConfig({ apiKey: "wa_totally_invalid" }) }));
    expect(res.ok).toBe(true);
  });

  it("makes no network call and consults no subscription — the exploding deps prove it", async () => {
    // Passes only because nothing above threw.
    const res = await getSampleAudit({}, explodingDeps());
    expect(res.ok).toBe(true);
  });

  it("is unmistakably marked as sample data", async () => {
    const res = await getSampleAudit({}, explodingDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Canned output must never read as a real audit of the caller's own site.
    expect(res.data.is_sample).toBe(true);
    expect(res.data.domain).toBe("example.com");
    expect(res.data.note.toLowerCase()).toContain("sample");
  });

  it("carries the price and the upgrade URL, so the model can quote both", async () => {
    const res = await getSampleAudit({}, explodingDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.price).toContain("$10");
    expect(res.data.upgrade_url).toContain("admin_portal");
  });

  it("returns a real-shaped audit, not a stub — it has to show what is actually bought", async () => {
    const res = await getSampleAudit({}, explodingDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const audit = res.data.audit;
    expect(audit.summary.pass_rate).toBeTypeOf("number");
    expect(Array.isArray(audit.results)).toBe(true);
    expect(audit.results.length).toBeGreaterThan(0);
    // The AI-visibility block is the differentiator and the reason to subscribe.
    expect(audit.ai_visibility?.overall_score).toBeTypeOf("number");
    expect(Object.keys(audit.ai_visibility?.platform_scores ?? {}).length).toBeGreaterThan(0);
  });

  it("takes no arguments — it cannot be pointed at a caller's domain", async () => {
    // If it accepted a domain, canned data would masquerade as a real result for
    // that site. Extra args are ignored rather than honoured.
    const res = await getSampleAudit({ domain: "acme.com" } as Record<string, never>, explodingDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.domain).toBe("example.com");
  });
});
