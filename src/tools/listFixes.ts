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
  const rest = fixes
    .filter((f) => f !== first)
    .map((f) => {
      const status = f.request?.status ? ` Its newest request is ${f.request.status}.` : "";
      return `${f.title ?? f.kind ?? "A fix"}: ${f.needed ? "needed" : "not needed"}.${f.why ? ` ${f.why}` : ""}${status}`;
    });
  return [lead, ...rest].join(" ");
}
