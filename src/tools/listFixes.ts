/**
 * list_fixes [Pro]
 *
 * The site's "Get this fix" fixes, top first: whether each is needed and why,
 * whether the site's platform can take it, and its newest request (with that
 * request's id, which check_fix takes). Reads only: nothing is recorded and
 * the site is not fetched. Wired to `client.listFixes` (GET /api/fix).
 *
 * Its own tool rather than a mode of get_fix: get_fix records a press, so an
 * overview behind it would carry get_fix's not-read-only annotation, and an
 * agent that only wanted a request id would count a press the owner never
 * made.
 */
import type { FixOverview } from "../api/types.js";
import { gateProTool, fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";

export interface ListFixesArgs {
  domain: string;
}

export interface ListFixesResult {
  domain: string;
  platform?: string;
  platforms?: FixOverview["platforms"];
  top: string | null;
  fixes: FixOverview["fixes"];
  summary: string;
}

export async function listFixes(args: ListFixesArgs, deps: ToolDeps): Promise<ToolResult<ListFixesResult>> {
  const gate = await gateProTool(deps, args.domain);
  if (gate) return gate;

  try {
    const res = await deps.client.listFixes({ domain: args.domain });
    const domain = typeof res.site?.domain === "string" ? res.site.domain : args.domain;
    const top = typeof res.top === "string" ? res.top : null;
    return ok({
      domain,
      ...(res.platform !== undefined ? { platform: res.platform } : {}),
      ...(res.platforms !== undefined ? { platforms: res.platforms } : {}),
      top,
      fixes: res.fixes,
      summary: summaryOf(domain, top, res.fixes),
    });
  } catch (e) {
    return fromApiError(e, deps.config, deps.transport, deps.authVia, args.domain);
  }
}

function summaryOf(domain: string, top: string | null, fixes: FixOverview["fixes"]): string {
  const first = fixes.find((f) => f.kind === top);
  const lead = first
    ? `Top fix for ${domain}: ${first.title ?? first.kind}.${first.why ? ` ${first.why}` : ""}`
    : `No fix is waiting to be applied for ${domain} right now.`;
  const said = (f: FixOverview["fixes"][number]) => {
    const platform = f.can_apply === false ? " The site's platform most likely can't take it." : "";
    const live = f.request?.status === "live";
    // A fix found live is said as live, whatever the last audit (which
    // hasn't run since) still says it needs.
    const need = live ? "added, and found live" : f.needed === true ? "needed" : f.needed === false ? "not needed" : "";
    const lead = need ? `${f.title ?? f.kind ?? "A fix"}: ${need}.` : `${f.title ?? f.kind ?? "A fix"}.`;
    return `${lead}${!live && f.why ? ` ${f.why}` : ""}${platform}${live ? "" : requestSaid(f.request?.status)}`;
  };
  const rest = fixes
    .filter((f) => f !== first)
    .map(said);
  const topStatus = first ? requestSaid(first.request?.status) : "";
  return [lead + topStatus, ...rest].join(" ");
}

/** A request's status in words: the engine's "missing" is the fix not found
 * live at its last check, not a missing request. */
function requestSaid(status: string | null | undefined): string {
  if (!status) return "";
  if (status === "live") return " Its last check found it live.";
  if (status === "missing") return " Its last check didn't find it live yet.";
  return ` Its newest request is ${status}.`;
}
