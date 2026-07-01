/**
 * track_site [Pro]
 *
 * Start (or stop) weekly scheduled monitoring of a domain's AI visibility. The
 * schedule itself lives SERVER-SIDE in website-auditor-api (the MCP client isn't
 * always connected, so it can't be relied on to run anything on a cadence); this
 * tool is a thin enroll/unenroll call. Enrollment establishes the snapshot
 * history that get_changes reads.
 *
 * Product rules surfaced as clean structured errors:
 *   - Pro-gated (PRO_REQUIRED for free/no key)
 *   - at most 5 tracked domains (LIMIT_REACHED on the 6th — untrack one first)
 *   - weekly cadence only in v1 (INVALID_INPUT for anything else)
 */
import { gateProTool, fromApiError, ok, err, type ToolDeps, type ToolResult } from "./context.js";

export interface TrackSiteArgs {
  domain: string;
  cadence?: "weekly";
  /** Set false to STOP monitoring the domain. Defaults to true (start). */
  enabled?: boolean;
}

export interface TrackSiteResult {
  domain: string;
  /** True after a start/confirm; false after a stop. */
  tracking: boolean;
  cadence?: "weekly";
  /** Present when starting: whether this call created a new tracking. */
  created?: boolean;
  already_tracked?: boolean;
  /** Present when stopping. */
  removed?: boolean;
  message: string;
}

export async function trackSite(args: TrackSiteArgs, deps: ToolDeps): Promise<ToolResult<TrackSiteResult>> {
  const gate = await gateProTool(deps);
  if (gate) return gate;

  if (args.cadence && args.cadence !== "weekly") {
    return err(
      "INVALID_INPUT",
      "Only weekly cadence is supported in v1. Tracked domains are re-audited once per week.",
    );
  }

  // Stop monitoring.
  if (args.enabled === false) {
    try {
      const res = await deps.client.untrackSite({ domain: args.domain });
      return ok({
        domain: res.domain,
        tracking: false,
        removed: res.removed,
        message: `Stopped weekly monitoring for ${res.domain}.`,
      });
    } catch (e) {
      return fromApiError(e, deps.config.upgradeUrl);
    }
  }

  // Start (or confirm) monitoring.
  try {
    const res = await deps.client.trackSite({ domain: args.domain, cadence: "weekly" });
    const message = res.created
      ? `Now monitoring ${res.domain} weekly. The first scheduled audit runs shortly and establishes a baseline; use get_changes to see movement over time.`
      : `${res.domain} is already being monitored weekly.`;
    return ok({
      domain: res.domain,
      tracking: true,
      cadence: res.cadence as "weekly",
      created: res.created,
      already_tracked: res.already_tracked,
      message,
    });
  } catch (e) {
    return fromApiError(e, deps.config.upgradeUrl);
  }
}
