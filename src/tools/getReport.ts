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
import { gateProTool, fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";

export interface GetReportArgs {
  domain: string;
}

export async function getReport(args: GetReportArgs, deps: ToolDeps): Promise<ToolResult<ReportLinks>> {
  const gate = await gateProTool(deps);
  if (gate) return gate;

  try {
    const report = await deps.client.getReport({ domain: args.domain });
    return ok(report);
  } catch (e) {
    return fromApiError(e, deps.config.upgradeUrl);
  }
}
