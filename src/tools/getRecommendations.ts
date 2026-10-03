/**
 * get_recommendations [any key]
 *
 * Read-only. Returns the next steps from the domain's latest audit, each built
 * from that audit's own evidence (website-auditor-api #131, card 227). Wired to
 * `client.getRecommendations` (GET /api/recommendations); the client strips the
 * API's `success` envelope, so this tool returns `{ run_id, tier,
 * recommendations: [{ action, why, expected_impact, effort, source, evidence,
 * locked?, fix_id? }] }`.
 *
 * Needs a key, not a subscription: the API decides the tier from the key's own
 * standing — Pro gets the whole list, a key without Pro the free one — so the
 * pre-flight (gateKeyedTool) refuses only a missing or rejected key.
 */
import type { Recommendations } from "../api/types.js";
import { gateKeyedTool, fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";

export interface GetRecommendationsArgs {
  domain: string;
}

export async function getRecommendations(
  args: GetRecommendationsArgs,
  deps: ToolDeps,
): Promise<ToolResult<Recommendations>> {
  const gate = await gateKeyedTool(deps);
  if (gate) return gate;

  try {
    const recommendations = await deps.client.getRecommendations({ domain: args.domain });
    return ok(recommendations);
  } catch (e) {
    return fromApiError(e, deps.config, deps.transport, deps.authVia);
  }
}
