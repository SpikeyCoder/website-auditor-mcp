/**
 * Declared output shapes, one per tool.
 *
 * WHY THESE EXIST. The Apps SDK portal flags every tool that declares no
 * `outputSchema` — "so models can better understand this tool's results". That
 * is the whole purpose: these are DOCUMENTATION FOR THE MODEL, published
 * alongside the input schema so a caller knows what it is getting before it
 * calls. They are not a validation gate we want, and treating them as one is
 * how they break things.
 *
 * WHY THEY ARE PERMISSIVE. The MCP SDK validates a tool's `structuredContent`
 * against this schema on every SUCCESSFUL call and throws `McpError` when it
 * does not match — TWICE, once on each side of the wire: the server before
 * sending (server/mcp.js → validateToolOutput) and the client on receipt
 * (client/index.js → callTool). A schema stricter than reality therefore does
 * not report a problem — it MANUFACTURES one, turning a working tool into a
 * hard failure in production. The upstream
 * types this mirrors say so explicitly ("only the fields the MCP reads are
 * typed; real rows carry more"), so:
 *
 *   * anything optional in the TypeScript type is `.optional()` here;
 *   * anything nullable is `.nullable()`;
 *   * every NESTED object that carries upstream data is `.passthrough()`, which
 *     is also the honest thing to publish — it emits `additionalProperties:
 *     true`, telling the model more fields may appear rather than implying a
 *     closed set. This does NOT reach the top level: the SDK wraps the exported
 *     raw shape in a plain `z.object(shape)`, so each tool's root object
 *     publishes `additionalProperties: false`. That is accurate today — every
 *     root key each tool returns is declared below — but it is the SDK's choice
 *     rather than this file's, and adding an undeclared root key would make the
 *     published schema wrong before it made anything fail;
 *   * fields whose VALUES come from upstream are typed `z.string()` rather than
 *     enums, even where a union type narrows them locally.
 *
 * Enums appear only where this package constructs the literal itself.
 *
 * Error results are unaffected by anything in this file — but NOT for the
 * reason this comment gave for most of its life, and the difference cost every
 * gated tool its refusal copy. The old claim was that "the SDK returns early on
 * isError". Only the SERVER does. The client's validation branch is gated on
 * presence alone — `if (result.structuredContent)`, no isError test — so an
 * error body carrying that field was measured against the success schema above
 * and thrown away as an McpError before the caller saw it.
 *
 * What makes error results safe is therefore not a property of the SDK but a
 * decision in src/mcp/server.ts → toCallResult: an error result carries NO
 * `structuredContent` at all. The AUTH_REQUIRED / PRO_REQUIRED payload travels
 * in `content[0].text` and the challenge in `_meta["mcp/www_authenticate"]`,
 * neither of which any validator inspects. Do not "restore" structuredContent
 * on the error path to make an error machine-readable — that is the bug.
 *
 * WHAT KEEPS THEM HONEST. tests/tools/outputSchemas.test.ts runs the success
 * payload of every tool fixture in the suite through the matching schema. A
 * schema tightened past what a real response carries fails there rather than in
 * front of a user.
 */
import { z } from "zod";
import type { ZodRawShape } from "zod";

/** An object that mirrors upstream data: extra keys are expected, not an error. */
const open = <T extends ZodRawShape>(shape: T) => z.object(shape).passthrough();

// ─── shared fragments ──────────────────────────────────────────────────────

// NULLABLE, and it had to widen in the same commit as the mapper: the SDK
// validates `structuredContent` against this on BOTH sides of the wire
// (server/mcp.js throws McpError on a mismatch), so a null arriving against
// `z.number()` would turn a successful, quota-spending audit into an error
// naming neither the domain nor the engine.
const engineScores = open({
  chatgpt: z.number().nullable(),
  perplexity: z.number().nullable(),
  claude: z.number().nullable(),
  gemini: z.number().nullable(),
}).describe(
  "Per-engine AI-visibility score, 0–100. NULL means the engine was not "
  + "scored — see engine_status for which of the two reasons. A null is NOT a "
  + "zero: zero means the engine answered and never named the business.");

const engineStatus = open({
  chatgpt: z.enum(["scored", "unanswered", "not_asked"]),
  perplexity: z.enum(["scored", "unanswered", "not_asked"]),
  claude: z.enum(["scored", "unanswered", "not_asked"]),
  gemini: z.enum(["scored", "unanswered", "not_asked"]),
}).describe(
  "Why each engine's score is what it is. 'scored' — the engine answered and "
  + "the number is a measurement. 'unanswered' — it was asked and returned "
  + "nothing, so there is no score; do not report it as 0. 'not_asked' — it "
  + "was not part of this run at all.");

const enginePresence = open({
  chatgpt: z.boolean().nullable(),
  perplexity: z.boolean().nullable(),
  claude: z.boolean().nullable(),
  gemini: z.boolean().nullable(),
}).describe(
  "Whether the site appeared at all on each engine. Distinct from the scores: "
  + "an engine can have appearances yet a low score, or the reverse. NULL when "
  + "the engine was not scored — false would assert it did not name the "
  + "business, which is a claim an unmeasured engine cannot support.");

const engineChange = open({
  engine: z.string(),
  from: z.number(),
  to: z.number(),
  delta: z.number(),
});

const trendWindow = open({
  window_days: z.number(),
  from_score: z.number(),
  to_score: z.number(),
  score_delta: z.number(),
  engine_changes: z.array(engineChange),
  snapshots: z.number().describe("Snapshots that fell inside this window."),
});

const aiVisibilityTrend = open({
  change_7d: trendWindow.nullable().describe("Null when fewer than two snapshots fall in the window."),
  change_30d: trendWindow.nullable(),
  snapshots_analyzed: z.number(),
  latest_captured_at: z.string(),
  includes_simulated: z.boolean().describe("True if any analyzed snapshot was estimated rather than measured."),
});

const aiVisibilitySource = open({
  domain: z.string(),
  answers: z.number().describe("Answers citing this domain — not citation entries."),
  platforms: z.array(z.string()),
  ownership: z.string().describe('"yours" | "competitor" | "third_party". Competitor rows are context, not targets.'),
  url: z.string().nullable(),
  title: z.string(),
});

// Every field optional but `severity`, which toAuditSummary filters on and so
// must exist. The rest are copied VERBATIM from upstream result rows
// (mappers.ts toAuditSummary) with no defaulting — and mappers.ts guards the
// same field names with `?? ""` elsewhere, which is the repo's own evidence
// that they arrive missing. Requiring them here would have turned a successful,
// quota-spending run_audit into an McpError.
const auditIssue = open({
  name: z.string().optional(),
  severity: z.string(),
  module: z.string().optional(),
  url: z.string().optional(),
  details: z.string().optional(),
  recommendation: z.string().optional(),
});

const changes = open({
  score_delta: z.number(),
  engine_changes: z.array(engineChange),
  competitor_changes: z.array(z.unknown()),
  new_issues: z.array(z.unknown()),
  resolved_issues: z.array(z.unknown()),
});

// ─── per-tool output schemas ───────────────────────────────────────────────

export const getAiVisibilityOutput: ZodRawShape = {
  score: z.number().describe("Overall AI-visibility score, 0–100."),
  by_engine: engineScores,
  engine_status: engineStatus,
  appears_by_engine: enginePresence,
  top_competitor: z.string().nullable().describe("The competitor appearing in place of the site, if any."),
  summary: z.string(),
  trend: aiVisibilityTrend.nullable().describe("Pro only; null when unavailable — trend_note says why."),
  trend_note: z.string().optional().describe("Present exactly when trend is null: the reason."),
  coverage_note: z.string().optional().describe(
    "Present exactly when an engine was asked and did not answer. Relay it: "
    + "the score covers fewer engines than the four this tool can query."),
  name_warning: z.string().optional().describe(
    "Set ONLY when the business name behind the score could not be verified. The score is "
    + "computed from queries built around that name, so relay this caveat rather than "
    + "presenting the score as settled."),
  name_verified: z.boolean().optional(),
  name_source: z.string().optional().describe('"detected" | "user_supplied" | "domain_fallback".'),
  // Tri-state BY CONTRACT: an array is the ranked list, null means the recorded
  // answers cited nothing attributable, and an ABSENT key means no readable
  // citation records exist at all. Absent must never be read as null.
  sources: z.array(aiVisibilitySource).nullable().optional(),
};

export const runAuditOutput: ZodRawShape = {
  scores: open({
    ai_visibility: z.number().nullable(),
    seo: z.number().nullable(),
    security: z.number().nullable(),
    performance: z.number().nullable(),
  }),
  top_issues: z.array(auditIssue),
  report_url: z.string(),
  name_warning: z.string().optional().describe(
    "Set ONLY when the business name could not be verified, which puts the AI-visibility "
    + "score in question."),
};

export const getChangesOutput: ZodRawShape = {
  score_delta: z.number(),
  engine_changes: z.array(engineChange),
  competitor_changes: z.array(z.unknown()),
  new_issues: z.array(z.unknown()),
  resolved_issues: z.array(z.unknown()),
};

export const compareCompetitorsOutput: ZodRawShape = {
  ranking: z.array(open({
    domain: z.string(),
    score: z.number().nullable(),
    note: z.string().optional(),
  })),
  gaps: z.array(open({
    engine: z.string(),
    competitor: z.string(),
  })).describe("Engines where a competitor appears in AI answers and this site does not."),
  quota: open({
    limit: z.number().nullable(),
    remaining: z.number().nullable(),
    audits_used: z.number().describe("Fresh audits actually spent by this call."),
    audits_skipped: z.number().describe("Competitors skipped because the daily quota ran out."),
    cached_reused: z.number().describe("Domains served from a recent cached audit; cost no quota."),
    reset: z.string().nullable(),
  }),
  skipped: z.array(open({
    domain: z.string(),
    reason: z.string().describe('"quota" | "unreachable" | "error".'),
    detail: z.string().optional(),
  })),
  summary: z.string(),
};

export const trackSiteOutput: ZodRawShape = {
  domain: z.string(),
  tracking: z.boolean().describe("True after a start/confirm; false after a stop."),
  cadence: z.string().optional(),
  created: z.boolean().optional().describe("Present when starting: whether this call created a new tracking."),
  already_tracked: z.boolean().optional(),
  removed: z.boolean().optional().describe("Present when stopping."),
  message: z.string(),
};

export const untrackSiteOutput: ZodRawShape = {
  domain: z.string(),
  tracking: z.boolean(),
  removed: z.boolean(),
  limit: z.number().optional(),
  used: z.number().optional(),
  remaining: z.number().optional(),
  message: z.string(),
};

export const listTrackedSitesOutput: ZodRawShape = {
  limit: z.number(),
  used: z.number(),
  remaining: z.number(),
  // Passed through from listTrackedDomains without per-row normalization, so
  // only `domain` is guaranteed. `.nullable()` does not cover an ABSENT key —
  // a newly-enrolled row that carries no next_run_at yet would fail.
  tracked: z.array(open({
    domain: z.string(),
    cadence: z.string().optional(),
    active: z.boolean().optional(),
    digest_enabled: z.boolean().optional(),
    last_audited_at: z.string().nullable().optional(),
    next_run_at: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
  })),
  summary: z.string(),
};

export const getMonitoringStatusOutput: ZodRawShape = {
  limit: z.number(),
  used: z.number(),
  remaining: z.number(),
  // `change` and `summary` are computed by the tool, so they are guaranteed.
  // `latest_score` is now normalized to number-or-null at the seam (it was read
  // raw, and an absent upstream score reached here as undefined); everything
  // else is copied straight off an unnormalized body.sites and is not.
  sites: z.array(open({
    domain: z.string(),
    cadence: z.string().optional(),
    active: z.boolean().optional(),
    latest_score: z.number().nullable(),
    last_audited_at: z.string().nullable().optional(),
    next_run_at: z.string().nullable().optional(),
    change: changes.nullable().describe("Latest vs previous snapshot; null if fewer than two."),
    summary: z.string(),
  })),
  summary: z.string(),
};

export const getBenchmarkOutput: ZodRawShape = {
  percentile: z.number().describe("The domain's percentile within its industry/geo peer set, 0–100."),
  peer_median: z.number(),
  sample_size: z.number().describe("How many peers the percentile and median are computed over."),
  position_summary: z.string(),
};

export const getRecommendationsOutput: ZodRawShape = {
  // The client checks only that this IS an array; nothing validates the rows.
  recommendations: z.array(open({
    action: z.string().optional(),
    why: z.string().optional(),
    expected_impact: z.string().optional(),
    effort: z.string().optional(),
  })),
};

export const generateSchemaOutput: ZodRawShape = {
  // Object or array, by contract — z.unknown() rather than a guess.
  jsonld: z.unknown().describe("The JSON-LD document, ready to paste into the site."),
  placement_notes: z.string().describe('Where to put the snippet, e.g. "in the <head> of every page".'),
};

export const getReportOutput: ZodRawShape = {
  report_url: z.string(),
  badge_html: z.string(),
};

/**
 * One action card. Every field is BOTH nullable and optional, for two
 * different reasons that both point the same way.
 *
 * Nullable is the contract: the engine builds each card with
 * `dict.fromkeys` and fills a field only when the plan actually wrote it, so
 * a missing effort arrives as `null` — present and empty — rather than being
 * omitted. Declaring `z.string()` here would turn the ordinary case into an
 * McpError on a plan the caller was already billed for.
 *
 * Optional is the same unchecked-cast reasoning as `sections` below: the
 * client relays this array behind an `as GtmPlanPhase[]`, so the schema must
 * hold whatever the engine really sends, not what its parser promises.
 */
const gtmPlanAction = open({
  title: z.string().optional(),
  effort: z.string().nullable().optional().describe(
    "The plan's own effort estimate, or null when it did not give one. Null means "
    + "unknown — never render a substitute."),
  priority: z.string().nullable().optional().describe(
    'Typically "High" or "Medium"; null when the plan gave none or gave one outside '
    + "the two the engine keeps. Upstream text, so not an enum here."),
  why: z.string().nullable().optional(),
  goal: z.string().nullable().optional(),
  steps: z.array(z.string()).optional().describe("How to apply it, in order. May be empty."),
});

const gtmPlanPhase = open({
  phase: z.number().optional().describe("30, 60 or 90 — the day the band closes."),
  range: z.string().optional().describe('The band as the engine names it, e.g. "Days 1–30".'),
  name: z.string().optional(),
  short: z.string().optional(),
  headline: z.string().nullable().optional(),
  focus: z.string().nullable().optional(),
  actions: z.array(gtmPlanAction).optional().describe(
    "Empty for a phase the plan wrote as prose. That is a real plan with nothing "
    + "cut into cards for this band, not a plan with nothing in it."),
});

export const getGtmPlanOutput: ZodRawShape = {
  domain: z.string(),
  plan: open({
    markdown: z.string(),
    // Behind an unchecked `as GtmPlanSection[]` over LLM-derived sections, so a
    // heading with no body is entirely possible — and requiring body_lines
    // would discard a plan the caller has already been billed for.
    sections: z.array(open({ title: z.string().optional(), body_lines: z.array(z.string()).optional() })),
    // OPTIONAL because absent is a real answer, and a different one from `[]`.
    // The description is the point: this is the same plan as `markdown`, cut
    // into cards, and the model has to be told what each empty form means or
    // it will read one as the other and tell the customer their paid plan
    // contains no actions.
    phases: z.array(gtmPlanPhase).optional().describe(
      "The same plan as `markdown`, cut into 30/60/90-day cards — a rendering, never "
      + "extra content. An empty array means this plan was not written in card form: "
      + "render `markdown` instead, and do not report it as a plan without actions. "
      + "The key being absent means the plan came from a build that predates the cards, "
      + "which is also not a claim about the plan."),
  }),
  sources_used: z.array(z.string()),
  model: z.string(),
  evidence_note: z.string().optional().describe("Additive, never an error: set when the plan had no citation evidence."),
  summary: z.string(),
};

export const getSampleAuditOutput: ZodRawShape = {
  is_sample: z.literal(true).describe("Always true. Never present this as a live result."),
  domain: z.string().describe("The fixed sample domain. Never the caller's own."),
  note: z.string(),
  // The raw upstream report, which carries far more than the MCP types name.
  // Enumerating it here would be a large surface with nothing to gain: the
  // model is told what the envelope means, and the payload passes through.
  audit: open({
    run_id: z.string().optional(),
    base_url: z.string().optional(),
    status: z.string().optional(),
    summary: z.unknown().optional(),
    results: z.array(z.unknown()).optional(),
    ai_visibility: z.unknown().optional(),
  }).describe("A real GET /api/audit payload, populated with sample data."),
  price: z.string(),
  upgrade_url: z.string(),
};

export const checkUpgradeStatusOutput: ZodRawShape = {
  tier: z.string().describe('"none" | "free" | "pro".'),
  status: z.string().describe("Raw subscription status: active, trialing, canceled, none, …"),
  current_period_end: z.string().nullable(),
  cancel_at_period_end: z.boolean(),
  upgrade_url: z.string(),
  message: z.string(),
};

/**
 * Tool name → declared output shape.
 *
 * Keyed by name rather than attached to each registry entry so the registry
 * keeps its "names and descriptions VERBATIM from the listing doc" character,
 * and so a tool with no declared output simply has no entry here rather than an
 * empty one. registry.ts reads this map when it builds each ToolSpec.
 */
export const OUTPUT_SCHEMAS: Record<string, ZodRawShape> = {
  get_ai_visibility: getAiVisibilityOutput,
  run_audit: runAuditOutput,
  get_changes: getChangesOutput,
  compare_competitors: compareCompetitorsOutput,
  track_site: trackSiteOutput,
  untrack_site: untrackSiteOutput,
  list_tracked_sites: listTrackedSitesOutput,
  get_monitoring_status: getMonitoringStatusOutput,
  get_benchmark: getBenchmarkOutput,
  get_recommendations: getRecommendationsOutput,
  generate_schema: generateSchemaOutput,
  get_report: getReportOutput,
  get_gtm_plan: getGtmPlanOutput,
  get_sample_audit: getSampleAuditOutput,
  check_upgrade_status: checkUpgradeStatusOutput,
};
