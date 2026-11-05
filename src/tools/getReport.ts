/**
 * get_report [Pro]
 *
 * Pro-gated, read-only. Returns a shareable report URL and the embeddable
 * "Audited by Website Auditor" badge snippet for a domain. Wired to
 * `client.getReport` (GET /api/report). The client strips the API's `success`
 * envelope, so this tool returns the documented `{ report_url, badge_html }`
 * shape.
 */
import type { ReportLinks } from "../api/types.js";
import { gateAuditTool, fromApiError, isNoAuditOnRecord, noAuditYet, ok, type ToolDeps, type ToolResult } from "./context.js";

export interface GetReportArgs {
  domain: string;
}

export async function getReport(args: GetReportArgs, deps: ToolDeps): Promise<ToolResult<ReportLinks>> {
  // A free ChatGPT account reads the link to its own latest audit (the API
  // looks it up by the caller's account, so it can only be one of theirs).
  const { gate } = await gateAuditTool(deps, args.domain);
  if (gate) return gate;

  try {
    const report = await deps.client.getReport({ domain: args.domain });
    return ok(report);
  } catch (e) {
    // The API's 404 "No audit on record": nothing to report yet, not a failure.
    if (isNoAuditOnRecord(e)) return noAuditYet(deps, args.domain);
    return fromApiError(e, deps.config, deps.transport, deps.authVia, args.domain);
  }
}
