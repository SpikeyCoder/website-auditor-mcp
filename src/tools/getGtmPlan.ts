/**
 * get_gtm_plan [Pro]
 *
 * The MCP face of the citations-driven GTM chatbot. One-shot BY DESIGN: MCP
 * tools are stateless and the conversation loop belongs to the HOST, so
 * refinement is "call again with `prior_plan`", never a transcript argument
 * (token-heavy and un-schema-able). The tool maps its args onto the proxy's
 * messages[] wire (POST /api/growth-plan takes {domain, messages}); the plan
 * is composed ENGINE-side from the audit's citation evidence — this tool
 * never fabricates one, and an upstream failure is an error, not a template.
 *
 * Degradation is additive (the getAiVisibility trend_note style): a plan
 * grounded in no attributable citations still returns ok, with
 * `evidence_note` saying so — never an invented evidence list.
 *
 * THE PHASE CARDS (api PR #84, engine chaos_tester #489). The same plan
 * arrives a second way, parsed into 30/60/90-day cards, and it is relayed
 * UNEDITED. Nothing here defaults a null: the engine leaves a field null
 * exactly when the plan did not write it, so filling one in would put an
 * effort estimate or a priority on the customer's calendar that no model
 * produced. `[]` and absent are relayed as they arrived — see api/types.ts.
 *
 * STILL THE DOMAIN HANDLE, and still only that one. The proxy takes exactly
 * one of run_id or domain, and an MCP caller holds neither a run_id nor
 * anything that converts to one: run_audit returns report_url, which carries
 * reports.id — a disjoint id space. So `domain` stays the argument and the
 * proxy resolves the caller's latest run for it server-side. A run_id
 * argument would be additive if a caller ever came to hold one; what this
 * tool must never do is invent one to fill it.
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

/** "1 section" / "2 sections". The summary is prose, and a host model reads it out. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

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
    return fromApiError(e, deps.config, deps.transport, deps.authVia);
  }

  try {
    const plan = await deps.client.getGtmPlan({
      domain,
      messages: buildMessages(args, domain),
    });

    // Counted, not composed: every number below is a length of something the
    // wire delivered. A phase whose actions the plan wrote as prose is
    // legitimately empty, so the total is what decides whether the summary
    // mentions cards at all — "0 actions" reads as a plan with nothing in it,
    // which is exactly the claim the engine collapses plan_phases to `[]` to
    // avoid making.
    const phases = plan.plan_phases;
    const actionCount = (phases ?? []).reduce(
      (n, phase) => n + (Array.isArray(phase.actions) ? phase.actions.length : 0),
      0,
    );

    const result: GtmPlanResult = {
      domain,
      plan: {
        markdown: plan.plan_markdown,
        sections: plan.plan_sections,
        // Spread so an absent key stays absent. `phases: undefined` would
        // still be an own property, and `in` checks — the caller's only way
        // to tell "this engine parsed no cards" from "an engine that predates
        // them" — would answer true for both.
        ...(phases ? { phases } : {}),
      },
      sources_used: plan.sources_used,
      model: plan.model,
      summary:
        `GTM plan for ${domain}: ${count(plan.plan_sections.length, "section")}` +
        (plan.plan_sections.length
          ? ` (${plan.plan_sections.map((s) => s.title).join(", ")})`
          : "") +
        (phases && actionCount
          ? `, ${count(actionCount, "action")} across ${count(phases.length, "phase")}`
          : "") +
        (plan.sources_used.length
          ? `, grounded in ${count(plan.sources_used.length, "cited source domain")}.`
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
    // that actually fixes it. Unchanged by the move to /api/growth-plan: the
    // ownership lookup runs before the counter on both names, so a domain the
    // caller never audited still costs nothing and still reads as a 404.
    if (e instanceof WaApiError && e.status === 404) {
      return err(
        "INVALID_INPUT",
        `No audit on record for ${domain}. Run run_audit for ${domain} first, then ask for the plan again.`,
      );
    }
    return fromApiError(e, deps.config, deps.transport, deps.authVia);
  }
}
