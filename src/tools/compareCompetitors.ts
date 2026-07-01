/**
 * compare_competitors [Pro]
 *
 * There is no dedicated comparison endpoint upstream, so today this tool fans
 * out real `runAudit` calls (one per domain) over the existing endpoint and
 * builds the head-to-head view from each site's AI-visibility block. This is a
 * genuine implementation over live data — the ranking is exact; `gaps` are the
 * per-engine deficits where a competitor's AI-visibility score beats yours.
 *
 * Note: each domain is a full audit and counts against the account's audit
 * quota. A dedicated batch/compare endpoint would be cheaper (future work).
 */
import type { Comparison, CompetitorRank, CompetitorGap, AiVisibility } from "../api/types.js";
import { toAiVisibility, detectUnreachable } from "../api/mappers.js";
import { WaApiError } from "../api/errors.js";
import { gateProTool, fromApiError, ok, err, type ToolDeps, type ToolResult } from "./context.js";

export interface CompareCompetitorsArgs {
  domain: string;
  competitors: string[];
}

type Resolved =
  | { domain: string; av: AiVisibility; reachable: true }
  | { domain: string; note: string; reachable: false };

export async function compareCompetitors(
  args: CompareCompetitorsArgs,
  deps: ToolDeps,
): Promise<ToolResult<Comparison>> {
  const gate = await gateProTool(deps);
  if (gate) return gate;

  if (!Array.isArray(args.competitors) || args.competitors.length === 0) {
    return err("INVALID_INPUT", "Provide at least one competitor domain in `competitors`.");
  }

  // Primary domain first — its failure fails the whole comparison.
  let primaryAv: AiVisibility;
  try {
    const res = await deps.client.runAudit({ domain: args.domain });
    if (detectUnreachable(res.report)) {
      return err(
        "UNREACHABLE_DOMAIN",
        `The site at ${args.domain} could not be reached, so it can't be compared. Check the domain is correct and publicly reachable.`,
      );
    }
    primaryAv = toAiVisibility(res.report);
  } catch (e) {
    return fromApiError(e, deps.config.upgradeUrl);
  }

  // Competitors — a single failure is captured as a note, not a hard error,
  // except quota/auth failures which are worth surfacing to the caller.
  const resolved: Resolved[] = [];
  for (const competitor of args.competitors) {
    try {
      const res = await deps.client.runAudit({ domain: competitor });
      if (detectUnreachable(res.report)) {
        resolved.push({ domain: competitor, note: "unreachable", reachable: false });
      } else {
        resolved.push({ domain: competitor, av: toAiVisibility(res.report), reachable: true });
      }
    } catch (e) {
      if (e instanceof WaApiError && (e.code === "OVER_QUOTA" || e.code === "INVALID_KEY")) {
        return fromApiError(e, deps.config.upgradeUrl);
      }
      resolved.push({ domain: competitor, note: e instanceof Error ? e.message : "audit failed", reachable: false });
    }
  }

  // Ranking: primary + competitors, by AI-visibility score (unreachable last).
  const ranking: CompetitorRank[] = [
    { domain: args.domain, score: primaryAv.score },
    ...resolved.map((r) =>
      r.reachable ? { domain: r.domain, score: r.av.score } : { domain: r.domain, score: null, note: r.note },
    ),
  ].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  // Gaps: per-engine deficits vs each reachable competitor.
  const engines = ["chatgpt", "perplexity", "claude", "gemini"] as const;
  const gaps: CompetitorGap[] = [];
  for (const r of resolved) {
    if (!r.reachable) continue;
    for (const engine of engines) {
      const theirs = r.av.by_engine[engine];
      const yours = primaryAv.by_engine[engine];
      if (theirs > yours) {
        gaps.push({ engine, competitor: r.domain, competitor_score: theirs, your_score: yours });
      }
    }
  }

  return ok({ ranking, gaps });
}
