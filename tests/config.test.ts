import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies documented defaults when env is empty", () => {
    const cfg = loadConfig({});
    expect(cfg.apiBaseUrl).toBe("https://api.website-auditor.io");
    expect(cfg.siteUrl).toBe("https://website-auditor.io");
    expect(cfg.upgradeUrl).toBe("https://api.website-auditor.io/admin_portal/");
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.requestTimeoutMs).toBe(120000);
    expect(cfg.devTier).toBeUndefined();
    // Audit cache TTL mirrors the upstream engine's 24h AI-visibility cache.
    expect(cfg.auditCacheTtlMs).toBe(24 * 60 * 60 * 1000);
    // Subscription tier cache: short by default so upgrades/downgrades reflect fast.
    expect(cfg.subscriptionCacheTtlMs).toBe(60 * 1000);
  });

  it("reads values from env and strips trailing slashes on URLs", () => {
    const cfg = loadConfig({
      WA_API_BASE_URL: "https://api.example.com/",
      WA_SITE_URL: "https://example.com/",
      WA_API_KEY: "wa_test_key",
      WA_UPGRADE_URL: "https://example.com/upgrade",
      WA_REQUEST_TIMEOUT_MS: "30000",
      WA_AUDIT_CACHE_TTL_MS: "900000",
      WA_SUBSCRIPTION_CACHE_TTL_MS: "120000",
    });
    expect(cfg.apiBaseUrl).toBe("https://api.example.com");
    expect(cfg.siteUrl).toBe("https://example.com");
    expect(cfg.apiKey).toBe("wa_test_key");
    expect(cfg.requestTimeoutMs).toBe(30000);
    expect(cfg.auditCacheTtlMs).toBe(900000);
    expect(cfg.subscriptionCacheTtlMs).toBe(120000);
  });

  // An unexpanded placeholder means the user configured NOTHING — the client
  // just forwarded its own syntax. Cursor 3.15.19 does exactly this on a
  // first-run plugin install (verified 2026-08-13: the spawned process carried
  // the literal WA_API_KEY=${WA_API_KEY}). Read as a key it is merely
  // malformed, so check_upgrade_status answered "Invalid API key format" to
  // someone who never set a key, instead of the "no key configured, create one
  // at …" onboarding the keyless surface exists to give.
  it("treats an unexpanded client placeholder as no key at all", () => {
    for (const placeholder of [
      "${WA_API_KEY}", // Cursor plugin variables
      "${env:WA_API_KEY}", // VS Code / Cursor mcp.json interpolation
      "${input:apiKey}",
      "{{WA_API_KEY}}", // moustache-style templating
      "$WA_API_KEY", // bare shell-style
    ]) {
      expect(loadConfig({ WA_API_KEY: placeholder }).apiKey, placeholder).toBeUndefined();
    }
  });

  it("never mistakes a real key for a placeholder", () => {
    // The guard must not swallow keys: only self-contained placeholder syntax
    // counts, never a key that merely contains braces or a dollar sign.
    for (const key of ["wa_live_abc123", "wa_${weird}but_real", "wa_$dollar", "{not-a-key"]) {
      expect(loadConfig({ WA_API_KEY: key }).apiKey, key).toBe(key);
    }
  });

  it("accepts a dev tier override for local testing", () => {
    expect(loadConfig({ WA_DEV_TIER: "pro" }).devTier).toBe("pro");
    expect(loadConfig({ WA_DEV_TIER: "free" }).devTier).toBe("free");
  });

  it("ignores an invalid dev tier", () => {
    expect(loadConfig({ WA_DEV_TIER: "banana" }).devTier).toBeUndefined();
  });

  it("enables metrics by default and lets WA_METRICS_DISABLED opt out", () => {
    expect(loadConfig({}).metricsEnabled).toBe(true);
    expect(loadConfig({ WA_METRICS_DISABLED: "1" }).metricsEnabled).toBe(false);
    expect(loadConfig({ WA_METRICS_DISABLED: "true" }).metricsEnabled).toBe(false);
    expect(loadConfig({ WA_METRICS_DISABLED: "0" }).metricsEnabled).toBe(true);
  });
});
