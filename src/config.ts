/**
 * Configuration for the Website Auditor MCP server.
 *
 * All values come from environment variables (set in the MCP client's server
 * config). See `.env.example` for the full list. The MCP is a thin wrapper over
 * the SpikeyCoder/website-auditor-api service, so the important knobs are the
 * API base URL and the per-user API key.
 */

export type Tier = "none" | "free" | "pro";

export interface WaConfig {
  /** Base URL of the website-auditor-api portal (the service we wrap). */
  apiBaseUrl: string;
  /** Base URL of website-auditor.io, used to build shareable report links. */
  siteUrl: string;
  /** Per-user API key (starts with `wa_`). Undefined ⇒ unauthenticated. */
  apiKey?: string;
  /** Where callers are sent to subscribe/upgrade. Surfaced in error payloads. */
  upgradeUrl: string;
  /** Free-tier: max audits per key per UTC day (MCP-side abuse guard). */
  freeDailyAuditLimit: number;
  /** Free-tier: max distinct domains per key. */
  freeMaxDomains: number;
  /** Timeout (ms) for calls to the API portal. */
  requestTimeoutMs: number;
  /**
   * TTL (ms) for the audit cache. A domain audited within this window is reused
   * instead of spending a fresh audit against the daily quota. Defaults to 24h
   * to mirror the upstream engine's own AI-visibility cache.
   */
  auditCacheTtlMs: number;
  /**
   * Optional local-dev/testing override for the resolved tier. There is not yet
   * an API-key-authed subscription endpoint in website-auditor-api (PRD open
   * question #1), so this lets you exercise Pro paths locally. Ignored in the
   * absence of an API key.
   */
  devTier?: Tier;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseTier(value: string | undefined): Tier | undefined {
  return value === "free" || value === "pro" || value === "none" ? value : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): WaConfig {
  const apiKey = env.WA_API_KEY?.trim();
  return {
    apiBaseUrl: stripTrailingSlash(env.WA_API_BASE_URL?.trim() || "https://api.website-auditor.io"),
    siteUrl: stripTrailingSlash(env.WA_SITE_URL?.trim() || "https://website-auditor.io"),
    apiKey: apiKey ? apiKey : undefined,
    upgradeUrl: env.WA_UPGRADE_URL?.trim() || "https://website-auditor.io/admin_portal",
    freeDailyAuditLimit: parseIntOr(env.WA_FREE_DAILY_AUDIT_LIMIT, 3),
    freeMaxDomains: parseIntOr(env.WA_FREE_MAX_DOMAINS, 1),
    requestTimeoutMs: parseIntOr(env.WA_REQUEST_TIMEOUT_MS, 120000),
    auditCacheTtlMs: parseIntOr(env.WA_AUDIT_CACHE_TTL_MS, 24 * 60 * 60 * 1000),
    devTier: parseTier(env.WA_DEV_TIER?.trim()),
  };
}
