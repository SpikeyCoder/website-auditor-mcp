/**
 * TypeScript shapes for the REAL website-auditor-api responses and the tool
 * return shapes defined in the listing-and-tools doc.
 *
 * The `AuditReport` mirrors chaos_tester's `TestRun.to_dict()` (returned as the
 * `audit` field of `GET /api/audit`), including the `ai_visibility` block from
 * modules/ai_visibility.py. Only the fields the MCP actually reads are typed;
 * the raw JSON is preserved separately on the client response.
 */

// ─── Upstream report shapes (from website-auditor-api / chaos_tester) ──────

export type TestStatus = "passed" | "failed" | "warning" | "skipped" | "error";
export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface TestResult {
  test_id: string;
  module: string; // availability | links | forms | chaos | auth | security | performance | ai_visibility
  name: string;
  description: string;
  status: TestStatus;
  severity: Severity;
  url: string;
  details: string;
  recommendation: string;
  [key: string]: unknown;
}

export interface AuditSummaryBlock {
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  errors: number;
  pass_rate: number;
}

export interface AiPlatformResult {
  platform: string;
  query: string;
  recommended: string[];
  client_appears: boolean;
  position: number;
  competitors: string[];
  is_simulated?: boolean;
  [key: string]: unknown;
}

export type EngineState = "scored" | "unanswered" | "not_asked";

export interface AiPlatformScore {
  score: number;
  appearances: number;
  /** Queries the provider ANSWERED — the score's denominator, not what was
   *  sent. 0 with `asked` > 0 means the engine was asked and stayed silent. */
  total: number;
  /** Queries SENT to this engine. Arrives through the index signature on older
   *  payloads, so treat it as optional however the shape reads. */
  asked?: number;
  results: AiPlatformResult[];
  [key: string]: unknown;
}

/**
 * One entry of the ranked cited-sources list (chaos_tester #447): a document
 * the AI assistants actually read while answering, deduplicated by domain.
 * `answers` counts answers, not citation entries — one answer citing three
 * pages of a site counts once. `url`/`title` name one representative page;
 * `url` is null when no citation named a directly linkable page (Gemini cites
 * through a grounding redirect, which does not count), and `title` is always
 * "" in that case.
 */
export interface AiVisibilitySource {
  domain: string;
  answers: number;
  /** Fixed order: ChatGPT, Perplexity, Claude, Gemini; others alphabetically after. */
  platforms: string[];
  /** `competitor` rows are context, not placement targets. */
  ownership: "yours" | "competitor" | "third_party";
  url: string | null;
  title: string;
}

/** The `ai_visibility` block. Empty object when the homepage could not load. */
export interface AiVisibilityBlock {
  business_info?: { business_name?: string; sector?: string; industry?: string; location?: string };
  overall_score?: number;
  total_queries?: number;
  total_appearances?: number;
  platform_scores?: Partial<Record<"ChatGPT" | "Perplexity" | "Claude" | "Gemini", AiPlatformScore>>;
  queries?: string[];
  is_simulated?: boolean;
  has_api_key?: boolean;
  site_signals?: Record<string, unknown>;
  /**
   * How the business was identified (chaos_tester #334). Optional because a
   * report produced before that deploy — or replayed from cache — has no such
   * block, and absent must read as "no warning" rather than a crash.
   */
  identification?: {
    confidence?: string;
    identification_sources?: string[];
    /** "detected" | "user_supplied" | "domain_fallback". */
    name_source?: string;
    /** Stricter than confidence: corroborated, or externally verified. */
    name_verified?: boolean;
    /** Actionable text when the name is unverified; "" when it is not. */
    name_warning?: string;
    [key: string]: unknown;
  };
  /**
   * The flattened per-answer table; `citations` carries the raw grounded-source
   * evidence the ranked `sources` list is derived from. Only the fields the
   * MCP reads (or its fixtures pin) are typed; real rows carry more.
   */
  all_results?: Array<{
    platform: string;
    query: string;
    citations?: Array<{ url?: string; title?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  }>;
  /**
   * Ranked cited documents, top ten (chaos_tester #447) — tri-state BY
   * CONTRACT: null means the recorded answers cited nothing attributable, and
   * an ABSENT key means no readable citation records exist at all (the
   * budget-deferral `ai_visibility == {}`, a build predating citation capture,
   * or a server-side ranking failure). Absent must never be read as null.
   */
  sources?: AiVisibilitySource[] | null;
  [key: string]: unknown;
}

export interface AuditReport {
  run_id: string;
  base_url: string;
  environment: string;
  started_at: string;
  finished_at: string;
  duration_s: number;
  status: string;
  summary: AuditSummaryBlock;
  results: TestResult[];
  performance_metrics: Record<string, unknown>;
  ai_visibility: AiVisibilityBlock;
  [key: string]: unknown;
}

// ─── Tool return shapes (from the listing-and-tools doc) ───────────────────

/** Per-engine boolean map (does the site appear on this engine at all). */
export interface EnginePresence {
  /** NULL when the engine was not scored. `false` asserts the engine did not
   *  name the business, which an unmeasured engine cannot support — and
   *  compare_competitors turns that assertion into a reported gap. */
  chatgpt: boolean | null;
  perplexity: boolean | null;
  claude: boolean | null;
  gemini: boolean | null;
}

/** One stored AI-visibility measurement, as the history endpoint returns it. */
export interface AiVisibilitySnapshot {
  captured_at: string;
  score: number;
  by_engine: Record<string, number>;
  /** True when the snapshot was produced without live AI queries. */
  is_simulated: boolean;
}

/** Score movement across one lookback window (newest vs oldest in range). */
export interface TrendWindow {
  window_days: number;
  from_score: number;
  to_score: number;
  score_delta: number;
  engine_changes: EngineChange[];
  /** Snapshots that fell inside this window. */
  snapshots: number;
}

/**
 * Historical movement behind the current score (Pro — reads the same
 * ai_visibility_snapshots history that powers get_changes). A window is null
 * when fewer than two snapshots fall inside it.
 */
export interface AiVisibilityTrend {
  change_7d: TrendWindow | null;
  change_30d: TrendWindow | null;
  snapshots_analyzed: number;
  latest_captured_at: string;
  /** True if any analyzed snapshot was simulated (estimated) data. */
  includes_simulated: boolean;
}

export interface AiVisibility {
  score: number;
  /** Per-engine score, or NULL when the engine was not scored. A null is not a
   *  zero: zero means the engine answered and never named the business.
   *  `engine_status` says which of the two non-scored reasons applies. */
  by_engine: {
    chatgpt: number | null; perplexity: number | null;
    claude: number | null; gemini: number | null;
  };
  /** Why each engine's score is what it is. */
  engine_status: {
    chatgpt: EngineState; perplexity: EngineState;
    claude: EngineState; gemini: EngineState;
  };
  /**
   * Whether the site appeared at all on each engine (derived from the per-query
   * `client_appears` signal). Distinct from `by_engine` scores: an engine can
   * have appearances (appears = true) yet a low score, or vice versa.
   */
  appears_by_engine: EnginePresence;
  top_competitor: string | null;
  summary: string;
  /** Pro only; null when unavailable — `trend_note` says why. */
  trend: AiVisibilityTrend | null;
  /** Present exactly when `trend` is null: the human-readable reason. */
  trend_note?: string;
  /** Present exactly when an engine was asked and did not answer. Also folded
   *  into `summary`, because a field the model never reads changes nothing. */
  coverage_note?: string;
  /**
   * Set ONLY when the business name could not be verified. The score is
   * computed from queries built around that name, so an unverified name means
   * the whole result may describe a different business. Also folded into
   * `summary`, because a field the model never reads changes nothing.
   */
  name_warning?: string;
  /** Present when the engine reported it: corroborated or externally verified. */
  name_verified?: boolean;
  /** Present when the engine reported it: "detected" | "user_supplied" | "domain_fallback". */
  name_source?: string;
  /**
   * The ranked cited-documents evidence behind the score, passed through from
   * the report. It reaches callers only via the subscription-gated audit tools
   * — there is no free live path; the keyless demo returns canned data. Same
   * tri-state as upstream: an array is the ranked list (at most ten rows,
   * enforced client-side as well); null means the recorded answers cited
   * nothing attributable; the key is ABSENT when the audit holds no readable
   * citation records — "never measured", not "cited nothing" — and a payload
   * whose rows are all malformed reads as absent, never as an empty list.
   */
  sources?: AiVisibilitySource[] | null;
}

export interface AuditIssue {
  name: string;
  severity: Severity;
  module: string;
  url: string;
  details: string;
  recommendation: string;
}

export interface AuditSummary {
  scores: { ai_visibility: number | null; seo: number | null; security: number | null; performance: number | null };
  top_issues: AuditIssue[];
  report_url: string;
  /**
   * Set ONLY when the business name could not be verified — the AI-visibility
   * score is built from queries around that name, so an unverified name puts
   * the whole score in question. run_audit carries it because it is the tool
   * most agents reach for first.
   */
  name_warning?: string;
}

export interface EngineChange {
  engine: string;
  from: number;
  to: number;
  delta: number;
}

export interface Changes {
  score_delta: number;
  engine_changes: EngineChange[];
  competitor_changes: unknown[];
  new_issues: unknown[];
  resolved_issues: unknown[];
}

// ─── Scheduled monitoring (track_site / tracked domains) ───────────────────

export interface TrackedDomain {
  domain: string;
  cadence: string;
  active: boolean;
  digest_enabled: boolean;
  last_audited_at: string | null;
  next_run_at: string | null;
  created_at?: string | null;
}

/** Result of listing a user's tracked domains, with cap accounting. */
export interface TrackedDomainsList {
  limit: number;
  used: number;
  remaining: number;
  tracked: TrackedDomain[];
}

/** Result of enrolling (or re-confirming) a domain for weekly monitoring. */
export interface TrackResult {
  domain: string;
  cadence: string;
  active: boolean;
  /** True when this call created a new tracking; false when it already existed. */
  created: boolean;
  already_tracked: boolean;
}

export interface UntrackResult {
  domain: string;
  /** True if a tracking was removed; false if it wasn't tracked (idempotent). */
  removed: boolean;
  /** Slot accounting after removal, when the API reports it. */
  limit?: number;
  used?: number;
  remaining?: number;
}

/** One AI-visibility snapshot as returned by monitoring-status (read shape). */
export interface MonitoringSnapshot {
  score: number | null;
  by_engine: { chatgpt: number | null; perplexity: number | null; claude: number | null; gemini: number | null };
  captured_at: string;
  is_simulated: boolean | null;
}

/** Per-domain monitoring status: tracking metadata + latest/previous snapshots. */
export interface MonitoringSite {
  domain: string;
  cadence: string;
  active: boolean;
  last_audited_at: string | null;
  next_run_at: string | null;
  snapshots_count: number;
  latest: MonitoringSnapshot | null;
  previous: MonitoringSnapshot | null;
}

/** The user's whole monitoring picture, with cap accounting. */
export interface MonitoringStatus {
  limit: number;
  used: number;
  remaining: number;
  sites: MonitoringSite[];
}

export interface CompetitorRank {
  domain: string;
  score: number | null;
  note?: string;
}

/**
 * An engine/surface where a competitor APPEARS in AI answers and the primary
 * site does NOT — i.e. "where they appear that the site does not". This is an
 * appearance (presence/absence) gap, not a score comparison.
 */
export interface CompetitorGap {
  engine: string;
  competitor: string;
}

/** Rate-limit state, from the API's `X-RateLimit-*` response headers. */
export interface RateLimit {
  limit: number | null;
  remaining: number | null;
  reset: string | null;
}

export type SkipReason = "quota" | "unreachable" | "error";

export interface SkippedDomain {
  domain: string;
  reason: SkipReason;
  detail?: string;
}

/** Quota accounting for a `compare_competitors` call. */
export interface CompareQuota {
  /** Daily audit limit for the key, if known. */
  limit: number | null;
  /** Audits remaining after this call, if known (null = couldn't determine). */
  remaining: number | null;
  /** Fresh audits actually spent by this call. */
  audits_used: number;
  /** Competitors skipped specifically because the daily quota was exhausted. */
  audits_skipped: number;
  /** Domains served from a recent cached audit (cost no quota). */
  cached_reused: number;
  /** When the daily quota resets (ISO), if known. */
  reset: string | null;
}

export interface Comparison {
  ranking: CompetitorRank[];
  gaps: CompetitorGap[];
  /** Quota accounting so an agent knows what was spent and what remains. */
  quota: CompareQuota;
  /** Domains that were not ranked, each with an explicit reason. */
  skipped: SkippedDomain[];
  /** Human/agent-readable summary of what was compared vs. skipped and why. */
  summary: string;
}

// ─── Phase-1 read tools (benchmark / recommendations / schema / report) ────
// Tool return shapes from the listing-and-tools doc, wired to the new
// website-auditor-api endpoints (PR #10). The client strips each endpoint's
// `success` envelope and returns exactly these shapes.

/** `get_benchmark` — percentile/peer context for a domain's AI visibility. */
export interface Benchmark {
  /** The domain's percentile within its industry/geo peer set (0–100). */
  percentile: number;
  /** Median AI-visibility score across the peer set. */
  peer_median: number;
  /** How many peers the percentile/median are computed over. */
  sample_size: number;
  /** Human-readable position summary (e.g. "top 15% for legal services in TX"). */
  position_summary: string;
}

/** One prioritized fix from `get_recommendations`. */
export interface Recommendation {
  action: string;
  why: string;
  expected_impact: string;
  effort: string;
}

/** `get_recommendations` — ranked actions to raise AI-visibility/audit scores. */
export interface Recommendations {
  recommendations: Recommendation[];
}

/** `generate_schema` — ready-to-paste JSON-LD plus where to put it. */
export interface SchemaResult {
  /** The JSON-LD document (object or array), ready to paste into the site. */
  jsonld: unknown;
  /** Where/how to place the snippet (e.g. "in the <head> of every page"). */
  placement_notes: string;
}

/** `get_report` — shareable report URL + embeddable badge snippet. */
export interface ReportLinks {
  report_url: string;
  badge_html: string;
}

// ── Growth plan (POST /api/growth-plan) ────────────────────────────────

/** One chat message on the proxy's transcript wire. */
export interface GtmChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GtmPlanSection {
  title: string;
  body_lines: string[];
}

/**
 * One action card inside a phase.
 *
 * Every key is always PRESENT on the wire and `null` when the plan did not
 * write it — the engine builds the card with `dict.fromkeys(_ACTION_FIELDS)`
 * (chaos_tester gtm_chat.py, parse_plan_actions) precisely so nothing is
 * inferred: a missing effort is null and the chip is not drawn, and a
 * priority outside the two values the design has styles for is dropped
 * rather than passed through. Nullable, therefore, rather than optional —
 * and never defaulted here, which would put a commitment on the customer's
 * calendar that no model produced.
 */
export interface GtmPlanAction {
  title: string;
  effort: string | null;
  priority: string | null;
  why: string | null;
  goal: string | null;
  steps: string[];
}

/** One 30-day band of the plan. The three bands are fixed engine-side. */
export interface GtmPlanPhase {
  phase: number;
  range: string;
  name: string;
  short: string;
  headline: string | null;
  focus: string | null;
  actions: GtmPlanAction[];
}

/**
 * What POST /api/growth-plan answers, envelope stripped.
 *
 * `plan_phases` is OPTIONAL and that is the contract, not laziness. The
 * engine answers `[]` for a plan that did not follow the card contract
 * rather than refusing a deliverable it already billed for, and the proxy
 * forwards the key by PRESENCE (`k in engineBody`). So the two empty
 * answers mean different things and must stay distinguishable here:
 * `[]` — this engine parsed no cards, render the prose; absent — an engine
 * older than the one that added them.
 */
export interface GtmPlanResponse {
  plan_markdown: string;
  plan_sections: GtmPlanSection[];
  sources_used: string[];
  model: string;
  plan_phases?: GtmPlanPhase[];
}

/** What the get_gtm_plan tool returns to the host model. */
export interface GtmPlanResult {
  domain: string;
  /** `phases` is absent, never `[]`, when the wire did not carry the key. */
  plan: { markdown: string; sections: GtmPlanSection[]; phases?: GtmPlanPhase[] };
  sources_used: string[];
  model: string;
  /** Additive, never an error: set when the plan had no citation evidence. */
  evidence_note?: string;
  summary: string;
}
