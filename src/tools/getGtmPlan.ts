/**
 * get_gtm_plan [Pro]
 *
 * The MCP face of the citations-driven GTM chatbot. One-shot BY DESIGN: MCP
 * tools are stateless and the conversation loop belongs to the HOST, so
 * refinement is "call again with `prior_plan`", never a transcript argument
 * (token-heavy and un-schema-able). The tool maps its args onto the proxy's
 * messages[] wire (POST /api/gtm-plan takes {domain, messages}); the plan is
 * composed ENGINE-side from the audit's citation evidence — this tool never
 * fabricates one, and an upstream failure is an error, not a template.
 *
 * Degradation is additive (the getAiVisibility trend_note style): a plan
 * grounded in no attributable citations still returns ok, with
 * `evidence_note` saying so — never an invented evidence list.
 */
import type { GtmChatMessage, GtmPlanResult } from "../api/types.js";
import { normalizeDomain } from "../api/domain.js";
import { WaApiError } from "../api/errors.js";
import { gateProTool, fromApiError, ok, err, type ToolDeps, type ToolResult } from "./context.js";

export interface GetGtmPlanArgs {
  domain: string;
  focus?: string;
  constraints?: string;
  prior_plan?: string;
}

// Steering strings stay short — they ride inside one user message, and the
// proxy mirrors the engine's transcript caps.
const MAX_STEER_CHARS = 300;
// The assistant-message cap the wire actually carries (engine
// GTM_CHAT_MAX_TOKENS * 8, mirrored by the proxy). A longer prior plan is a
// normal artifact of this very tool, so it is TRIMMED (keeping the tail,
// where the most recent sequencing lives) rather than bounced. Left at half
// the wire's cap it silently discarded plan the proxy would have accepted —
// on the refinement path, where the tail is what the user is refining.
const MAX_PRIOR_PLAN_CHARS = 8192;

function buildMessages(args: GetGtmPlanArgs, domain: string): GtmChatMessage[] {
  const steer =
    (args.focus ? ` Focus on: ${args.focus.trim()}.` : "") +
    (args.constraints ? ` Constraints: ${args.constraints.trim()}.` : "");
  const brief =
    `Prepare a written go-to-market plan for ${domain}, grounded in this ` +
    `audit's citation evidence — the documents the AI assistants actually read.`;

  // Blank is absent, not a turn: the engine refuses empty content (the
  // Messages API does), and a whitespace assistant message reached the user
  // as a generic upstream failure they could only answer by retrying it.
  const prior = (args.prior_plan ?? "").trim();
  if (!prior) {
    return [{ role: "user", content: brief + steer }];
  }
  return [
    { role: "user", content: brief },
    { role: "assistant", content: prior.slice(-MAX_PRIOR_PLAN_CHARS) },
    { role: "user", content: `Refine the plan above.${steer}` },
  ];
}

export async function getGtmPlan(
  args: GetGtmPlanArgs,
  deps: ToolDeps,
): Promise<ToolResult<GtmPlanResult>> {
  const gate = await gateProTool(deps);
  if (gate) return gate;

  for (const [name, value] of [["focus", args.focus], ["constraints", args.constraints]] as const) {
    if (value && value.length > MAX_STEER_CHARS) {
      return err("INVALID_INPUT", `\`${name}\` must be ${MAX_STEER_CHARS} characters or fewer.`);
    }
  }

  // The same normalization every other domain tool applies (run_audit,
  // track_site, compare_competitors). The proxy's own check is a strict bare
  // -host regex, so a URL-shaped argument — the form run_audit accepts and
  // therefore the form a host model already holds — was refused there as a
  // bare "Validation failed", breaking the audit-then-plan handoff on the
  // identical string.
  let domain: string;
  try {
    domain = normalizeDomain(args.domain);
  } catch (e) {
    return fromApiError(e, deps.config, deps.transport);
  }

  try {
    const plan = await deps.client.getGtmPlan({
      domain,
      messages: buildMessages(args, domain),
    });

    const result: GtmPlanResult = {
      domain,
      plan: { markdown: plan.plan_markdown, sections: plan.plan_sections },
      sources_used: plan.sources_used,
      model: plan.model,
      summary:
        `GTM plan for ${domain}: ${plan.plan_sections.length} sections` +
        (plan.plan_sections.length
          ? ` (${plan.plan_sections.map((s) => s.title).join(", ")})`
          : "") +
        (plan.sources_used.length
          ? `, grounded in ${plan.sources_used.length} cited source domains.`
          : "."),
    };
    if (plan.sources_used.length === 0) {
      // sources_used is DERIVED from the plan's prose, so an empty list has
      // three indistinguishable causes on the wire: no citations recorded,
      // answers that cited nothing attributable, or a plan that discussed
      // the sources without typing their domains. Asserting the first
      // contradicted the sources list the host may have relayed moments
      // earlier — so the note states only what the wire proves.
      result.evidence_note =
        "This plan names no domains from the audit's citation evidence — " +
        "either none was recorded, or the plan discussed the sources without " +
        "naming them. get_ai_visibility shows which.";
    }
    return ok(result);
  } catch (e) {
    // The proxy answers 404 for "no audit on record for this domain" with a
    // REST remedy ("run one first via GET /api/audit") that an MCP caller
    // cannot follow — and it arrives as a bare upstream error. Name the tool
    // that actually fixes it.
    if (e instanceof WaApiError && e.status === 404) {
      return err(
        "INVALID_INPUT",
        `No audit on record for ${domain}. Run run_audit for ${domain} first, then ask for the plan again.`,
      );
    }
    return fromApiError(e, deps.config, deps.transport);
  }
}
