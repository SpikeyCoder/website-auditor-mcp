/**
 * Configuration for the Website Auditor MCP server.
 *
 * All values come from environment variables (set in the MCP client's server
 * config). See `.env.example` for the full list. The MCP is a thin wrapper over
 * the SpikeyCoder/website-auditor-api service, so the important knobs are the
 * API base URL and the per-user API key.
 */

// "invalid" is a resolved state, not a tier the user can hold: the key was
// definitively rejected (revoked/unknown). Kept distinct from "free" so the Pro
// gate can tell a paying customer to replace their key instead of telling them
// to buy a subscription they already have.
export type Tier = "none" | "free" | "pro" | "invalid";

/**
 * How auth/upgrade surfaces talk about the paid plan.
 *
 *   "link" — the default, and the behavior every existing install has: errors
 *            and instructions carry the sign-up/portal link (WA_UPGRADE_URL).
 *   "info" — for deployments under marketplace rules that forbid checkout
 *            links (the OpenAI plugin directory prohibits "direct checkout
 *            links or transactional pages" while allowing plans to be
 *            explained): price and trial terms are still stated, but every
 *            link points at the informational `upsellInfoUrl` instead — and
 *            checkout links the API itself returns are replaced too.
 */
export type UpsellStyle = "link" | "info";

export interface WaConfig {
  /** Base URL of the website-auditor-api portal (the service we wrap). */
  apiBaseUrl: string;
  /** Base URL of website-auditor.io, used to build shareable report links. */
  siteUrl: string;
  /** Per-user API key (starts with `wa_`). Undefined ⇒ unauthenticated. */
  apiKey?: string;
  /** Where callers are sent to subscribe/upgrade. Surfaced in error payloads. */
  upgradeUrl: string;
  /** See UpsellStyle. Default "link". */
  upsellStyle: UpsellStyle;
  /**
   * The informational page "info"-style deployments link to instead of the
   * portal. Defaults to the site homepage; never defaults to `upgradeUrl` —
   * that default is the checkout the style exists to avoid.
   */
  upsellInfoUrl: string;
  /** Timeout (ms) for calls to the API portal. */
  requestTimeoutMs: number;
  /**
   * TTL (ms) for the audit cache. A domain audited within this window is reused
   * instead of spending a fresh audit against the daily quota. Defaults to 24h
   * to mirror the upstream engine's own AI-visibility cache.
   */
  auditCacheTtlMs: number;
  /**
   * TTL (ms) for the per-key subscription-tier cache. The tier is resolved from
   * the live `GET /api/subscription` endpoint and cached for this window so a
   * tier lookup isn't a round-trip on every tool call, while still reflecting
   * upgrades/downgrades reasonably fast. Defaults to 60s.
   */
  subscriptionCacheTtlMs: number;
  /**
   * EXPLICIT local-dev/testing override for the resolved tier. This is NOT the
   * default path: tier is normally resolved from the live subscription endpoint
   * (see `subscriptionCacheTtlMs`). Set `WA_DEV_TIER=pro`/`free` only to exercise
   * a tier locally without a real subscription. Ignored when no API key is set.
   */
  devTier?: Tier;
  /**
   * Emit P0 success-metric telemetry (session_init + tool_call) to the API
   * portal's /api/mcp-events endpoint. On by default; set WA_METRICS_DISABLED=1
   * to opt out (emission is always fire-and-forget and never blocks a tool call
   * either way).
   */
  metricsEnabled: boolean;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseTier(value: string | undefined): Tier | undefined {
  return value === "free" || value === "pro" || value === "none" ? value : undefined;
}

function parseUpsellStyle(value: string | undefined): UpsellStyle {
  return value?.trim().toLowerCase() === "info" ? "info" : "link";
}

/**
 * An unexpanded config placeholder is not a key — it is the ABSENCE of one.
 *
 * Clients that support variable substitution (`${WA_API_KEY}` in Cursor plugin
 * mcp.json, `${env:…}`/`${input:…}` elsewhere) pass the placeholder through
 * VERBATIM when the user has not set a value. Verified in Cursor 3.15.19:
 * a first-run install spawns the server with the literal `WA_API_KEY=${WA_API_KEY}`.
 *
 * Read as a key, that string is merely malformed, so the user who configured
 * nothing was told their key was invalid — accusatory, and it buried the
 * "create one at …" onboarding behind an error. Treating it as unset restores
 * the keyless surface these installs are supposed to land on.
 */
function isUnexpandedPlaceholder(value: string): boolean {
  // Whole-string placeholder syntax only — ${X}, {X}, {{X}}, ${env:X} — plus
  // bare $X. A real key that merely CONTAINS a brace is left alone.
  return /^\$?\{{1,2}[^{}]*\}{1,2}$/.test(value) || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/**
 * The one place a raw string becomes a key, or nothing.
 *
 * Both entry points take the key from somewhere untrusted — stdio from
 * WA_API_KEY at startup, hosted from a per-request Authorization/X-API-Key
 * header — and both have to answer "is this a key?" the same way. Until this
 * existed only stdio applied the placeholder rule above, so the SAME broken
 * client config landed on the keyless onboarding surface over stdio and on
 * "Invalid API key format. Keys start with wa_." over HTTP.
 *
 * Deliberately NOT a `wa_` prefix check. A key that is present and merely
 * wrong is a different answer from no key at all — the whole four-way 401
 * split exists to keep those apart — so normalizing a typo to "unset" would
 * tell someone who pasted `wa-123` that they had configured nothing, and
 * strand them one step earlier than the truth. A placeholder is the one
 * string that genuinely IS the absence of a value rather than a bad one.
 */
export function normalizeApiKey(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return isUnexpandedPlaceholder(trimmed) ? undefined : trimmed;
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): WaConfig {
  const apiKey = normalizeApiKey(env.WA_API_KEY);
  const siteUrl = stripTrailingSlash(env.WA_SITE_URL?.trim() || "https://website-auditor.io");
  return {
    apiBaseUrl: stripTrailingSlash(env.WA_API_BASE_URL?.trim() || "https://api.website-auditor.io"),
    siteUrl,
    apiKey,
    upgradeUrl: env.WA_UPGRADE_URL?.trim() || "https://api.website-auditor.io/admin_portal/",
    upsellStyle: parseUpsellStyle(env.WA_UPSELL_STYLE),
    upsellInfoUrl: stripTrailingSlash(env.WA_UPSELL_INFO_URL?.trim() || "") || siteUrl,
    requestTimeoutMs: parseIntOr(env.WA_REQUEST_TIMEOUT_MS, 120000),
    auditCacheTtlMs: parseIntOr(env.WA_AUDIT_CACHE_TTL_MS, 24 * 60 * 60 * 1000),
    subscriptionCacheTtlMs: parseIntOr(env.WA_SUBSCRIPTION_CACHE_TTL_MS, 60 * 1000),
    devTier: parseTier(env.WA_DEV_TIER?.trim()),
    metricsEnabled: !isTruthy(env.WA_METRICS_DISABLED),
  };
}

/** Truthy-string check for boolean-ish env flags ("1", "true", "yes", "on"). */
function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
