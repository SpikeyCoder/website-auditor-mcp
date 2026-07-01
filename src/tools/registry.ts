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
}

const domainArg = z.string().describe('The website domain, e.g. "example.com".');

// ─── Phase 0 (MVP) ─────────────────────────────────────────────────────────

export const P0_TOOLS: ToolSpec[] = [
  {
    name: "get_ai_visibility",
    tier: "free",
    title: "Check AI visibility",
    description:
      'Check how visible a website is to AI assistants right now. Use this whenever someone asks "does ChatGPT/Perplexity/Claude/Gemini recommend this business," "is my site showing up in AI answers," "what\'s my AI visibility / GEO score," or wants a quick read on whether an AI assistant would surface a given domain. Returns an overall AI-visibility score (0–100), a per-engine breakdown (ChatGPT, Perplexity, Claude, Gemini), and the top competitor appearing in place of the site.',
    inputSchema: { domain: domainArg },
  },
  {
    name: "run_audit",
    tier: "free",
    title: "Run a full audit",
    description:
      'Run a full one-time audit of a website — AI visibility plus SEO, security headers, broken links, and performance. Use this when someone asks to "audit," "scan," "check," or "review" a website\'s health or SEO, or wants a complete report rather than just the AI-visibility number. Returns a scored summary across categories and a link to the full report.',
    inputSchema: { domain: domainArg },
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

export const ALL_TOOL_SPECS: ToolSpec[] = [...P0_TOOLS, ...P1_TOOLS, ...MONITORING_TOOLS];

const TRACK_SITE_TOOL: ToolSpec = P1_TOOLS.find((t) => t.name === "track_site")!;

// The four Pro-gated read tools whose backends landed in website-auditor-api
// PR #10 (benchmark / recommendations / schema / report). Declared in P1_TOOLS
// with full metadata; now wired to their endpoints and served.
const PHASE1_READ_TOOL_NAMES = ["get_benchmark", "get_recommendations", "generate_schema", "get_report"] as const;
const PHASE1_READ_TOOLS: ToolSpec[] = PHASE1_READ_TOOL_NAMES.map((name) => P1_TOOLS.find((t) => t.name === name)!);

/**
 * The tools actually registered on the running server: the four Phase-0 tools,
 * the scheduled-monitoring surface — track_site (start), untrack_site (stop),
 * list_tracked_sites (list), get_monitoring_status (per-user view) — and the
 * four Pro-gated read tools (get_benchmark, get_recommendations,
 * generate_schema, get_report) now that their website-auditor-api endpoints have
 * shipped. Twelve tools in total.
 */
export const SERVED_TOOLS: ToolSpec[] = [...P0_TOOLS, TRACK_SITE_TOOL, ...PHASE1_READ_TOOLS, ...MONITORING_TOOLS];
