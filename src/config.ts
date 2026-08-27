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
  /**
   * OAuth 2.1 authorization server for the hosted transport, and this server's
   * own canonical resource identifier. BOTH are required before any OAuth
   * surface appears: RFC 9728 metadata must name a `resource` and at least one
   * `authorization_servers` entry, so a half-configured pair could only publish
   * a document that fails discovery. Unset (the default, and every stdio
   * install) means Mixed Auth is off and this server behaves exactly as it did
   * before OAuth existed — see oauthEnabled in auth/oauth.ts.
   */
  oauthIssuer?: string;
  oauthResourceUrl?: string;
  /**
   * The single scope protected tools ask for. Deliberately ONE scope, not a
   * read/write split: ChatGPT's Apps SDK and the MCP authorization spec
   * disagree about mid-session scope escalation, so a tool that discovers it
   * needs a second scope has no reliable way to ask. Requesting the whole
   * capability up front is the honest version of what the consent screen has
   * to say anyway — every Pro tool needs the subscriber's account.
   */
  oauthScope: string;
  /**
   * Every scope this resource's authorization requests use, for the RFC 9728
   * document. A SUPERSET of oauthScope: that one names the audit capability a
   * tool needs, while this also carries the identity scopes ChatGPT requests
   * alongside it. Separate values because a tool needs `audit`, never `openid`.
   */
  oauthScopes: string[];
  /**
   * RFC 7662 introspection endpoint, where an access token is exchanged for the
   * account's API key. Defaults to the API's own path because that is where the
   * authorization server lives for this product; overridable because the issuer
   * and the API need not stay the same host forever.
   */
  oauthIntrospectionUrl?: string;
  /**
   * How this server authenticates ITSELF to that endpoint. RFC 7662 §2.1
   * requires it: an unauthenticated introspection endpoint is a token oracle
   * anyone who can reach it may probe. Sent as a bearer on the introspection
   * call only — it is never a caller-facing credential.
   */
  oauthIntrospectionSecret?: string;
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

function parseUpsellStyle(value: string | undefined): UpsellStyle {
  return value?.trim().toLowerCase() === "info" ? "info" : "link";
}

/**
 * An unexpanded config placeholder is not a value — it is the ABSENCE of one.
 *
 * Clients and deploy templates that support variable substitution (`${X}` in
 * Cursor plugin mcp.json, `${env:…}`/`${input:…}` elsewhere, `${X}` in compose
 * and Cloud Run) pass the placeholder through VERBATIM when nothing was set.
 * Verified in Cursor 3.15.19: a first-run install spawns the server with the
 * literal `WA_API_KEY=${WA_API_KEY}`.
 *
 * The key case is where this was found and is still the sharpest: read as a
 * key, that string is merely malformed, so the user who configured nothing was
 * told their key was invalid — accusatory, and it buried the "create one at …"
 * onboarding behind an error. But the predicate now decides five inputs, one of
 * which (WA_APPS_CHALLENGE_TOKEN) is not a credential at all, so the rule is
 * stated for values generally. See normalizeEnvValue, which is the entry point;
 * nothing should call this directly.
 */
function isUnexpandedPlaceholder(value: string): boolean {
  // Whole-string placeholder syntax only — ${X}, {X}, {{X}}, ${env:X} — plus
  // bare $X. A real key that merely CONTAINS a brace is left alone.
  return /^\$?\{{1,2}[^{}]*\}{1,2}$/.test(value) || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/**
 * The one place a raw configured string becomes a value, or nothing.
 *
 * Named for values rather than keys on purpose: the rule is about how a value
 * ARRIVED, not what it means. Every setting a client or deploy template
 * interpolates can reach us unexpanded, and each one that skipped this grew
 * its own bug — WA_API_KEY over HTTP (an accusatory "Invalid API key format"
 * where stdio gave onboarding), WA_HTTP_DEFAULT_KEY (every anonymous caller on
 * the box acting as a tenant named `${...}`), WA_APPS_CHALLENGE_TOKEN (serving
 * the literal placeholder with a 200, so the verifier reports a token mismatch
 * instead of the 404 that names the real cause). Three instances of one defect
 * is the argument for a single named rule rather than a habit.
 *
 * Deliberately NOT a `wa_` prefix check, for the key case. A value that is
 * present and merely wrong is a different answer from no value at all — the
 * whole four-way 401 split exists to keep those apart — so normalizing a typo
 * to "unset" would tell someone who pasted `wa-123` that they had configured
 * nothing, and strand them one step earlier than the truth. A placeholder is
 * the one string that genuinely IS the absence of a value rather than a bad
 * one.
 */
export function normalizeEnvValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return isUnexpandedPlaceholder(trimmed) ? undefined : trimmed;
}

/**
 * A port from configuration, or a loud failure naming the bad value.
 *
 * Three failure modes, all of which reached production shapes:
 *   * BLANK is not a value. `??` only falls through on null/undefined, so an
 *     empty WA_HTTP_PORT counted as present: parseInt("") is NaN and
 *     listen(NaN) throws ERR_SOCKET_BAD_PORT on boot. .env.example ships the
 *     line as `WA_HTTP_PORT=`, so any compose env_file exported exactly that —
 *     and it also swallowed the PORT Cloud Run injects.
 *   * OUT OF RANGE still crashes. 70000 and -1 parse fine and are finite, and
 *     listen() rejects both the same way, so a plain int parse fixes the blank
 *     case while leaving the crash it was written to prevent.
 *   * SILENTLY WRONG is worse than either. A generic int fallback turns
 *     "havoc" into 8787 and "8080abc" into 8080, so a box behind a proxy comes
 *     up on a port nobody asked for and 502s with nothing in the log; `0.5`
 *     truncates to 0, which binds a random ephemeral port that no health probe
 *     will find.
 *
 * So: absent or blank takes the fallback, anything else must be a real port or
 * the process refuses to start with the offending value quoted. main() already
 * turns a throw into a one-line fatal and exit(1).
 *
 * `name` is the variable the value came from, because the message is read by
 * someone staring at a config file: "Invalid port" quoting a value they can see
 * in two places does not say which one to edit.
 *
 * Digits only, deliberately. Number() accepts 0x1F90 (8080), 0b1111 (15) and
 * 1e4 (10000) — all integers, all in range, none of them what the operator
 * wrote. Silently reinterpreting a port is the exact class the third bullet
 * above says this function exists to stop, and 0b1111 would try a privileged
 * bind.
 */
export function parsePort(raw: string | undefined, fallback: number, name = "port"): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const n = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid ${name} ${JSON.stringify(trimmed)} — expected an integer from 1 to 65535.`);
  }
  return n;
}

// Every env value that can arrive interpolated goes through normalizeEnvValue,
// which is what its docstring already claimed and what only WA_API_KEY actually
// did. The URLs were the live hole: an unexpanded WA_UPGRADE_URL is truthy, so
// it beat the working default and every AUTH_REQUIRED / PRO_REQUIRED /
// INVALID_KEY payload shipped `create a key at ${WA_UPGRADE_URL}` as both prose
// and the structured `upgrade_url` — a dead signup link in exactly the messages
// this whole line of work exists to make followable. tagSource swallows the
// parse failure (`catch { return rawUrl }`), so nothing surfaced it.
export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): WaConfig {
  const apiKey = normalizeEnvValue(env.WA_API_KEY);
  const siteUrl = stripTrailingSlash(normalizeEnvValue(env.WA_SITE_URL) || "https://website-auditor.io");
  return {
    apiBaseUrl: stripTrailingSlash(normalizeEnvValue(env.WA_API_BASE_URL) || "https://api.website-auditor.io"),
    siteUrl,
    apiKey,
    upgradeUrl: normalizeEnvValue(env.WA_UPGRADE_URL) || "https://api.website-auditor.io/admin_portal/",
    upsellStyle: parseUpsellStyle(env.WA_UPSELL_STYLE),
    upsellInfoUrl: stripTrailingSlash(normalizeEnvValue(env.WA_UPSELL_INFO_URL) || "") || siteUrl,
    requestTimeoutMs: parseIntOr(env.WA_REQUEST_TIMEOUT_MS, 120000),
    auditCacheTtlMs: parseIntOr(env.WA_AUDIT_CACHE_TTL_MS, 24 * 60 * 60 * 1000),
    subscriptionCacheTtlMs: parseIntOr(env.WA_SUBSCRIPTION_CACHE_TTL_MS, 60 * 1000),
    devTier: parseTier(env.WA_DEV_TIER?.trim()),
    metricsEnabled: !isTruthy(env.WA_METRICS_DISABLED),
    // Same normalizeEnvValue treatment as every other configured value. An
    // unexpanded issuer is the WA_APPS_CHALLENGE_TOKEN failure again: truthy,
    // so the metadata document publishes `${WA_OAUTH_ISSUER}` with a 200 and
    // the client's discovery fails against a URL nobody can debug, instead of
    // the 404 that says "no OAuth configured".
    oauthIssuer: normalizeEnvValue(env.WA_OAUTH_ISSUER),
    oauthResourceUrl: normalizeEnvValue(env.WA_OAUTH_RESOURCE_URL),
    oauthScope: normalizeEnvValue(env.WA_OAUTH_SCOPE) || "audit",
    // Defaults to the single scope, so an unset value behaves exactly as before.
    // The MCP must never advertise a scope the authorization server lacks — it
    // cannot see the AS's capabilities from here — so this is configured rather
    // than inferred.
    oauthScopes: (normalizeEnvValue(env.WA_OAUTH_SCOPES) || normalizeEnvValue(env.WA_OAUTH_SCOPE) || "audit")
      .split(/\s+/)
      .filter(Boolean),
    oauthIntrospectionUrl:
      normalizeEnvValue(env.WA_OAUTH_INTROSPECTION_URL) ||
      `${stripTrailingSlash(normalizeEnvValue(env.WA_API_BASE_URL) || "https://api.website-auditor.io")}/api/oauth/introspect`,
    oauthIntrospectionSecret: normalizeEnvValue(env.WA_OAUTH_INTROSPECTION_SECRET),
  };
}

/** Truthy-string check for boolean-ish env flags ("1", "true", "yes", "on"). */
function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
