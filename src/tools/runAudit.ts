/**
 * run_audit [Subscription, rate-limited server-side]
 *
 * Runs the real full audit and maps it to the listing-doc return shape:
 * `{ scores, top_issues[], report_url }`. Requires an active/trialing
 * subscription — there is no free API tier (api PR #17); the pre-flight gate
 * mirrors the server's own 403.
 *
 * Deliberately does NOT carry `ai_visibility.sources` (chaos_tester #447):
 * this is the compact cross-category summary, and a ten-row evidence list in
 * every response taxes the many calls that never look at it. The ranked
 * evidence lives on get_ai_visibility, whose job it is.
 */
import type { AuditSummary } from "../api/types.js";
import { toAuditSummary, detectUnreachable } from "../api/mappers.js";
import { dashboardLink, dashboardField } from "./dashboardLink.js";
import { normalizeDomain } from "../api/domain.js";
import { WaApiError } from "../api/errors.js";
import { startWeeklyChanges, invalidateWeeklyChanges, NO_WEEKLY, type PendingWeekly } from "./weeklyChanges.js";
import { freeNextSteps, nextStepsSentence, uncheckedEnginesNote } from "./nextSteps.js";
import { gateAuditTool, fromApiError, ok, err, type ToolDeps, type ToolResult } from "./context.js";

export interface RunAuditArgs {
  domain: string;
  /** Optional; omitted means "detect it, and warn if unverified". */
  business_name?: string;
  /** Optional; omitted means "detect it, then scope by what was found". */
  business_location?: string;
}

export async function runAudit(args: RunAuditArgs, deps: ToolDeps): Promise<ToolResult<AuditSummary>> {
  const { gate, free } = await gateAuditTool(deps, args.domain);
  if (gate) return gate;

  // An unusable domain is refused here, as the client would: no read, and no
  // audit attempted, so nothing to invalidate either.
  try {
    normalizeDomain(args.domain);
  } catch (e) {
    return fromApiError(e, deps.config, deps.transport, deps.authVia, args.domain);
  }

  // Started beside the audit, so the block costs no extra wait; the audited
  // site is left out of it, since this reply already shows that audit.
  const weeklyRead = free ? NO_WEEKLY : startWeeklyChanges(deps, { exclude: args.domain });

  // Invalidated only after that read has been awaited and used, in this
  // finally: the audit stored a snapshot, so nothing read before it may stay
  // cached. During an outage that costs one read per audit; accepted.
  const run = { sent: false };
  try {
    return await runAuditChecked(args, deps, free, weeklyRead, run);
  } finally {
    // A success has already awaited and used the read. On any other outcome it
    // is not awaited: invalidating cancels its store, and the reply need not wait.
    // Only an audit that was sent stored anything: a refusal before sending leaves the cache alone.
    // A client-side timeout may store later, so a read in that gap can be up to five minutes stale.
    if (run.sent) invalidateWeeklyChanges(deps);
  }
}

async function runAuditChecked(
  args: RunAuditArgs,
  deps: ToolDeps,
  free: boolean,
  weeklyRead: PendingWeekly,
  run: { sent: boolean },
): Promise<ToolResult<AuditSummary>> {
  let response;
  try {
    response = await deps.client.runAudit({
      domain: args.domain,
      businessName: args.business_name,
      businessCity: args.business_location,
    });
  } catch (e) {
    // A refusal (quota, key, rate limit, invalid input) stored nothing; a timeout or
    // network failure may have landed after the audit was sent.
    if (!(e instanceof WaApiError) || e.code === "TIMEOUT" || e.code === "UPSTREAM_ERROR") run.sent = true;
    return fromApiError(e, deps.config, deps.transport, deps.authVia, args.domain);
  }
  run.sent = true;

  if (detectUnreachable(response.report)) {
    return err(
      "UNREACHABLE_DOMAIN",
      `The site at ${args.domain} didn't load during the audit (no page loaded), so no audit scores can be produced. Check the domain is correct, publicly reachable and serving pages.`,
    );
  }

  // A free audit: no dashboard link (Pro's), and what the result found that
  // another tool can act on, as a field and as a sentence (tools/nextSteps.ts).
  // Not under neutral copy (the Claude connector): there those tools answer with
  // the plan's terms, which neutral copy keeps out of what the server volunteers.
  if (free) {
    const summaryOnly = toAuditSummary(response.report, { siteUrl: deps.config.siteUrl });
    if (deps.config.toolCopy === "neutral") {
      // Still say which engines this result left out, as the instructions promise.
      const note = uncheckedEnginesNote(response.report);
      return ok(note ? { ...summaryOnly, summary: note } : summaryOnly);
    }
    const next_steps = freeNextSteps(response.report, args.domain);
    return ok({ ...summaryOnly, summary: nextStepsSentence(next_steps), next_steps });
  }

  // No `summary` on this reply: the link's note rides in `dashboard.note`.
  const [link, weekly] = await Promise.all([dashboardLink(deps, "run_audit", args.domain), weeklyRead.result()]);
  return ok({ ...toAuditSummary(response.report, { siteUrl: deps.config.siteUrl }), ...dashboardField(link), ...weekly });
}
