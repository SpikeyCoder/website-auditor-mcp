/**
 * get_ai_visibility [Free]
 *
 * Maps to the real audit endpoint and returns the AI-visibility slice. There is
 * no AI-visibility-only endpoint upstream, so this runs the full audit and
 * extracts the `ai_visibility` block (a thin, honest adaptation).
 */
import type { AiVisibility } from "../api/types.js";
import { toAiVisibility, detectUnreachable } from "../api/mappers.js";
import { gateFreeTool, fromApiError, ok, err, type ToolDeps, type ToolResult } from "./context.js";

export interface GetAiVisibilityArgs {
  domain: string;
}

export async function getAiVisibility(args: GetAiVisibilityArgs, deps: ToolDeps): Promise<ToolResult<AiVisibility>> {
  const gate = await gateFreeTool(deps, args.domain);
  if (gate) return gate;

  let response;
  try {
    response = await deps.client.runAudit({ domain: args.domain });
  } catch (e) {
    return fromApiError(e, deps.config.upgradeUrl);
  }

  if (detectUnreachable(response.report)) {
    return err(
      "UNREACHABLE_DOMAIN",
      `The site at ${args.domain} could not be reached, so no AI-visibility score can be produced. Check the domain is correct and publicly reachable.`,
    );
  }

  return ok(toAiVisibility(response.report));
}
