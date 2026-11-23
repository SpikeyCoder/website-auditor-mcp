/**
 * get_ai_visibility [Subscription]
 *
 * Maps to the real audit endpoint and returns the AI-visibility slice. There is
 * no AI-visibility-only endpoint upstream, so this runs the full audit and
 * extracts the `ai_visibility` block (a thin, honest adaptation). Requires an
 * active/trialing subscription — no free API tier (api PR #17).
 *
 * The result includes `trend`: 7- and 30-day movement computed from the
 * domain's stored snapshot history, for the question this audit asked. Trend is strictly additive — any failure
 * to load history degrades to `trend: null` with a `trend_note`, never to a
 * failed tool call.
 */
import type { AiVisibility } from "../api/types.js";
import { toAiVisibility, computeTrend, detectUnreachable, measuredRun } from "../api/mappers.js";
import { freeNextSteps, nextStepsSentence, uncheckedEnginesNote } from "./nextSteps.js";
import { normalizeDomain } from "../api/domain.js";
import { WaApiError } from "../api/errors.js";
import { startWeeklyChanges, invalidateWeeklyChanges, NO_WEEKLY, type PendingWeekly } from "./weeklyChanges.js";
import { dashboardLink, dashboardField, withDashboardNote } from "./dashboardLink.js";
import { gateAuditTool, fromApiError, ok, err, type ToolDeps, type ToolResult } from "./context.js";

export interface GetAiVisibilityArgs {
  domain: string;
  /** Optional; omitted means "detect it, and warn if unverified". */
  business_name?: string;
  /** Optional; omitted means "detect it, then scope by what was found". */
  business_location?: string;
}

/** Fill `trend`/`trend_note` on a mapped result. Never throws.
 *  Runs after gateProTool, so the caller is a verified subscriber. */
async function attachTrend(result: AiVisibility, domain: string, runId: string, deps: ToolDeps): Promise<void> {
  try {
    const snapshots = await deps.client.getAiVisibilityHistory({ domain });
    // FOR THIS AUDIT'S QUESTION, or none. Following the newest measured
    // snapshot instead, an audit that stored no score (no engine answered, a
    // name it could not confirm, a page it could not read) or a simulated one
    // sat above another audit's trend, for a question it may never have asked.
    if (!measuredRun(snapshots, runId)) {
      result.trend_note =
        "No trend for this audit: it stored no measured AI-visibility snapshot to follow (no score, a simulated one, or none at all), and earlier snapshots may have asked a different question.";
      return;
    }
    const trend = computeTrend(snapshots, new Date(), runId);
    if (trend) {
      result.trend = trend;
    } else {
      result.trend_note =
        "Not enough history yet to show a trend — at least two measured snapshots are needed. Each audit stores one, and tracked sites (track_site) add one automatically every week.";
    }
  } catch {
    // History is a bonus on this tool; the fresh score above is still valid.
    result.trend_note = "Trend history could not be loaded right now; the current score is unaffected.";
  }
}

export async function getAiVisibility(args: GetAiVisibilityArgs, deps: ToolDeps): Promise<ToolResult<AiVisibility>> {
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
    return await getAiVisibilityChecked(args, deps, free, weeklyRead, run);
  } finally {
    // A success has already awaited and used the read. On any other outcome it
    // is not awaited: invalidating cancels its store, and the reply need not wait.
    // Only an audit that was sent stored anything: a refusal before sending leaves the cache alone.
    // A client-side timeout may store later, so a read in that gap can be up to five minutes stale.
    if (run.sent) invalidateWeeklyChanges(deps);
  }
}

async function getAiVisibilityChecked(
  args: GetAiVisibilityArgs,
  deps: ToolDeps,
  free: boolean,
  weeklyRead: PendingWeekly,
  run: { sent: boolean },
): Promise<ToolResult<AiVisibility>> {
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
      `The site at ${args.domain} didn't load during the audit (no page loaded), so no AI-visibility score can be produced. Check the domain is correct, publicly reachable and serving pages.`,
    );
  }

  const result = toAiVisibility(response.report);
  if (free) {
    // History and trend are monitoring's; the free result says what is next,
    // except under neutral copy (the Claude connector; see runAudit.ts).
    const free_result = { ...result, trend: null, trend_note: "No trend is returned with this result." };
    if (deps.config.toolCopy === "neutral") {
      const note = uncheckedEnginesNote(response.report);
      return ok(note ? { ...free_result, summary: `${result.summary} ${note}` } : free_result);
    }
    const next_steps = freeNextSteps(response.report, args.domain);
    return ok({ ...free_result, summary: `${result.summary} ${nextStepsSentence(next_steps)}`, next_steps });
  }
  await attachTrend(result, args.domain, response.runId, deps);
  const [link, weekly] = await Promise.all([dashboardLink(deps, "get_ai_visibility", args.domain), weeklyRead.result()]);
  return ok({ ...result, summary: withDashboardNote(result.summary, link), ...dashboardField(link), ...weekly });
}
