/**
 * list_tracked_sites [Pro]
 *
 * List the domains currently enrolled for scheduled monitoring, with cadence,
 * active state, and slot accounting (used / remaining of the 5-domain cap).
 * Read-only.
 */
import type { TrackedDomain } from "../api/types.js";
import { gateProTool, fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";

export interface ListTrackedSitesResult {
  limit: number;
  used: number;
  remaining: number;
  tracked: TrackedDomain[];
  summary: string;
}

export async function listTrackedSites(_args: Record<string, never>, deps: ToolDeps): Promise<ToolResult<ListTrackedSitesResult>> {
  const gate = await gateProTool(deps);
  if (gate) return gate;

  try {
    const res = await deps.client.listTrackedDomains();
    const summary =
      res.used === 0
        ? `No sites are being monitored yet (0 of ${res.limit} slots used). Use track_site to start.`
        : `Monitoring ${res.used} of ${res.limit} site(s); ${res.remaining} slot(s) free.`;
    return ok({
      limit: res.limit,
      used: res.used,
      remaining: res.remaining,
      tracked: res.tracked,
      summary,
    });
  } catch (e) {
    return fromApiError(e, deps.config.upgradeUrl);
  }
}
