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

/**
 * What a call does to the world. Every ToolSpec declares one, and it is the
 * single source of the tool's MCP annotations (annotationsFor in
 * src/mcp/server.ts) and of its manifest.json label (checked in
 * tests/manifests.test.ts). Required, so a new tool cannot fall through to
 * read-only: that default is how three audit tools shipped readOnlyHint true
 * until the ChatGPT/Codex portal flagged them (2026-10-05 UTC).
 *
 * OpenAI's definitions (developers.openai.com/plugins/build/mcp-server):
 *   readOnlyHint    — "true only when the tool cannot change state".
 *   destructiveHint — "true when a tool can cause irreversible or difficult
 *                     to reverse outcomes".
 *   openWorldHint   — "true when a tool accesses the public internet or
 *                     open-ended external entities ... A tool limited to a
 *                     bounded private account or workspace can set this to
 *                     false, even when that service is externally hosted."
 * The rule applied: open-world exactly when the call makes something reach
 * the public internet — an audit crawls the site and queries the AI engines,
 * and enrolling schedules weekly audits. Reading what this service already
 * holds, building an answer from the input, and writing a growth plan from
 * the stored audit (the plan engine carries no web search: chaos_tester
 * gtm_chat.py) are closed-world. Spending a daily allowance is not
 * destructive: it is not irreversible, the allowance resets each day.
 */
export type ToolEffect =
  | "stored"      // reads data this service holds (the caller's audits, account, aggregates)
  | "computes"    // builds its answer from the input alone (generate_schema's template)
  | "local"       // a bundled fixture; no network (get_sample_audit)
  | "runs-audit"  // starts a new audit: a stored report and a unit of daily quota
  | "runs-audits" // one audit per uncached site compared (compare_competitors)
  | "uses-plan"   // generates a growth plan: one of the daily plan allowance
  | "enrolls"     // enrolls a domain in weekly audits; enabled:false deletes the tracking row
  | "untracks";   // deletes the tracking row

export interface EffectTraits {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  /** The bracketed label manifest.json gives the tool after its title. */
  label: string;
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const SPENDS = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

/** Exhaustive by type: a new effect does not compile until it has a row. */
export const EFFECTS: Record<ToolEffect, EffectTraits> = {
  stored: { ...READ, label: "[read-only]" },
  computes: { ...READ, label: "[read-only]" },
  // The sample's listing opens with its pitch and carries no label.
  local: { ...READ, label: "" },
  "runs-audit": { ...SPENDS, label: "[runs an audit]" },
  // Cached audits are reused at no quota cost; each uncached site costs one.
  "runs-audits": { ...SPENDS, label: "[runs an audit per uncached site]" },
  // Written from the stored audit; the plan engine searches nothing. It also
  // refreshes the account's dashboard tasks — derived data, recomputed on
  // every refresh — so it is not destructive.
  "uses-plan": { ...SPENDS, openWorldHint: false, label: "[uses a daily plan]" },
  // Both tracking tools can make the same hard delete (there is no pause);
  // enrolling also schedules weekly audits of a public domain.
  enrolls: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, label: "[destructive: writes tracking state]" },
  untracks: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, label: "[destructive: writes tracking state]" },
};

export const labelFor = (spec: { effect: ToolEffect }): string => EFFECTS[spec.effect].label;

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
  /** What a call does to the world: see ToolEffect and EFFECTS above. */
  effect: ToolEffect;
  /**
   * A free-tier tool that still needs an account (a key, or a connected login)
   * to do anything. Every Pro tool does by definition; this marks the free ones
   * that do too, so the Mixed Auth listing asks for a login up front instead of
   * advertising `noauth` for a tool that can only answer AUTH_REQUIRED without
   * one. See securitySchemesFor.
   */
  needsAccount?: boolean;
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
//: The same field, described for a tool that audits SEVERAL domains.
//:
//: businessLocationArg's text says "the city the business trades in" and
//: "leave it out and the audit detects it" — both written for a
//: single-business tool. On a comparison the location is the QUESTION's, and
//: it is applied to every domain in it; a model reading the single-business
//: wording has no way to learn that.
const compareLocationArg = z.string().optional().describe(
  "Optional. The market to compare within, e.g. \"Chiang Mai, Thailand\". "
  + "Applied to the site AND every competitor, because a comparison asks "
  + "about one market — scoring one locally and the others globally would "
  + "rank answers to two different questions. Leave it out and each audit "
  + "detects its own location, which is right for national or global "
  + "businesses and wrong for local ones.");

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
    effect: "runs-audit",
    title: "Check AI visibility",
    description:
      'Check how visible a website is to AI assistants right now. Use this whenever someone asks "does ChatGPT/Perplexity/Claude/Gemini recommend this business," "is my site showing up in AI answers," "what\'s my AI visibility / GEO score," or wants a quick read on whether an AI assistant would surface a given domain. Returns an overall AI-visibility score (0–100), a per-engine breakdown (ChatGPT, Perplexity, Claude, Gemini), and the top competitor appearing in place of the site. When the audit recorded citations, `sources` lists the documents the assistants actually read, ranked by cross-engine agreement, each marked `yours`, `competitor` or `third_party` — treat `competitor` rows as context, not as placement targets; `sources: null` means the recorded answers cited nothing attributable, and an absent key means citations were not recorded for this audit. The result also includes trend data: 7- and 30-day score movement computed from the domain\'s stored snapshot history, for the question this audit asked, ending at the snapshot this audit stored; when it stored no measured snapshot, `trend` is null and `trend_note` says why. If `name_warning` is present, the business name behind the score could not be verified — relay that caveat rather than presenting the score as settled fact, and offer to re-run with an explicit business name. Requires an active subscription.',
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
    effect: "runs-audit",
    title: "Run a full audit",
    // No "SEO" claim: there is no SEO module upstream. `scores.seo` is
    // seoProxyScore() in src/api/mappers.ts, a share of crawlability and markup
    // signals, and the description names them. Pinned (here and in
    // manifest.json) by tests/tools/runAuditSaysWhatItChecks.test.ts.
    description:
      'Run a full one-time audit of a website — AI visibility, plus security headers, broken links, performance, and a crawlability-and-markup score (`scores.seo`: robots.txt, AI crawler access, sitemap, structured data, meta description and Open Graph tags). Use this when someone asks to "audit," "scan," "check," or "review" a website\'s health, or wants a complete report rather than just the AI-visibility number. Returns a scored summary across categories and a link to the full report. The ranked cited-`sources` evidence behind the AI-visibility number is returned by get_ai_visibility, not by this tool. If `name_warning` is present, the business name the AI-visibility score was measured against could not be verified — relay that caveat rather than presenting the score as settled fact. Requires an active subscription.',
    inputSchema: {
      domain: domainArg,
      business_name: businessNameArg,
      business_location: businessLocationArg,
    },
  },
  {
    name: "get_changes",
    tier: "pro",
    effect: "stored",
    title: "What changed in AI visibility",
    description:
      'Report what changed in a website\'s AI-visibility score, only between two snapshots that asked the same question. Use this when someone asks "did anything change," "what\'s different this week/month," or "did my AI visibility drop." The domain need not be tracked: history accrues from any audit of it, tracked or not — track_site adds the weekly re-audits to the series, it is not a precondition, so do not track a site just to answer a change question. Returns the change in the overall score and the per-engine score changes, for engines measured both times — the overall only when the same engines answered both snapshots, otherwise it is null with an overall_note naming which answered each, and the per-engine changes stand alone; competitor_changes, new_issues and resolved_issues are always empty, since snapshots record neither competitors nor audit issues. A change is only ever measured between two snapshots that asked the same question (the same business name, market and queries); when there is no such pair it says why instead of giving a number, with the date the series re-baselined when it did. The series is the measured weekly re-audits and any audit that asked the same question as the newest recorded one, while it has no gap longer than four weeks and a day from the newest weekly re-audit that recorded its question, through each later snapshot of the series (weekly re-audits included, recorded or not), to the newest measured snapshot; otherwise every measured snapshot.',
    inputSchema: {
      domain: domainArg,
      since: z.string().optional().describe('Optional ISO date or "last_check".'),
    },
  },
  {
    name: "compare_competitors",
    tier: "pro",
    effect: "runs-audits",
    title: "Compare against competitors",
    description:
      'Compare a website\'s AI visibility head-to-head against named competitors. Use this when someone asks "how do I stack up against X and Y," "who does ChatGPT recommend instead of me," or wants a competitive AI-visibility view. Returns each competitor\'s score and where they appear that the site does not. Each competitor not already cached costs one audit against your daily quota; if the quota can\'t cover every competitor, it ranks the ones it could audit and returns a `quota` summary plus a `skipped` list naming the rest — it never drops competitors silently or invents scores. If the quota is already exhausted it returns an over-quota error with the reset time.',
    inputSchema: {
      domain: domainArg,
      competitors: z.array(z.string()).describe("Competitor domains to compare against."),
      // ONE LOCATION FOR THE WHOLE COMPARISON, and no business_name.
      //
      // A comparison is a question about one market — "who does ChatGPT
      // recommend for a trauma retreat in Chiang Mai" — so the place belongs
      // to the question, not to each domain in it, and it is applied to every
      // audit the tool fans out. A name does not work that way: it identifies
      // ONE business, and forwarding the caller's to their competitors would
      // score every one of them as the caller.
      //
      // Optional, like everywhere else it appears. Omitted, each audit detects
      // its own location exactly as it does today.
      business_location: compareLocationArg,
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
    effect: "enrolls",
    title: "Start/stop monitoring",
    description:
      'Start (or stop) ongoing monitoring of a website\'s AI visibility on a schedule. Use this when someone wants to "monitor," "track," "watch," or "get alerted about" a site\'s AI visibility over time, rather than a one-off check. Adds weekly re-audits to the history that get_changes reads from — a history every audit already accrues, tracked or not — so use this to be watched on a schedule, not to make get_changes work. Passing enabled: false stops monitoring by deleting the enrollment, as untrack_site does.',
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
    effect: "stored",
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
    // Free-tier since website-auditor-api #131 (card 227): any valid key is
    // answered, and the API decides how much of the list it gets.
    tier: "free",
    effect: "stored",
    needsAccount: true,
    title: "Prioritized fixes",
    description:
      'Get specific, prioritized fixes to raise a website\'s AI visibility and audit scores. Use this when someone asks "how do I fix this," "what should I change," "how do I improve my AI visibility," or after an audit surfaces issues. Returns ranked actions with expected impact, each built from the domain\'s latest audit and citing its evidence (blocked AI crawlers, missing structured data, the competitor sites the assistants cited). Works with any Website Auditor API key and needs an audit on record for the domain; with Pro it also says where to get listed, what the assistants get wrong about the business, and which file in the fix package fixes each finding — without Pro the listing places are only counted.',
    inputSchema: { domain: domainArg },
  },
  {
    name: "generate_schema",
    tier: "pro",
    effect: "computes",
    title: "Generate JSON-LD schema",
    description:
      'Generate structured data (JSON-LD schema) tailored to a website, to improve how AI assistants and search engines understand it. Use this when someone asks for "schema," "structured data," "JSON-LD," or wants the actual markup to implement a recommendation. Returns a DRAFT, not finished markup: every name field arrives as a placeholder — "Your Business Name" on the business types, and on a Product the product\'s own name and brand as "Your Product Name" and "Brand Name" — that the owner must replace with real names confirmed with them, never guessed from the domain or copied from an audit. `placement_notes` says what to replace first, then where to embed the finished snippet, so relay the whole ask and do not tell the user to paste the draft as returned.',
    inputSchema: {
      domain: domainArg,
      type: z
        .enum(["Organization", "LocalBusiness", "Product", "FAQPage", "auto"])
        .optional()
        .describe(
          'Schema type; "auto" (also the default when omitted) does not detect anything — it returns an Organization draft.'),
    },
  },
  {
    name: "get_report",
    tier: "pro",
    effect: "stored",
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
    effect: "untracks",
    title: "Stop monitoring",
    description:
      'Stop ongoing monitoring of a website\'s AI visibility. Use this when someone wants to "stop tracking," "unmonitor," "stop watching," or "remove" a site from scheduled monitoring, or to free up a monitoring slot. Removing a tracked site deletes its monitoring enrollment (its past audits are kept); calling it for a site that isn\'t tracked changes nothing. Returns how many monitoring slots are now free.',
    inputSchema: { domain: domainArg },
  },
  {
    name: "list_tracked_sites",
    tier: "pro",
    effect: "stored",
    title: "List monitored sites",
    description:
      'List the websites currently being monitored for AI visibility on a schedule. Use this when someone asks "what am I tracking," "which sites am I monitoring," "how many monitoring slots am I using," or wants to see their tracked domains. Returns each tracked domain with its cadence and active state, plus slots used and remaining (out of 5).',
    inputSchema: {},
  },
  {
    name: "get_monitoring_status",
    tier: "pro",
    effect: "stored",
    title: "Monitoring status summary",
    description:
      'Get a glanceable summary of monitoring status across all tracked websites. Use this when someone asks "how are my tracked sites doing," "what\'s my current AI visibility across everything I monitor," "when were my sites last checked or when do they run next," or wants a dashboard of their monitored domains. Returns, per domain, the latest AI-visibility score of its series (the measured weekly re-audits and any audit that asked the same question as the newest recorded one, while it has no gap longer than four weeks and a day from the newest weekly re-audit that recorded its question, through each later snapshot of the series (weekly re-audits included, recorded or not), to the newest measured snapshot; otherwise every measured snapshot; a newer measured snapshot outside the series is not shown, and get_changes names it), the date of its last scheduled run and when the next one runs, and the most recent change against the last snapshot that asked the same question, or a note or the summary saying why there is none — when different engines answered the two snapshots, the change shows the per-engine changes only, with a note naming which answered each, and its score_delta is null; like get_changes, a change carries competitor_changes, new_issues and resolved_issues, always empty.',
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
  effect: "stored",
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
  effect: "local",
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
  effect: "uses-plan",
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

// The four read tools whose backends landed in website-auditor-api PR #10
// (benchmark / recommendations / schema / report). Declared in P1_TOOLS with
// full metadata; now wired to their endpoints and served. Three are Pro-gated;
// get_recommendations answers any key since api #131.
const PHASE1_READ_TOOL_NAMES = ["get_benchmark", "get_recommendations", "generate_schema", "get_report"] as const;
const PHASE1_READ_TOOLS: ToolSpec[] = PHASE1_READ_TOOL_NAMES.map((name) => P1_TOOLS.find((t) => t.name === name)!);

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

/**
 * The tools actually registered on the running server: the four Phase-0 tools,
 * the scheduled-monitoring surface — track_site (start), untrack_site (stop),
 * list_tracked_sites (list), get_monitoring_status (per-user view) — the four
 * read tools (get_benchmark, generate_schema and get_report, Pro-gated, and
 * get_recommendations, any key), get_gtm_plan, check_upgrade_status (1.0.4)
 * and get_sample_audit (no key at all).
 */
export const SERVED_TOOLS: ToolSpec[] = [
  ...P0_TOOLS,
  TRACK_SITE_TOOL,
  ...PHASE1_READ_TOOLS,
  ...MONITORING_TOOLS,
  GET_GTM_PLAN_TOOL,
  CHECK_UPGRADE_STATUS_TOOL,
  GET_SAMPLE_AUDIT_TOOL,
].map(withProSuffix).map(withOutput);
