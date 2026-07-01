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

export interface AiPlatformScore {
  score: number;
  appearances: number;
  total: number;
  results: AiPlatformResult[];
  [key: string]: unknown;
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
  chatgpt: boolean;
  perplexity: boolean;
  claude: boolean;
  gemini: boolean;
}

export interface AiVisibility {
  score: number;
  by_engine: { chatgpt: number; perplexity: number; claude: number; gemini: number };
  /**
   * Whether the site appeared at all on each engine (derived from the per-query
   * `client_appears` signal). Distinct from `by_engine` scores: an engine can
   * have appearances (appears = true) yet a low score, or vice versa.
   */
  appears_by_engine: EnginePresence;
  top_competitor: string | null;
  summary: string;
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
