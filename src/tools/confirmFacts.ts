/**
 * confirm_facts [Pro]
 *
 * Confirms the owner's business facts, which "Get this fix" writes fixes from.
 * Owner decision (2026-11-03): a member's AI agent may confirm, but only facts
 * the owner was shown and agreed to, and only by sending back exactly the
 * `seen` it was handed (by get_fix_facts or a confirm_first answer). The tool
 * passes `seen` through untouched; the engine checks it against the site.
 * Wired to `client.confirmFacts` (POST /api/fix/confirm).
 *
 * facts_changed (the site changed since the owner was shown the facts) and
 * facts_not_read (nothing to confirm yet) are steps of the flow, so they come
 * back as RESULTS with their status. The confirmation cap and the outages
 * stay errors, with retry_after and maybe_recorded in details.
 */
import type { ConfirmBlock, FactsSeen } from "../api/types.js";
import { WaApiError } from "../api/errors.js";
import { isRecord } from "../api/mappers.js";
import { gateProTool, fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";


export interface ConfirmFactsArgs {
  domain: string;
  facts: Record<string, string | null>;
  seen: FactsSeen;
}

export type ConfirmFactsToolResult =
  | { status: "confirmed"; domain: string; confirm: ConfirmBlock; seen: FactsSeen | null; message: string }
  | { status: "facts_changed"; domain: string; confirm?: ConfirmBlock; message: string }
  | { status: "facts_not_read"; domain: string; confirm?: ConfirmBlock; message: string };

export async function confirmFacts(args: ConfirmFactsArgs, deps: ToolDeps): Promise<ToolResult<ConfirmFactsToolResult>> {
  const gate = await gateProTool(deps, args.domain);
  if (gate) return gate;

  try {
    const res = await deps.client.confirmFacts({ domain: args.domain, facts: args.facts, seen: args.seen });
    return ok({
      status: "confirmed",
      domain: args.domain,
      confirm: res.confirm,
      seen: res.seen,
      // Not "the fix is ready": a fact left out or empty is not confirmed, and
      // get_fix says (confirm_first) if one a fix needs is still missing.
      message:
        "Confirmed what the owner confirmed; `confirm` shows each fact as it now stands. get_fix writes the fix from " +
        "these, and answers confirm_first if a fact it needs is still unconfirmed." +
        (res.seen ? " To correct a fact later, show the owner the facts again and send this `seen` back with the change." : ""),
    });
  } catch (e) {
    if (e instanceof WaApiError && (e.code === "FACTS_CHANGED" || e.code === "FACTS_NOT_READ")) {
      const d = isRecord(e.details) ? e.details : {};
      const confirm = isRecord(d.confirm) ? { confirm: d.confirm as ConfirmBlock } : {};
      if (e.code === "FACTS_CHANGED") {
        return ok({
          status: "facts_changed",
          domain: args.domain,
          ...confirm,
          // The API's sentence already says to read the facts again
          // (get_fix_facts, after the client's rewrite); only the rule is added.
          // The next step by the code, never by reading the API's sentence.
          message: `Nothing was confirmed: the site's facts changed since they were shown. Read them again with get_fix_facts (it returns the new \`seen\`), show the owner the facts as they are now, and confirm only what the owner confirms from them.`,
        });
      }
      return ok({ status: "facts_not_read", domain: args.domain, ...confirm, message: `Nothing was confirmed. ${e.message} Read the facts again with get_fix_facts after the site's next weekly check reads it, and confirm them with the owner then.` });
    }
    return fromApiError(e, deps.config, deps.transport, deps.authVia, args.domain);
  }
}
