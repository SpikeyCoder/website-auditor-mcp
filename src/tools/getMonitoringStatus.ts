/**
 * get_monitoring_status [Pro]
 *
 * The end-user's in-client monitoring view (distinct from the ops dashboard):
 * for each tracked domain, its latest AI-visibility score, when it was last
 * audited and next runs, and the most recent like-for-like change: against the
 * latest earlier snapshot that asked the same question (sameQuestion in
 * mappers.ts), or, when there is none, a note saying why.
 * Read-only; reads the snapshots the scheduler writes. Compact, glanceable.
 */
import type { Changes, MonitoringSite, MonitoringSnapshot } from "../api/types.js";
import { computeChanges, questionDifference, sameQuestion } from "../api/mappers.js";
import { gateProTool, fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";

export interface MonitoringStatusSite {
  domain: string;
  cadence: string;
  active: boolean;
  latest_score: number | null;
  last_audited_at: string | null;
  next_run_at: string | null;
  /** The latest like-for-like change, or null when there is none to show. */
  change: Changes | null;
  /** Present when there is no like-for-like change for a reason worth saying, or snapshots were passed over. */
  note?: string;
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

const day = (iso: string): string => iso.slice(0, 10);

const NOT_RECORDED =
  "These snapshots do not record what each audit asked the assistants, so no like-for-like change can be "
  + "shown yet. Snapshots stored from now on record it.";

/**
 * The change a site can show, and why when it can show none.
 *
 * THE KEYS ARE CHECKED HERE TOO. The API returns as `previous` only a snapshot
 * that asked what `latest` asked, but a build of it from before that rule
 * returns the snapshot just before, whatever it asked, and a delta across a
 * change of question is exactly what must not reach a summary. So a pair this
 * cannot confirm is not subtracted, whichever API sent it.
 */
function assess(
  latest: MonitoringSnapshot,
  latestScore: number,
  site: MonitoringSite,
): { change: Changes | null; label: string; note?: string } {
  const previous = site.previous;
  const comparison = site.comparison ?? null;

  if (previous && sameQuestion(latest, previous)) {
    const change: Changes = {
      ...computeChanges(
        { score: latestScore, by_engine: mapEngines(latest.by_engine) },
        { score: num(previous.score), by_engine: mapEngines(previous.by_engine) },
      ),
      from_captured_at: previous.captured_at,
      to_captured_at: latest.captured_at,
    };
    const skipped = comparison?.status === "compared" && typeof comparison.skipped_snapshots === "number"
      ? comparison.skipped_snapshots
      : 0;
    const d = change.score_delta;
    const dir = d > 0 ? `up ${d}` : d < 0 ? `down ${Math.abs(d)}` : "unchanged";
    if (skipped <= 0) return { change, label: `${dir} since ${day(previous.captured_at)}` };
    change.skipped_snapshots = skipped;
    return {
      change,
      label: `${dir} since ${day(previous.captured_at)}`,
      note: `Compared with ${day(previous.captured_at)}, the most recent snapshot that asked the same question; `
        + `${skipped} ${skipped === 1 ? "snapshot" : "snapshots"} in between asked a different question and `
        + `${skipped === 1 ? "was" : "were"} not compared.`,
    };
  }

  if (comparison?.status === "rebaselined") {
    const prior = comparison.prior;
    const why = prior?.question?.key && latest.question?.key
      ? `it asked about ${questionDifference(latest.question, prior.question)}`
      : "the snapshots before it do not record what they asked";
    return {
      change: null,
      label: `re-baselined on ${day(latest.captured_at)}; no like-for-like change yet`,
      note: `Re-baselined on ${day(latest.captured_at)}: ${why}, and no earlier snapshot asked the same question, `
        + "so there is no like-for-like change yet.",
    };
  }

  if (previous?.question?.key && latest.question?.key) {
    return {
      change: null,
      label: "no like-for-like change yet",
      note: `The previous snapshot asked about ${questionDifference(previous.question, latest.question)}, so no `
        + "like-for-like change can be shown.",
    };
  }

  if (previous || comparison?.status === "not_recorded") {
    return { change: null, label: "no like-for-like change yet", note: NOT_RECORDED };
  }
  return { change: null, label: "baseline; no change yet" };
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
      // `s.latest ? s.latest.score : null` was not enough: a latest snapshot
      // that carries no score yields UNDEFINED, not null, and the two are not
      // interchangeable here. The summary reads a null score as "not audited
      // yet", so undefined slipped past it into "AI visibility undefined/100",
      // and the declared output schema — which types this as a number-or-null —
      // rejected the whole successful call.
      const latestScore = typeof s.latest?.score === "number" ? s.latest.score : null;
      const base = {
        domain: s.domain,
        cadence: s.cadence,
        active: s.active,
        latest_score: latestScore,
        last_audited_at: s.last_audited_at,
        next_run_at: s.next_run_at,
      };
      if (!s.latest || latestScore === null) {
        return {
          ...base,
          change: null,
          summary: `${s.domain}: not audited yet — the first scheduled run will set a baseline.`,
        };
      }
      const { change, label, note } = assess(s.latest, latestScore, s);
      return {
        ...base,
        change,
        ...(note ? { note } : {}),
        summary: `${s.domain}: AI visibility ${latestScore}/100 (${label}).`,
      };
    });

    const summary =
      status.used === 0
        ? "No sites are being monitored yet. Use track_site to start weekly monitoring."
        : `Monitoring ${status.used} of ${status.limit} site(s); ${status.remaining} slot(s) free.`;

    return ok({ limit: status.limit, used: status.used, remaining: status.remaining, sites, summary });
  } catch (e) {
    return fromApiError(e, deps.config, deps.transport, deps.authVia);
  }
}

/** Per-engine scores for the delta computation, NULLS PRESERVED.
 *
 * This used to `num()` them to zero, which is the same "untested is a zero"
 * mistake one layer along: a Claude outage in a scheduled snapshot became
 * {from: 55, to: 0, delta: -55} — a 55-point crash that did not happen,
 * published to a paying customer. computeChanges now skips an engine missing
 * on either side, and coercing here would route straight around that guard.
 */
export function mapEngines(by: { chatgpt: number | null; perplexity: number | null; claude: number | null; gemini: number | null }): Record<string, number | null> {
  return {
    chatgpt: by.chatgpt,
    perplexity: by.perplexity,
    claude: by.claude,
    gemini: by.gemini,
  };
}
