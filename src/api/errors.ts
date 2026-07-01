/**
 * Typed errors thrown by the API client and normalized error codes surfaced by
 * the tools. Codes are stable so agents (and tests) can branch on them.
 */

export type ErrorCode =
  | "AUTH_REQUIRED" // no API key configured — the backend requires one
  | "INVALID_KEY" // key present but rejected by the API (401)
  | "PRO_REQUIRED" // a Pro tool was called without an active subscription
  | "OVER_QUOTA" // free-tier daily/domain cap or API rate limit hit (429)
  | "UNREACHABLE_DOMAIN" // the audited site could not be reached
  | "INVALID_INPUT" // bad domain / missing required argument (400)
  | "UPSTREAM_ERROR" // the API or audit service errored (5xx / network)
  | "TIMEOUT" // the audit did not complete in time (504)
  | "NOT_YET_AVAILABLE"; // endpoint not yet implemented in website-auditor-api

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
