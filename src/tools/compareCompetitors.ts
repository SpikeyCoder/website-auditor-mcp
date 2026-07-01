/**
 * compare_competitors [Pro]
 *
 * There is no dedicated comparison endpoint upstream, so this tool fans out real
 * `runAudit` calls (one per domain) and builds the head-to-head view from each
 * site's AI-visibility block. Because the API enforces a hard per-key daily
 * audit cap (5/day), a naive fan-out over several competitors would exhaust the
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
 *     actionable OVER_QUOTA error with the reset time and upgrade path.
 */
import type {
  Comparison,
  CompetitorRank,
  CompetitorGap,
  AiVisibility,
  SkippedDomain,
  CompareQuota,
} from "../api/types.js";
import { toAiVisibility, detectUnreachable } from "../api/mappers.js";
import { normalizeDomain } from "../api/domain.js";
import { WaApiError } from "../api/errors.js";
import { gateProTool, fromApiError, ok, err, type ToolDeps, type ToolResult } from "./context.js";

export interface CompareCompetitorsArgs {
  domain: string;
  competitors: string[];
}

const ENGINES = ["chatgpt", "perplexity", "claude", "gemini"] as const;

/** Mutable quota tracker shared across the fan-out. */
interface QuotaState {
  limit: number | null;
  remaining: number | null;
  reset: string | null;
  auditsUsed: number;
  cachedReused: number;
}

type AuditOutcome =
  | { kind: "scored"; av: AiVisibility; fromCache: boolean }
  | { kind: "unreachable" }
  | { kind: "skip_quota" } // known-zero budget: not attempted
  | { kind: "quota_error" } // attempted, API returned 429
  | { kind: "error"; error: unknown };

export async function compareCompetitors(
  args: CompareCompetitorsArgs,
  deps: ToolDeps,
): Promise<ToolResult<Comparison>> {
  const gate = await gateProTool(deps);
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
    return fromApiError(e, deps.config.upgradeUrl);
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

  const quota: QuotaState = { limit: null, remaining: null, reset: null, auditsUsed: 0, cachedReused: 0 };

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
  const primaryOutcome = await auditDomain(deps, primaryHost, quota);
  switch (primaryOutcome.kind) {
    case "skip_quota":
    case "quota_error":
      return overQuota(deps, primaryHost, quota);
    case "unreachable":
      return err(
        "UNREACHABLE_DOMAIN",
        `The site at ${args.domain} could not be reached, so it can't be compared. Check the domain is correct and publicly reachable.`,
      );
    case "error":
      return fromApiError(primaryOutcome.error, deps.config.upgradeUrl);
  }
  const primaryAv = primaryOutcome.av;

  // Competitors. We always route through auditDomain even after the quota is
  // exhausted: it consults the cache FIRST (a cache hit is free regardless of
  // budget) and only returns skip_quota on a genuine cache miss with no budget.
  // So a cached competitor is still served for free rather than dropped.
  const audited: Array<{ host: string; av: AiVisibility }> = [];
  for (const host of competitorHosts) {
    const outcome = await auditDomain(deps, host, quota);
    switch (outcome.kind) {
      case "scored":
        audited.push({ host, av: outcome.av });
        break;
      case "unreachable":
        skipped.push({ domain: host, reason: "unreachable" });
        break;
      case "error":
        // An auth failure is systemic — every subsequent audit will fail too.
        if (outcome.error instanceof WaApiError && outcome.error.code === "INVALID_KEY") {
          return fromApiError(outcome.error, deps.config.upgradeUrl);
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
      if (a.av.appears_by_engine[engine] && !primaryAv.appears_by_engine[engine]) {
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
    otherSkipped: skipped.filter((s) => s.reason !== "quota"),
    remaining: quota.remaining,
    reset: quota.reset,
    cachedReused: quota.cachedReused,
  });

  return ok({ ranking, gaps, quota: compareQuota, skipped, summary });
}

/**
 * Obtain an audit for a domain, honoring the cache and the known quota budget.
 * Mutates `quota` (auditsUsed, cachedReused, and the learned remaining/limit/reset).
 */
async function auditDomain(deps: ToolDeps, host: string, quota: QuotaState): Promise<AuditOutcome> {
  const cached = deps.cache.get(host);
  if (cached) {
    quota.cachedReused += 1;
    return { kind: "scored", av: cached, fromCache: true };
  }

  // We know the budget is exhausted — don't attempt (avoids a wasted 429).
  if (quota.remaining !== null && quota.remaining <= 0) {
    return { kind: "skip_quota" };
  }

  try {
    const res = await deps.client.runAudit({ domain: host });
    quota.auditsUsed += 1;
    if (res.rateLimit) {
      if (res.rateLimit.remaining !== null) quota.remaining = res.rateLimit.remaining;
      if (res.rateLimit.limit !== null) quota.limit = res.rateLimit.limit;
      if (res.rateLimit.reset) quota.reset = res.rateLimit.reset;
    }
    if (detectUnreachable(res.report)) return { kind: "unreachable" };
    const av = toAiVisibility(res.report);
    deps.cache.set(host, av);
    return { kind: "scored", av, fromCache: false };
  } catch (e) {
    if (e instanceof WaApiError && e.code === "OVER_QUOTA") {
      quota.remaining = 0;
      applyQuotaDetails(quota, e.details);
      return { kind: "quota_error" };
    }
    return { kind: "error", error: e };
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

function overQuota(deps: ToolDeps, primaryHost: string, quota: QuotaState): ToolResult<never> {
  const resetTxt = quota.reset ? ` It resets at ${quota.reset}.` : "";
  return err(
    "OVER_QUOTA",
    `Your daily audit quota is exhausted, so ${primaryHost} can't be audited to compare it.${resetTxt} Re-run after the reset or upgrade for a higher quota.`,
    { upgrade_url: deps.config.upgradeUrl, details: { limit: quota.limit, remaining: 0, reset: quota.reset } },
  );
}

function buildSummary(p: {
  primary: string;
  comparedCount: number;
  requestedCount: number;
  quotaSkipped: number;
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
      `${p.quotaSkipped} competitor${p.quotaSkipped === 1 ? "" : "s"} skipped because ${remainTxt}. They were not dropped — re-run after the reset or upgrade for a higher quota.`,
    );
  } else if (p.remaining !== null) {
    parts.push(`${p.remaining} audit${p.remaining === 1 ? "" : "s"} remain today.`);
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
