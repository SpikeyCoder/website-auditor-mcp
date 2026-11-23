/**
 * `weekly_changes`: what the weekly check found, on the replies of the main
 * tools while the account is in a trial.
 *
 * WHY. Trialists mostly work through the assistant and rarely open the
 * dashboard, so the ongoing value (the weekly check and what it found) has to
 * arrive in the replies they already read. The block says what moved on their
 * tracked sites, each change given since a date, when the next weekly check runs, or that
 * nothing changed, or that no site is tracked.
 *
 * THE RULES.
 *   * Trial accounts only: the subscription's status is `trialing`
 *     (TierResolution.trialing). Everyone else gets no key at all.
 *   * One read, GET /api/monitoring-status (client.getMonitoringStatus), the same data
 *     get_monitoring_status is built from, described by the same
 *     `describeSite`, so the numbers and words cannot differ from theirs.
 *   * Cached per account for five minutes, bounded in size, keyed by a hash of
 *     the account's key. A lookup that fails or runs long is remembered for a
 *     short while too, so an outage costs one wait, not one per reply.
 *   * Fail soft: any failure means the reply is returned unchanged.
 *   * Neutral words: facts about the member's sites. No price, no plan, no
 *     trial in the text; no tool name under neutral copy.
 */
import { createHash } from "node:crypto";
import { normalizeDomain } from "../api/domain.js";
import { ENGINE_LABELS, day, movement } from "../api/mappers.js";
import type { MonitoringSite, WeeklyChanges, WeeklySite } from "../api/types.js";
import { describeSite, type MonitoringStatusSite } from "./getMonitoringStatus.js";
import type { ToolDeps } from "./context.js";

export type { WeeklyChanges };

/**
 * Success TTL. Short because the invalidation is per process and the hosted
 * service can run several instances (Cloud Run, --max-instances 20): a change
 * made through one instance leaves the others' entries until they expire. A
 * monitoring read is cheap, so five minutes costs little, and it also bounds a
 * read that landed just before a change.
 */
export const WEEKLY_TTL_MS = 5 * 60 * 1000;
export const WEEKLY_FAILURE_TTL_MS = 60 * 1000;
export const WEEKLY_MAX_ENTRIES = 500;
/** The monitoring read. */
export const WEEKLY_READ_TIMEOUT_MS = 1500;
/** The whole field: subscription lookup and monitoring read together. */
export const WEEKLY_TOTAL_TIMEOUT_MS = 2000;
const MAX_SITES = 3;
const MAX_ENGINES = 3;

interface Entry {
  /** The monitoring read, or null for a remembered failure. */
  sites: readonly MonitoringSite[] | null;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

/**
 * The read in progress per key. A lookup that misses joins it or starts one, so
 * concurrent callers for one account share one read. `cancelled`: the account's
 * data changed while it ran, so it stores nothing. `discarded` (a track or
 * untrack): what it read is not said either, its callers get nothing. After an
 * audit it is only `cancelled`, and its callers still render what they awaited. Per process, like the cache.
 */
interface Flight { promise: Promise<readonly MonitoringSite[] | null>; cancelled: boolean; discarded: boolean }
const inFlight = new Map<string, Flight>();

/** Test seam: forget everything. */
export function clearWeeklyChangesCache(): void {
  cache.clear();
  for (const f of inFlight.values()) f.cancelled = f.discarded = true;
  inFlight.clear();
}

/** Test seam: how many entries the cache holds. */
export function weeklyChangesCacheSize(): number {
  return cache.size;
}

/** The account's cache key. A hash, so the key itself is never held here. */
function cacheKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function put(key: string, entry: Entry, now: number): void {
  cache.delete(key);
  if (cache.size >= WEEKLY_MAX_ENTRIES) {
    for (const [k, e] of cache) if (e.expiresAt <= now) cache.delete(k);
    // Still full: drop the oldest stored (Map keeps insertion order).
    while (cache.size >= WEEKLY_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  cache.set(key, entry);
}

/**
 * The account's data changed: drop its entry and cancel a read still running,
 * which predates the change. Writes nothing, so an account that never gets a
 * block (not in a trial) adds no entry. Used after track_site, untrack_site and
 * every audit.
 *
 * Audits call it after their own weekly read has finished and been used. After
 * an audit a second read in the same window is possible: a reply that arrives
 * while an audit runs can start its own read, and its result is stored unless a
 * later invalidation cancels it. During an outage each audit costs one read;
 * accepted.
 *
 * A flight cancelled by an audit is no longer reachable for a later discard
 * (a track or untrack within the same moment): at most one concurrent reply can
 * render a read that predates it, and nothing is stored. Accepted.
 *
 * Per process, and per API key: another instance, or another key on the same
 * account, keeps its own entry, which can be stale for up to the TTL. The API
 * exposes no account id to key on, and the TTL caps it.
 */
export function invalidateWeeklyChanges(deps: ToolDeps, opts: { discard?: boolean } = {}): void {
  if (!deps.config.apiKey) return;
  const key = cacheKey(deps.config.apiKey);
  cache.delete(key);
  const flight = inFlight.get(key);
  if (flight) {
    flight.cancelled = true;
    if (opts.discard) flight.discarded = true;
    inFlight.delete(key);
  }
}

function hostOf(domain: string): string | null {
  try {
    return normalizeDomain(domain);
  } catch {
    return null;
  }
}

function label(engine: string): string {
  return ENGINE_LABELS[engine] ?? engine;
}

interface Described {
  site: WeeklySite;
  /** The headline sentence get_monitoring_status words the site with. */
  line: string;
  /** A like-for-like overall comparison was made and nothing moved. */
  quiet: boolean;
  /** Something moved: the overall, or an engine. */
  moved: boolean;
  /** A like-for-like comparison exists (even if only per engine). */
  compared: boolean;
}

/** One site. No wording of its own: the sentence is describeSite's, as get_monitoring_status says it. */
function describe(s: MonitoringSite, host: string): Described {
  // `host` is the validated, normalized domain (lowercase, no "www."): the raw
  // API string is not put in prose. sites[].domain may differ in case or "www."
  // from what list_tracked_sites shows.
  const parts = describeSite({ ...s, domain: host });
  const d: MonitoringStatusSite = parts.site;
  const change = d.change;
  const engines = (change?.engine_changes ?? [])
    .filter((c) => c.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, MAX_ENGINES)
    .map((c) => ({ engine: c.engine, label: label(c.engine), delta: c.delta }));
  const delta = change ? change.score_delta : null;
  const moved = engines.length > 0 || (delta ?? 0) !== 0;
  // The line is describeSite's headline (score and change since a date). The
  // caveat that the score is older than the last run stays with it, and so do
  // the top two engine moves; the rest goes in `detail`.
  let line = parts.headline;
  if (parts.olderCaveat) line += ` ${parts.olderCaveat}`;
  let byDetail = "";
  if (engines.length > 0) {
    line += ` By assistant: ${engines.slice(0, 2).map((c) => `${label(c.engine)} ${movement(c.delta)}`).join(", ")}.`;
    const also = engines.slice(2).map((c) => `${label(c.engine)} ${movement(c.delta)}`).join(", ");
    byDetail = also ? `Also: ${also}.` : "";
  }
  // A score older than the last run is not a settled "no change".
  const stale = parts.stale;
  const detail = [parts.rest, byDetail, d.note ?? ""].filter(Boolean).join(" ");
  return {
    site: {
      domain: host,
      latest_score: d.latest_score,
      score_delta: delta,
      since: change?.from_captured_at && Number.isFinite(Date.parse(change.from_captured_at)) ? day(change.from_captured_at) : null,
      engines,
      ...(detail ? { detail } : {}),
    },
    line,
    // Passed-over snapshots mean the comparison skipped some history: not a settled "no change".
    quiet: change !== null && delta === 0 && !moved && !stale && !(change.skipped_snapshots && change.skipped_snapshots > 0),
    moved,
    compared: change !== null && !stale,
  };
}

/** The block from the monitoring read; pure, so it is tested without a client. */
export function buildWeeklyChanges(
  sites: readonly MonitoringSite[],
  deps: Pick<ToolDeps, "config">,
  now: number,
  /** A site was left out because the reply is about it: say "other" sites. */
  excluded = false,
): WeeklyChanges {
  const own = excluded ? "other tracked" : "tracked";
  const active = sites
    .filter((s) => s.active !== false)
    .map((s) => ({ s, host: hostOf(s.domain) }))
    .filter((x): x is { s: MonitoringSite; host: string } => x.host !== null);

  if (active.length === 0 && sites.length > 0) {
    // Tracked, but nothing to report on: paused, or no readable domain.
    const pausedN = sites.filter((s) => s.active === false).length;
    const unreadN = sites.length - pausedN;
    const noun = (n: number) => (n === 1 ? "site" : "sites");
    // A site whose domain cannot be normalized is not shown (the raw string is
    // not put in prose): said as not shown here, never as having no result.
    const shown = (n: number) =>
      `can't be shown here${deps.config.toolCopy === "neutral" ? "" : ` (get_monitoring_status lists ${n === 1 ? "it" : "them"})`}`;
    const summary = unreadN === 0
      ? `Weekly checks are paused for your ${own} ${noun(pausedN)}.`
      : pausedN === 0
        ? `${unreadN} ${own} ${noun(unreadN)} ${shown(unreadN)}.`
        : `Your ${own} sites: ${pausedN} paused; ${unreadN} ${shown(unreadN)}.`;
    return {
      summary,
      tracking: true,
      next_check_at: null,
      sites: [],
    };
  }

  if (active.length === 0) {
    // Said as a fact under neutral copy, with the tool's name elsewhere.
    const summary = deps.config.toolCopy === "neutral"
      ? "No site is tracked yet; tracking a site starts a weekly check, and what changed shows up here."
      : "No site is tracked yet. Track one (track_site) and each week's changes show up here.";
    return { summary, tracking: false, next_check_at: null, sites: [] };
  }

  const runs = active
    .map(({ s }) => s.next_run_at)
    .filter((t): t is string => typeof t === "string" && Number.isFinite(Date.parse(t)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  // Any run already past is overdue: say so, naming the earliest. Else the earliest ahead.
  const next = runs[0] ?? null;
  const overdue = next !== null && Date.parse(next) <= now;
  const nextText = !next
    ? ""
    : overdue ? ` Next weekly check: due now (scheduled ${day(next)}).` : ` Next weekly check: ${day(next)}.`;

  const paused = sites.filter((s) => s.active === false).length;
  // Active sites whose domain cannot be read are dropped above but still tracked.
  const unreadable = sites.filter((s) => s.active !== false).length - active.length;
  const pausedText = paused > 0 ? `${paused} paused` : "";

  // No active site has a snapshot or a run: nothing has been checked yet.
  if (active.every(({ s }) => (s.snapshots_count ?? 0) === 0 && !s.latest && !s.last_audited_at)) {
    const hiddenFirst = Math.max(0, active.length - MAX_SITES) + unreadable;
    const tail = [hiddenFirst > 0 ? `${hiddenFirst} more tracked` : "", pausedText].filter(Boolean).join(", ");
    return {
      summary: `The first weekly check hasn't run yet${excluded ? ` on your other tracked ${active.length === 1 ? "site" : "sites"}` : ""}.${tail ? ` ${tail}.` : ""}${nextText}`,
      tracking: true,
      next_check_at: next,
      ...(overdue ? { next_check_due: true } : {}),
      sites: active.slice(0, MAX_SITES).map(({ host }) => ({ domain: host, latest_score: null, score_delta: null, since: null, engines: [] })),
    };
  }

  // Every active site is described, so what is said about all of them is true
  // of all of them; the ones that moved, or were not compared, are shown first.
  const all = active.map(({ s, host }) => describe(s, host));
  const rank = (d: Described) => (d.moved ? 0 : d.quiet ? 2 : 1);
  const ordered = all.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i).map((x) => x.d);
  const shown = ordered.slice(0, MAX_SITES);
  const hidden = ordered.slice(MAX_SITES);

  const head = unreadable === 0 && all.every((d) => d.quiet)
    ? `No ${excluded ? "other " : ""}${paused > 0 ? "active " : ""}tracked site has changed`
    : all.some((d) => d.compared) ? "Latest changes" : "Weekly tracking";
  const hiddenNotable = hidden.some((d) => d.moved);
  const hiddenText = hidden.length + unreadable === 0
    ? ""
    : `${hidden.length + unreadable} more tracked${hiddenNotable ? `, ${hidden.length + unreadable === 1 ? "with changes" : "some with changes"}${deps.config.toolCopy === "neutral" ? "" : " (get_monitoring_status lists all)"}` : ""}`;
  const more = [hiddenText, pausedText].filter(Boolean).join(", ");
  const moreText = more ? ` ${more}.` : "";
  const body = shown.map((d) => d.line).join(" ");
  return {
    summary: `${head} — ${body}${moreText}${nextText}`,
    tracking: true,
    next_check_at: next,
    ...(overdue ? { next_check_due: true } : {}),
    sites: shown.map((d) => d.site),
  };
}

async function lookup(deps: ToolDeps): Promise<readonly MonitoringSite[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([
      deps.client.getMonitoringStatus({ timeoutMs: WEEKLY_READ_TIMEOUT_MS, requireSites: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("monitoring read timed out")), WEEKLY_READ_TIMEOUT_MS);
      }),
    ]);
    return status.sites;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The reply's optional field: `{ weekly_changes }` for a trial account, else
 * `{}`. Never throws, never waits longer than WEEKLY_TOTAL_TIMEOUT_MS from the await,
 * and never costs more than one read per account per cache window. `trialing`
 * may be passed when the caller already knows it (check_upgrade_status reads
 * the status itself). `exclude` is a site the reply is itself about (an audit
 * that just ran): it is left out of the block, which is built per reply from
 * the cached read, so the block never contradicts the audit beside it. When
 * that leaves no site to talk about, there is no block.
 */
export function weeklyChangesField(
  deps: ToolDeps,
  opts: { trialing?: boolean; exclude?: string } = {},
): Promise<{ weekly_changes?: WeeklyChanges }> {
  return startWeeklyChanges(deps, opts).result();
}

/** A weekly read that may already be running; its cap starts when `result()` is awaited. */
export interface PendingWeekly {
  result(): Promise<{ weekly_changes?: WeeklyChanges }>;
}

/** Nothing to wait for: a caller that gets no block. */
export const NO_WEEKLY: PendingWeekly = { result: () => Promise.resolve({}) };

/**
 * Start the read now and return a handle. The two-second cap runs from the
 * moment the caller awaits `result()`, not from launch, so a read started
 * beside a long audit is not given up on just because the audit took a while.
 */
export function startWeeklyChanges(
  deps: ToolDeps,
  opts: { trialing?: boolean; exclude?: string } = {},
): PendingWeekly {
  const started = compute(deps, opts).catch((): { weekly_changes?: WeeklyChanges } => ({}));
  return {
    async result() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          started,
          new Promise<{}>((resolve) => {
            timer = setTimeout(() => resolve({}), WEEKLY_TOTAL_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

async function compute(deps: ToolDeps, opts: { trialing?: boolean; exclude?: string }): Promise<{ weekly_changes?: WeeklyChanges }> {
  const apiKey = deps.config.apiKey;
  if (!apiKey) return {};
  let trialing = opts.trialing;
  if (trialing === undefined) {
    const resolved = await deps.subscriptions.resolve(apiKey);
    trialing = resolved.verified && resolved.tier === "pro" && resolved.trialing === true;
  }
  if (!trialing) return {};

  const key = cacheKey(apiKey);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.sites ? render(hit.sites, deps, opts.exclude, now) : {};
  }

  let flight = inFlight.get(key);
  if (!flight) {
    const f: Flight = { promise: Promise.resolve(null), cancelled: false, discarded: false };
    inFlight.set(key, f);
    f.promise = (async () => {
      let result: readonly MonitoringSite[] | null;
      try {
        result = await lookup(deps);
      } catch {
        result = null;
      }
      // Stored only by the flight still current for the key, and not cancelled.
      if (inFlight.get(key) === f && !f.cancelled) {
        const at = Date.now();
        put(key, { sites: result, expiresAt: at + (result ? WEEKLY_TTL_MS : WEEKLY_FAILURE_TTL_MS) }, at);
      }
      if (inFlight.get(key) === f) inFlight.delete(key);
      return result;
    })();
    flight = f;
  }
  // A cancelled flight only skips the store: what it read still renders, unless
  // a track or untrack discarded it.
  const sites = await flight.promise;
  if (flight.discarded) return {};
  return sites ? render(sites, deps, opts.exclude, Date.now()) : {};
}

function render(
  sites: readonly MonitoringSite[],
  deps: ToolDeps,
  exclude: string | undefined,
  now: number,
): { weekly_changes?: WeeklyChanges } {
  let use = sites;
  if (exclude) {
    const host = hostOf(exclude);
    if (host) {
      use = sites.filter((s) => hostOf(s.domain) !== host);
      // Something was left out and nothing active and readable remains: what is
      // left (paused, unreadable) is not the account, so there is nothing to say.
      if (use.length < sites.length && !use.some((s) => s.active !== false && hostOf(s.domain) !== null)) return {};
    }
  }
  return { weekly_changes: buildWeeklyChanges(use, deps, now, use.length < sites.length) };
}
