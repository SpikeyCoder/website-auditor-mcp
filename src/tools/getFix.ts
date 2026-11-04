/**
 * get_fix [Pro] — "Get this fix" (served fixes, part 1)
 *
 * A site fix served finished (the business-facts structured data and About /
 * FAQ text, an llms.txt, or the robots.txt lines that let the AI assistants
 * in), written only from the facts its owner confirmed (the robots.txt lines
 * state none),
 * with paste steps for the platform the site runs on. Each call is recorded as
 * a press (the API counts it as "mcp": the client stamps X-WA-MCP-Version on
 * every request). Wired to `client.getFix` (POST /api/fix).
 *
 * Before the owner has confirmed the facts the fix states, the API answers
 * confirm_first. That is a step of the flow, not a failure, so it comes back
 * as a RESULT (status "confirm_first") carrying what to show the owner — the
 * confirm block, the reason and, when the owner can answer, `seen` for
 * confirm_facts. So does nothing_to_fix (the newest audit found nothing for
 * the fix to change): an answer, not a failure to retry. Every other refusal
 * stays an error with its own code.
 */
import type { ConfirmBlock, FactsSeen, FixRequest, ServedFix } from "../api/types.js";
import { WaApiError } from "../api/errors.js";
import { isRecord, isSeen } from "../api/mappers.js";
import { gateProTool, fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";
import { AFTER_THE_WEEKLY_CHECK, OWNER_ONLY } from "./fixCopy.js";

export interface GetFixArgs {
  domain: string;
  kind?: string;
  platform?: string;
}

export type GetFixResult =
  | { status: "served"; domain: string; request: FixRequest; fix: ServedFix; message: string }
  | { status: "confirm_first"; domain: string; reason: string; confirm?: ConfirmBlock; seen?: FactsSeen; message: string }
  | { status: "nothing_to_fix"; domain: string; message: string };

export async function getFix(args: GetFixArgs, deps: ToolDeps): Promise<ToolResult<GetFixResult>> {
  const gate = await gateProTool(deps, args.domain);
  if (gate) return gate;

  try {
    const { request, fix } = await deps.client.getFix({
      domain: args.domain,
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.platform ? { platform: args.platform } : {}),
    });
    return ok({ status: "served", domain: args.domain, request, fix, message: servedMessage(request, fix) });
  } catch (e) {
    if (e instanceof WaApiError && e.code === "CONFIRM_FIRST") return ok(confirmFirst(args.domain, e));
    if (e instanceof WaApiError && e.code === "NOTHING_TO_FIX") {
      return ok({
        status: "nothing_to_fix",
        domain: args.domain,
        message: `${e.message} Nothing was recorded. list_fixes shows which fixes the site needs.`,
      });
    }
    return fromApiError(e, deps.config, deps.transport, deps.authVia, args.domain);
  }
}

function servedMessage(request: FixRequest, fix: ServedFix): string {
  const title = fix.title ?? "The fix";
  const where = fix.steps?.label ? ` with the steps for ${fix.steps.label}` : "";
  const all = fix.copy_all
    ? " `copy_all` is the prompt and every block in one paste, for the agent that edits the site."
    : "";
  const check = request.id
    ? ` Once the owner has added it, check_fix with id ${request.id} reads the live site and says whether it is live.`
    : "";
  // What the steps say first: a platform the site's isn't known for asks
  // the owner which it is; one that most likely can't take the fix says so.
  if (fix.steps?.picker && fix.steps.picker.length) {
    return `${title}, ready. The site's platform isn't known: ask the owner which one it runs on (\`steps.picker\`), then call get_fix again with \`platform\` for its own steps. Until then the steps are general.${all}${check}`;
  }
  if (fix.steps?.can_apply === false) {
    const note = fix.steps.note ? ` ${fix.steps.note}` : "";
    return `${title}, ready, but ${fix.steps.label ?? "the site's platform"} most likely can't take it.${note} Tell the owner so rather than ask them to paste it.${check}`;
  }
  return `${title}, ready to apply${where}. Give the owner each block and its steps.${all}${check}`;
}

function confirmFirst(domain: string, e: WaApiError): Extract<GetFixResult, { status: "confirm_first" }> {
  const d = (isRecord(e.details) ? e.details : {}) as Record<string, unknown>;
  // The engine's reason, never a guess at one.
  const reason = typeof d.reason === "string" ? d.reason : "unknown";
  const confirm = isRecord(d.confirm) ? (d.confirm as ConfirmBlock) : undefined;
  const seen = isSeen(d.seen) ? (d.seen as FactsSeen) : undefined;
  // Built from the reason and what came back, never by reading the API's
  // sentence. facts_not_read: only when to ask again is added. No seen (an
  // older API): point at get_fix_facts, which hands one out. With a seen the
  // API's sentence already names confirm_facts, so only the rule is added.
  const message = reason === "facts_not_read"
    ? `${e.message} ${AFTER_THE_WEEKLY_CHECK}`
    : !seen
      ? `${e.message} Read the facts with get_fix_facts to show the owner; it returns the \`seen\` a confirmation sends back.`
      : `${e.message} ${OWNER_ONLY} After that, call get_fix again for the fix.`;
  return {
    status: "confirm_first",
    domain,
    reason,
    ...(confirm ? { confirm } : {}),
    ...(seen ? { seen } : {}),
    message,
  };
}

