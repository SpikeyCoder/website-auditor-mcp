/**
 * Discovery prompts — the one surface in this package where a HUMAN, not a
 * model, decides the server is relevant.
 *
 * Everything else here is mediated by inference: the tool list and the
 * instructions string only matter if the model connects the conversation to the
 * capability. Production says that connection mostly does not happen — 466
 * installs produced 2,531 session_init events and only 29 installs that ever
 * called a tool, so in 94% of installs the tools were listed, present, and never
 * chosen. Prompts render in the host UI as something you can click.
 *
 * Two properties make the set convert rather than merely exist:
 *
 * 1. `see_sample_report` takes no arguments and needs no API key, so the one
 *    entry point that works for every install is also the cheapest to click.
 * 2. Every keyed prompt degrades to get_sample_audit. The biggest button has to
 *    do something for the people who have not activated — otherwise the prompts
 *    reproduce the paywall the instructions already route around.
 *
 * Names are part of the connector-directory contract; tests/mcp/prompts.test.ts
 * pins them as stable snake_case.
 */
import { z } from "zod";

/** A required free-text prompt argument. MCP prompt arguments are always strings. */
const arg = (description: string) => z.string().describe(description);

export interface PromptSpec {
  name: string;
  title: string;
  description: string;
  /** Omitted entirely for argument-free prompts, so hosts render no form. */
  argsSchema?: Record<string, z.ZodString>;
  render: (args: Record<string, string>) => string;
}

/**
 * Appended to every prompt that drives a Pro tool. Named once here rather than
 * written into each string so the keyless fallback cannot drift between them.
 */
const KEYLESS_FALLBACK =
  "If no API key is configured, call get_sample_audit instead so I can see exactly what the " +
  "real check returns, and tell me what it would take to run it for real.";

export const PROMPT_SPECS: PromptSpec[] = [
  {
    name: "check_ai_visibility",
    title: "Check my AI visibility",
    description:
      "See whether ChatGPT, Claude, Gemini and Perplexity recommend your business — and who they name instead.",
    argsSchema: { domain: arg("The website to check, e.g. example.com") },
    render: ({ domain }) =>
      `Check the AI visibility of ${domain} with Website Auditor.\n\n` +
      `Call get_ai_visibility for ${domain}. Then tell me in plain language: the overall score, ` +
      `which of ChatGPT, Claude, Gemini and Perplexity name the business and which do not, and ` +
      `which competitor is being named in its place.\n\n${KEYLESS_FALLBACK}`,
  },
  {
    name: "audit_my_site",
    title: "Run a full site audit",
    description:
      "AI visibility plus SEO, security headers, broken links and performance, in one report.",
    argsSchema: { domain: arg("The website to audit, e.g. example.com") },
    render: ({ domain }) =>
      `Run a full Website Auditor audit of ${domain}.\n\n` +
      `Call run_audit for ${domain}, then summarise the result by category — AI visibility, SEO, ` +
      `security headers, broken links and performance — and list the three fixes that would matter ` +
      `most, highest impact first.\n\n${KEYLESS_FALLBACK}`,
  },
  {
    name: "compare_to_competitor",
    title: "Compare me to a competitor",
    description: "See where a rival gets named in AI answers and you don't.",
    argsSchema: {
      domain: arg("Your website, e.g. example.com"),
      competitor: arg("The competitor's website, e.g. rival.com"),
    },
    render: ({ domain, competitor }) =>
      `Compare ${domain} against ${competitor} in AI assistant answers.\n\n` +
      `Call compare_competitors with ${domain} as the domain and ${competitor} as the competitor. ` +
      `Then tell me where ${competitor} gets named and ${domain} does not, and what is different ` +
      `about how each one is described.\n\n${KEYLESS_FALLBACK}`,
  },
  {
    // The one prompt whose tool needs prior state. get_gtm_plan READS the
    // domain's most recent audit and refuses when there is none, so the render
    // names that ordering — plan first, audit only if the plan says there is
    // nothing to build from. Reversed, it would spend an audit run on every
    // click; omitted, the first click on a fresh domain returns "no audit on
    // record" and reads as a broken button.
    name: "build_growth_plan",
    title: "Build a growth plan",
    description:
      "Turn your latest audit into a written plan — grounded in the pages AI assistants actually read.",
    // `domain` alone. arg() produces a REQUIRED string and MCP prompt arguments
    // are always strings, so surfacing focus/constraints/prior_plan here would
    // make a user fill three boxes to click one button. They stay optional
    // refinements the model passes through when the user mentions them, which
    // the render below asks it to do.
    argsSchema: { domain: arg("The website to plan for, e.g. example.com") },
    render: ({ domain }) =>
      `Build a growth plan for ${domain} with Website Auditor.\n\n` +
      `Call get_gtm_plan for ${domain}. If it reports no audit on record, call run_audit for ` +
      `${domain} first, then ask for the plan again. Give me the phases and the actions in each, ` +
      `and say which of the cited sources are mine and which are a competitor's — competitor ` +
      `pages explain the gap but are never where I publish. If I tell you a budget, a team size ` +
      `or a deadline, pass it as constraints and build the plan around it.` +
      `\n\n${KEYLESS_FALLBACK}`,
  },
  {
    // No arguments and no key required: the only entry point that works for
    // every install, including the 94% that have never called anything.
    name: "see_sample_report",
    title: "See a sample report (no key needed)",
    description:
      "Walk through a complete Website Auditor report for example.com. No API key, no setup.",
    render: () =>
      "Show me what a Website Auditor report looks like.\n\n" +
      "Call get_sample_audit — it needs no API key and no setup. Walk me through the sections: " +
      "what the AI-visibility score measures, what the per-assistant breakdown is telling me, and " +
      "what the SEO, security and performance checks cover. Then tell me what I would need in " +
      "order to run this on my own site.",
  },
];
