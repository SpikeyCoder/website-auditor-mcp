/**
 * get_ai_visibility [Free; trend data for Pro]
 *
 * Maps to the real audit endpoint and returns the AI-visibility slice. There is
 * no AI-visibility-only endpoint upstream, so this runs the full audit and
 * extracts the `ai_visibility` block (a thin, honest adaptation).
 *
 * Pro callers additionally get `trend`: 7- and 30-day movement computed from
 * the domain's stored snapshot history (the Pro history endpoint). Trend is
 * strictly additive — any failure to load history degrades to `trend: null`
 * with a `trend_note`, never to a failed tool call.
 */
import type { AiVisibility } from "../api/types.js";
import { toAiVisibility, computeTrend, detectUnreachable } from "../api/mappers.js";
import { gateFreeTool, fromApiError, ok, err, type ToolDeps, type ToolResult } from "./context.js";

export interface GetAiVisibilityArgs {
  domain: string;
}

/** Fill `trend`/`trend_note` on a mapped result. Never throws. */
async function attachTrend(result: AiVisibility, domain: string, deps: ToolDeps): Promise<void> {
  const { tier } = await deps.subscriptions.resolve();
  if (tier !== "pro") {
    result.trend_note = `AI-visibility trend history requires a Pro subscription (${deps.config.upgradeUrl}).`;
    return;
  }

  try {
    const snapshots = await deps.client.getAiVisibilityHistory({ domain });
    const trend = computeTrend(snapshots);
    if (trend) {
      result.trend = trend;
    } else {
      result.trend_note =
        "Not enough history yet to show a trend — at least two snapshots are needed. Each audit stores one, and tracked sites (track_site) add one automatically every week.";
    }
  } catch {
    // History is a bonus on this tool; the fresh score above is still valid.
    result.trend_note = "Trend history could not be loaded right now; the current score is unaffected.";
  }
}

export async function getAiVisibility(args: GetAiVisibilityArgs, deps: ToolDeps): Promise<ToolResult<AiVisibility>> {
  const gate = await gateFreeTool(deps, args.domain);
  if (gate) return gate;

  let response;
  try {
    response = await deps.client.runAudit({ domain: args.domain });
  } catch (e) {
    return fromApiError(e, deps.config.upgradeUrl);
  }

  if (detectUnreachable(response.report)) {
    return err(
      "UNREACHABLE_DOMAIN",
      `The site at ${args.domain} could not be reached, so no AI-visibility score can be produced. Check the domain is correct and publicly reachable.`,
    );
  }

  const result = toAiVisibility(response.report);
  await attachTrend(result, args.domain, deps);
  return ok(result);
}
