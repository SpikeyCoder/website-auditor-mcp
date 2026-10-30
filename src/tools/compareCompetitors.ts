/**
 * compare_competitors [Pro]
 *
 * There is no dedicated comparison endpoint upstream, so this tool fans out real
 * `runAudit` calls (one per domain) and builds the head-to-head view from each
 * site's AI-visibility block. Because the API enforces a hard per-key daily
 * audit cap (10/day), a naive fan-out over several competitors would exhaust the
 * whole day's quota in one call and 429 everything after it.
 *
 * This implementation is quota-aware and cache-aware instead:
 *   - It reuses a recent cached audit for a domain when available (no quota cost).
 *   - It learns the remaining quota up-front (subscription endpoint, when
 *     available) and/or from each audit's `X-RateLimit-Remaining` header, and
 *     caps the fan-out to what's actually available.
 *   - When the requested competitor set exceeds the remaining quota, it ranks
 *     the domains it could audit and returns an explicit `skipped` list + a
 *     `quota` block + a `summary` — competitors are never silently dropped, and
 *     scores are never fabricated for a domain that wasn't audited.
 *   - Zero remaining quota (can't even audit the primary domain) is an
 *     actionable OVER_QUOTA error carrying the reset time. Not an upgrade
 *     prompt: the cap applies to every subscription, so there is nothing to
 *     upgrade to — see the 429 branch in api/client.ts.
 *
 * It also has to finish inside one tool call. Claude stops waiting for a tool
 * after 240 seconds, and a cold audit takes about 70s at p50, so auditing the
 * competitors one after another passed that limit at three uncached sites. The
 * primary is still audited first and alone (its failure fails the comparison,
 * and its rate-limit header sizes the rest), then every competitor is started
 * at once. A competitor audit starts only if it can run to its own request
 * timeout before the deadline; one that can't is not started, costs nothing,
 * and is listed in `skipped` as "time_limit". Nothing in flight is ever
 * abandoned, because the API charges an audit once it has dispatched it.
 */
import type {
  Comparison,
  CompetitorRank,
  CompetitorGap,
  AiVisibility,
  SkippedDomain,
  CompareQuota,
} from "../api/types.js";
import { toAiVisibility, detectUnreachable, toComparisonRecommendationGap } from "../api/mappers.js";
import { normalizeDomain } from "../api/domain.js";
import { WaApiError, isKeyRejection } from "../api/errors.js";
import { gateProTool, fromApiError, ok, err, type ToolDeps, type ToolResult } from "./context.js";

export interface CompareCompetitorsArgs {
  domain: string;
  competitors: string[];
  /** Optional market scope, applied to the primary domain AND every
   *  competitor: the comparison asks about one market, not one business. */
  business_location?: string;
}

const ENGINES = ["chatgpt", "perplexity", "claude", "gemini"] as const;

/**
 * The whole call must answer inside this. Claude's limit on one tool call
 * (claude.com/docs/connectors/building) is 240s. The clock starts when this
 * function is entered, so the Pro gate is inside the budget; the margin covers
 * what runs before it (sign-in, the price refresh) and the trip back.
 *
 * Only competitor audits are held to it. The primary is audited however long
 * the gate took, and a gate that needed a slow subscription lookup can still
 * push one call past the limit: that takes a degraded upstream, not a cold
 * cache.
 */
export const TOOL_CALL_BUDGET_MS = 240_000 - 15_000;

/** Mutable quota tracker shared across the fan-out. */
interface QuotaState {
  limit: number | null;
  remaining: number | null;
  reset: string | null;
  auditsUsed: number;
  cachedReused: number;
  /**
   * Audits sent and not yet answered. The API reserves a slot for each one as
   * it arrives, so the budget left to start another is `remaining - inFlight`;
   * without it a parallel start would send every competitor against a budget
   * that only covers some of them.
   */
  inFlight: number;
}

type AuditOutcome =
  | { kind: "scored"; av: AiVisibility; fromCache: boolean }
  | { kind: "unreachable" }
  | { kind: "skip_quota" } // known-zero budget: not attempted
  | { kind: "skip_time" } // could not finish before the deadline: not attempted
  | { kind: "quota_error" } // attempted, API returned 429
  | { kind: "error"; error: unknown };

/**
 * Is this engine a gap: the competitor was named here and the primary was not?
 *
 * EXPORTED so tests drive this and not a copy of it. The first version of the
 * untested-vs-zero change asserted only that `appears_by_engine.claude` became
 * null and claimed that fixed the fabricated gap. It did not — the guard read
 * `!primaryAv.appears_by_engine[engine]`, and `!null` is `true` exactly as
 * `!false` was — and the test that was supposed to cover it re-implemented the
 * predicate inline, so reverting the real code still passed.
 *
 * BOTH sides must be explicit. A gap is a claim about two measurements, and an
 * engine that never answered for either site cannot support half of it.
 */
export function isGap(primary: boolean | null, competitor: boolean | null): boolean {
  return competitor === true && primary === false;
}

export async function compareCompetitors(
  args: CompareCompetitorsArgs,
  deps: ToolDeps,
): Promise<ToolResult<Comparison>> {
  const deadline = Date.now() + TOOL_CALL_BUDGET_MS;
  const gate = await gateProTool(deps, args.domain);
  if (gate) return gate;

  if (!Array.isArray(args.competitors) || args.competitors.length === 0) {
    return err("INVALID_INPUT", "Provide at least one competitor domain in `competitors`.");
  }

  // Normalize + dedupe. An invalid PRIMARY domain is fatal; invalid competitors
  // are reported as skipped, not fatal.
  let primaryHost: string;
  try {
    primaryHost = normalizeDomain(args.domain);
  } catch (e) {
    return fromApiError(e, deps.config, deps.transport, deps.authVia, args.domain);
  }

  const seen = new Set<string>([primaryHost]);
  const competitorHosts: string[] = [];
  const skipped: SkippedDomain[] = [];
  for (const raw of args.competitors) {
    let host: string;
    try {
      host = normalizeDomain(raw);
    } catch (e) {
      skipped.push({ domain: raw, reason: "error", detail: e instanceof Error ? e.message : "invalid domain" });
      continue;
    }
    if (seen.has(host)) continue; // collapse the primary-as-competitor and duplicates
    seen.add(host);
    competitorHosts.push(host);
  }

  const quota: QuotaState = {
    limit: null, remaining: null, reset: null, auditsUsed: 0, cachedReused: 0, inFlight: 0,
  };

  // Pre-flight: read remaining quota without spending an audit, if possible.
  const preflight = await safeRemaining(deps);
  if (preflight) {
    quota.remaining = preflight.remaining;
    quota.limit = preflight.limit;
    quota.reset = preflight.reset;
  }

  // Primary domain first — its hard failures fail the whole comparison.
  // NB: we do NOT short-circuit on a known-zero budget here — auditDomain
  // consults the cache first, so a fully-cached re-run still succeeds with zero
  // quota spend. Only an uncached primary with no budget yields OVER_QUOTA.
  // TRIMMED ONCE, HERE. The cache key was built from the raw value while
  // client.runAudit trims before sending, so " Chiang Mai" and "Chiang Mai"
  // produced two cache entries for one upstream answer — and the second one
  // re-spent the hard 10/day quota to learn what the first already knew.
  const market = typeof args.business_location === 'string'
    ? args.business_location.trim() : '';
  const primaryOutcome = await auditDomain(
    deps, primaryHost, quota, market || undefined);
  switch (primaryOutcome.kind) {
    case "skip_quota":
    case "quota_error":
      return overQuota(primaryHost, quota);
    case "unreachable":
      return err(
        "UNREACHABLE_DOMAIN",
        `The site at ${args.domain} didn't load during the audit (no page loaded), so it can't be compared. Check the domain is correct, publicly reachable and serving pages.`,
      );
    case "error":
      return fromApiError(primaryOutcome.error, deps.config, deps.transport, deps.authVia, args.domain);
    case "skip_time":
      // Unreachable: the primary is given no latest start. It is audited first,
      // and without it there is nothing to compare.
      throw new Error("compare_competitors: the primary audit was skipped for time");
  }
  const primaryAv = primaryOutcome.av;

  // Competitors, all started at once. We always route through auditDomain even
  // after the quota is exhausted: it consults the cache FIRST (a cache hit is
  // free regardless of budget and time) and only returns skip_quota or
  // skip_time on a genuine cache miss. So a cached competitor is still served
  // for free rather than dropped.
  //
  // Every start decision is made in list order before any answer arrives:
  // auditDomain runs synchronously up to its runAudit call, so each map step
  // sees the in-flight count the previous ones left. When the primary's header
  // gave a budget, earlier competitors get it first, as they did when this loop
  // was sequential. When it gave none (the primary came from the cache), every
  // uncached competitor is sent and the API decides which fit: the ones it
  // refuses get a 429, which costs nothing, and are reported as quota skips.
  //
  // An audit may start only if it can reach its own request timeout before the
  // deadline, so nothing started here is still running when the call answers.
  // That makes WA_REQUEST_TIMEOUT_MS part of this tool's budget: at 120s a
  // competitor can start up to 105s in, and raised past 225s none ever could.
  const latestStart = deadline - deps.config.requestTimeoutMs;
  const outcomes = await Promise.all(
    competitorHosts.map((host) => auditDomain(deps, host, quota, market || undefined, latestStart)),
  );
  const audited: Array<{ host: string; av: AiVisibility }> = [];
  for (const [i, host] of competitorHosts.entries()) {
    const outcome = outcomes[i]!;
    switch (outcome.kind) {
      case "scored":
        audited.push({ host, av: outcome.av });
        break;
      case "unreachable":
        skipped.push({ domain: host, reason: "unreachable" });
        break;
      case "error":
        // An auth failure is systemic — every subsequent audit will fail too.
        // Any key rejection, however the API named it — a revoked key fails
        // every remaining domain exactly as an unrecognised one does.
        if (outcome.error instanceof WaApiError && isKeyRejection(outcome.error.code)) {
          return fromApiError(outcome.error, deps.config, deps.transport, deps.authVia, args.domain);
        }
        skipped.push({
          domain: host,
          reason: "error",
          detail: outcome.error instanceof Error ? outcome.error.message : "audit failed",
        });
        break;
      case "skip_quota":
      case "quota_error":
        // Budget is now known-zero; subsequent cache misses fall here too (no
        // network), while cached competitors still resolve via auditDomain.
        skipped.push({ domain: host, reason: "quota" });
        break;
      case "skip_time":
        skipped.push({
          domain: host,
          reason: "time_limit",
          detail: "Not started: an audit could not finish inside the time limit on one tool call. No quota was spent.",
        });
        break;
    }
  }

  const ranking: CompetitorRank[] = [
    { domain: primaryHost, score: primaryAv.score },
    ...audited.map((a) => ({ domain: a.host, score: a.av.score })),
  ].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  // Gaps are appearance-based: an engine where the competitor APPEARS in AI
  // answers and the primary site does NOT ("where they appear that the site does
  // not"). This is presence/absence, not a score comparison — a competitor can
  // outscore the site on an engine where both appear (no gap), and a gap can
  // exist on an engine where neither has a high score.
  const gaps: CompetitorGap[] = [];
  for (const a of audited) {
    for (const engine of ENGINES) {
      if (isGap(primaryAv.appears_by_engine[engine], a.av.appears_by_engine[engine])) {
        gaps.push({ engine, competitor: a.host });
      }
    }
  }

  const quotaSkipped = skipped.filter((s) => s.reason === "quota").length;
  const compareQuota: CompareQuota = {
    limit: quota.limit,
    remaining: quota.remaining,
    audits_used: quota.auditsUsed,
    audits_skipped: quotaSkipped,
    cached_reused: quota.cachedReused,
    reset: quota.reset,
  };

  const summary = buildSummary({
    primary: primaryHost,
    comparedCount: audited.length,
    requestedCount: competitorHosts.length,
    quotaSkipped,
    timeSkipped: skipped.filter((s) => s.reason === "time_limit").length,
    otherSkipped: skipped.filter((s) => s.reason !== "quota" && s.reason !== "time_limit"),
    remaining: quota.remaining,
    reset: quota.reset,
    cachedReused: quota.cachedReused,
  });

  // How far behind each competitor you are in RECOMMENDED answers:
  // each audit's own stance counts, so the audits' sample sizes need not match.
  // Absent when your audit or every competitor's recorded none. The sentence
  // goes in `summary`, the text the model actually reads.
  const recommendationGap = toComparisonRecommendationGap(
    primaryAv.stance_counts,
    audited.map((a) => ({ domain: a.host, counts: a.av.stance_counts })),
  );
  const summaryWithGap = recommendationGap ? `${summary} ${recommendationGap.sentence}` : summary;

  // NAMED IN THE RESULT, because a scoped comparison and an unscoped one are
  // different measurements and were indistinguishable to every reader —
  // including whatever later diffs two of them. null rather than '' so "no
  // market" is one state rather than two.
  return ok({
    ranking, gaps, quota: compareQuota, skipped, summary: summaryWithGap, market: market || null,
    ...(recommendationGap ? { recommendation_gap: recommendationGap } : {}),
  });
}

/**
 * Obtain an audit for a domain, honoring the cache, the known quota budget and,
 * when `latestStart` is given, the time left: an uncached audit is not started
 * after that instant.
 * Mutates `quota` (auditsUsed, cachedReused, inFlight, and the learned
 * remaining/limit/reset).
 */
async function auditDomain(
  deps: ToolDeps,
  host: string,
  quota: QuotaState,
  businessCity?: string,
  latestStart?: number,
): Promise<AuditOutcome> {
  // KEYED WITH THE LOCATION, not by host alone. The same domain scored
  // against "Chiang Mai, Thailand" and against nothing are two different
  // measurements — different questions, different competitors — and a
  // host-only key would serve whichever landed first for 24 hours.
  const cacheKey = businessCity ? `${host}\u001f${businessCity}` : host;
  const cached = deps.cache.get(cacheKey);
  if (cached) {
    quota.cachedReused += 1;
    return { kind: "scored", av: cached, fromCache: true };
  }

  // We know the budget is exhausted, counting the audits already sent — don't
  // attempt (avoids a wasted 429).
  if (quota.remaining !== null && quota.remaining - quota.inFlight <= 0) {
    return { kind: "skip_quota" };
  }

  // Quota before time: an exhausted budget is the reason that tells the caller
  // to wait for the reset, where a re-run now would only be refused again.
  if (latestStart !== undefined && Date.now() > latestStart) {
    return { kind: "skip_time" };
  }

  quota.inFlight += 1;
  try {
    const res = await deps.client.runAudit({ domain: host, businessCity });
    quota.auditsUsed += 1;
    if (res.rateLimit) {
      // The LOWEST remaining seen, not the last one to arrive. Each header is
      // the count when that request was reserved; parallel answers arrive in
      // any order, and the last to land can carry a count from before its
      // siblings were reserved. Compared only within one day: a header naming
      // a LATER reset was reserved after UTC midnight and replaces the count,
      // and one naming an EARLIER reset is yesterday's and is ignored.
      const { remaining: r, reset } = res.rateLimit;
      const newerDay = !!reset && !!quota.reset && reset > quota.reset;
      const olderDay = !!reset && !!quota.reset && reset < quota.reset;
      if (r !== null && !olderDay) {
        quota.remaining = quota.remaining === null || newerDay ? r : Math.min(quota.remaining, r);
      }
      if (res.rateLimit.limit !== null) quota.limit = res.rateLimit.limit;
      if (reset && !olderDay) quota.reset = reset;
    }
    if (detectUnreachable(res.report)) return { kind: "unreachable" };
    const av = toAiVisibility(res.report);
    deps.cache.set(cacheKey, av);
    return { kind: "scored", av, fromCache: false };
  } catch (e) {
    if (e instanceof WaApiError && e.code === "OVER_QUOTA") {
      quota.remaining = 0;
      applyQuotaDetails(quota, e.details);
      return { kind: "quota_error" };
    }
    return { kind: "error", error: e };
  } finally {
    quota.inFlight -= 1;
  }
}

/** Read remaining quota without spending an audit; null on any failure. */
async function safeRemaining(deps: ToolDeps) {
  try {
    return await deps.client.getRemainingQuota();
  } catch {
    return null;
  }
}

function applyQuotaDetails(quota: QuotaState, details: unknown): void {
  if (details && typeof details === "object") {
    const d = details as { limit?: unknown; resets_at?: unknown; reset?: unknown };
    if (typeof d.limit === "number") quota.limit = d.limit;
    if (typeof d.resets_at === "string") quota.reset = d.resets_at;
    else if (typeof d.reset === "string") quota.reset = d.reset;
  }
}

/**
 * The daily audit cap is spent. NOT an upsell: there is one plan,
 * so "upgrade for a higher quota" — which this used to say in words — describes
 * a product nobody can buy, to a customer who is already paying. The only true
 * remedy is waiting for the reset, so that is the whole message.
 */
function overQuota(primaryHost: string, quota: QuotaState): ToolResult<never> {
  const resetTxt = quota.reset ? ` It resets at ${quota.reset}.` : "";
  return err(
    "OVER_QUOTA",
    `Your daily audit quota is exhausted, so ${primaryHost} can't be audited to compare it.${resetTxt} Re-run after it resets.`,
    { details: { limit: quota.limit, remaining: 0, reset: quota.reset } },
  );
}

function buildSummary(p: {
  primary: string;
  comparedCount: number;
  requestedCount: number;
  quotaSkipped: number;
  timeSkipped: number;
  otherSkipped: SkippedDomain[];
  remaining: number | null;
  reset: string | null;
  cachedReused: number;
}): string {
  const parts: string[] = [];
  parts.push(
    `Compared ${p.primary} against ${p.comparedCount} of ${p.requestedCount} competitor${p.requestedCount === 1 ? "" : "s"}.`,
  );

  if (p.quotaSkipped > 0) {
    const resetTxt = p.reset ? ` (quota resets ${p.reset})` : "";
    const remainTxt =
      p.remaining !== null
        ? `${p.remaining} audit${p.remaining === 1 ? "" : "s"} remain today${resetTxt}`
        : `the daily audit quota is exhausted${resetTxt}`;
    parts.push(
      `${p.quotaSkipped} competitor${p.quotaSkipped === 1 ? "" : "s"} skipped because ${remainTxt}. They were not dropped — re-run after the reset.`,
    );
  } else if (p.remaining !== null) {
    parts.push(`${p.remaining} audit${p.remaining === 1 ? "" : "s"} remain today.`);
  }

  if (p.timeSkipped > 0) {
    const them = p.timeSkipped === 1 ? "it" : "them";
    parts.push(
      `${p.timeSkipped} competitor${p.timeSkipped === 1 ? " was" : "s were"} not audited because too little time was left for another audit to finish inside the time limit on one tool call. No quota was spent on ${them}; run the comparison again to include ${them}.`,
    );
  }

  if (p.cachedReused > 0) {
    parts.push(`${p.cachedReused} domain${p.cachedReused === 1 ? "" : "s"} reused a recent cached audit (no quota spent).`);
  }

  if (p.otherSkipped.length > 0) {
    const detail = p.otherSkipped.map((s) => `${s.domain} (${s.reason})`).join(", ");
    parts.push(`${p.otherSkipped.length} could not be audited: ${detail}.`);
  }

  return parts.join(" ");
}
