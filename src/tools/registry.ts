/**
 * Tool registry — the agent-discovery metadata.
 *
 * Names, descriptions and input params are kept VERBATIM from
 * website-auditor-mcp-listing-and-tools.md. Agents bind to these names and match
 * on the trigger phrases in the descriptions, so they must not drift.
 *
 * Only P0_TOOLS are registered on the server today. P1_TOOLS are declared with
 * full metadata + input schemas so adding them in Phase 1 is a wiring change,
 * not a rewrite.
 */
import { z } from "zod";
import type { ZodRawShape } from "zod";
import { OUTPUT_SCHEMAS } from "./outputSchemas.js";

export type ToolTier = "free" | "pro";

export interface ToolSpec {
  name: string;
  tier: ToolTier;
  /** Short human title for clients that show one. */
  title: string;
  /** Verbatim, trigger-first description from the listing doc. */
  description: string;
  /** Zod raw shape registered as the tool's input schema. */
  inputSchema: ZodRawShape;
  /**
   * Zod raw shape registered as the tool's output schema, when one is declared.
   *
   * Optional rather than required so a tool without a stable result shape
   * simply omits it — the SDK validates `structuredContent` against this on
   * every successful call, so declaring a shape we cannot honour turns a
   * working tool into an McpError. Sourced from OUTPUT_SCHEMAS rather than
   * written inline: this file keeps names and descriptions VERBATIM from the
   * listing doc, and the schemas carry their own rationale.
   */
  outputSchema?: ZodRawShape;
}

const domainArg = z.string().describe('The website domain, e.g. "example.com".');

// Optional overrides for the two inputs that decide WHAT QUESTION the audit
// asks. Both were previously unreachable: the schemas accepted `domain` alone,
// so the client filled them in — a hostname slug for the name and a whitespace
// sentinel for the city. A supplied name OVERRIDES detection upstream and is
// stamped `user_supplied`, so an invented one silenced the name_warning it
// should have triggered. Omit them and the engine detects and labels what it
// found; supply them and the caller is on record as the source.
const businessNameArg = z.string().optional().describe(
  "Optional. The business's real name, if you know it. Leave it out and the "
  + "audit detects the name from the site and flags it when unverified — a "
  + "guessed name is scored as if confirmed, so supply one only when it is "
  + "actually known.");
const businessLocationArg = z.string().optional().describe(
  "Optional. The city the business trades in, e.g. \"Hilo, HI\". Leave it out "
  + "and the audit detects it; when nothing is detectable the questions widen "
  + "to the country or drop the place entirely, which is right for a national "
  + "or global business and wrong for a local one.");

// ─── Phase 0 (MVP) ─────────────────────────────────────────────────────────

export const P0_TOOLS: ToolSpec[] = [
  {
    name: "get_ai_visibility",
    // Retiered free -> pro in 1.0.5: no free API tier since api PR #17.
    tier: "pro",
    title: "Check AI visibility",
    description:
      'Check how visible a website is to AI assistants right now. Use this whenever someone asks "does ChatGPT/Perplexity/Claude/Gemini recommend this business," "is my site showing up in AI answers," "what\'s my AI visibility / GEO score," or wants a quick read on whether an AI assistant would surface a given domain. Returns an overall AI-visibility score (0–100), a per-engine breakdown (ChatGPT, Perplexity, Claude, Gemini), and the top competitor appearing in place of the site. When the audit recorded citations, `sources` lists the documents the assistants actually read, ranked by cross-engine agreement, each marked `yours`, `competitor` or `third_party` — treat `competitor` rows as context, not as placement targets; `sources: null` means the recorded answers cited nothing attributable, and an absent key means citations were not recorded for this audit. The result also includes trend data: 7- and 30-day score movement computed from the domain\'s stored snapshot history. If `name_warning` is present, the business name behind the score could not be verified — relay that caveat rather than presenting the score as settled fact, and offer to re-run with an explicit business name. Requires an active subscription.',
    inputSchema: {
      domain: domainArg,
      business_name: businessNameArg,
      business_location: businessLocationArg,
    },
  },
  {
    name: "run_audit",
    // Retiered free -> pro in 1.0.5: no free API tier since api PR #17.
    tier: "pro",
    title: "Run a full audit",
    description:
      'Run a full one-time audit of a website — AI visibility plus SEO, security headers, broken links, and performance. Use this when someone asks to "audit," "scan," "check," or "review" a website\'s health or SEO, or wants a complete report rather than just the AI-visibility number. Returns a scored summary across categories and a link to the full report. The ranked cited-`sources` evidence behind the AI-visibility number is returned by get_ai_visibility, not by this tool. If `name_warning` is present, the business name the AI-visibility score was measured against could not be verified — relay that caveat rather than presenting the score as settled fact. Requires an active subscription.',
    inputSchema: {
      domain: domainArg,
      business_name: businessNameArg,
      business_location: businessLocationArg,
    },
  },
  {
    name: "get_changes",
    tier: "pro",
    title: "What changed since last check",
    description:
      'Report what changed in a website\'s AI visibility and audit since it was last checked. Use this when someone asks "did anything change," "what\'s different this week/month," "did my AI visibility drop," or "did a competitor overtake me." Requires the domain to be tracked (see track_site). Returns deltas: score movement, engines gained/lost, competitors that moved, and new or resolved issues.',
    inputSchema: {
      domain: domainArg,
      since: z.string().optional().describe('Optional ISO date or "last_check".'),
    },
  },
  {
    name: "compare_competitors",
    tier: "pro",
    title: "Compare against competitors",
    description:
      'Compare a website\'s AI visibility head-to-head against named competitors. Use this when someone asks "how do I stack up against X and Y," "who does ChatGPT recommend instead of me," or wants a competitive AI-visibility view. Returns each competitor\'s score and where they appear that the site does not. Each competitor not already cached costs one audit against your daily quota; if the quota can\'t cover every competitor, it ranks the ones it could audit and returns a `quota` summary plus a `skipped` list naming the rest — it never drops competitors silently or invents scores. If the quota is already exhausted it returns an over-quota error with the reset time.',
    inputSchema: {
      domain: domainArg,
      competitors: z.array(z.string()).describe("Competitor domains to compare against."),
    },
  },
];

// ─── Phase 1 (fast follow) ─────────────────────────────────────────────────
// Declared with full metadata. `track_site` is now SERVED (its server-side
// cadence job shipped — see SERVED_TOOLS); the rest stay declared-but-unserved
// until their backends land, so adding them is a wiring change, not a rewrite.

export const P1_TOOLS: ToolSpec[] = [
  {
    name: "track_site",
    tier: "pro",
    title: "Start/stop monitoring",
    description:
      'Start (or stop) ongoing monitoring of a website\'s AI visibility on a schedule. Use this when someone wants to "monitor," "track," "watch," or "get alerted about" a site\'s AI visibility over time, rather than a one-off check. Establishes the history that get_changes reads from.',
    inputSchema: {
      domain: domainArg,
      // Weekly-only in v1 (the server enforces this too). Kept as a single-value
      // enum rather than a free string so agents don't try daily and get an error.
      cadence: z.enum(["weekly"]).default("weekly").describe("Monitoring cadence (weekly)."),
      enabled: z.boolean().default(true).describe("Set false to stop monitoring."),
    },
  },
  {
    name: "get_benchmark",
    tier: "pro",
    title: "Benchmark vs industry/geo",
    description:
      'Benchmark a website\'s AI visibility against its industry and location. Use this when someone asks "how do I compare to others in my space," "is this a good score for my industry," or wants percentile/peer context rather than an absolute number. Backed by aggregated audit data.',
    inputSchema: {
      domain: domainArg,
      industry: z.string().optional().describe("Optional industry override."),
      geo: z.string().optional().describe("Optional location override."),
    },
  },
  {
    name: "get_recommendations",
    tier: "pro",
    title: "Prioritized fixes",
    description:
      'Get specific, prioritized fixes to raise a website\'s AI visibility and audit scores. Use this when someone asks "how do I fix this," "what should I change," "how do I improve my AI visibility," or after an audit surfaces issues. Returns ranked actions with expected impact.',
    inputSchema: { domain: domainArg },
  },
  {
    name: "generate_schema",
    tier: "pro",
    title: "Generate JSON-LD schema",
    description:
      'Generate ready-to-paste structured data (JSON-LD schema) tailored to a website, to improve how AI assistants and search engines understand it. Use this when someone asks for "schema," "structured data," "JSON-LD," or wants the actual markup to implement a recommendation. Returns valid JSON-LD.',
    inputSchema: {
      domain: domainArg,
      type: z
        .enum(["Organization", "LocalBusiness", "Product", "FAQPage", "auto"])
        .optional()
        .describe("Schema type, or auto-detect."),
    },
  },
  {
    name: "get_report",
    tier: "pro",
    title: "Shareable report + badge",
    description:
      'Get a shareable report URL and the embeddable "Audited by Website Auditor" badge snippet for a website. Use this when someone wants to "share," "export," "send a client," or "embed" the audit result. Returns a link and an HTML badge snippet.',
    inputSchema: { domain: domainArg },
  },
];

// ─── Scheduled-monitoring management tools ─────────────────────────────────
// The user-drivable START/STOP/LIST/STATUS surface for the weekly cadence job,
// all backed by website-auditor-api's tracked-domains + monitoring-status
// endpoints. track_site (declared in P1_TOOLS) is the START tool; these are its
// companions. Trigger-first descriptions, consistent with the listing doc.

export const MONITORING_TOOLS: ToolSpec[] = [
  {
    name: "untrack_site",
    tier: "pro",
    title: "Stop monitoring",
    description:
      'Stop ongoing monitoring of a website\'s AI visibility. Use this when someone wants to "stop tracking," "unmonitor," "stop watching," or "remove" a site from scheduled monitoring, or to free up a monitoring slot. Idempotent — safe to call even if the site isn\'t currently tracked. Returns how many monitoring slots are now free.',
    inputSchema: { domain: domainArg },
  },
  {
    name: "list_tracked_sites",
    tier: "pro",
    title: "List monitored sites",
    description:
      'List the websites currently being monitored for AI visibility on a schedule. Use this when someone asks "what am I tracking," "which sites am I monitoring," "how many monitoring slots am I using," or wants to see their tracked domains. Returns each tracked domain with its cadence and active state, plus slots used and remaining (out of 5).',
    inputSchema: {},
  },
  {
    name: "get_monitoring_status",
    tier: "pro",
    title: "Monitoring status summary",
    description:
      'Get a glanceable summary of monitoring status across all tracked websites. Use this when someone asks "how are my tracked sites doing," "what\'s my current AI visibility across everything I monitor," "when were my sites last checked or when do they run next," or wants a dashboard of their monitored domains. Returns, per domain, the latest AI-visibility score, when it was last audited and next runs, and the most recent change since the prior check.',
    inputSchema: {},
  },
];

/**
 * Self-serve subscription introspection (1.0.4). Free tier and unmetered: it
 * reads the caller's own /api/subscription standing — not an audit — so it
 * must never spend audit quota or require Pro.
 */
export const CHECK_UPGRADE_STATUS_TOOL: ToolSpec = {
  name: "check_upgrade_status",
  tier: "free",
  title: "Check upgrade status",
  description:
    'Check the caller\'s own Website Auditor subscription standing. Use this when someone asks "am I on Pro," "is my trial still active," "when does my subscription renew/end," "why is this tool locked," or before suggesting an upgrade. Works with any valid API key and consumes no audit quota. Returns the tier (none/free/pro), raw subscription status, period end, whether the subscription is set to cancel, the upgrade URL, and a plain-language summary — including what starting Pro requires (a payment method and accepting the Terms).',
  inputSchema: {},
};

/**
 * The free demo (1.0.8). The ONLY tool that runs without an API key — no
 * subscription lookup, no network call, no quota.
 *
 * Exists because minting a key requires an active subscription, so a developer
 * evaluating this server otherwise has to pay $10/mo before seeing a single
 * byte of output. Production telemetry showed the cost of that: 102 keyless
 * sessions produced 1 tool call.
 *
 * The description leads with "no API key required" because that phrase is what
 * a model needs to see to pick this tool over refusing outright.
 */
export const GET_SAMPLE_AUDIT_TOOL: ToolSpec = {
  name: "get_sample_audit",
  tier: "free",
  title: "See a sample audit (no key needed)",
  description:
    'Show a complete sample Website Auditor report — no API key required, nothing to set up. Use this whenever someone wants to "try it," "see a demo," "show me what this does," "what does the output look like," or is deciding whether Website Auditor is worth subscribing to — and use it INSTEAD of refusing when no API key is configured. Returns fixed sample data for example.com in the exact shape a real audit returns: scored summary, per-test results, and the AI-visibility breakdown across ChatGPT, Perplexity, Claude and Gemini. It is clearly marked as a sample and always describes example.com, never the user\'s own site — auditing a real domain needs a subscription.',
  inputSchema: {},
};

// The MCP face of the citations-driven GTM chatbot (ships in 1.0.21,
// together with the web widget — the release is held until both exist).
// One-shot with args; the HOST owns the conversation, so refinement is
// "call again with prior_plan". The description mentions `sources` on
// purpose and is therefore under the manifests SOURCED linkage test.
const GET_GTM_PLAN_TOOL: ToolSpec = {
  name: "get_gtm_plan",
  tier: "pro",
  title: "Build a GTM plan from the audit",
  description:
    'Build a written go-to-market plan from a website\'s latest audit, grounded in its citation evidence. ' +
    'Use this when someone asks "what should I do about my AI visibility," "turn this audit into a plan," ' +
    'or wants a GTM or marketing plan for their site. The plan is built from the `sources` the assistants ' +
    'actually read — each marked `yours`, `competitor` or `third_party`; competitor sources shape the ' +
    'analysis but are never placement targets. When the audit recorded no citation evidence the plan ' +
    'grounds itself in the report\'s issues and stats instead. Pass `focus` or `constraints` to ' +
    'steer it, and `prior_plan` (the markdown from an earlier call) to refine rather than start over.',
  inputSchema: {
    domain: domainArg,
    focus: z.string().optional()
      .describe('What to emphasize — e.g. "local directories", "content", "a launch next month".'),
    constraints: z.string().optional()
      .describe('Budget, team, or time constraints — e.g. "solo founder, $200/mo".'),
    prior_plan: z.string().optional()
      .describe("The markdown of a plan from an earlier call, to refine instead of starting over."),
  },
};

/**
 * Attaches the declared output shape, by name.
 *
 * Applied here rather than written into each literal above: the specs are kept
 * verbatim from the listing doc, and one lookup keyed on `name` cannot drift
 * from the map the way fifteen inline fields could. A tool with no entry in
 * OUTPUT_SCHEMAS keeps `outputSchema` undefined and registers exactly as before.
 */
const withOutput = (spec: ToolSpec): ToolSpec => {
  const outputSchema = OUTPUT_SCHEMAS[spec.name];
  return outputSchema ? { ...spec, outputSchema } : spec;
};

export const ALL_TOOL_SPECS: ToolSpec[] = [
  ...P0_TOOLS,
  ...P1_TOOLS,
  ...MONITORING_TOOLS,
  GET_GTM_PLAN_TOOL,
  CHECK_UPGRADE_STATUS_TOOL,
  GET_SAMPLE_AUDIT_TOOL,
].map(withOutput);

const TRACK_SITE_TOOL: ToolSpec = P1_TOOLS.find((t) => t.name === "track_site")!;

// The four Pro-gated read tools whose backends landed in website-auditor-api
// PR #10 (benchmark / recommendations / schema / report). Declared in P1_TOOLS
// with full metadata; now wired to their endpoints and served.
const PHASE1_READ_TOOL_NAMES = ["get_benchmark", "get_recommendations", "generate_schema", "get_report"] as const;
const PHASE1_READ_TOOLS: ToolSpec[] = PHASE1_READ_TOOL_NAMES.map((name) => P1_TOOLS.find((t) => t.name === name)!);

/**
 * The tools actually registered on the running server: the four Phase-0 tools,
 * the scheduled-monitoring surface — track_site (start), untrack_site (stop),
 * list_tracked_sites (list), get_monitoring_status (per-user view) — the four
 * Pro-gated read tools (get_benchmark, get_recommendations, generate_schema,
 * get_report), and check_upgrade_status (1.0.4). Thirteen tools in total.
 */
/**
 * Appended to every subscription-gated description at registration time.
 *
 * Two problems it fixes. First, consistency: get_ai_visibility and run_audit
 * ended with "Requires an active subscription." while the other ten said nothing
 * about auth at all, so the model's picture of what's gated was arbitrary.
 *
 * Second, and the reason for the wording: a bare "requires a subscription" is a
 * dead end. A model reading it with no key configured declines and stops — no
 * tool call, no link, nothing the user can act on. Naming the price and pointing
 * at the free demo turns a refusal into a next step.
 *
 * Applied here rather than edited into the twelve strings above so the trigger
 * phrases stay verbatim (agents bind to those — see this file's header) and the
 * price lives in exactly one place.
 */
const PRO_SUFFIX =
  " Requires a Website Auditor subscription ($10/month; eligible new customers get a 7-day free trial — payment method required, no charge until the trial ends) — if the user doesn't have one, call get_sample_audit first to show them the exact output format, free and with no API key.";

function withProSuffix(spec: ToolSpec): ToolSpec {
  if (spec.tier !== "pro") return spec;
  // Strip the older, inconsistent phrasing so it isn't stated twice.
  const base = spec.description.replace(/\s*Requires an active subscription\.\s*$/, "");
  return { ...spec, description: base + PRO_SUFFIX };
}

export const SERVED_TOOLS: ToolSpec[] = [
  ...P0_TOOLS,
  TRACK_SITE_TOOL,
  ...PHASE1_READ_TOOLS,
  ...MONITORING_TOOLS,
  GET_GTM_PLAN_TOOL,
  CHECK_UPGRADE_STATUS_TOOL,
  GET_SAMPLE_AUDIT_TOOL,
].map(withProSuffix).map(withOutput);
