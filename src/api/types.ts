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

export interface AiVisibility {
  score: number;
  by_engine: { chatgpt: number; perplexity: number; claude: number; gemini: number };
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

export interface CompetitorRank {
  domain: string;
  score: number | null;
  note?: string;
}

export interface CompetitorGap {
  engine: string;
  competitor: string;
  competitor_score: number;
  your_score: number;
}

export interface Comparison {
  ranking: CompetitorRank[];
  gaps: CompetitorGap[];
}
