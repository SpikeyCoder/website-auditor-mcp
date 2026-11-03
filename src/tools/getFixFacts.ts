/**
 * get_fix_facts [Pro]
 *
 * The business facts a site's fixes are written from, as they stand to be
 * confirmed: the confirm block, `seen` (exactly what it shows, which
 * confirm_facts sends back unchanged) and `name` (the business name the
 * audits found, to fill the name fact where the site states none). Reads only.
 * Wired to `client.getFixFacts` (GET /api/fix/facts).
 *
 * `seen` is absent when the facts can't be confirmed yet (the site has not
 * been read): the result says so, rather than leave the agent to infer it.
 */
import type { ConfirmBlock, FactsSeen } from "../api/types.js";
import { gateProTool, fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";
import { NOTHING_TO_CONFIRM, OWNER_CONFIRMS } from "./fixCopy.js";

export interface GetFixFactsArgs {
  domain: string;
}

export interface GetFixFactsResult {
  domain: string;
  confirm: ConfirmBlock;
  seen?: FactsSeen;
  name: string;
  can_confirm: boolean;
  message: string;
}

export async function getFixFacts(args: GetFixFactsArgs, deps: ToolDeps): Promise<ToolResult<GetFixFactsResult>> {
  const gate = await gateProTool(deps, args.domain);
  if (gate) return gate;

  try {
    const res = await deps.client.getFixFacts({ domain: args.domain });
    const canConfirm = res.seen !== undefined;
    return ok({
      domain: args.domain,
      confirm: res.confirm,
      ...(res.seen !== undefined ? { seen: res.seen } : {}),
      name: res.name,
      can_confirm: canConfirm,
      message: canConfirm
        ? `These are the facts ${args.domain}'s fixes are written from.${res.name ? ` The audits found the business name "${res.name}", for the name fact where the site states none.` : ""} ${OWNER_CONFIRMS}`
        : NOTHING_TO_CONFIRM,
    });
  } catch (e) {
    return fromApiError(e, deps.config, deps.transport, deps.authVia, args.domain);
  }
}
