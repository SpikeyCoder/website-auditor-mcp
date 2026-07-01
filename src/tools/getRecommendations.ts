/**
 * get_recommendations [Pro]
 *
 * Pro-gated, read-only. Returns specific, prioritized fixes to raise a domain's
 * AI-visibility and audit scores. Wired to `client.getRecommendations`
 * (GET /api/recommendations). The client strips the API's `success` envelope, so
 * this tool returns the documented `{ recommendations: [{ action, why,
 * expected_impact, effort }] }` shape.
 */
import type { Recommendations } from "../api/types.js";
import { gateProTool, fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";

export interface GetRecommendationsArgs {
  domain: string;
}

export async function getRecommendations(
  args: GetRecommendationsArgs,
  deps: ToolDeps,
): Promise<ToolResult<Recommendations>> {
  const gate = await gateProTool(deps);
  if (gate) return gate;

  try {
    const recommendations = await deps.client.getRecommendations({ domain: args.domain });
    return ok(recommendations);
  } catch (e) {
    return fromApiError(e, deps.config.upgradeUrl);
  }
}
