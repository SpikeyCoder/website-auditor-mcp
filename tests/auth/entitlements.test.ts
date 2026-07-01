import { describe, it, expect } from "vitest";
import { DefaultSubscriptionProvider, isPro } from "../../src/auth/entitlements.js";

const cfg = (over: Record<string, unknown> = {}) => ({
  apiBaseUrl: "https://api.website-auditor.io",
  siteUrl: "https://website-auditor.io",
  upgradeUrl: "https://website-auditor.io/admin_portal",
  freeDailyAuditLimit: 3,
  freeMaxDomains: 1,
  requestTimeoutMs: 120000,
  ...over,
});

describe("DefaultSubscriptionProvider", () => {
  it("returns 'none' when no API key is configured", async () => {
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: undefined }));
    expect(await p.getTier()).toBe("none");
  });

  it("defaults a present key to 'free' (Pro cannot yet be confirmed via the API)", async () => {
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: "wa_key" }));
    expect(await p.getTier("wa_key")).toBe("free");
  });

  it("honors a dev tier override when a key is present", async () => {
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: "wa_key", devTier: "pro" }));
    expect(await p.getTier("wa_key")).toBe("pro");
  });

  it("does not grant a tier from the dev override when no key is present", async () => {
    const p = new DefaultSubscriptionProvider(cfg({ apiKey: undefined, devTier: "pro" }));
    expect(await p.getTier()).toBe("none");
  });
});

describe("isPro", () => {
  it("is true only for the pro tier", () => {
    expect(isPro("pro")).toBe(true);
    expect(isPro("free")).toBe(false);
    expect(isPro("none")).toBe(false);
  });
});
