/**
 * untrack_site [Pro]
 *
 * Stop weekly scheduled monitoring of a domain and free its slot. Idempotent:
 * stopping a domain that isn't tracked is a success, not an error. Confirms the
 * remaining slot count so the caller (agent or human) knows the freed capacity.
 */
import { gateProTool, fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";

export interface UntrackSiteArgs {
  domain: string;
}

export interface UntrackSiteResult {
  domain: string;
  tracking: false;
  removed: boolean;
  limit?: number;
  used?: number;
  remaining?: number;
  message: string;
}

export async function untrackSite(args: UntrackSiteArgs, deps: ToolDeps): Promise<ToolResult<UntrackSiteResult>> {
  const gate = await gateProTool(deps);
  if (gate) return gate;

  try {
    const res = await deps.client.untrackSite({ domain: args.domain });
    const slots =
      res.remaining != null && res.limit != null
        ? ` ${res.remaining} of ${res.limit} monitoring slots are now free.`
        : "";
    const message = res.removed
      ? `Stopped weekly monitoring for ${res.domain}.${slots}`
      : `${res.domain} wasn't being monitored — nothing to stop.${slots}`;
    return ok({
      domain: res.domain,
      tracking: false,
      removed: res.removed,
      limit: res.limit,
      used: res.used,
      remaining: res.remaining,
      message,
    });
  } catch (e) {
    return fromApiError(e, deps.config.upgradeUrl);
  }
}
