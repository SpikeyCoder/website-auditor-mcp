/**
 * get_monitoring_status [Pro]
 *
 * The end-user's in-client monitoring view (distinct from the ops dashboard):
 * for each tracked domain, its latest AI-visibility score, when it was last
 * audited and next runs, and the most recent like-for-like change: against the
 * latest earlier snapshot that asked the same question (sameQuestion in
 * mappers.ts), or, when there is none, a note or the summary saying why.
 * Read-only; reads the snapshots the scheduler writes. Compact, glanceable.
 */
import type { Changes, MonitoringSite, MonitoringSnapshot } from "../api/types.js";
import { computeChanges, day, movement, questionDifference, sameQuestion, toQuestion } from "../api/mappers.js";
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

const NOT_RECORDED =
  "These snapshots do not record what each audit asked the assistants, so no like-for-like change can be shown.";

/**
 * The change a site can show, and why when it can show none.
 *
 * THE KEYS ARE CHECKED HERE TOO. The API returns as `previous` only a snapshot
 * that asked what `latest` asked, but a build of it from before that rule
 * returns the snapshot just before, whatever it asked, and a delta across a
 * change of question is exactly what must not reach a summary. So a pair this
 * cannot confirm is not subtracted, whichever API sent it.
 *
 * AND THE QUESTIONS ARE READ DEFENSIVELY. The client passes this payload through
 * unnormalized, and one malformed question field used to throw inside the
 * wording below and fail the whole tool, healthy sites included.
 */
function assess(
  latest: MonitoringSnapshot,
  latestScore: number,
  site: MonitoringSite,
): { change: Changes | null; label: string; note?: string } {
  const previous = site.previous;
  const comparison = site.comparison ?? null;
  const latestQuestion = toQuestion(latest.question);
  const previousQuestion = toQuestion(previous?.question);

  if (previous && sameQuestion({ question: latestQuestion }, { question: previousQuestion })) {
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
    const label = `${movement(change.score_delta)} since ${day(previous.captured_at)}`;
    if (skipped <= 0) return { change, label };
    change.skipped_snapshots = skipped;
    return {
      change,
      label,
      // The API sends how many were passed over, not why, so both reasons are named.
      note: `Compared with ${day(previous.captured_at)}, the most recent snapshot that asked the same question; `
        + `passed over in between: ${skipped} ${skipped === 1 ? "snapshot" : "snapshots"} that asked a different `
        + "question or did not record what was asked.",
    };
  }

  // Only a latest snapshot that recorded its question can start a series again;
  // whatever a comparison says about one that did not, nothing is known to have
  // changed.
  if (comparison?.status === "rebaselined" && latestQuestion?.key) {
    const priorQuestion = toQuestion(comparison.prior?.question);
    const why = priorQuestion?.key
      ? `it asked about ${questionDifference(latestQuestion, priorQuestion)}, compared with the snapshot on `
        + `${day(comparison.prior?.captured_at)}, and no earlier snapshot asked the same question`
      : "the snapshots before it do not record what they asked";
    return {
      change: null,
      label: `re-baselined on ${day(latest.captured_at)}; no like-for-like change yet`,
      note: `Re-baselined on ${day(latest.captured_at)}: ${why}, so there is no like-for-like change yet.`,
    };
  }

  if (previous && previousQuestion?.key && latestQuestion?.key) {
    return {
      change: null,
      label: "no like-for-like change yet",
      note: `The previous snapshot, on ${day(previous.captured_at)}, asked about `
        + `${questionDifference(previousQuestion, latestQuestion)}, so no like-for-like change can be shown.`,
    };
  }

  if (previous || comparison?.status === "not_recorded" || comparison?.status === "rebaselined") {
    // Say which side recorded nothing: the latest snapshot, or, from an API
    // before the rule, the previous one beside a latest that did record.
    const note = !latestQuestion?.key
      ? "The latest snapshot does not record what it asked the assistants, so no like-for-like change can be shown."
      : previous && !previousQuestion?.key
        ? `The previous snapshot, on ${day(previous.captured_at)}, does not record what it asked the assistants, `
          + "so no like-for-like change can be shown."
        : NOT_RECORDED;
    return { change: null, label: "no like-for-like change yet", note };
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
      // interchangeable here. The summary says in words why a score is null,
      // so undefined slipped past it into "AI visibility undefined/100", and
      // the declared output schema — which types this as a number-or-null —
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
        // AUDITED IS NOT "NOT AUDITED". A domain with no latest score may have
        // been audited all the same: its snapshots all measured nothing of the
        // business (weekly re-audits of a name invented from the hostname), or
        // an older API sent a latest snapshot without a score. Calling either
        // never audited sat beside the date of its last audit. Nor is every
        // claimed run an audit: the scheduler stamps last_audited_at when it
        // claims the domain, before the audit runs, fails, or is skipped for a
        // site that cannot be scored, so that case names the run, not an audit.
        const n = s.snapshots_count ?? 0;
        let summary: string;
        if (s.latest) {
          summary = `${s.domain}: its latest snapshot, on ${day(s.latest.captured_at)}, has no score.`;
        } else if (n > 0) {
          summary = `${s.domain}: audited, but ${n === 1 ? "its one snapshot did not measure" : `none of its ${n} snapshots measured`} the business, so there is no score yet.`;
        } else if (s.last_audited_at) {
          summary = `${s.domain}: its scheduled run on ${day(s.last_audited_at)} has stored no snapshot — it may still be running, or the audit failed, or the site cannot be scored — so there is no score.`;
        } else {
          summary = `${s.domain}: not audited yet — the first scheduled run will set a baseline.`;
        }
        return { ...base, change: null, summary };
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
