/**
 * Pure mappers from the REAL upstream `AuditReport` to the tool return shapes.
 * No fabrication: every value is derived from data the audit actually produced.
 * Where the upstream has no direct equivalent (e.g. a dedicated SEO score), the
 * derivation is documented inline and the value can be null.
 */
import type {
  AuditReport,
  AiVisibilityBlock,
  AiVisibility,
  AiVisibilitySource,
  AiVisibilitySnapshot,
  AiVisibilityTrend,
  TrendWindow,
  AuditSummary,
  AuditIssue,
  Severity,
  Changes,
  EngineChange,
} from "./types.js";

const ENGINE_KEYS = ["ChatGPT", "Perplexity", "Claude", "Gemini"] as const;
type EngineKey = (typeof ENGINE_KEYS)[number];

const SEVERITY_RANK: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

/**
 * True when the audited site could not be reached at all: the availability
 * module reported connection-level failures (tagged by the upstream module with
 * the "connectivity or DNS resolution" recommendation) and NO page load
 * succeeded. A homepage that loads with some broken sub-pages is NOT unreachable.
 */
export function detectUnreachable(report: AuditReport): boolean {
  const availability = (report.results ?? []).filter((r) => r.module === "availability");
  if (availability.length === 0) return false;

  const connFailures = availability.filter(
    (r) => r.status === "failed" && /connectivity or DNS/i.test(r.recommendation ?? ""),
  );
  if (connFailures.length === 0) return false;

  const pageLoads = availability.filter((r) => (r.name ?? "").startsWith("Page load:"));
  const anyLoaded = pageLoads.some((r) => r.status === "passed" || r.status === "warning");
  return !anyLoaded;
}

/** Lowercase payload key -> the display name upstream uses. One map, because
 *  a second spelling of this is how a raw key like "grok" reaches prose. */
const ENGINE_LABELS: Record<string, string> = {
  chatgpt: "ChatGPT", perplexity: "Perplexity", claude: "Claude", gemini: "Gemini",
};

/** "A", "A and B", "A, B and C" — for engine names in prose. */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A finite number, or undefined.
 *
 * The upstream types overstate what is present: `AiPlatformScore` declares
 * `total` as required and does not declare `asked` at all — it arrives through
 * the index signature — so neither can be trusted to be a number at runtime.
 */
function numeric(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * TWO DIFFERENT ZEROES.
 *
 * A customer reported `claude: 0` from this tool beside a report page reading
 * "Claude didn't return an answer — this score covers 3 platforms", and was
 * right: an API failure was being published as a measured score of zero.
 *
 * Upstream already ships the discriminator. `total` is what the provider
 * ANSWERED — the score's own denominator (chaos_tester
 * modules/ai_visibility.py:6104) — and `asked` is what it was SENT. Answered 0
 * with asked > 0 is a hole in the measurement, not a score. No row at all is an
 * engine this run never asked, which is a different fact again: naming it would
 * make a deliberately narrow run accuse itself of an outage.
 *
 * This is the same reasoning report_view.py's platform loop carries under the
 * same heading; the page has been correct about it for months and only this
 * surface was not.
 *
 * Run b546b7ccd0c5 (newparadigm.org, the reported case): Claude total 0 /
 * asked 8 -> unanswered; the other three answered 8 each -> scored, value 0.
 */
export type EngineState = "scored" | "unanswered" | "not_asked";

function engineReading(
  av: AiVisibilityBlock,
  key: EngineKey,
): { value: number | null; state: EngineState } {
  const ps = av.platform_scores?.[key];
  if (!ps) return { value: null, state: "not_asked" };
  // "queries" is the same defensive fallback report_view.py keeps for payloads
  // written before "total" was the denominator.
  const answered = numeric(ps.total) ?? numeric(ps.queries) ?? 0;
  const asked = numeric(ps.asked) ?? answered;
  const score = numeric(ps.score);
  if (answered > 0) {
    // The provider ANSWERED, so it is not silent whatever else is missing.
    // Blaming it for our own absent field would be this bug inverted — the
    // score is appearances over answered, so derive it rather than misattribute.
    const appearances = numeric(ps.appearances);
    const value = score ?? (appearances === undefined
      ? null
      : Math.round((appearances / answered) * 100));
    if (value !== null) return { value, state: "scored" };
  }
  return { value: null, state: asked > 0 ? "unanswered" : "not_asked" };
}

/**
 * Whether the site appeared on an engine at all, or null when the engine was
 * not measured. Upstream aggregates the per-query `client_appears` flags into
 * `appearances`, so `appearances > 0` is the faithful signal; when that count
 * is absent we fall back to the raw per-result `client_appears`.
 *
 * NULL, not false, for an unmeasured engine. `false` is the assertion "this
 * engine did not name the business", and compare_competitors turns exactly
 * that into a reported gap — so a silent Claude on the primary site fabricated
 * a "claude" gap against every competitor Claude *did* answer about.
 */
function engineAppears(
  av: AiVisibilityBlock,
  key: EngineKey,
  state: EngineState,
): boolean | null {
  const ps = av.platform_scores?.[key];
  if (!ps) return null;
  // The state is PASSED IN, not re-derived. Two independent derivations of one
  // fact can disagree, and the disagreement here would be a row reported as
  // `scored` in engine_status and `null` in appears_by_engine.
  if (state !== "scored") return null;
  if (typeof ps.appearances === "number") return ps.appearances > 0;
  return (ps.results ?? []).some((r) => r.client_appears === true);
}

/** Most frequently-cited competitor across all engines, or null if none. */
export function topCompetitor(av: AiVisibilityBlock): string | null {
  const counts = new Map<string, number>();
  for (const key of ENGINE_KEYS) {
    const results = av.platform_scores?.[key]?.results ?? [];
    for (const r of results) {
      for (const c of r.competitors ?? []) {
        const name = c.trim();
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The engine's name-provenance block, defensively read.
 *
 * chaos_tester #334 ships `identification.name_warning` / `name_verified` /
 * `name_source`, but a report produced before that deploy — or replayed from
 * the 24h answer cache — has no block at all, and a hostile/garbled payload
 * must not throw inside a mapper. Anything that is not the expected shape
 * reads as "nothing to say", never as a fabricated caveat.
 */
/** The defensive-read policy in one place: a payload value counts as an object
 *  only when it is a plain record — never null, never an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((p) => typeof p === "string");
}

function nameProvenance(av: AiVisibilityBlock): {
  warning?: string;
  verified?: boolean;
  source?: string;
} {
  const block = av.identification;
  if (!isRecord(block)) return {};
  const warning = typeof block.name_warning === "string" ? block.name_warning.trim() : "";
  return {
    warning: warning || undefined, // "" means verified — omit rather than emit empty
    verified: typeof block.name_verified === "boolean" ? block.name_verified : undefined,
    source: typeof block.name_source === "string" && block.name_source ? block.name_source : undefined,
  };
}

/** One well-formed ranked-sources row, re-picked to the documented six keys,
 *  or null. Early returns narrow each field, so the returned object carries
 *  exactly what was checked — no casts that could drift from the checks. */
function sourceRow(row: unknown): AiVisibilitySource | null {
  if (!isRecord(row)) return null;
  const { domain, answers, platforms, ownership, url, title } = row;
  if (typeof domain !== "string" || domain === "") return null;
  if (typeof answers !== "number") return null;
  if (!isStringArray(platforms)) return null;
  if (ownership !== "yours" && ownership !== "competitor" && ownership !== "third_party") return null;
  if (url !== null && typeof url !== "string") return null;
  if (typeof title !== "string") return null;
  return { domain, answers, platforms, ownership, url, title };
}

/** The documented cap on the ranked list — upstream promises at most ten, and
 *  the client enforces it too so a garbled over-long payload cannot flood the
 *  tool response (or the 24h compare cache) with unbounded rows. */
const MAX_SOURCES = 10;

/**
 * The report's cited-sources evidence, tri-state preserved (chaos_tester #447):
 * `{sources: [...]}` ranked list, `{sources: null}` recorded-but-uncited, `{}`
 * when the key is absent — no readable citation records, which must never be
 * served as a positive "cited nothing" claim. A garbled value (neither array
 * nor null) also reads as absent: same policy as nameProvenance above — a
 * hostile payload must not throw in a mapper, and nothing is ever fabricated.
 *
 * Post-condition: the key is present-and-array ONLY when it holds at least one
 * well-formed row. Upstream never emits `[]` (it serves null, a non-empty
 * list, or strips the key), so an array that ranks to nothing here — every
 * row malformed — is a schema break, and serving `sources: []` for it would
 * manufacture the exact "cited nothing" reading the tri-state forbids. It
 * reads as absent instead.
 */
function citedSources(av: AiVisibilityBlock): { sources?: AiVisibilitySource[] | null } {
  if (!Object.hasOwn(av, "sources")) return {};
  const raw = av.sources;
  if (raw === null) return { sources: null };
  if (!Array.isArray(raw)) return {};
  const kept = raw.map(sourceRow).filter((r): r is AiVisibilitySource => r !== null);
  return kept.length > 0 ? { sources: kept.slice(0, MAX_SOURCES) } : {};
}

export function toAiVisibility(report: AuditReport): AiVisibility {
  const av = report.ai_visibility ?? {};
  const score = av.overall_score ?? 0;
  const readings = {
    chatgpt: engineReading(av, "ChatGPT"),
    perplexity: engineReading(av, "Perplexity"),
    claude: engineReading(av, "Claude"),
    gemini: engineReading(av, "Gemini"),
  };
  const by_engine = {
    chatgpt: readings.chatgpt.value,
    perplexity: readings.perplexity.value,
    claude: readings.claude.value,
    gemini: readings.gemini.value,
  };
  // A SIBLING MAP, not a nullable number alone. The consumer is a language
  // model, and a null it rounds to zero is no better than the bug — it reads a
  // named state word far more reliably. Same shape as the existing
  // by_engine / appears_by_engine pair.
  const engine_status = {
    chatgpt: readings.chatgpt.state,
    perplexity: readings.perplexity.state,
    claude: readings.claude.state,
    gemini: readings.gemini.state,
  };
  const appears_by_engine = {
    chatgpt: engineAppears(av, "ChatGPT", readings.chatgpt.state),
    perplexity: engineAppears(av, "Perplexity", readings.perplexity.state),
    claude: engineAppears(av, "Claude", readings.claude.state),
    gemini: engineAppears(av, "Gemini", readings.gemini.state),
  };
  const competitor = topCompetitor(av);
  const name = av.business_info?.business_name ?? report.base_url;
  const simulatedNote = av.is_simulated ? " (estimated — live AI queries were unavailable)" : "";
  const provenance = nameProvenance(av);
  // Folded into the sentence, not just carried as a field: the caller is a
  // model, and it reads `summary`. Same reasoning as simulatedNote above.
  const nameNote = provenance.warning ? ` NOTE: ${provenance.warning}` : "";
  // COVERAGE, in the sentence the model actually reads. The second branch below
  // used to claim "across ChatGPT, Perplexity, Claude and Gemini"
  // unconditionally, so a three-engine score was published as a four-engine
  // one. This is the MCP's analogue of report_view._coverage_note.
  //
  // The verb is "did not return an answer" and never "didn't answer in time":
  // `unobserved_reasons` is a whole-run tally, so a per-engine cause cannot be
  // attributed, and calling an empty 200 a timeout is a small lie the reader
  // has no way to check. report_view.py refuses the same attribution on the
  // same grounds.
  const unanswered = Object.entries(engine_status)
    .filter(([, state]) => state === "unanswered")
    .map(([key]) => ENGINE_LABELS[key] ?? key);
  const scoredCount = Object.values(engine_status).filter((st) => st === "scored").length;
  const coverage_note = unanswered.length
    ? `${listOf(unanswered)} did not return an answer — this score covers `
      + `${scoredCount} ${scoredCount === 1 ? "engine" : "engines"}.`
    : undefined;
  const coverageNote = coverage_note ? ` NOTE: ${coverage_note}` : "";
  const scoredNames = Object.entries(engine_status)
    .filter(([, state]) => state === "scored")
    .map(([key]) => ENGINE_LABELS[key] ?? key);
  // NO SCORE SENTENCE when nothing was scored. "scores 0/100 across no engines"
  // pairs a verdict with its own refutation, and 0/100 over zero observations
  // is the fabricated number this whole change exists to stop. The upstream
  // page refuses to render this case at all.
  const summary = scoredNames.length === 0
    ? `${name}: no AI-visibility score — no engine returned an answer for this `
      + `run, so there is nothing to report.${simulatedNote}${nameNote}`
    : competitor && competitor.length > 0
      ? `${name} scores ${score}/100 for AI visibility; the competitor most often surfaced instead is ${competitor}.${simulatedNote}${nameNote}${coverageNote}`
      : `${name} scores ${score}/100 for AI visibility across ${listOf(scoredNames)}.${simulatedNote}${nameNote}${coverageNote}`;

  // trend is filled in by the tool layer (Pro history lookup); the mapper
  // itself only ever sees a single report.
  return {
    score,
    by_engine,
    engine_status,
    appears_by_engine,
    top_competitor: competitor,
    summary,
    ...(coverage_note ? { coverage_note } : {}),
    trend: null,
    ...(provenance.warning ? { name_warning: provenance.warning } : {}),
    ...(provenance.verified !== undefined ? { name_verified: provenance.verified } : {}),
    ...(provenance.source ? { name_source: provenance.source } : {}),
    ...citedSources(av),
  };
}

/** Pass-rate (0–100) of results for a given module, or null if none ran. */
function modulePassRate(report: AuditReport, moduleName: string): number | null {
  const rows = (report.results ?? []).filter((r) => r.module === moduleName);
  if (rows.length === 0) return null;
  const passed = rows.filter((r) => r.status === "passed").length;
  return Math.round((passed / rows.length) * 100);
}

/**
 * Derive an SEO proxy score from the AI-readiness `site_signals` the audit
 * collects (structured data, meta description, sitemap, robots access). The
 * upstream has no dedicated SEO module, so this is an explicit proxy; null when
 * no signals were captured.
 */
function seoProxyScore(av: AiVisibilityBlock): number | null {
  const s = av.site_signals as Record<string, unknown> | undefined;
  if (!s) return null;
  const checks = [
    s.robots_txt_present === true,
    s.robots_txt_blocks_all === false,
    Array.isArray(s.ai_bots_blocked) && (s.ai_bots_blocked as unknown[]).length === 0,
    s.sitemap_present === true,
    s.has_structured_data === true,
    s.has_meta_description === true,
    s.has_open_graph === true,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

export function toAuditSummary(report: AuditReport, opts: { siteUrl: string }): AuditSummary {
  const av = report.ai_visibility ?? {};

  const top_issues: AuditIssue[] = (report.results ?? [])
    .filter((r) => r.severity === "critical" || r.severity === "high")
    .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0))
    .slice(0, 10)
    .map((r) => ({
      name: r.name,
      severity: r.severity,
      module: r.module,
      url: r.url,
      details: r.details,
      recommendation: r.recommendation,
    }));

  const report_url = `${opts.siteUrl.replace(/\/+$/, "")}/report/${report.run_id}`;
  const provenance = nameProvenance(av);

  // No `sources` here by decision, not omission — see runAudit.ts's header.
  return {
    scores: {
      ai_visibility: av.overall_score ?? null,
      seo: seoProxyScore(av),
      security: modulePassRate(report, "security"),
      performance: modulePassRate(report, "performance"),
    },
    top_issues,
    report_url,
    // Only when unverified. ai_visibility above is scored on queries built
    // around the business name, so this caveat qualifies that number.
    ...(provenance.warning ? { name_warning: provenance.warning } : {}),
  };
}

/**
 * Compute AI-visibility deltas between two snapshots. This is the delta logic
 * for `get_changes`, kept pure and tested so the tool is ready the moment
 * website-auditor-api exposes a history/delta endpoint (PRD open question #2).
 */
/**
 * Fold a raw snapshot series (oldest first) into 7- and 30-day trend windows.
 * A window compares the newest snapshot against the OLDEST snapshot inside the
 * window, and is null when fewer than two snapshots fall inside it — snapshot
 * cadence is irregular (one per audit + one per weekly scheduled run), so
 * windows describe "movement within the last N days", not fixed daily points.
 * Returns null when the series has fewer than two usable snapshots at all.
 *
 * `now` is injectable for deterministic tests; callers default it.
 */
export function computeTrend(
  snapshots: AiVisibilitySnapshot[],
  now: Date = new Date(),
): AiVisibilityTrend | null {
  if (snapshots.length < 2) return null;

  const latest = snapshots[snapshots.length - 1]!;

  const windowOf = (days: number): TrendWindow | null => {
    const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
    const inWindow = snapshots.filter((s) => Date.parse(s.captured_at) >= cutoff);
    if (inWindow.length < 2) return null;
    const oldest = inWindow[0]!;
    // Engine deltas compare ONLY engines measured at BOTH endpoints. Engines
    // roll out incrementally (null = not measured, stripped by the client), so
    // an engine absent from one endpoint must not become a fabricated from-0
    // gain via computeChanges' `?? 0`, nor silently vanish on a drop.
    const shared = Object.keys(latest.by_engine).filter((k) => k in oldest.by_engine);
    const pickShared = (m: Record<string, number>): Record<string, number> =>
      Object.fromEntries(shared.map((k) => [k, m[k]!]));
    const changes = computeChanges(
      { score: latest.score, by_engine: pickShared(latest.by_engine) },
      { score: oldest.score, by_engine: pickShared(oldest.by_engine) },
    );
    return {
      window_days: days,
      from_score: oldest.score,
      to_score: latest.score,
      score_delta: changes.score_delta,
      engine_changes: changes.engine_changes,
      snapshots: inWindow.length,
    };
  };

  return {
    change_7d: windowOf(7),
    change_30d: windowOf(30),
    snapshots_analyzed: snapshots.length,
    latest_captured_at: latest.captured_at,
    includes_simulated: snapshots.some((s) => s.is_simulated),
  };
}

export function computeChanges(
  current: { score: number; by_engine: Record<string, number | null> },
  previous: { score: number; by_engine: Record<string, number | null> },
): Changes {
  const engine_changes: EngineChange[] = [];
  for (const engine of Object.keys(current.by_engine)) {
    const to = current.by_engine[engine];
    const from = previous.by_engine[engine];
    // SKIPPED, not zeroed. `?? 0` turned an engine that was never measured on
    // one side into a real score of zero, so a Claude outage in this week's
    // snapshot published {from: 55, to: 0, delta: -55} — a 55-point crash that
    // did not happen. Same rule computeTrend already applies by intersecting
    // the engines present on both sides.
    if (typeof to !== "number" || typeof from !== "number") continue;
    if (to !== from) engine_changes.push({ engine, from, to, delta: to - from });
  }
  return {
    score_delta: current.score - previous.score,
    engine_changes,
    competitor_changes: [],
    new_issues: [],
    resolved_issues: [],
  };
}
