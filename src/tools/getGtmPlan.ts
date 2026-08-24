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
// The engine's assistant-message cap. A longer prior plan is a normal
// artifact of this very tool, so it is TRIMMED (keeping the tail, where the
// most recent sequencing lives) rather than bounced.
const MAX_PRIOR_PLAN_CHARS = 4000;

function buildMessages(args: GetGtmPlanArgs): GtmChatMessage[] {
  const steer =
    (args.focus ? ` Focus on: ${args.focus.trim()}.` : "") +
    (args.constraints ? ` Constraints: ${args.constraints.trim()}.` : "");
  const brief =
    `Prepare a written go-to-market plan for ${args.domain}, grounded in this ` +
    `audit's citation evidence — the documents the AI assistants actually read.`;

  if (!args.prior_plan) {
    return [{ role: "user", content: brief + steer }];
  }
  return [
    { role: "user", content: brief },
    { role: "assistant", content: args.prior_plan.slice(-MAX_PRIOR_PLAN_CHARS) },
    { role: "user", content: `Refine the plan above.${steer}` || "Refine the plan above." },
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

  try {
    const plan = await deps.client.getGtmPlan({
      domain: args.domain,
      messages: buildMessages(args),
    });

    const result: GtmPlanResult = {
      domain: args.domain,
      plan: { markdown: plan.plan_markdown, sections: plan.plan_sections },
      sources_used: plan.sources_used,
      model: plan.model,
      summary:
        `GTM plan for ${args.domain}: ${plan.plan_sections.length} sections` +
        (plan.plan_sections.length
          ? ` (${plan.plan_sections.map((s) => s.title).join(", ")})`
          : "") +
        (plan.sources_used.length
          ? `, grounded in ${plan.sources_used.length} cited source domains.`
          : "."),
    };
    if (plan.sources_used.length === 0) {
      result.evidence_note =
        "This plan is grounded in the report's issues and stats; the audit " +
        "recorded no citation evidence, so no source domains back it.";
    }
    return ok(result);
  } catch (e) {
    return fromApiError(e, deps.config);
  }
}
