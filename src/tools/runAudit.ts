/**
 * run_audit [Subscription, rate-limited server-side]
 *
 * Runs the real full audit and maps it to the listing-doc return shape:
 * `{ scores, top_issues[], report_url }`. Requires an active/trialing
 * subscription — there is no free API tier (api PR #17); the pre-flight gate
 * mirrors the server's own 403.
 */
import type { AuditSummary } from "../api/types.js";
import { toAuditSummary, detectUnreachable } from "../api/mappers.js";
import { gateProTool, fromApiError, ok, err, type ToolDeps, type ToolResult } from "./context.js";

export interface RunAuditArgs {
  domain: string;
  /** Optional; omitted means "detect it, and warn if unverified". */
  business_name?: string;
  /** Optional; omitted means "detect it, then scope by what was found". */
  business_location?: string;
}

export async function runAudit(args: RunAuditArgs, deps: ToolDeps): Promise<ToolResult<AuditSummary>> {
  const gate = await gateProTool(deps);
  if (gate) return gate;

  let response;
  try {
    response = await deps.client.runAudit({
      domain: args.domain,
      businessName: args.business_name,
      businessCity: args.business_location,
    });
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
