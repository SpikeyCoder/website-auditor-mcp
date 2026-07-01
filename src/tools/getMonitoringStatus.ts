/**
 * get_monitoring_status [Pro]
 *
 * The end-user's in-client monitoring view (distinct from the ops dashboard):
 * for each tracked domain, its latest AI-visibility score, when it was last
 * audited and next runs, and the most recent change vs the prior snapshot.
 * Read-only; reads the snapshots the scheduler writes. Compact, glanceable.
 */
import type { Changes } from "../api/types.js";
import { computeChanges } from "../api/mappers.js";
import { gateProTool, fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";

export interface MonitoringStatusSite {
  domain: string;
  cadence: string;
  active: boolean;
  latest_score: number | null;
  last_audited_at: string | null;
  next_run_at: string | null;
  /** Most recent delta (latest vs previous snapshot), or null if <2 snapshots. */
  change: Changes | null;
  summary: string;
}

export interface GetMonitoringStatusResult {
  limit: number;
  used: number;
  remaining: number;
  sites: MonitoringStatusSite[];
  summary: string;
}

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function siteSummary(domain: string, latestScore: number | null, change: Changes | null): string {
  if (latestScore == null) return `${domain}: not audited yet — the first scheduled run will set a baseline.`;
  if (!change) return `${domain}: AI visibility ${latestScore}/100 (baseline; no change yet).`;
  const d = change.score_delta;
  const dir = d > 0 ? `up ${d}` : d < 0 ? `down ${Math.abs(d)}` : "unchanged";
  return `${domain}: AI visibility ${latestScore}/100 (${dir} since last check).`;
}

export async function getMonitoringStatus(
  _args: Record<string, never>,
  deps: ToolDeps,
): Promise<ToolResult<GetMonitoringStatusResult>> {
  const gate = await gateProTool(deps);
  if (gate) return gate;

  try {
    const status = await deps.client.getMonitoringStatus();
    const sites: MonitoringStatusSite[] = status.sites.map((s) => {
      const latestScore = s.latest ? s.latest.score : null;
      const change =
        s.latest && s.previous
          ? computeChanges(
              { score: num(s.latest.score), by_engine: mapEngines(s.latest.by_engine) },
              { score: num(s.previous.score), by_engine: mapEngines(s.previous.by_engine) },
            )
          : null;
      return {
        domain: s.domain,
        cadence: s.cadence,
        active: s.active,
        latest_score: latestScore,
        last_audited_at: s.last_audited_at,
        next_run_at: s.next_run_at,
        change,
        summary: siteSummary(s.domain, latestScore, change),
      };
    });

    const summary =
      status.used === 0
        ? "No sites are being monitored yet. Use track_site to start weekly monitoring."
        : `Monitoring ${status.used} of ${status.limit} site(s); ${status.remaining} slot(s) free.`;

    return ok({ limit: status.limit, used: status.used, remaining: status.remaining, sites, summary });
  } catch (e) {
    return fromApiError(e, deps.config.upgradeUrl);
  }
}

/** Coerce nullable per-engine scores to numbers for the delta computation. */
function mapEngines(by: { chatgpt: number | null; perplexity: number | null; claude: number | null; gemini: number | null }): Record<string, number> {
  return {
    chatgpt: num(by.chatgpt),
    perplexity: num(by.perplexity),
    claude: num(by.claude),
    gemini: num(by.gemini),
  };
}
