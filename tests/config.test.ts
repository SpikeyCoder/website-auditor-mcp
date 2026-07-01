import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies documented defaults when env is empty", () => {
    const cfg = loadConfig({});
    expect(cfg.apiBaseUrl).toBe("https://api.website-auditor.io");
    expect(cfg.siteUrl).toBe("https://website-auditor.io");
    expect(cfg.upgradeUrl).toBe("https://website-auditor.io/admin_portal");
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.freeDailyAuditLimit).toBe(3);
    expect(cfg.freeMaxDomains).toBe(1);
    expect(cfg.requestTimeoutMs).toBe(120000);
    expect(cfg.devTier).toBeUndefined();
    // Audit cache TTL mirrors the upstream engine's 24h AI-visibility cache.
    expect(cfg.auditCacheTtlMs).toBe(24 * 60 * 60 * 1000);
  });

  it("reads values from env and strips trailing slashes on URLs", () => {
    const cfg = loadConfig({
      WA_API_BASE_URL: "https://api.example.com/",
      WA_SITE_URL: "https://example.com/",
      WA_API_KEY: "wa_test_key",
      WA_UPGRADE_URL: "https://example.com/upgrade",
      WA_FREE_DAILY_AUDIT_LIMIT: "5",
      WA_FREE_MAX_DOMAINS: "2",
      WA_REQUEST_TIMEOUT_MS: "30000",
      WA_AUDIT_CACHE_TTL_MS: "900000",
    });
    expect(cfg.apiBaseUrl).toBe("https://api.example.com");
    expect(cfg.siteUrl).toBe("https://example.com");
    expect(cfg.apiKey).toBe("wa_test_key");
    expect(cfg.freeDailyAuditLimit).toBe(5);
    expect(cfg.freeMaxDomains).toBe(2);
    expect(cfg.requestTimeoutMs).toBe(30000);
    expect(cfg.auditCacheTtlMs).toBe(900000);
  });

  it("accepts a dev tier override for local testing", () => {
    expect(loadConfig({ WA_DEV_TIER: "pro" }).devTier).toBe("pro");
    expect(loadConfig({ WA_DEV_TIER: "free" }).devTier).toBe("free");
  });

  it("ignores an invalid dev tier", () => {
    expect(loadConfig({ WA_DEV_TIER: "banana" }).devTier).toBeUndefined();
  });
});
