/**
 * get_changes [Pro]
 *
 * Pro-gated. Reports the latest like-for-like change in a domain's AI
 * visibility from its stored snapshot history, through `client.getChanges`
 * (GET /api/ai-visibility-history). Only between snapshots that asked the same
 * question: the same business name looked for, and the same queries, which
 * carry the market and the category. When there is no such pair, including a
 * re-baseline after the question changed, a Pro caller gets a clearly-flagged
 * NOT_YET_AVAILABLE saying why — never a fabricated delta.
 *
 * The delta *computation* lives in `computeChanges` and the pairing rule in
 * `sameQuestion` (mappers.ts), both unit-tested.
 */
import type { Changes } from "../api/types.js";
import { gateProTool, fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";

export interface GetChangesArgs {
  domain: string;
  since?: string;
}

export async function getChanges(args: GetChangesArgs, deps: ToolDeps): Promise<ToolResult<Changes>> {
  const gate = await gateProTool(deps);
  if (gate) return gate;

  try {
    const changes = await deps.client.getChanges({ domain: args.domain, since: args.since });
    return ok(changes);
  } catch (e) {
    return fromApiError(e, deps.config, deps.transport, deps.authVia);
  }
}
