/**
 * Typed errors thrown by the API client and normalized error codes surfaced by
 * the tools. Codes are stable so agents (and tests) can branch on them.
 */

export type ErrorCode =
  | "AUTH_REQUIRED" // no API key configured — the backend requires one
  | "INVALID_KEY" // key present and rejected by the API (401) — unknown or revoked
  | "MALFORMED_KEY" // key present but not a Website Auditor key at all (no `wa_` prefix)
  | "UNKNOWN_KEY" // well-formed key the API has no record of
  | "REVOKED_KEY" // a key that existed and was turned off — the one that means lost access
  | "PRO_REQUIRED" // a Pro tool was called without an active subscription
  | "SUBSCRIPTION_UNVERIFIED" // couldn't confirm subscription state (outage) — retryable, NOT a downgrade
  | "OVER_QUOTA" // shared daily audit cap hit (429) — every subscriber has it; not a plan boundary
  | "LIMIT_REACHED" // tracked-domain cap reached (5 domains) — untrack one first (409)
  | "UNREACHABLE_DOMAIN" // the audited site could not be reached
  | "INVALID_INPUT" // bad domain / missing required argument (400)
  | "UPSTREAM_ERROR" // the API or audit service errored (5xx / network)
  | "TIMEOUT" // the audit did not complete in time (504)
  | "NOT_YET_AVAILABLE"; // endpoint not yet implemented in website-auditor-api

/**
 * The codes that all mean "your key did not get you in".
 *
 * They exist as four because the causes want four different reactions, but
 * every consumer that asks "was this an auth failure?" must treat them as one.
 * Adding a code without adding it here is the failure mode this type exists to
 * prevent: entitlements would read a revoked key as a transient outage and
 * answer "try again in a moment", which is the 1.0.8 bug in a new costume.
 */
export type KeyRejectionCode = "INVALID_KEY" | "MALFORMED_KEY" | "UNKNOWN_KEY" | "REVOKED_KEY";

const KEY_REJECTION_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "INVALID_KEY",
  "MALFORMED_KEY",
  "UNKNOWN_KEY",
  "REVOKED_KEY",
]);

/** True when `code` is any of the ways a key can fail to authenticate. */
export function isKeyRejection(code: ErrorCode): code is KeyRejectionCode {
  return KEY_REJECTION_CODES.has(code);
}

/**
 * `reason` from a 401 body (website-auditor-api PR #44) → our code.
 *
 * Absent or unrecognised falls back to INVALID_KEY, which is what every 401
 * mapped to before the field existed. That fallback is load-bearing, not
 * defensive: this ships before the API does, and it must also survive the API
 * adding a fifth reason later.
 *
 * `missing_key` is deliberately absent. Nothing here calls the API without a
 * key — resolve() and check_upgrade_status both answer that case locally — so
 * the API can never report it to us, and inventing a mapping would imply a
 * path that does not exist.
 */
const REASON_TO_CODE: Readonly<Record<string, KeyRejectionCode>> = {
  malformed_key: "MALFORMED_KEY",
  unknown_key: "UNKNOWN_KEY",
  revoked_key: "REVOKED_KEY",
};

export function keyRejectionFromReason(reason: unknown): KeyRejectionCode {
  return (typeof reason === "string" && REASON_TO_CODE[reason]) || "INVALID_KEY";
}

export interface WaApiErrorOpts {
  status?: number;
  details?: unknown;
  upgradeUrl?: string;
}

/** Error thrown by {@link WaApiClient}. Carries a normalized {@link ErrorCode}. */
export class WaApiError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly details?: unknown;
  readonly upgradeUrl?: string;

  constructor(code: ErrorCode, message: string, opts: WaApiErrorOpts = {}) {
    super(message);
    this.name = "WaApiError";
    this.code = code;
    this.status = opts.status;
    this.details = opts.details;
    this.upgradeUrl = opts.upgradeUrl;
  }
}
