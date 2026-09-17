/**
 * Thin HTTP adapter over the REAL website-auditor-api endpoints.
 *
 * Implemented today (maps to a live endpoint):
 *   - runAudit           → GET  /api/audit?businessUrl=&businessName=&businessCity=
 *   - getSubscription    → GET  /api/subscription           (API-key-authed tier/status)
 *   - getChanges         → GET  /api/ai-visibility-history?domain= (+ computeChanges)
 *                          the whole history: `since` is applied here, not sent
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
  AiVisibilitySnapshot,
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
  GtmChatMessage,
  GtmPlanPhase,
  GtmPlanResponse,
  GtmPlanSection,
} from "./types.js";
import { WaApiError, keyRejectionFromReason } from "./errors.js";
import { versionHeader } from "../version.js";
import {
  computeChanges, day, laterNote, measuredTheBusiness, movement, newestComparablePair, newestRecorded, unmeasuredNote,
  newestSameQuestion, notCompared, notComparedPhrase, oldestSameQuestion, questionDifference, seriesOf, toQuestion,
} from "./mappers.js";
import { normalizeDomain } from "./domain.js";

export interface AuditParams {
  domain: string;
  /** Optional. Omitted, the engine identifies the business; supplied, the engine takes it as the answer. */
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
  /** True when the subscription is set to end (not renew) at the period end. */
  cancel_at_period_end?: boolean;
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
  /**
   * Raw AI-visibility snapshot series for a domain (Pro endpoint), oldest
   * first. Unlike getChanges this does NOT collapse to a single delta or throw
   * on short history — trend logic decides what enough data means.
   */
  getAiVisibilityHistory(params: { domain: string; since?: string }): Promise<AiVisibilitySnapshot[]>;
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
  /**
   * Written growth plan grounded in the domain's citation evidence (Pro).
   * POST /api/growth-plan with {domain, messages}; the proxy resolves the
   * caller's latest run for the domain server-side.
   */
  getGtmPlan(params: { domain: string; messages: GtmChatMessage[] }): Promise<GtmPlanResponse>;
}

interface ClientDeps {
  fetch?: typeof fetch;
}

// getGtmPlan only — see the note at its call site.
const GROWTH_PLAN_TIMEOUT_MS = 270_000;

/**
 * The TODO here is done: api PR #42 makes businessName/businessCity optional
 * and normalises a blank to absent, so the workaround is gone.
 *
 * WHAT IT USED TO DO, AND WHY IT HAD TO GO. The old upstream check was a naive
 * `if (!businessCity)`, so this client sent `" "` to satisfy it and a name
 * derived from the host (`deriveBusinessName`, since deleted) for the name.
 * Both were actively harmful:
 *
 *   * A supplied business_name OVERRIDES detection upstream and is stamped
 *     `user_supplied` — the most trusted provenance there is — so a hostname
 *     slug like "Hawaiibackroad" was scored and reported as though a human had
 *     confirmed it, and chaos_tester #334's name_warning could never fire.
 *   * The `" "` sentinel is the exact value that put a Hawaii tour company in
 *     Council Bluffs, and after the 2026-08-01 hardening it became a
 *     guaranteed 400.
 *
 * Absent now means absent: the parameter is not sent at all, so the engine
 * detects the business and labels what it found. Sending "" would be the same
 * bug wearing a different value.
 */
function setIfProvided(url: URL, key: string, value: string | undefined): void {
  const trimmed = (value ?? "").trim();
  if (trimmed) url.searchParams.set(key, trimmed);
}

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
    setIfProvided(url, "businessName", params.businessName);
    setIfProvided(url, "businessCity", params.businessCity);

    const headers: Record<string, string> = { Accept: "application/json", ...versionHeader() };
    if (this.cfg.apiKey) headers["X-API-Key"] = this.cfg.apiKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    const startedAt = Date.now();

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

    if (!resp.ok) throw this.mapErrorResponse(resp.status, body, Date.now() - startedAt);

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
      cancel_at_period_end?: boolean;
    };

    const status = typeof body.status === "string" && body.status ? body.status : "none";
    const tier: "free" | "pro" = ACTIVE_SUBSCRIPTION_STATUSES.includes(status) ? "pro" : "free";
    const info: SubscriptionInfo = { tier, status };
    if (body.current_period_end) info.current_period_end = body.current_period_end;
    if (typeof body.cancel_at_period_end === "boolean") {
      info.cancel_at_period_end = body.cancel_at_period_end;
    }
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
   * Read the domain's AI-visibility history and report its latest like-for-like
   * change. The snapshots are exactly what the server-side scheduler writes (and
   * what a manual audit or an extension scan writes) into
   * ai_visibility_snapshots, so get_changes reflects the scheduled weekly
   * re-audits — the "value when nobody's watching" loop.
   *
   * ONLY BETWEEN SNAPSHOTS THAT ASKED THE SAME QUESTION (sameQuestion in
   * mappers.ts), over the domain's series (seriesOf). Without a `since` cursor
   * the series' latest snapshot is compared with the most recent earlier one
   * that asked what it asked, passing over any that asked something else; with
   * one, with the earliest such snapshot captured since then. The result names
   * both dates and says what was passed over or left out.
   *
   * It throws NOT_YET_AVAILABLE with a clear message rather than fabricating a
   * change when there is nothing like for like to compare: fewer than two
   * measured snapshots; a weekly series that is one measured re-audit, the
   * oldest measured snapshot, with every newer one asking something else or
   * recording nothing; nothing in the series since `since`; a latest snapshot
   * that does not record what it asked; or no earlier snapshot that asked its
   * question, reported as a re-baseline with the date and what changed, or, with
   * `since`, as nothing like for like for it in the window. Each says what it is
   * about, the series or the latest's question. The last two, which carry a
   * `reason`, also give the weekly series' most recent like-for-like change
   * before the latest, failing that the most recent among all earlier
   * snapshots; and a refusal that leaves newer snapshots out of the series names
   * the most recent like-for-like change among them. A `since` that does not
   * parse is INVALID_INPUT.
   *
   * The result's note and every refusal also name the weekly re-audits newer
   * than the series' latest that measured nothing of the business, whether or
   * not they stored a score (unmeasuredNote): no comparison uses them, and
   * unnamed, an older change reads as current. With fewer than two measured
   * snapshots there is no series, and the refusal names those newer than the
   * newest measured snapshot, or every one when there is none.
   */
  async getChanges(params: GetChangesParams): Promise<Changes> {
    const since = params.since && params.since !== "last_check" ? params.since : undefined;
    if (since !== undefined && Number.isNaN(Date.parse(since))) {
      throw new WaApiError("INVALID_INPUT", 'since must be an ISO-8601 date or timestamp, or "last_check".');
    }
    // THE WHOLE HISTORY, with the window applied below. Which snapshots form the
    // series depends on weekly re-audits older than any window, and a history
    // the API had already cut to the window built a different series from the
    // one /api/monitoring-status reads.
    //
    // ONE READ, TWO LISTS. What is compared is the trend's rows: a row with no
    // usable score poisons a delta. Subtracting an absent score yields NaN, which
    // JSON.stringify writes as `null` in the text content and which fails the
    // declared output schema outright, so a successful call came back as an error
    // naming neither. What is named is every weekly re-audit that measured
    // nothing, scored or not: a declined page, an invented name scoring 0 and a
    // run no engine answered store no score, and dropped with the other unscored
    // rows, they went unnamed and an older change read as current.
    const history = await this.historyRows({ domain: params.domain });
    const snaps = history.filter(scored);
    const unmeasuredRuns = history.filter((s) => !measuredTheBusiness(s));
    return changesInHistory(params.domain, snaps, unmeasuredRuns, since);
  }

  async getAiVisibilityHistory(params: { domain: string; since?: string }): Promise<AiVisibilitySnapshot[]> {
    // Only the rows with a usable score, rather than invented zeros that would
    // poison deltas.
    return (await this.historyRows(params)).filter(scored);
  }

  /**
   * The history endpoint's rows, oldest first as the server returns them, read
   * defensively: a row without a timestamp, a null row among them, is dropped,
   * and a row without a usable score is kept with a null one.
   * getAiVisibilityHistory keeps the scored rows; getChanges compares only
   * those. Of the weekly re-audits among all the rows that measured nothing of
   * the business, scored or not, it names only those newer than the series'
   * latest (with fewer than two measured snapshots, those newer than the newest
   * measured snapshot, or every one when there is none). One older than the
   * series' latest goes unnamed: a weekly 50, then a weekly re-audit that
   * measured nothing, then a weekly 55, is up 5 with no note.
   */
  private async historyRows(params: { domain: string; since?: string }): Promise<HistoryRow[]> {
    const url = new URL(`${this.cfg.apiBaseUrl}/api/ai-visibility-history`);
    url.searchParams.set("domain", params.domain);
    if (params.since) url.searchParams.set("since", params.since);

    type WireSnapshot = {
      captured_at?: string;
      run_id?: unknown;
      score?: number | null;
      by_engine?: Record<string, number | null> | null;
      is_simulated?: boolean | null;
      source?: unknown;
      question?: unknown;
    };
    const body = (await this.requestJson("GET", url)) as { snapshots?: Array<WireSnapshot | null> };

    return (body.snapshots ?? [])
      .filter((s): s is WireSnapshot & { captured_at: string } => typeof s?.captured_at === "string")
      .map((s) => ({
        captured_at: s.captured_at,
        // Which audit wrote it: how the trend finds the audit it sits under.
        run_id: typeof s.run_id === "string" ? s.run_id : null,
        score: typeof s.score === "number" ? s.score : null,
        by_engine: Object.fromEntries(
          Object.entries(s.by_engine ?? {}).filter(([, v]) => typeof v === "number"),
        ) as Record<string, number>,
        is_simulated: s.is_simulated === true,
        source: typeof s.source === "string" ? s.source : null,
        // Absent from an API that predates it, and then null: no key, so the
        // snapshot compares with nothing rather than with everything.
        question: toQuestion(s.question),
      }));
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

  /**
   * Written growth plan for the caller's latest run of `domain`. Wired to
   * `POST /api/growth-plan` (website-auditor-api routes/chat.js, PR #84).
   * Strips the `success` envelope and coerces defensively like every method
   * here.
   *
   * WHY THE NEW NAME. The plan answers to two paths off ONE mount config —
   * same engine path, same 5/day counter, same charge point — and
   * `/api/growth-plan` is the one the proxy asks callers to build against.
   * `/api/gtm-plan` is kept alive only for MCP builds already installed on
   * somebody else's upgrade schedule, and it is retired once the request
   * log shows no supported build still calling it. A shipping client that
   * stays on the alias is the traffic keeping it mounted.
   *
   * The two names differ in exactly one byte of the envelope: the quota
   * block is named for the path you called. That is why mapErrorResponse
   * reads `growth_plan_limit` as well — moving the path without moving that
   * read leaves every spent-allowance 429 on this route saying "blocked"
   * with no "until when".
   */
  async getGtmPlan(params: { domain: string; messages: GtmChatMessage[] }): Promise<GtmPlanResponse> {
    // Normalized here too, like runAudit/trackSite: the proxy's bare-host
    // regex refuses the URL forms this client's own convention accepts.
    const host = normalizeDomain(params.domain);
    const url = new URL(`${this.cfg.apiBaseUrl}/api/growth-plan`);
    // The plan's own clock, ABOVE the whole serving chain (engine <= 240s,
    // Node proxy <= 260s as of api PR #84 — it was 250s, and the extra 10s
    // buys the proxy a transfer window under a Supabase brownout): each
    // layer waits longer than the one inside it, so the inner verdict always
    // arrives first. That margin is now 10s, not 20s, so this number cannot
    // come down without checking the proxy's. The shared 120s default
    // sat BELOW the chain — a 120-240s plan aborted here as TIMEOUT while
    // the proxy charged the slot and the engine billed a deliverable
    // nobody received. max() keeps a caller-raised global override.
    const body = (await this.requestJson(
      "POST",
      url,
      {
        // EXACTLY ONE handle, and this is it. The proxy refuses a body
        // carrying both run_id and domain, and an MCP caller holds no
        // run_id: run_audit hands back report_url, which carries reports.id
        // — a disjoint id space. `domain` resolves the caller's latest run
        // from their own snapshot ledger, server-side.
        domain: host,
        messages: params.messages,
      },
      {
        timeoutMs: Math.max(GROWTH_PLAN_TIMEOUT_MS, this.cfg.requestTimeoutMs),
        // A plan is minutes-long BY DESIGN, so the elapsed-time heuristic
        // that reads a late 502 as an infrastructure timeout would relabel
        // every charged provider failure on this route.
        gatewayTimeoutFloor: false,
      },
    )) as Partial<GtmPlanResponse>;
    const plan: GtmPlanResponse = {
      plan_markdown: typeof body.plan_markdown === "string" ? body.plan_markdown : "",
      plan_sections: Array.isArray(body.plan_sections) ? (body.plan_sections as GtmPlanSection[]) : [],
      sources_used: Array.isArray(body.sources_used) ? body.sources_used.filter((s): s is string => typeof s === "string") : [],
      model: typeof body.model === "string" ? body.model : "",
    };
    // ASSIGNED ONLY WHEN THE WIRE CARRIES ONE, which is the opposite of the
    // coerce-to-a-default treatment every sibling field above gets (each by
    // its own idiom, but all of them landing on a value) — and deliberately
    // so. `[]` is a
    // real answer from a current engine ("this plan took no card shape, use
    // the prose"); absent is an older engine that never tried. Defaulting
    // absent to `[]` would report the first where the second happened, and
    // the phase cards are what the caller falls back FROM. Contents are
    // relayed unedited: a field the plan did not write is null on the wire
    // by design, and filling it in here would invent an effort estimate or a
    // priority no model produced.
    if (Array.isArray(body.plan_phases)) plan.plan_phases = body.plan_phases as GtmPlanPhase[];
    return plan;
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
  private async requestJson(
    method: string,
    url: URL,
    jsonBody?: unknown,
    opts: { timeoutMs?: number; gatewayTimeoutFloor?: boolean } = {},
  ): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? this.cfg.requestTimeoutMs;
    const headers: Record<string, string> = { Accept: "application/json", ...versionHeader() };
    if (this.cfg.apiKey) headers["X-API-Key"] = this.cfg.apiKey;
    if (jsonBody !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

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
    if (!resp.ok) {
      throw this.mapErrorResponse(resp.status, body, Date.now() - startedAt, opts.gatewayTimeoutFloor !== false);
    }
    return body ?? {};
  }

  private async parseJson(resp: Response): Promise<unknown> {
    try {
      return await resp.json();
    } catch {
      return undefined;
    }
  }

  /**
   * A 502/503 arriving after this long is a timeout, not a dead backend.
   *
   * mcp_events recorded three failures at 60945/61121/60629 ms, all classified
   * UPSTREAM_ERROR and all suspiciously exactly 60s — an infrastructure timeout
   * between the API and the audit engine. They could not have been client
   * aborts (requestTimeoutMs is 120000, and an abort maps to TIMEOUT above), so
   * they arrived as a gateway 5xx and fell through `default:`.
   *
   * The status alone cannot separate the two cases: a FAST 502 means the
   * service really is down, and telling that user to "wait for the timeout"
   * sends them to wait for something that will never finish. Only elapsed time
   * distinguishes them, hence the floor. 30s is well past any healthy response
   * (audit p50 is ~77s end-to-end but the API answers long before that) and
   * well short of the 60s boundary actually observed.
   */
  private static readonly GATEWAY_TIMEOUT_FLOOR_MS = 30_000;

  private mapErrorResponse(
    status: number,
    body: unknown,
    elapsedMs = 0,
    gatewayTimeoutFloor = true,
  ): WaApiError {
    const b = (body ?? {}) as {
      error?: string;
      details?: unknown;
      rate_limit?: unknown;
      /** The GTM routes name their quota block after the route. */
      growth_plan_limit?: unknown;
      gtm_plan_limit?: unknown;
      gtm_chat_limit?: unknown;
      /** Why a 401 happened, machine-readable (website-auditor-api PR #44). */
      reason?: unknown;
    };
    const message = b.error || `Website Auditor API returned HTTP ${status}.`;
    const upgradeUrl = this.cfg.upgradeUrl;

    switch (status) {
      case 400:
        return new WaApiError("INVALID_INPUT", message, { status, details: b.details });
      case 401:
        // The API states the cause in `reason`; `message` says the same thing
        // in prose and stays the text the user reads. Before the field existed
        // the only ways to tell a revoked key from a mistyped one were parsing
        // that prose or timing the response — a bad prefix is rejected before
        // the database is touched, so it returns in ~1ms against ~200ms for a
        // real lookup. keyRejectionFromReason falls back to INVALID_KEY, which
        // is what this line did unconditionally until now.
        return new WaApiError(keyRejectionFromReason(b.reason), message, { status, upgradeUrl });
      case 402:
      case 403:
        return new WaApiError("PRO_REQUIRED", message, { status, upgradeUrl });
      case 409:
        // Cap reached. The caller is already Pro, so this is not an upgrade
        // prompt — the fix is to untrack a domain, surfaced in the message.
        return new WaApiError("LIMIT_REACHED", message, { status });
      case 429: {
        // Same reasoning as the 409 above, one status code along. This is the
        // server's shared daily audit cap (rateLimitPerDay), not a plan
        // boundary — and since website-auditor-api PR #17 removed the free API
        // tier, only an existing subscriber can reach it at all. Offering them
        // an upgrade offers the plan they already pay for.
        //
        // With the upsell gone, the reset time is the whole remedy, so it goes
        // in the MESSAGE as well as in details. details serves callers that
        // track quota programmatically (compare_competitors); the message is
        // what a client actually shows the customer, and the API's own text
        // stops at "you can make N requests per day" — blocked, with no "until
        // when". Left in details alone it is a fact nobody reads out.
        // The GTM routes name the block after the route, so reading
        // rate_limit alone dropped the whole remedy there: the caller was
        // told "blocked" with no "until when".
        //
        // growth_plan_limit is what THIS client can actually receive: the
        // limit block is named for the path called, and this client calls
        // only /api/growth-plan. Adding it is not defensive — without it the
        // move to the new path silently reintroduces the very gap
        // gtm_plan_limit was added to close, on the same route.
        //
        // The other two are the API's remaining quota-block names, kept for
        // the same reason gtm_chat_limit has always been here: this mapper is
        // shared by every endpoint, and it lists what the API can send rather
        // than what today's call sites happen to reach. (Neither is reachable
        // from this client now — nothing here POSTs /api/gtm-plan or
        // /api/gtm-chat — and that is not an argument about already-installed
        // builds, which run their own shipped copy of this file and are
        // untouched by anything in it.)
        const quota = b.rate_limit ?? b.growth_plan_limit ?? b.gtm_plan_limit ?? b.gtm_chat_limit;
        const resetsAt = quotaResetsAt(quota);
        const text = resetsAt ? `${message} It resets at ${resetsAt}. Re-run after that.` : message;
        return new WaApiError("OVER_QUOTA", text, { status, details: quota });
      }
      case 504:
        // Self-describing; needs no timing heuristic.
        return new WaApiError("TIMEOUT", message, { status });
      case 502:
      case 503:
        // Ambiguous by status, decided by elapsed time — see the note on
        // GATEWAY_TIMEOUT_FLOOR_MS. Slow ⇒ the request timed out somewhere
        // upstream; fast ⇒ the service is genuinely unavailable.
        //
        // NOTE 500 is deliberately NOT here. The API returns 500 for
        // report_unavailable (website-auditor-api src/routes/audit.js) — a run
        // that completed but whose report could not be fetched. That is slow by
        // nature and relabelling it a timeout would be a lie.
        // Callers that are SLOW BY DESIGN opt out: for them a late 5xx is a
        // real verdict, and relabelling it a timeout erases both the cause
        // and any notice about what the attempt cost.
        return gatewayTimeoutFloor && elapsedMs >= WaApiClient.GATEWAY_TIMEOUT_FLOOR_MS
          ? new WaApiError("TIMEOUT", "The Website Auditor API timed out while running this request.", { status })
          : new WaApiError("UPSTREAM_ERROR", message, { status, details: b.details });
      default:
        return new WaApiError("UPSTREAM_ERROR", message, { status, details: b.details });
    }
  }
}

/**
 * The reset timestamp out of a 429's `rate_limit` block, or null if absent.
 *
 * `resets_at` is what the API sends (middleware/rateLimiter.js, an end-of-UTC-day
 * ISO string); `reset` is also accepted because that is the name the
 * header-derived {@link RateLimit} shape uses, and both reach quota consumers.
 */
function quotaResetsAt(rateLimit: unknown): string | null {
  if (!rateLimit || typeof rateLimit !== "object") return null;
  const r = rateLimit as { resets_at?: unknown; reset?: unknown };
  if (typeof r.resets_at === "string") return r.resets_at;
  if (typeof r.reset === "string") return r.reset;
  return null;
}

/** A caller's `since` as a date where it parses; the API accepts anything Date.parse does. */
function dateOf(since: string): string {
  const t = Date.parse(since);
  return Number.isNaN(t) ? since : new Date(t).toISOString().slice(0, 10);
}

/** A history row as the endpoint sends it: a snapshot whose score is null when the run stored none. */
type HistoryRow = Omit<AiVisibilitySnapshot, "score"> & { score: number | null };

/** Whether a history row has a usable score: only those are compared, or read by a trend. */
function scored(row: HistoryRow): row is AiVisibilitySnapshot {
  return row.score !== null;
}

/**
 * The like-for-like change get_changes reports, or why there is none — see
 * WaApiClient.getChanges. `snaps` is the scored history, oldest first, however
 * short: the first refusal below covers fewer than two measured snapshots, and
 * so fewer than two scored rows; `unmeasuredRuns` the history's weekly
 * re-audits that measured nothing of the business, scored or not, which are
 * never compared and are named only when newer than the series' latest, or,
 * with fewer than two measured snapshots, newer than the newest measured
 * snapshot (every one, when there is none); `since` is set exactly when the
 * caller asked for a window.
 */
function changesInHistory(
  domain: string,
  snaps: AiVisibilitySnapshot[],
  unmeasuredRuns: HistoryRow[],
  since: string | undefined,
): Changes {
  // A simulated snapshot, or a weekly re-audit that measured nothing of the
  // business, is no comparison point: the rule get_monitoring_status and the
  // weekly digest already apply.
  const rows = snaps.filter((s) => !s.is_simulated && measuredTheBusiness(s));
  if (rows.length < 2) {
    throw new WaApiError(
      "NOT_YET_AVAILABLE",
      `Not enough AI-visibility history for ${domain} yet — at least two measured snapshots are needed to show what changed. Snapshots accrue as the tracked domain is re-audited weekly (see track_site).${unmeasuredNote(unmeasuredRuns, rows[rows.length - 1] ?? null)}`,
    );
  }

  // The series' latest (seriesOf): the newest snapshot, unless newer ones asked
  // something the weekly re-audits do not ask. /api/monitoring-status reads the
  // same one, so the two report the same change.
  const series = seriesOf(rows);
  const current = series[series.length - 1]!;
  const at = rows.indexOf(current);
  const before = rows.slice(0, at);
  const earlier = series.slice(0, -1);
  const after = laterNote(rows.slice(at + 1), current);
  // Weekly re-audits newer than the series' latest that measured nothing of the
  // business: no comparison uses them, so they are named, and no result reads
  // as current when the newest weekly runs measured nothing.
  const unmeasured = unmeasuredNote(unmeasuredRuns, current);
  const later = `${after}${unmeasured}`;
  const on = day(current.captured_at);
  const sinceAt = since === undefined ? undefined : Date.parse(since);

  if (since !== undefined && sinceAt !== undefined && Date.parse(current.captured_at) < sinceAt) {
    // About the series, which is all this compares: newer snapshots outside it
    // can sit in the window, a like-for-like pair among them, and `after`
    // names them and that change.
    throw new WaApiError(
      "NOT_YET_AVAILABLE",
      after
        ? `No AI-visibility snapshot in the weekly series for ${domain} since ${dateOf(since)}: the series' latest is from ${on}, so the series has no change in that window.${later}`
        : `No AI-visibility snapshot for ${domain} to compare since ${dateOf(since)}: the latest measured snapshot is from ${on}, so there is no change in that window.${unmeasured}`,
    );
  }
  // What the window holds before the latest: every snapshot before it without
  // one.
  const inWindow = sinceAt === undefined ? before : before.filter((s) => Date.parse(s.captured_at) >= sinceAt);

  if (!before.length) {
    // Only a weekly series that is one measured re-audit, the oldest measured
    // snapshot, gets here (seriesOf): every newer snapshot is left out of it,
    // and `after` names them.
    throw new WaApiError(
      "NOT_YET_AVAILABLE",
      `Not enough history in the weekly series for ${domain} yet: its only measured re-audit so far, on ${on}, has no measured snapshot before it to compare with.${later}`,
    );
  }

  // THE CHANGE THAT STILL EXISTS, for every refusal below: a caller asking what
  // changed wants the last like-for-like change even when the latest has none.
  // Looked for in the series first, where the weekly re-audits are. Its overall
  // goes through computeChanges like every other subtraction: when different
  // engines answered the pair, the dates are named and no overall is.
  const seriesPair = newestComparablePair(earlier);
  const pair = seriesPair ?? newestComparablePair(before);
  const pairChanges = pair
    ? computeChanges(
      { score: pair.to.score, by_engine: pair.to.by_engine },
      { score: pair.from.score, by_engine: pair.from.by_engine },
    )
    : null;
  const previous_change = pair
    ? {
      from_captured_at: pair.from.captured_at,
      to_captured_at: pair.to.captured_at,
      score_delta: pairChanges!.score_delta,
    }
    : null;
  // The series' pair is the most recent only among the series once snapshots
  // outside it came before the latest too, so it is named as the series'.
  const whose = seriesPair && before.length > earlier.length ? "The weekly series' most recent" : "The most recent";
  const priorChange = previous_change
    ? previous_change.score_delta !== null
      ? ` ${whose} like-for-like change before it was ${movement(previous_change.score_delta)}, `
        + `from ${day(previous_change.from_captured_at)} to ${day(previous_change.to_captured_at)}.`
      : ` ${whose} like-for-like change before it was `
        + `from ${day(previous_change.from_captured_at)} to ${day(previous_change.to_captured_at)}, `
        + "with different engines answering, so it has no overall."
    : "";
  const withPrevious = previous_change ? { previous_change } : {};

  if (!current.question?.key) {
    const which = after
      ? `The newest AI-visibility snapshot in the weekly series for ${domain}, on ${on},`
      : `The latest AI-visibility snapshot for ${domain}, on ${on},`;
    throw new WaApiError(
      "NOT_YET_AVAILABLE",
      `${which} does not record what it asked the assistants, so it can't be compared like for like.${priorChange}${later}`,
      { details: { reason: "question_not_recorded", ...withPrevious } },
    );
  }

  const { base } = since ? oldestSameQuestion(inWindow, current) : newestSameQuestion(before, current);
  if (!base) {
    // Explained against the newest snapshot in the series that recorded its
    // question: an audit beside the series asked something else, and the one
    // just before may have recorded nothing. Only when none did, any that did.
    const prior = newestRecorded(earlier) ?? newestRecorded(before);
    const asked = prior?.question
      ? `asked about ${questionDifference(current.question, prior.question)}, compared with the snapshot on `
        + day(prior.captured_at)
      : null;
    const unrecorded = "the snapshots before it do not record what they asked";
    // A first recorded question is no change of question: nothing earlier says
    // what it asked.
    const reason = asked ? "question_changed" : "earlier_not_recorded";
    // A window can hold no match while an older snapshot outside it does, so
    // only the unwindowed read may call this a re-baseline. When that older one
    // exists, the refusal names it rather than a difference that is not there.
    if (since) {
      const outside = newestSameQuestion(before, current).base;
      if (outside) {
        throw new WaApiError(
          "NOT_YET_AVAILABLE",
          `No earlier AI-visibility snapshot for ${domain} since ${dateOf(since)} asked the question the one on ${on} asked; the most recent that did is from ${day(outside.captured_at)}, before the window, so there is no like-for-like change for it in the window.${priorChange}${later}`,
          { details: { reason: "not_in_window", since, ...withPrevious } },
        );
      }
      throw new WaApiError(
        "NOT_YET_AVAILABLE",
        `No earlier AI-visibility snapshot for ${domain} since ${dateOf(since)} asked the question the one on ${on} asked (${asked ? `that one ${asked}` : unrecorded}), so there is no like-for-like change for it in that window.${priorChange}${later}`,
        { details: { reason, since, ...withPrevious } },
      );
    }
    throw new WaApiError(
      "NOT_YET_AVAILABLE",
      `AI visibility for ${domain} re-baselined on ${on}: ${asked ? `that day's snapshot ${asked}, and no earlier snapshot asked the same question` : unrecorded}, so there is no like-for-like change for it yet.${priorChange}${later}`,
      { details: { reason, rebaselined_at: current.captured_at, ...withPrevious } },
    );
  }

  // Every snapshot between the base and the latest, or in the window before the
  // latest: by construction none of them asked the latest's question.
  const passedOver = notCompared(since ? inWindow : before.slice(before.indexOf(base) + 1), current);
  const skipped = passedOver.different + passedOver.unrecorded;
  const result: Changes = {
    ...computeChanges(
      { score: current.score, by_engine: current.by_engine },
      { score: base.score, by_engine: base.by_engine },
    ),
    from_captured_at: base.captured_at,
    to_captured_at: current.captured_at,
    skipped_snapshots: skipped,
  };
  const notes: string[] = [];
  if (skipped > 0) {
    notes.push(since
      ? `Compared with ${day(base.captured_at)}, the earliest snapshot in the window that asked the same question as the one on ${on}; in the window but not compared: ${notComparedPhrase(passedOver)}.`
      : `Compared with ${day(base.captured_at)}, the most recent snapshot that asked the same question; passed over in between: ${notComparedPhrase(passedOver)}.`);
  }
  // THE OVERALL'S OWN REASON FOR NOT BEING THERE. `skipped` counts snapshots
  // passed over for asking another question; this is the pair itself, asked
  // the same question and answered by different engines. A null `score_delta`
  // with no word beside it reads as "no change" rather than "no comparison".
  if (result.score_delta === null) notes.push(result.overall_note!);
  if (later) notes.push(later.trim());
  if (notes.length) result.note = notes.join(" ");
  return result;
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
