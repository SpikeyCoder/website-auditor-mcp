/**
 * Thin HTTP adapter over the REAL website-auditor-api endpoints.
 *
 * Implemented today (maps to a live endpoint):
 *   - runAudit           → GET  /api/audit?businessUrl=&businessName=&businessCity=
 *   - getSubscription    → GET  /api/subscription           (API-key-authed tier/status)
 *   - getChanges         → GET  /api/ai-visibility-history?domain=&since= (+ computeChanges)
 *   - trackSite          → POST /api/tracked-domains        (enroll for weekly monitoring)
 *   - listTrackedDomains → GET  /api/tracked-domains
 *   - untrackSite        → DELETE /api/tracked-domains
 *   - getBenchmark       → GET  /api/benchmark?domain=&industry=&geo=
 *   - getRecommendations → GET  /api/recommendations?domain=
 *   - generateSchema     → GET  /api/schema?domain=&type=
 *   - getReport          → GET  /api/report?domain=
 *
 * Declared but NOT yet available upstream (PRD open questions). These methods
 * exist so the tools can be wired against the interface and light up the moment
 * the endpoints ship. They throw NOT_YET_AVAILABLE rather than fabricating data:
 *   - compareCompetitors → no dedicated comparison endpoint (the compare_competitors
 *                          tool instead fans out real runAudit calls today)
 */
import type { WaConfig } from "../config.js";
import type {
  AuditReport,
  Changes,
  RateLimit,
  TrackResult,
  TrackedDomainsList,
  UntrackResult,
  MonitoringStatus,
  Benchmark,
  Recommendations,
  SchemaResult,
  ReportLinks,
} from "./types.js";
import { WaApiError } from "./errors.js";
import { computeChanges } from "./mappers.js";
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

export interface TrackSiteParams {
  domain: string;
  /** Fixed 'weekly' in v1 (the only supported cadence). */
  cadence?: "weekly";
}

export interface BenchmarkParams {
  domain: string;
  /** Optional industry override; the endpoint infers it from the site otherwise. */
  industry?: string;
  /** Optional location override; the endpoint infers it from the site otherwise. */
  geo?: string;
}

export interface SchemaParams {
  domain: string;
  /** Schema.org type, or "auto" to let the endpoint pick. */
  type?: "Organization" | "LocalBusiness" | "Product" | "FAQPage" | "auto";
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
  /** Enroll a domain for weekly scheduled monitoring (Pro). */
  trackSite(params: TrackSiteParams): Promise<TrackResult>;
  /** List the caller's tracked domains with cap accounting (Pro). */
  listTrackedDomains(): Promise<TrackedDomainsList>;
  /** Stop monitoring a domain (Pro). Idempotent. */
  untrackSite(params: { domain: string }): Promise<UntrackResult>;
  /** Per-domain monitoring status (latest score, runs, recent change) (Pro). */
  getMonitoringStatus(): Promise<MonitoringStatus>;
  /** Benchmark a domain's AI visibility vs its industry/geo peers (Pro). */
  getBenchmark(params: BenchmarkParams): Promise<Benchmark>;
  /** Prioritized fixes to raise a domain's AI-visibility/audit scores (Pro). */
  getRecommendations(params: { domain: string }): Promise<Recommendations>;
  /** Ready-to-paste JSON-LD structured data for a domain (Pro). */
  generateSchema(params: SchemaParams): Promise<SchemaResult>;
  /** Shareable report URL + embeddable badge snippet for a domain (Pro). */
  getReport(params: { domain: string }): Promise<ReportLinks>;
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

/**
 * Stripe subscription statuses that grant Pro. Mirrors the server's own
 * `ACTIVE_STATUSES` in website-auditor-api (`services/subscriptions.js`) so the
 * MCP and the API agree on who is Pro — active/trialing => pro, else free.
 */
export const ACTIVE_SUBSCRIPTION_STATUSES: readonly string[] = ["active", "trialing"];

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

  /**
   * Read the caller's subscription tier/status from the live, API-key-authed
   * `GET /api/subscription` endpoint (shipped in website-auditor-api PR #7).
   *
   * `tier` is derived from `status`: an active/trialing subscription is Pro,
   * everything else (none / canceled / past_due / …) is free — matching the
   * server's own mapping and the web session path. The real `status` is
   * preserved so callers can tell "never subscribed" (none) from "lapsed"
   * (canceled). A 401 surfaces as INVALID_KEY and a 5xx/network failure as
   * UPSTREAM_ERROR (transient) — the tier resolver relies on that distinction.
   */
  async getSubscription(): Promise<SubscriptionInfo> {
    const url = new URL(`${this.cfg.apiBaseUrl}/api/subscription`);
    const body = (await this.requestJson("GET", url)) as {
      tier?: string;
      status?: string;
      current_period_end?: string | null;
    };

    const status = typeof body.status === "string" && body.status ? body.status : "none";
    const tier: "free" | "pro" = ACTIVE_SUBSCRIPTION_STATUSES.includes(status) ? "pro" : "free";
    const info: SubscriptionInfo = { tier, status };
    if (body.current_period_end) info.current_period_end = body.current_period_end;
    return info;
  }

  async getRemainingQuota(): Promise<RateLimit | null> {
    // `/api/subscription` reports tier/status only — it carries no audit-quota
    // block — so there is no no-audit-cost way to read remaining quota today.
    // Callers learn the remaining quota from runAudit's `X-RateLimit-*` response
    // headers instead (the audit call is the source of truth).
    return null;
  }

  /**
   * Read the domain's AI-visibility history and compute deltas. The snapshots
   * are exactly what the server-side scheduler writes (and what a manual audit
   * writes) into ai_visibility_snapshots, so get_changes reflects the scheduled
   * weekly re-audits — the "value when nobody's watching" loop.
   *
   * Needs at least two snapshots to compute a delta; with fewer it throws
   * NOT_YET_AVAILABLE with a clear message rather than fabricating a change.
   * When `since` is an ISO cursor, the delta spans that window (first vs last in
   * range); otherwise it's the most recent move (previous vs latest).
   */
  async getChanges(params: GetChangesParams): Promise<Changes> {
    const url = new URL(`${this.cfg.apiBaseUrl}/api/ai-visibility-history`);
    url.searchParams.set("domain", params.domain);
    const windowed = Boolean(params.since && params.since !== "last_check");
    if (windowed) url.searchParams.set("since", params.since as string);

    const body = (await this.requestJson("GET", url)) as {
      snapshots?: Array<{ score: number; by_engine: Record<string, number> }>;
      insufficient_history?: boolean;
    };

    const snaps = body.snapshots ?? [];
    if (snaps.length < 2) {
      throw new WaApiError(
        "NOT_YET_AVAILABLE",
        `Not enough AI-visibility history for ${params.domain} yet — at least two snapshots are needed to show what changed. Snapshots accrue as the tracked domain is re-audited weekly (see track_site).`,
      );
    }

    const current = snaps[snaps.length - 1]!;
    // Windowed: compare against the first snapshot in range; otherwise the
    // immediately-previous one.
    const previous = windowed ? snaps[0]! : snaps[snaps.length - 2]!;
    return computeChanges(
      { score: current.score, by_engine: current.by_engine },
      { score: previous.score, by_engine: previous.by_engine },
    );
  }

  async trackSite(params: TrackSiteParams): Promise<TrackResult> {
    const host = normalizeDomain(params.domain); // throws INVALID_INPUT
    const url = new URL(`${this.cfg.apiBaseUrl}/api/tracked-domains`);
    const body = (await this.requestJson("POST", url, {
      domain: host,
      cadence: params.cadence ?? "weekly",
    })) as { created?: boolean; already_tracked?: boolean; tracked?: Partial<TrackResult> & { domain?: string } };

    const tracked = body.tracked ?? {};
    return {
      domain: tracked.domain ?? host,
      cadence: tracked.cadence ?? "weekly",
      active: tracked.active ?? true,
      created: Boolean(body.created),
      already_tracked: Boolean(body.already_tracked),
    };
  }

  async listTrackedDomains(): Promise<TrackedDomainsList> {
    const url = new URL(`${this.cfg.apiBaseUrl}/api/tracked-domains`);
    const body = (await this.requestJson("GET", url)) as Partial<TrackedDomainsList>;
    return {
      limit: body.limit ?? 0,
      used: body.used ?? 0,
      remaining: body.remaining ?? 0,
      tracked: body.tracked ?? [],
    };
  }

  async untrackSite(params: { domain: string }): Promise<UntrackResult> {
    const host = normalizeDomain(params.domain); // throws INVALID_INPUT
    const url = new URL(`${this.cfg.apiBaseUrl}/api/tracked-domains`);
    const body = (await this.requestJson("DELETE", url, { domain: host })) as {
      removed?: boolean;
      limit?: number;
      used?: number;
      remaining?: number;
    };
    const result: UntrackResult = { domain: host, removed: Boolean(body.removed) };
    if (typeof body.limit === "number") result.limit = body.limit;
    if (typeof body.used === "number") result.used = body.used;
    if (typeof body.remaining === "number") result.remaining = body.remaining;
    return result;
  }

  async getMonitoringStatus(): Promise<MonitoringStatus> {
    const url = new URL(`${this.cfg.apiBaseUrl}/api/monitoring-status`);
    const body = (await this.requestJson("GET", url)) as Partial<MonitoringStatus>;
    return {
      limit: body.limit ?? 0,
      used: body.used ?? 0,
      remaining: body.remaining ?? 0,
      sites: body.sites ?? [],
    };
  }

  /**
   * Benchmark a domain against its industry/geo peer set. Wired to
   * `GET /api/benchmark?domain=&industry=&geo=` (website-auditor-api PR #10).
   * Strips the `success` envelope and returns the documented Benchmark shape.
   * Optional industry/geo are only sent when provided (the endpoint infers them
   * from the site otherwise).
   */
  async getBenchmark(params: BenchmarkParams): Promise<Benchmark> {
    const url = new URL(`${this.cfg.apiBaseUrl}/api/benchmark`);
    url.searchParams.set("domain", params.domain);
    if (params.industry?.trim()) url.searchParams.set("industry", params.industry.trim());
    if (params.geo?.trim()) url.searchParams.set("geo", params.geo.trim());

    const body = (await this.requestJson("GET", url)) as Partial<Benchmark>;
    return {
      percentile: num(body.percentile),
      peer_median: num(body.peer_median),
      sample_size: num(body.sample_size),
      position_summary: typeof body.position_summary === "string" ? body.position_summary : "",
    };
  }

  /**
   * Prioritized fixes for a domain. Wired to
   * `GET /api/recommendations?domain=` (website-auditor-api PR #10). Strips the
   * `success` envelope and returns `{ recommendations }`.
   */
  async getRecommendations(params: { domain: string }): Promise<Recommendations> {
    const url = new URL(`${this.cfg.apiBaseUrl}/api/recommendations`);
    url.searchParams.set("domain", params.domain);

    const body = (await this.requestJson("GET", url)) as { recommendations?: Recommendations["recommendations"] };
    return { recommendations: Array.isArray(body.recommendations) ? body.recommendations : [] };
  }

  /**
   * Generate ready-to-paste JSON-LD for a domain. Wired to
   * `GET /api/schema?domain=&type=` (website-auditor-api PR #10). Strips the
   * `success` envelope and returns `{ jsonld, placement_notes }`. `type` is only
   * sent when provided.
   */
  async generateSchema(params: SchemaParams): Promise<SchemaResult> {
    const url = new URL(`${this.cfg.apiBaseUrl}/api/schema`);
    url.searchParams.set("domain", params.domain);
    if (params.type) url.searchParams.set("type", params.type);

    const body = (await this.requestJson("GET", url)) as Partial<SchemaResult>;
    return {
      jsonld: body.jsonld ?? null,
      placement_notes: typeof body.placement_notes === "string" ? body.placement_notes : "",
    };
  }

  /**
   * Shareable report URL + embeddable badge snippet for a domain. Wired to
   * `GET /api/report?domain=` (website-auditor-api PR #10). Strips the `success`
   * envelope and returns `{ report_url, badge_html }`.
   */
  async getReport(params: { domain: string }): Promise<ReportLinks> {
    const url = new URL(`${this.cfg.apiBaseUrl}/api/report`);
    url.searchParams.set("domain", params.domain);

    const body = (await this.requestJson("GET", url)) as Partial<ReportLinks>;
    return {
      report_url: typeof body.report_url === "string" ? body.report_url : "",
      badge_html: typeof body.badge_html === "string" ? body.badge_html : "",
    };
  }

  async compareCompetitors(_params: { domain: string; competitors: string[] }): Promise<never> {
    throw new WaApiError(
      "NOT_YET_AVAILABLE",
      "No dedicated comparison endpoint exists; the compare_competitors tool fans out runAudit calls instead.",
    );
  }

  // ── internals ─────────────────────────────────────────────────────────

  /**
   * Authenticated JSON request with the same timeout/abort + error-mapping
   * contract as runAudit, for the simpler JSON endpoints (history + tracking).
   * Sends the X-API-Key header, applies the configured timeout, maps non-2xx to
   * a WaApiError, and returns the parsed body.
   */
  private async requestJson(method: string, url: URL, jsonBody?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cfg.apiKey) headers["X-API-Key"] = this.cfg.apiKey;
    if (jsonBody !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method,
        headers,
        body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new WaApiError("TIMEOUT", "The request to the Website Auditor API timed out.", { details: String(err) });
      }
      throw new WaApiError("UPSTREAM_ERROR", "Could not reach the Website Auditor API.", { details: String(err) });
    } finally {
      clearTimeout(timer);
    }

    const body = await this.parseJson(resp);
    if (!resp.ok) throw this.mapErrorResponse(resp.status, body);
    return body ?? {};
  }

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
      case 409:
        // Cap reached. The caller is already Pro, so this is not an upgrade
        // prompt — the fix is to untrack a domain, surfaced in the message.
        return new WaApiError("LIMIT_REACHED", message, { status });
      case 429:
        return new WaApiError("OVER_QUOTA", message, { status, details: b.rate_limit, upgradeUrl });
      case 504:
        return new WaApiError("TIMEOUT", message, { status });
      default:
        return new WaApiError("UPSTREAM_ERROR", message, { status, details: b.details });
    }
  }
}

/** Coerce a value to a finite number, defaulting to 0 (used for numeric fields). */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
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
