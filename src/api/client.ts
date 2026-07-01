/**
 * Thin HTTP adapter over the REAL website-auditor-api endpoints.
 *
 * Implemented today (maps to a live endpoint):
 *   - runAudit  → GET /api/audit?businessUrl=&businessName=&businessCity=
 *
 * Declared but NOT yet available upstream (PRD open questions). These methods
 * exist so the tools can be wired against the interface and light up the moment
 * the endpoints ship. They throw NOT_YET_AVAILABLE rather than fabricating data:
 *   - getSubscription    → no API-key-authed subscription endpoint exists
 *   - getChanges         → no deltas/history endpoint exists (API-key-authed)
 *   - compareCompetitors → no dedicated comparison endpoint (the compare_competitors
 *                          tool instead fans out real runAudit calls today)
 */
import type { WaConfig } from "../config.js";
import type { AuditReport, Changes, RateLimit } from "./types.js";
import { WaApiError } from "./errors.js";
import { normalizeDomain, deriveBusinessName } from "./domain.js";

export interface AuditParams {
  domain: string;
  /** Optional override; defaults to a name derived from the domain. */
  businessName?: string;
  /** Optional location hint; the upstream audit auto-detects when omitted. */
  businessCity?: string;
}

export interface AuditResponse {
  runId: string;
  report: AuditReport;
  /** Rate-limit state from the response headers, when the API provides it. */
  rateLimit?: RateLimit;
  /** The untouched JSON envelope from the API, for debugging/extension. */
  raw: unknown;
}

export interface GetChangesParams {
  domain: string;
  since?: string;
}

export interface SubscriptionInfo {
  tier: "free" | "pro";
  status: string;
  current_period_end?: string;
  /** Remaining daily audit quota, once the subscription endpoint reports it. */
  quota?: RateLimit;
}

export interface WaApiClientLike {
  runAudit(params: AuditParams): Promise<AuditResponse>;
  getSubscription(): Promise<SubscriptionInfo>;
  /**
   * Best-effort read of the remaining daily audit quota WITHOUT spending an
   * audit. Returns null when it can't be determined (e.g. the subscription
   * endpoint isn't available yet) — callers then learn the remaining quota from
   * `runAudit` response headers instead.
   */
  getRemainingQuota(): Promise<RateLimit | null>;
  getChanges(params: GetChangesParams): Promise<Changes>;
  compareCompetitors(params: { domain: string; competitors: string[] }): Promise<never>;
}

interface ClientDeps {
  fetch?: typeof fetch;
}

/**
 * The upstream `/api/audit` requires a non-empty `businessCity` (naive
 * `if (!businessCity)` validation). The MCP tools only receive a `domain`, and
 * the audit re-detects the real location from the site, so we pass a
 * validation-safe sentinel that does NOT override detection. The upstream
 * treats a whitespace-only value as "no override" (it `.strip()`s it), so a
 * single space satisfies validation without polluting the location.
 *
 * TODO(website-auditor-api): make businessName/businessCity optional so the MCP
 * doesn't need this workaround.
 */
const CITY_SENTINEL = " ";

export class WaApiClient implements WaApiClientLike {
  private readonly cfg: WaConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: WaConfig, deps: ClientDeps = {}) {
    this.cfg = cfg;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  async runAudit(params: AuditParams): Promise<AuditResponse> {
    const host = normalizeDomain(params.domain); // throws INVALID_INPUT

    const url = new URL(`${this.cfg.apiBaseUrl}/api/audit`);
    url.searchParams.set("businessUrl", params.domain);
    url.searchParams.set("businessName", params.businessName?.trim() || deriveBusinessName(host));
    url.searchParams.set("businessCity", params.businessCity?.trim() || CITY_SENTINEL);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cfg.apiKey) headers["X-API-Key"] = this.cfg.apiKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new WaApiError("TIMEOUT", "The audit request timed out.", { details: String(err) });
      }
      throw new WaApiError("UPSTREAM_ERROR", "Could not reach the Website Auditor API.", { details: String(err) });
    } finally {
      clearTimeout(timer);
    }

    const body = await this.parseJson(resp);

    if (!resp.ok) throw this.mapErrorResponse(resp.status, body);

    const runId: string | undefined = (body as { run_id?: string })?.run_id;
    const report = (body as { audit?: AuditReport })?.audit;
    if (!report || !runId) {
      throw new WaApiError("UPSTREAM_ERROR", "The API response did not include an audit report.", { details: body });
    }
    const rateLimit = parseRateLimit(resp.headers);
    return rateLimit ? { runId, report, rateLimit, raw: body } : { runId, report, raw: body };
  }

  // ── Not yet available upstream — see class docstring ──────────────────

  async getSubscription(): Promise<SubscriptionInfo> {
    throw new WaApiError(
      "NOT_YET_AVAILABLE",
      "website-auditor-api does not yet expose an API-key-authed subscription endpoint (PRD open question #1).",
    );
  }

  async getRemainingQuota(): Promise<RateLimit | null> {
    // Prefer a no-audit-cost read from the subscription endpoint. That endpoint
    // isn't available yet, so this returns null today and callers fall back to
    // learning the remaining quota from runAudit's response headers. Any failure
    // to read quota is non-fatal (the audit call is the source of truth).
    try {
      const sub = await this.getSubscription();
      return sub.quota ?? null;
    } catch {
      return null;
    }
  }

  async getChanges(_params: GetChangesParams): Promise<Changes> {
    throw new WaApiError(
      "NOT_YET_AVAILABLE",
      "website-auditor-api does not yet expose an AI-visibility deltas/history endpoint (PRD open question #2).",
    );
  }

  async compareCompetitors(_params: { domain: string; competitors: string[] }): Promise<never> {
    throw new WaApiError(
      "NOT_YET_AVAILABLE",
      "No dedicated comparison endpoint exists; the compare_competitors tool fans out runAudit calls instead.",
    );
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async parseJson(resp: Response): Promise<unknown> {
    try {
      return await resp.json();
    } catch {
      return undefined;
    }
  }

  private mapErrorResponse(status: number, body: unknown): WaApiError {
    const b = (body ?? {}) as { error?: string; details?: unknown; rate_limit?: unknown };
    const message = b.error || `Website Auditor API returned HTTP ${status}.`;
    const upgradeUrl = this.cfg.upgradeUrl;

    switch (status) {
      case 400:
        return new WaApiError("INVALID_INPUT", message, { status, details: b.details });
      case 401:
        return new WaApiError("INVALID_KEY", message, { status, upgradeUrl });
      case 402:
      case 403:
        return new WaApiError("PRO_REQUIRED", message, { status, upgradeUrl });
      case 429:
        return new WaApiError("OVER_QUOTA", message, { status, details: b.rate_limit, upgradeUrl });
      case 504:
        return new WaApiError("TIMEOUT", message, { status });
      default:
        return new WaApiError("UPSTREAM_ERROR", message, { status, details: b.details });
    }
  }
}

function toIntOrNull(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** Parse `X-RateLimit-*` headers, or undefined if none are present. */
export function parseRateLimit(headers: Headers): RateLimit | undefined {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (limit === null && remaining === null && reset === null) return undefined;
  return { limit: toIntOrNull(limit), remaining: toIntOrNull(remaining), reset };
}
