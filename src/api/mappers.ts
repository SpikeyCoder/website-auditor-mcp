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
  SnapshotQuestion,
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
 * THE SAME QUESTION, OR NO DELTA.
 *
 * A score answers a question: the queries put to the assistants, which carry
 * the market and the business category in their text, and the business name
 * looked for in their answers. Subtract two scores that answered different
 * questions and the difference is a change of subject, not of visibility, and
 * every delta here used to publish exactly that. The weekly re-audit asked
 * about a name guessed from the domain until website-auditor-api #96, a hand
 * audit in one market sat beside weekly re-audits in another until #94, and
 * detection can move a name or a category from one week to the next.
 *
 * The API records what each snapshot asked, and `question.key` is its verdict
 * on sameness (website-auditor-api src/services/snapshotQuestion.js). Nothing
 * here decides sameness; this only refuses to subtract across two keys that
 * differ, or that are missing.
 *
 * MISSING IS NOT THE SAME. A snapshot stored before the API recorded questions,
 * or served by an API that does not send them, has no key and compares with
 * nothing. Reading "cannot tell" as "the same" is the bug itself, so an API
 * that stops sending the key turns deltas off rather than back into
 * fabrications.
 */
export function sameQuestion(
  a: { question?: SnapshotQuestion | null } | null | undefined,
  b: { question?: SnapshotQuestion | null } | null | undefined,
): boolean {
  const key = a?.question?.key;
  return typeof key === "string" && key !== "" && key === b?.question?.key;
}

/**
 * The snapshot a change is measured from: the NEWEST of `earlier` (oldest
 * first) that asked what `current` asked, and how many after it asked something
 * else and were passed over. Passed over, not a break: a hand audit in another
 * market between two weekly re-audits leaves the weekly pair either side of it
 * a like-for-like change. `skipped` is 0 when there is no base.
 */
export function newestSameQuestion<T extends { question?: SnapshotQuestion | null }>(
  earlier: T[],
  current: T,
): { base: T | null; skipped: number } {
  for (let i = earlier.length - 1; i >= 0; i -= 1) {
    const candidate = earlier[i]!;
    if (sameQuestion(candidate, current)) return { base: candidate, skipped: earlier.length - 1 - i };
  }
  return { base: null, skipped: 0 };
}

/**
 * For a window: the OLDEST of `earlier` that asked what `current` asked, so the
 * change spans as much of the window as a like-for-like comparison can, and how
 * many of `earlier` were left out, having asked something else or recorded
 * nothing. `skipped` is 0 when there is no base.
 */
export function oldestSameQuestion<T extends { question?: SnapshotQuestion | null }>(
  earlier: T[],
  current: T,
): { base: T | null; skipped: number } {
  const base = earlier.find((s) => sameQuestion(s, current)) ?? null;
  return { base, skipped: base ? earlier.filter((s) => !sameQuestion(s, current)).length : 0 };
}

/**
 * Why each of `snapshots` does not compare with `current`: it asked a different
 * question, or it recorded none. Two different facts, and saying the first
 * about the second tells a caller something nobody knows. For weeks after the
 * API began recording questions, most snapshots in any window are the second.
 */
export function notCompared<T extends { question?: SnapshotQuestion | null }>(
  snapshots: T[],
  current: T,
): { different: number; unrecorded: number } {
  let different = 0;
  let unrecorded = 0;
  for (const s of snapshots) {
    if (sameQuestion(s, current)) continue;
    if (s.question?.key) different += 1;
    else unrecorded += 1;
  }
  return { different, unrecorded };
}

/** `1 snapshot that asked a different question and 2 snapshots that do not record what they asked`. */
export function notComparedPhrase({ different, unrecorded }: { different: number; unrecorded: number }): string {
  const parts: string[] = [];
  if (different > 0) {
    parts.push(`${different} ${different === 1 ? "snapshot" : "snapshots"} that asked a different question`);
  }
  if (unrecorded > 0) {
    parts.push(unrecorded === 1
      ? "1 snapshot that does not record what it asked"
      : `${unrecorded} snapshots that do not record what they asked`);
  }
  return listOf(parts);
}

/** The newest of `snapshots` (oldest first) that recorded its question, or null. */
export function newestRecorded<T extends { question?: SnapshotQuestion | null }>(snapshots: T[]): T | null {
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const candidate = snapshots[i]!;
    if (candidate.question?.key) return candidate;
  }
  return null;
}

/**
 * The most recent like-for-like pair within `snapshots` (oldest first): the
 * newest snapshot that an earlier one asked the same question as, and the newest
 * such earlier one. Null when no two of them asked the same question.
 */
export function newestComparablePair<T extends { question?: SnapshotQuestion | null }>(
  snapshots: T[],
): { from: T; to: T } | null {
  for (let i = snapshots.length - 1; i > 0; i -= 1) {
    const to = snapshots[i]!;
    const { base } = newestSameQuestion(snapshots.slice(0, i), to);
    if (base) return { from: base, to };
  }
  return null;
}

/** `up 5`, `down 3` or `unchanged`. */
export function movement(delta: number): string {
  return delta > 0 ? `up ${delta}` : delta < 0 ? `down ${Math.abs(delta)}` : "unchanged";
}

/** A question off the wire, read defensively: anything malformed is absent, never guessed. */
export function toQuestion(raw: unknown): SnapshotQuestion | null {
  if (!isRecord(raw)) return null;
  const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    key: typeof raw.key === "string" && raw.key !== "" ? raw.key : null,
    business_name: text(raw.business_name),
    name_source: text(raw.name_source),
    business_location: text(raw.business_location),
    market_scope: text(raw.market_scope),
    queries: isStringArray(raw.queries) ? raw.queries : null,
  };
}

// A name as the engine's matcher starts from it (`name.lower().strip()`) and as
// the API keys it: names that differ in more than case are different questions.
const nameOf = (name: string | null): string => (name ?? "").trim().toLowerCase();
const spaced = (text: string | null): string => (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const quoted = (text: string | null): string | null => (text?.trim() ? `"${text.trim()}"` : null);

/** `the market "Honolulu, HI" rather than "Austin, TX"`, with an empty side said plainly. */
function contrast(label: string, other: string | null, reference: string | null): string {
  const was = quoted(reference) ?? "none";
  const now = quoted(other);
  return now ? `the ${label} ${now} rather than ${was}` : `no ${label} rather than ${was}`;
}

/**
 * How one recorded question differs from another, in words a caller can relay:
 * the name, the market, or, when neither, the queries themselves (another
 * business category, or a change in how the engine asks).
 *
 * DISPLAY ONLY. Whether two snapshots compare is `question.key`'s decision,
 * never this function's; it folds names and markets only as far as the API
 * does, so that "Acme" and "ACME" are not described as a new name.
 */
export function questionDifference(other: SnapshotQuestion, reference: SnapshotQuestion): string {
  const parts: string[] = [];
  if (nameOf(other.business_name) !== nameOf(reference.business_name)) {
    parts.push(contrast("business name", other.business_name, reference.business_name));
  }
  if (spaced(other.business_location) !== spaced(reference.business_location)) {
    parts.push(contrast("market", other.business_location, reference.business_location));
  }
  return parts.length
    ? listOf(parts)
    : "different queries (another business category, or a change in how Website Auditor asks)";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The date part of a timestamp, or a plain phrase for anything that is not one. */
export function day(iso: unknown): string {
  return typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : "an unknown date";
}

/**
 * Whether a snapshot with no like-for-like predecessor re-baselines its series:
 * when it is a weekly re-audit, or when there are no weekly re-audits to be a
 * series. An audit run by hand beside a weekly series only asked something the
 * series does not, and calling that a re-baseline hid the series' own last
 * change behind a break that never happened to it.
 */
export function breaksTheSeries(
  latest: { source?: string | null },
  earlier: Array<{ source?: string | null }>,
): boolean {
  return latest.source === "scheduled" || !earlier.some((s) => s.source === "scheduled");
}

/**
 * Why the trend compared less than its windows span, or nothing at all, when
 * what the snapshots asked is the reason. Undefined when every snapshot in play
 * asked the latest's question.
 */
function trendQuestionNote(snapshots: AiVisibilitySnapshot[], now: Date): string | undefined {
  const latest = snapshots[snapshots.length - 1]!;
  const earlier = snapshots.slice(0, -1);
  if (!latest.question?.key) {
    return "The latest snapshot does not record what it asked the assistants, so no trend is computed through it.";
  }
  if (!newestSameQuestion(earlier, latest).base) {
    // Explained against the newest snapshot that RECORDED its question, dated:
    // the one just before may have recorded nothing, or be a one-off audit.
    const prior = newestRecorded(earlier);
    const diff = prior?.question
      ? `${questionDifference(latest.question, prior.question)}, compared with the snapshot on ${day(prior.captured_at)}`
      : null;
    if (breaksTheSeries(latest, earlier)) {
      return diff
        ? `Re-baselined on ${day(latest.captured_at)}: the latest snapshot asked about ${diff}, and no earlier `
          + "snapshot asked the same question, so there is no trend for it."
        : `Re-baselined on ${day(latest.captured_at)}: the snapshots before it do not record what they asked, `
          + "so there is no trend for it.";
    }
    return `The latest snapshot, on ${day(latest.captured_at)}, is not a weekly re-audit. `
      + (diff
        ? `It asked about ${diff}, and no earlier snapshot asked the same question`
        : "The snapshots before it do not record what they asked")
      + ", so there is no trend through it; the weekly re-audits did not re-baseline.";
  }
  const cutoff = now.getTime() - 30 * DAY_MS;
  const inWindow = earlier.filter((s) => Date.parse(s.captured_at) >= cutoff);
  const left = notCompared(inWindow, latest);
  if (left.different + left.unrecorded === 0) return undefined;
  let lastDifferent: AiVisibilitySnapshot | undefined;
  for (const s of inWindow) if (s.question?.key && !sameQuestion(s, latest)) lastDifferent = s;
  const how = lastDifferent?.question
    ? ` The most recent that asked a different one, on ${day(lastDifferent.captured_at)}, asked about `
      + `${questionDifference(lastDifferent.question, latest.question)}.`
    : "";
  return "Only snapshots that asked the same question as the latest are compared; left out of the last 30 "
    + `days: ${notComparedPhrase(left)}.${how}`;
}

/**
 * Fold a raw snapshot series (oldest first) into 7- and 30-day trend windows.
 * A window compares the newest snapshot against the OLDEST snapshot inside the
 * window that asked the same question (see sameQuestion), and is null when it
 * holds none — snapshot cadence is irregular (one per audit + one per weekly
 * scheduled run), so windows describe "movement within the last N days", not
 * fixed daily points. Returns null when the series has fewer than two usable
 * snapshots at all.
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
    const cutoff = now.getTime() - days * DAY_MS;
    const inWindow = snapshots.filter((s) => Date.parse(s.captured_at) >= cutoff);
    if (inWindow.length < 2) return null;
    const { base: oldest, skipped } = oldestSameQuestion(inWindow.slice(0, -1), latest);
    if (!oldest) return null;
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
      from_captured_at: oldest.captured_at,
      skipped_snapshots: skipped,
    };
  };

  const question_note = trendQuestionNote(snapshots, now);
  return {
    change_7d: windowOf(7),
    change_30d: windowOf(30),
    snapshots_analyzed: snapshots.length,
    latest_captured_at: latest.captured_at,
    includes_simulated: snapshots.some((s) => s.is_simulated),
    ...(question_note ? { question_note } : {}),
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
