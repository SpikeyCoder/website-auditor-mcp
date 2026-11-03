/**
 * check_fix [Pro] — "I've added it"
 *
 * Reads the live site for a fix request and records what it found: live, or
 * what is missing, each named. A site that did not answer is not called
 * missing the fix. Once a minute per request (CHECKED_RECENTLY with
 * retry_after). Never predicts a score change. Wired to `client.checkFix`
 * (POST /api/fix/check).
 */
import type { FixCheck, FixRequest } from "../api/types.js";
import { gateProTool, fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";

export interface CheckFixArgs {
  domain: string;
  id: string;
}

export interface CheckFixResult {
  domain: string;
  live: boolean;
  request: FixRequest;
  check: FixCheck;
  message: string;
}

export async function checkFix(args: CheckFixArgs, deps: ToolDeps): Promise<ToolResult<CheckFixResult>> {
  const gate = await gateProTool(deps, args.domain);
  if (gate) return gate;

  try {
    const { request, check } = await deps.client.checkFix({ domain: args.domain, id: args.id });
    const live = check.live === true;
    return ok({ domain: args.domain, live, request, check, message: messageOf(args.domain, live, check) });
  } catch (e) {
    return fromApiError(e, deps.config, deps.transport, deps.authVia, args.domain);
  }
}

function messageOf(domain: string, live: boolean, check: FixCheck): string {
  if (live) return `The fix is live on ${domain}.`;
  const details = (check.missing ?? []).map((m) => m.detail).filter((d): d is string => typeof d === "string" && d !== "");
  if (check.reached === false) {
    // The site did not answer: that says nothing about the fix.
    return details.join(" ") || `We couldn't reach ${domain}. Try again in a few minutes.`;
  }
  return `Not live yet on ${domain}.${details.length ? ` ${details.join(" ")}` : ""}`;
}
