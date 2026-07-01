/**
 * get_changes [Pro]
 *
 * Pro-gated. The delta/history data source is not yet available in
 * website-auditor-api (PRD open question #2). The tool is fully wired against
 * `client.getChanges`: once that endpoint ships and the client method returns
 * real deltas, this tool returns them with no further change. Until then a Pro
 * caller gets a clearly-flagged NOT_YET_AVAILABLE — never a fabricated delta.
 *
 * The delta *computation* itself lives in `computeChanges` (mappers.ts) and is
 * unit-tested, so the client can wire it over a history endpoint when ready.
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
    return fromApiError(e, deps.config.upgradeUrl);
  }
}
