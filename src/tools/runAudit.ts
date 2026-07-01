/**
 * run_audit [Free, rate-limited]
 *
 * Runs the real full audit and maps it to the listing-doc return shape:
 * `{ scores, top_issues[], report_url }`.
 */
import type { AuditSummary } from "../api/types.js";
import { toAuditSummary, detectUnreachable } from "../api/mappers.js";
import { gateFreeTool, fromApiError, ok, err, type ToolDeps, type ToolResult } from "./context.js";

export interface RunAuditArgs {
  domain: string;
}

export async function runAudit(args: RunAuditArgs, deps: ToolDeps): Promise<ToolResult<AuditSummary>> {
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
      `The site at ${args.domain} could not be reached, so no audit scores can be produced. Check the domain is correct and publicly reachable.`,
    );
  }

  return ok(toAuditSummary(response.report, { siteUrl: deps.config.siteUrl }));
}
