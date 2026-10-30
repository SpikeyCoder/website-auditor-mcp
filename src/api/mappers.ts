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
  RecommendationGap,
  RecommendationGapEngine,
  StanceCounts,
  CompetitorRecommendationGap,
  ComparisonRecommendationGap,
  SiteReading,
} from "./types.js";

const ENGINE_KEYS = ["ChatGPT", "Perplexity", "Claude", "Gemini"] as const;
type EngineKey = (typeof ENGINE_KEYS)[number];

const SEVERITY_RANK: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

/**
 * True when no page of the audited site loaded: the availability module has
 * "Page load:" rows and none of them passed or warned. A homepage that loads
 * with some broken sub-pages is NOT unreachable, nor is one that redirected,
 * was forbidden or answered another unexpected status (a WARNING row).
 *
 * This read the remedy text too: a failed row had to say "connectivity or
 * DNS". The engine stopped writing that in chaos_tester #429 (each transport
 * failure now names its cause: a timeout, a refused connection, TLS, DNS), so
 * since then nothing was ever unreachable: a dead site got a report of zeros
 * and compare_competitors audited every competitor after a primary that never
 * loaded. The page-load rows are the signal; the wording is not. A homepage
 * that answered 404 or 5xx on every load did not load either, and counts.
 * It is the same rule as the API's own (website-auditor-api trialSeeding
 * siteLoaded), so a comparison stops exactly where the API would not start a
 * member's dashboard.
 */
export function detectUnreachable(report: AuditReport): boolean {
  const pageLoads = (report.results ?? []).filter(
    (r) => r.module === "availability" && (r.name ?? "").startsWith("Page load:"),
  );
  if (pageLoads.length === 0) return false;
  return !pageLoads.some((r) => r.status === "passed" || r.status === "warning");
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
  // The same processing as the names in the recommendation gap: cleaned where
  // they enter, counted without regard to case, the first spelling shown.
  const counts = new Map<string, { name: string; n: number }>();
  for (const key of ENGINE_KEYS) {
    const results = av.platform_scores?.[key]?.results ?? [];
    for (const r of results) {
      for (const c of r.competitors ?? []) {
        const name = cleanName(c);
        if (!name) continue;
        const k = name.toLowerCase();
        const seen = counts.get(k);
        if (seen) seen.n += 1; else counts.set(k, { name, n: 1 });
      }
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const { name, n } of counts.values()) {
    if (n > bestCount) {
      best = name;
      bestCount = n;
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


// ─── The recommendation gap and the stance counts  ─────────
//
// The engine measures both; these only validate and rename. Every number is
// checked before it reaches a result, because the consumer is a language model:
// a "22" it reads as a string or a null it rounds to zero is a fabricated
// finding. A count that is not a non-negative whole number is NULL, never
// coerced, and a gap the engine did not measure (not_measured, or no key at
// all) is ABSENT, not a hollow object.

const GAP_STATES = new Set([
  "behind", "level", "ahead", "no_rival", "no_local_rival", "not_enough_answers",
]);
// What an assistant's own entry may say: the overall states, and not_measured.
const ENGINE_STATES = new Set([...GAP_STATES, "not_measured"]);
const KNOWN_ENGINES = new Set(ENGINE_KEYS.map((k) => k.toLowerCase()));

/** The names, each once (however spelled in case), and none that repeats `except`. */
function distinctNames(names: Array<string | null>, except: string | null): string[] {
  const seen = new Set(except === null ? [] : [except.toLowerCase()]);
  const out: string[] = [];
  for (const n of names) {
    if (n === null || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(n);
  }
  return out;
}

const MAX_NAME_CHARS = 200;   // one cap for every business name read from an answer
const MAX_TIED = 5;

/** A business name read from a third-party answer, bounded: no control or hidden characters, 200 characters at most. */
function cleanName(value: unknown, max: number = MAX_NAME_CHARS): string | null {
  if (typeof value !== "string") return null;
  // Controls (C0, DEL, C1) and the invisible, formatting characters below go.
  // Only what hides text or steers it: the zero-width joiner and non-joiner
  // (U+200C/D) and the variation selectors stay, because Persian, Indic and
  // emoji names are spelled with them.
  const t = value
    .replace(/[\u00ad\u034f\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u206a-\u206f\u2800\u115f\u1160\u3164\uffa0\ufff9-\ufffb\ufeff\u{e0000}-\u{e007f}]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ").trim();
  // By code point: cutting a UTF-16 pair in half leaves a lone surrogate.
  const cut = Array.from(t).slice(0, max).join("").trim();
  // A name needs something to read: a letter, digit, symbol or punctuation mark.
  // (The joiners and variation selectors that stay are not enough on their own.)
  return /[\p{L}\p{N}\p{S}\p{P}]/u.test(cut) ? cut : null;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}


/**
 * The one plain sentence, rebuilt from the CHECKED fields. The engine's own
 * text is never relayed: it carries rival names read out of third-party
 * answers beside numbers this file has just validated, and the two must agree.
 * "" when a field the wording needs is missing.
 */
function gapSentence(g: {
  state: RecommendationGap["state"]; points: number | null; rival: string | null; tied: string[]; tiedExtra: number;
  rivalRec: number | null; youRec: number | null; answers: number | null;
}): string {
  if (g.state === "not_enough_answers") return "Not enough answers yet to measure a gap.";
  if (g.answers === null) return "";
  const these = g.answers === 1 ? "this 1 answer" : `these ${g.answers} answers`;
  if (g.state === "no_rival") return `No rival is recommended in ${these}.`;
  if (g.state === "no_local_rival") return `No local rival is recommended in ${these}.`;
  if (g.rival === null || g.rivalRec === null || g.youRec === null || g.points === null) return "";
  const group = g.tiedExtra > 0 ? [g.rival, ...g.tied, `${g.tiedExtra} more`] : [g.rival, ...g.tied];
  const of = `of ${g.answers} ${plural(g.answers, "answer", "answers")}`;
  const pts = `${Math.abs(g.points)} ${plural(Math.abs(g.points), "point", "points")}`;
  if (g.state === "level") return `You are level with ${listOf(group)}: recommended in ${g.youRec} ${of} each.`;
  if (g.state === "ahead") {
    return `You lead ${listOf(group)}: recommended in ${g.youRec} ${of}, ${group.length > 1 ? "each" : g.rival} in ${g.rivalRec}: ${pts} ahead.`;
  }
  return group.length > 1
    ? `${listOf(group)} are each recommended in ${g.rivalRec} ${of}, you in ${g.youRec}: ${pts} behind.`
    : `${g.rival} is recommended in ${g.rivalRec} ${of}, you in ${g.youRec}: ${pts} behind.`;
}

function wholeNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function count(v: unknown): number | null {
  const n = wholeNumber(v);
  return n !== null && n >= 0 ? n : null;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** The engine's recommendation_gap, validated, or undefined when it measured none. */
export function toRecommendationGap(av: AiVisibilityBlock): RecommendationGap | undefined {
  const raw = av.recommendation_gap;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const g = raw as Record<string, unknown>;
  if (typeof g.state !== "string" || !GAP_STATES.has(g.state)) return undefined;
  const state = g.state as RecommendationGap["state"];
  const hasRival = state === "behind" || state === "level" || state === "ahead";
  const rival = g.rival && typeof g.rival === "object" ? (g.rival as Record<string, unknown>) : null;
  const client = g.client && typeof g.client === "object" ? (g.client as Record<string, unknown>) : null;
  const sample = g.sample && typeof g.sample === "object" ? (g.sample as Record<string, unknown>) : null;

  // THE COUNTS ARE THE AUTHORITY. The points are what they work out to
  // (exactPoints, the figure compare_competitors uses), and the engine's own
  // `gap_points` and `sentence` are not relayed. A count means something only
  // over a sample: without one it is null, never the engine's placeholder zero.
  const answers = sample ? count(sample.answers) : null;
  const sampled = answers !== null && answers > 0;
  const youRec = client && sampled ? count(client.recommended) : null;
  const rivalName = rival && hasRival ? cleanName(rival.name) : null;
  const rivalRec = rival && hasRival && sampled ? count(rival.recommended) : null;

  const per_engine: RecommendationGapEngine[] = [];
  // Entries belong to a sample: with none, there is nothing for them to be a share of.
  for (const e of sampled && Array.isArray(g.engines) ? g.engines : []) {
    const entry = engineEntry(e);
    if (entry && !per_engine.some((x) => x.engine === entry.engine)) per_engine.push(entry);   // one per assistant
  }

  // WHOLE OR ABSENT. A behind, level or ahead gap needs its rival, both counts
  // and the sample, and a state its counts give; every state's counts must fit
  // its sample, and the assistants' answers must fit the whole.
  if (youRec !== null && answers !== null && youRec > answers) return undefined;
  if ((state === "no_rival" || state === "no_local_rival") && !sampled) return undefined;
  if (hasRival) {
    if (rivalName === null || rivalRec === null || youRec === null || answers === null || answers <= 0) return undefined;
    if (!stateMatches(state, rivalRec, youRec) || rivalRec > answers) return undefined;
    if (rivalRec === 0) return undefined;       // a rival nobody recommended is the no-rival case
  }
  if (answers !== null) {
    const covered = per_engine.reduce((t, e) => t + (e.answers ?? 0), 0);
    if (covered > answers) return undefined;
    // When the assistants cover the whole sample their counts ARE the whole:
    // they must add up to it, or compare_competitors (which builds on them)
    // and this result would say different things about the same site.
    if (covered === answers && per_engine.length > 0) {
      if (youRec !== null && per_engine.reduce((t, e) => t + (e.you_recommended ?? 0), 0) !== youRec) return undefined;
      if (hasRival && rivalRec !== null && per_engine.every((e) => e.rival_recommended !== null)
          && per_engine.reduce((t, e) => t + (e.rival_recommended ?? 0), 0) !== rivalRec) return undefined;
    }
  }

  const points = hasRival && rivalRec !== null && youRec !== null && answers !== null
    ? exactPoints(rivalRec, answers, youRec, answers) : null;
  const tiedAll = rival && hasRival && Array.isArray(rival.tied_with)
    ? distinctNames(rival.tied_with.map((n) => cleanName(n)), rivalName) : [];
  const tied = tiedAll.slice(0, MAX_TIED);
  const sentence = gapSentence({ state, points, rival: rivalName, tied, tiedExtra: tiedAll.length - tied.length, rivalRec, youRec, answers });
  return {
    state,
    gap_points: points,
    rival: rivalName,
    rival_recommended: rivalRec,
    tied_with: tied,
    you_recommended: youRec,
    answers,
    per_engine,
    sentence,
  };
}

/** Does the state say what the counts say? */
function stateMatches(state: string, rivalRec: number, youRec: number): boolean {
  return state === "behind" ? rivalRec > youRec : state === "ahead" ? rivalRec < youRec : rivalRec === youRec;
}

/**
 * One assistant's entry, or null. Known assistants only. A behind/level/ahead
 * entry is whole (its sample, both counts, a state its counts give) and carries
 * the points its counts give; any other state carries no points and no rival
 * count; and a count over no sample is null, not the engine's placeholder.
 */
function engineEntry(raw: unknown): RecommendationGapEngine | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const key = typeof e.engine === "string" ? e.engine.toLowerCase() : "";
  const st = text(e.state);
  if (!KNOWN_ENGINES.has(key) || st === null || !ENGINE_STATES.has(st)) return null;
  const answers = count(e.answers);
  const sampled = answers !== null && answers > 0;
  const you = sampled ? count(e.client) : null;
  const rivalCount = sampled ? count(e.rival) : null;
  if ((you !== null && you > answers!) || (rivalCount !== null && rivalCount > answers!)) return null;
  const hasRival = st === "behind" || st === "level" || st === "ahead";
  if (hasRival) {
    if (you === null || rivalCount === null || !stateMatches(st, rivalCount, you)) return null;
    return { engine: key, state: st, gap_points: exactPoints(rivalCount, answers!, you, answers!),
      you_recommended: you, rival_recommended: rivalCount, answers };
  }
  return { engine: key, state: st, gap_points: null, you_recommended: you, rival_recommended: null, answers: sampled ? answers : null };
}

/** The engine's stance_counts (its "uncertain" is "unclear" here), or undefined unless every count is whole. */
export function toStanceCounts(av: AiVisibilityBlock): StanceCounts | undefined {
  const raw = av.stance_counts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const recommended = count(c.recommended);
  const mentioned = count(c.mentioned);
  const cautioned = count(c.cautioned);
  const unclear = count(c.uncertain);
  const not_named = count(c.not_named);
  const answers = count(c.answers);
  if (recommended === null || mentioned === null || cautioned === null
      || unclear === null || not_named === null || answers === null) return undefined;
  // The parts are the answers: a block whose parts do not sum to its whole is
  // not one the model can be handed (a rate over 100%, a gap from nothing).
  if (recommended + mentioned + cautioned + unclear + not_named !== answers) return undefined;
  if (answers <= 0) return undefined;        // six zeros over no answers say nothing
  return { recommended, mentioned, cautioned, unclear, not_named, answers };
}

/**
 * (rival's share - your share) * 100 in whole points, halves away from zero,
 * in INTEGER arithmetic (29 of 200 against 0 of 200 is 14.5, which floats put at
 * 14.499999999999998). Never 0 for a gap that exists.
 */
function exactPoints(rivalRec: number, rivalAns: number, youRec: number, youAns: number): number {
  const numerator = (rivalRec * youAns - youRec * rivalAns) * 100;
  const denominator = rivalAns * youAns;
  if (numerator === 0) return 0;
  const rounded = Math.floor((2 * Math.abs(numerator) + denominator) / (2 * denominator));
  return Math.sign(numerator) * Math.max(1, rounded);
}

/**
 * You against each competitor, from each audit's own stance counts: recommended
 * answers as a share of THAT site's answers, so two audits with different
 * sample sizes still compare. A site with no counts, or none answered, is left
 * out; with nothing left the whole block is absent, never a 0.
 */
export function toComparisonRecommendationGap(
  you: SiteReading,
  competitors: Array<SiteReading & { domain: string }>,
): ComparisonRecommendationGap | undefined {
  const youCounts = you.counts;
  if (!youCounts || youCounts.answers <= 0) return undefined;
  const youEngines = engineCounts(you.per_engine);
  const youQuestions = questionSet(you.questions);
  // A competitor whose audit recorded no stances (an estimated run, or one from
  // before stance) cannot be compared, and is NAMED as left out, never dropped.
  const notCompared = competitors.filter((c) => !c.counts || c.counts.answers <= 0).map((c) => c.domain);
  const measured = competitors.flatMap((c) => {
    if (!c.counts || c.counts.answers <= 0) return [];
    // LIKE FOR LIKE. Each site was audited on its own, so what each was asked
    // and which assistants answered are checked, not assumed. With per-assistant
    // detail on both sides the figures are over the assistants that answered
    // for BOTH; without it they fall back to each audit's overall counts and
    // the result says the assistants could not be checked.
    const theirEngines = engineCounts(c.per_engine);
    let basis: { youRec: number; youAns: number; rivRec: number; rivAns: number; assistants: string[] | null; narrowed: boolean };
    if (youEngines && theirEngines) {
      const shared = [...youEngines.keys()].filter((k) => theirEngines.has(k));
      const sum = (m: Map<string, { rec: number; ans: number }>, f: "rec" | "ans") =>
        shared.reduce((t, k) => t + m.get(k)![f], 0);
      // Nothing both answered: each site's own answers, said so (assistants: []),
      // never a competitor silently left out.
      basis = shared.length === 0 ? {
        youRec: youCounts.recommended, youAns: youCounts.answers,
        rivRec: c.counts.recommended, rivAns: c.counts.answers,
        assistants: [], narrowed: false,
      } : {
        youRec: sum(youEngines, "rec"), youAns: sum(youEngines, "ans"),
        rivRec: sum(theirEngines, "rec"), rivAns: sum(theirEngines, "ans"),
        assistants: shared,
        // Narrowed also when answers were left out for want of a usable entry
        // (both audits' overall answers exceed what the shared assistants hold).
        narrowed: shared.length < youEngines.size || shared.length < theirEngines.size
          || sum(youEngines, "ans") < youCounts.answers || sum(theirEngines, "ans") < c.counts.answers,
      };
    } else {
      basis = {
        youRec: youCounts.recommended, youAns: youCounts.answers,
        rivRec: c.counts.recommended, rivAns: c.counts.answers,
        assistants: null, narrowed: false,
      };
    }
    if (basis.youAns <= 0 || basis.rivAns <= 0) return [];
    const theirQuestions = questionSet(c.questions);
    const points = exactPoints(basis.rivRec, basis.rivAns, basis.youRec, basis.youAns);
    return [{
      domain: c.domain,
      state: (points > 0 ? "behind" : points < 0 ? "ahead" : "level") as CompetitorRecommendationGap["state"],
      gap_points: points,
      recommended: basis.rivRec,
      answers: basis.rivAns,
      same_questions: youQuestions && theirQuestions ? sameSet(youQuestions, theirQuestions) : null,
      assistants: basis.assistants,
      narrowed: basis.narrowed,
      unverified: c.unverified === true,
      youRec: basis.youRec,
      youAns: basis.youAns,
    }];
  })
    // The competitor you trail MOST first, each on its own like-for-like
    // basis; then the higher share (exact, cross-multiplied); then by name.
    .sort((a, b) => exactShortfall(b, a)
      || (b.recommended * a.answers - a.recommended * b.answers)
      || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));    // code units: the same order on every runtime
  const top = measured[0];
  if (!top) return undefined;
  // Every competitor recommended at exactly the top rate is named, as the
  // single-site gap names its ties.
  // Tied only on IDENTICAL counts over the identical basis (a sentence about
  // "each recommended in 5 of 20" must be true of every name in it).
  const tied = measured.slice(1)
    .filter((c) => c.recommended === top.recommended && c.answers === top.answers
      && c.youRec === top.youRec && c.youAns === top.youAns
      && c.same_questions === top.same_questions && c.unverified === top.unverified && c.narrowed === top.narrowed
      && JSON.stringify(c.assistants) === JSON.stringify(top.assistants))
    .map((c) => c.domain);
  const group = [top.domain, ...tied];
  const pts = Math.abs(top.gap_points);
  const noun = plural(pts, "point", "points");
  const yours = `${top.youRec} of ${top.youAns}`;
  const theirs = `${top.recommended} of ${top.answers}`;
  const answersWord = top.answers === 1 ? "answer" : "answers";
  const yourAnswersWord = top.youAns === 1 ? "answer" : "answers";
  const base = top.state === "behind"
    ? (group.length > 1
      ? `${listOf(group)} are each recommended in ${theirs} ${answersWord}, you in ${yours}: ${pts} ${noun} behind.`
      : `${top.domain} is recommended in ${theirs} ${answersWord}, you in ${yours}: ${pts} ${noun} behind.`)
    : top.state === "ahead"
      ? `You lead ${listOf(group)}: recommended in ${yours} ${yourAnswersWord}, ${group.length > 1 ? "each" : top.domain} in ${theirs}: ${pts} ${noun} ahead.`
      : `You are level with ${listOf(group)}: recommended in ${yours} ${yourAnswersWord}, ${group.length > 1 ? "each" : top.domain} in ${theirs}.`;
  // What the reader needs to know about how like-for-like the two sides are.
  const caveats: string[] = [];
  if (top.assistants === null) caveats.push("Which assistants answered for each site could not be checked.");
  else if (top.assistants.length === 0) caveats.push("No assistant answered for both sites, so each figure is over that site's own answers.");
  else if (top.narrowed) {
    caveats.push(`Compared on ${listOf(top.assistants.map((k) => ENGINE_LABELS[k] ?? k))} only: the other assistants have no usable answers for both sites.`);
  }
  if (top.same_questions === false) caveats.push("Each site was asked different questions, so read this as indicative.");
  else if (top.same_questions === null) caveats.push("Whether both sites were asked the same questions could not be checked.");
  if (notCompared.length > 0) {
    caveats.push(`${listOf(notCompared)} could not be included: ${notCompared.length > 1 ? "their audits have" : "its audit has"} no usable stances (an estimated run, or one that recorded none).`);
  }
  if (you.unverified) caveats.push("The business name for your site could not be verified, so treat this as indicative.");
  if (top.unverified) caveats.push(`The business name for ${top.domain} could not be verified, so treat this as indicative.`);
  const sentence = [base, ...caveats].join(" ");
  return {
    state: top.state,
    gap_points: top.gap_points,
    rival: top.domain,
    tied_with: tied,
    rival_recommended: top.recommended,
    rival_answers: top.answers,
    you_recommended: top.youRec,
    you_answers: top.youAns,
    same_questions: top.same_questions,
    assistants: top.assistants,
    not_compared: notCompared,
    sentence,
    by_competitor: measured.map((c) => ({
      domain: c.domain, state: c.state, gap_points: c.gap_points, recommended: c.recommended,
      answers: c.answers, you_recommended: c.youRec, you_answers: c.youAns,
      same_questions: c.same_questions, assistants: c.assistants, unverified: c.unverified,
    })),
  };
}

/** Sign of (a's shortfall - b's), exactly: each is (rival share - your share) on its own basis, cross-multiplied. */
function exactShortfall(
  a: { recommended: number; answers: number; youRec: number; youAns: number },
  b: { recommended: number; answers: number; youRec: number; youAns: number },
): number {
  const an = a.recommended * a.youAns - a.youRec * a.answers;
  const ad = a.answers * a.youAns;
  const bn = b.recommended * b.youAns - b.youRec * b.answers;
  const bd = b.answers * b.youAns;
  return Math.sign(an * bd - bn * ad);
}

/**
 * Why no comparison gap was drawn, for the summary, when the audits had stances
 * to offer on one side but not the other. Undefined when nobody had any (the
 * feature is simply absent) or when nothing is left unsaid.
 */
export function comparisonGapNote(
  you: SiteReading,
  competitors: Array<SiteReading & { domain: string }>,
): string | undefined {
  const usable = (r: SiteReading) => !!r.counts && r.counts.answers > 0;
  const reason = "no usable stances (an estimated run, or one that recorded none).";
  if (!usable(you)) {
    return competitors.some(usable) ? `No recommendation gap was compared: your audit has ${reason}` : undefined;
  }
  const missing = competitors.filter((c) => !usable(c)).map((c) => c.domain);
  if (missing.length === 0) return undefined;
  return `No recommendation gap was compared: ${listOf(missing)} ${missing.length > 1 ? "have" : "has"} ${reason}`;
}

/** Per-assistant recommended counts (only assistants that answered), or null when none are recorded. */
function engineCounts(entries: RecommendationGapEngine[] | undefined): Map<string, { rec: number; ans: number }> | null {
  if (!entries || entries.length === 0) return null;
  const out = new Map<string, { rec: number; ans: number }>();
  for (const e of entries) {
    if (e.answers !== null && e.answers > 0 && e.you_recommended !== null && e.you_recommended <= e.answers) {
      out.set(e.engine, { rec: e.you_recommended, ans: e.answers });
    }
  }
  return out.size > 0 ? out : null;
}

/**
 * A set of questions, compared without regard to order, case or padding; null
 * when none were recorded. Unlike the history's `question.key` (one business
 * across time, which includes the name), this compares two DIFFERENT businesses
 * audited in one call, so the name cannot be part of it: what is compared is
 * what the assistants were asked.
 */
function questionSet(questions: string[] | undefined): Set<string> | null {
  if (!questions) return null;
  const set = new Set(questions.map((q) => q.trim().toLowerCase()).filter((q) => q !== ""));
  return set.size > 0 ? set : null;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((q) => b.has(q));
}

/**
 * The gap and the counts, each only when the engine measured it, and never for
 * an estimated run ("you in 4 of 32" over answers nobody gave is the fabricated
 * number this change exists to stop). They come from two blocks built from the
 * same answers, so if they disagree neither is handed on.
 */
function reconcileGap(av: AiVisibilityBlock): { gap?: RecommendationGap; counts?: StanceCounts } {
  if (av.is_simulated) return {};
  const gap = toRecommendationGap(av);
  const counts = toStanceCounts(av);
  // The gap and the counts come from two blocks of the report, built from the
  // same answers: if they disagree about them, neither is handed on.
  if (gap && counts
      && ((gap.you_recommended !== null && gap.you_recommended !== counts.recommended)
        || (gap.answers !== null && gap.answers !== counts.answers))) return {};
  return { ...(gap ? { gap } : {}), ...(counts ? { counts } : {}) };
}

function gapAndCounts(reconciled: { gap?: RecommendationGap; counts?: StanceCounts }) {
  return {
    ...(reconciled.gap ? { recommendation_gap: reconciled.gap } : {}),
    ...(reconciled.counts ? { stance_counts: reconciled.counts } : {}),
  };
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

  // The gap, in the sentence the model actually reads: a field it never reads
  // changes nothing (the same reasoning as the notes above).
  // Nothing scored, or an estimated run: no gap at all, in the sentence or the
  // result (it would contradict the "no score" summary beside it).
  const reconciled = scoredNames.length > 0 ? reconcileGap(av) : {};
  const gap = reconciled.gap;
  const asked = questionsAsked(av);
  const gapSuffix = gap && gap.sentence ? ` ${gap.sentence}` : "";

  // trend is filled in by the tool layer (Pro history lookup); the mapper
  // itself only ever sees a single report.
  return {
    score,
    by_engine,
    engine_status,
    appears_by_engine,
    top_competitor: competitor,
    summary: `${summary}${gapSuffix}`,
    ...gapAndCounts(reconciled),
    ...(asked.length > 0 && !av.is_simulated && scoredNames.length > 0 ? { questions_asked: asked } : {}),
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

const MAX_QUESTIONS = 50;
const MAX_QUESTION_CHARS = 200;

/** The questions this audit put to the assistants, trimmed, as the report recorded them (none when there are more than 50). */
function questionsAsked(av: AiVisibilityBlock): string[] {
  const raw = av.queries;
  if (!isStringArray(raw)) return [];
  // Whole or unrecorded: a question cut short could make two different ones read as the same.
  const cleaned = raw.map((q) => cleanName(q, MAX_QUESTION_CHARS + 1)).filter((q): q is string => q !== null);
  if (cleaned.some((q) => Array.from(q).length > MAX_QUESTION_CHARS)) return [];
  // A list this long is not one audit's question set: leave it unrecorded
  // rather than cut it, so two cut lists can never read as the same.
  return cleaned.length > MAX_QUESTIONS ? [] : cleaned;
}

/** Did at least one assistant return an answer this run? */
function anyEngineScored(av: AiVisibilityBlock): boolean {
  return ENGINE_KEYS.some((n) => engineReading(av, n).state === "scored");
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
    // As in get_ai_visibility: nothing scored, nothing to say about a gap.
    ...(anyEngineScored(av) ? gapAndCounts(reconcileGap(av)) : {}),
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
 * Whether a snapshot measured the business: not a weekly re-audit the scheduler
 * marked as measuring nothing of it ("scheduled_unmeasured"). That mark covers a
 * name invented from the hostname, whose score the API keeps when it has one, so
 * a score alone does not make a row a measurement.
 */
export function measuredTheBusiness(s: { source?: string | null }): boolean {
  return s.source !== "scheduled_unmeasured";
}

/**
 * THE DOMAIN'S SERIES, as /api/monitoring-status reads it: every snapshot given
 * (oldest first) until one is a weekly re-audit ("scheduled") that recorded its
 * question, and from then on the weekly re-audits together with every other
 * snapshot that asked what the newest such re-audit asked. That question
 * anchors the series only while the series has no gap longer than four weekly
 * cadences and a day, the span across which the weekly digest still compares
 * one re-audit with another, between that re-audit, each later snapshot of the
 * series (weekly re-audits included, recorded or not), and the newest snapshot
 * given. After a gap (the domain untracked or paused, or its re-audits
 * unmeasured, while an audit asked something else), the series is every
 * snapshot again, until another weekly re-audit records its question. A gap is a
 * step between snapshots, so time alone opens none: with nothing newer, the
 * series' last snapshot stays its latest.
 *
 * The weekly re-audits, because they are what monitors a tracked domain: an
 * audit run by hand in another market, or an extension scan, asks a question of
 * its own, and read as the latest it announced a re-baseline that never
 * happened to the weekly re-audits, or had to be talked around. With what asked
 * their question, because such an audit is a newer measurement of the same
 * thing.
 *
 * Every snapshot that asked the series' latest question is in the series. So the
 * like-for-like base found among all earlier snapshots is the one in the series,
 * this client and the API pick the same one, and "no earlier snapshot asked the
 * same question" is true of every snapshot, not only of the series.
 */
export const SERIES_ANCHOR_REACH_MS = (4 * 7 + 1) * DAY_MS;

export function seriesOf<T extends { source?: string | null; question?: SnapshotQuestion | null; captured_at?: string }>(
  rows: T[],
): T[] {
  // Anchored on the newest weekly re-audit that recorded its question. One that
  // recorded nothing matches nothing, and as the anchor it hid every newer
  // audit that asked the weekly question.
  const anchors = rows.filter((s) => s.source === "scheduled" && Boolean(s.question?.key));
  if (!anchors.length) return rows;
  const newest = anchors[anchors.length - 1]!;
  const anchored = rows.filter((s) => s.source === "scheduled" || sameQuestion(s, newest));
  // Only while the anchored series has no gap: from that re-audit, through each
  // later snapshot of it, to the newest snapshot given, no step is longer than
  // the reach. With no limit, an
  // untracked domain's audits in another market months later never became its latest. Judged
  // by the re-audit alone, one audit in another market a month after it hid a
  // like-for-like change measured days before; judged by the series' newest
  // snapshot alone, one audit of a question last re-audited a year before
  // brought it back.
  const steps = [...anchored.slice(anchored.indexOf(newest)), rows[rows.length - 1]!];
  for (let i = 1; i < steps.length; i += 1) {
    const step = Date.parse(steps[i]!.captured_at ?? "") - Date.parse(steps[i - 1]!.captured_at ?? "");
    if (step > SERIES_ANCHOR_REACH_MS) return rows;
  }
  return anchored;
}

/**
 * What to say about snapshots newer than the series' latest, which the series
 * leaves out: they asked something the weekly re-audits do not ask, or recorded
 * nothing. When two of them asked the same question it names the most recent
 * such change: a refusal about the series is not "nothing changed" about them.
 * Empty when there are none; otherwise sentences with a leading space.
 */
export function laterNote<T extends { captured_at: string; score: number; by_engine?: Record<string, number>; question?: SnapshotQuestion | null }>(
  later: T[],
  latest: T,
): string {
  if (!later.length) return "";
  const pair = newestComparablePair(later);
  // The overall of that pair is named only when the same engines answered it
  // (sameEngines): a change of denominator is not a change of visibility, and
  // this sentence exists so a refusal about the series is not read as
  // "nothing changed" about what it leaves out.
  const move = pair
    ? sameEngines(pair.from.by_engine, pair.to.by_engine)
      ? `was ${movement(pair.to.score - pair.from.score)}, from ${day(pair.from.captured_at)} to ${day(pair.to.captured_at)}`
      : `was from ${day(pair.from.captured_at)} to ${day(pair.to.captured_at)}, with different engines answering, so it has no overall`
    : "";
  const change = pair ? ` The most recent like-for-like change among them ${move}.` : "";
  if (!latest.question?.key) {
    // Nothing is known about what the latest asked, so nothing is said about
    // what these asked beside it.
    const n = later.length;
    return ` Left out as not part of the weekly series: ${n === 1 ? "1 newer snapshot" : `${n} newer snapshots`}, `
      + `${n === 1 ? "on" : "the newest on"} ${day(later[n - 1]!.captured_at)}.${change}`;
  }
  const newest = newestRecorded(later);
  const what = newest?.question && latest.question?.key
    ? ` The newest of them that records its question, on ${day(newest.captured_at)}, asked about `
      + `${questionDifference(newest.question, latest.question)}.`
    : "";
  return ` Left out as not part of the weekly series: ${notComparedPhrase(notCompared(later, latest))}, `
    + `newer than ${day(latest.captured_at)}.${what}${change}`;
}

/**
 * What to say about weekly re-audits newer than `latest` that measured nothing
 * of the business ("scheduled_unmeasured"): no comparison uses them, so without
 * a word a result reads as current when the newest weekly runs measured
 * nothing. With no `latest`, every such re-audit counts. Empty when there are
 * none; otherwise a sentence with a leading space.
 */
export function unmeasuredNote<T extends { captured_at: string; source?: string | null }>(
  snapshots: T[],
  latest: { captured_at: string } | null,
): string {
  const after = latest ? Date.parse(latest.captured_at) : Number.NEGATIVE_INFINITY;
  const runs = snapshots.filter((s) => s.source === "scheduled_unmeasured" && Date.parse(s.captured_at) > after);
  if (!runs.length) return "";
  const newest = runs.reduce((a, b) => (Date.parse(b.captured_at) > Date.parse(a.captured_at) ? b : a));
  return runs.length === 1
    ? ` The weekly re-audit on ${day(newest.captured_at)} measured nothing of the business, so it is not compared.`
    : ` ${runs.length} weekly re-audits${latest ? ` newer than ${day(latest.captured_at)}` : ""} measured nothing `
      + `of the business, the newest on ${day(newest.captured_at)}, so they are not compared.`;
}

/**
 * THE OVERALL ONLY COMPARES LIKE WITH LIKE.
 *
 * An overall AI-visibility score is computed over the engines that answered
 * (the engine computes it over the answers it observed, in the digest's own
 * words), so when an engine goes silent or rolls out the denominator changes
 * and the overall moves with nothing else moving — a ChatGPT outage week read
 * as "down 15" with no engine line to explain it. The weekly digest has
 * refused that subtraction since it gained per-engine scores
 * (website-auditor-api src/services/digest.js, detectMeaningfulChange:
 * the overall is compared only when the same engines answered both times,
 * engines that answered both times are still compared one by one); the pull
 * surfaces subtract the overall regardless, so every one of them reported the
 * change of a denominator as a change of visibility.
 *
 * An engine ANSWERED a snapshot when its `by_engine` value is a finite number.
 * Not a null (the monitoring path, which keeps all four keys), and not a
 * missing key (the history path, which drops unanswered engines at the read).
 * A MISSING MAP reads as no engines — `by_engine || {}`, the digest's own
 * defensive read — and never throws: laterNote's snapshots come from callers
 * that may carry none. Two snapshots were answered by the same engines
 * exactly when both sets of answering engines are equal — the empty set equal
 * to the empty set included, as in the digest: two snapshots no engine
 * answered still compare.
 */
function answeredEngines(by: Record<string, number | null> | undefined): string[] {
  // KNOWN ENGINES FIRST, IN THE DIGEST'S ORDER, then any other key that
  // carries a score: the digest decides over the four it knows, and an unknown
  // key that answered one side only changes the overall's denominator just as
  // well, so it is refused rather than ignored.
  const known = Object.keys(ENGINE_LABELS).filter((k) => numeric(by?.[k]) !== undefined);
  const unknown = Object.keys(by ?? {})
    .filter((k) => !(k in ENGINE_LABELS) && numeric(by?.[k]) !== undefined).sort();
  return [...known, ...unknown];
}

const sameEngines = (
  a: Record<string, number | null> | undefined,
  b: Record<string, number | null> | undefined,
): boolean => answeredEngines(a).join(",") === answeredEngines(b).join(",");

/** The engines' display names for a note, or "no engine" when none answered. */
function engineNames(by: Record<string, number | null> | undefined): string {
  return listOf(answeredEngines(by).map((k) => ENGINE_LABELS[k] ?? k)) || "no engine";
}

/**
 * Why the trend compared less than its windows span, or nothing at all, when
 * what the snapshots asked is the reason. `before` is every snapshot before
 * `latest`. Undefined when every snapshot in play asked the latest's question.
 */
function trendQuestionNote(latest: AiVisibilitySnapshot, before: AiVisibilitySnapshot[], now: Date): string | undefined {
  const on = day(latest.captured_at);
  if (!latest.question?.key) {
    return "The latest snapshot does not record what it asked the assistants, so no trend is computed through it.";
  }
  if (!newestSameQuestion(before, latest).base) {
    const prior = newestRecorded(before);
    return prior?.question
      ? `No earlier snapshot asked the question the latest one, on ${on}, asked. It asked about `
        + `${questionDifference(latest.question, prior.question)}, compared with the snapshot on `
        + `${day(prior.captured_at)}, so there is no trend for it yet.`
      : `The snapshots before the latest one, on ${on}, do not record what they asked, so there is no trend for it yet.`;
  }
  const cutoff = now.getTime() - 30 * DAY_MS;
  const inWindow = before.filter((s) => Date.parse(s.captured_at) >= cutoff);
  const left = notCompared(inWindow, latest);
  if (left.different + left.unrecorded === 0) return undefined;
  let lastDifferent: AiVisibilitySnapshot | undefined;
  for (const s of inWindow) if (s.question?.key && !sameQuestion(s, latest)) lastDifferent = s;
  const how = lastDifferent?.question
    ? ` The most recent that asked a different one, on ${day(lastDifferent.captured_at)}, asked about `
      + `${questionDifference(lastDifferent.question, latest.question)}.`
    : "";
  return "Only snapshots that asked the same question as the latest are compared. Not compared, from the last "
    + `30 days: ${notComparedPhrase(left)}.${how}`;
}

/**
 * Fold a raw snapshot series (oldest first) into 7- and 30-day trend windows.
 * The trend sits under an audit, so it follows the question that audit asked:
 * it ends at the snapshot of the run `runId` names (without one, at the newest
 * measured snapshot), and a window compares that snapshot against the OLDEST
 * snapshot inside the window that asked the same question (see sameQuestion),
 * and is null when it holds none. get_changes and get_monitoring_status report
 * the domain's weekly series instead (seriesOf). Simulated snapshots, and
 * weekly re-audits that measured nothing of the business, are no point to
 * measure movement from and are left out. Snapshot cadence is irregular (one
 * per audit + one per weekly scheduled run), so windows describe "movement
 * within the last N days", not fixed daily points. Returns null when fewer than
 * two measured snapshots remain, or when `runId` names no measured snapshot
 * (measuredRun says which).
 *
 * `now` is injectable for deterministic tests; callers default it.
 */
export function computeTrend(
  snapshots: AiVisibilitySnapshot[],
  now: Date = new Date(),
  runId?: string,
): AiVisibilityTrend | null {
  const measured = snapshots.filter((s) => !s.is_simulated && measuredTheBusiness(s));
  // Ending at the audit's own snapshot: the newest measured snapshot is another
  // audit's whenever this one stored no score or a simulated one, and the trend
  // then followed a question this audit never asked.
  const end = runId === undefined ? measured.length : measured.findIndex((s) => s.run_id === runId) + 1;
  const rows = measured.slice(0, end);
  if (rows.length < 2) return null;

  const latest = rows[rows.length - 1]!;

  const windowOf = (days: number): TrendWindow | null => {
    const cutoff = now.getTime() - days * DAY_MS;
    const inWindow = rows.filter((s) => Date.parse(s.captured_at) >= cutoff);
    if (inWindow.length < 2) return null;
    const { base: oldest, skipped } = oldestSameQuestion(inWindow.slice(0, -1), latest);
    if (!oldest) return null;
    // THE FULL ENGINE MAPS, not the engines shared by both endpoints. The old
    // intersection made the engine deltas safe (an engine absent from one
    // endpoint must not become a fabricated from-0 gain, which computeChanges
    // now skips on its own) but it also handed computeChanges two maps of the
    // SAME key set, so the same-engines rule never saw that the endpoints were
    // answered by different engines — and the window kept reporting an overall
    // delta over a denominator that had changed. computeChanges skips an
    // engine unmeasured on either side; what it needs from here is the truth
    // about who answered.
    const changes = computeChanges(
      { score: latest.score, by_engine: latest.by_engine },
      { score: oldest.score, by_engine: oldest.by_engine },
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
      ...(changes.overall_note ? { overall_note: changes.overall_note } : {}),
    };
  };

  const question_note = trendQuestionNote(latest, rows.slice(0, -1), now);
  return {
    change_7d: windowOf(7),
    change_30d: windowOf(30),
    snapshots_analyzed: rows.length,
    latest_captured_at: latest.captured_at,
    includes_simulated: rows.some((s) => s.is_simulated),
    ...(question_note ? { question_note } : {}),
  };
}

/** Whether the run `runId` left a measured snapshot in `snapshots` for a trend to end at. */
export function measuredRun(snapshots: AiVisibilitySnapshot[], runId: string): boolean {
  return snapshots.some((s) => s.run_id === runId && !s.is_simulated && measuredTheBusiness(s));
}

/**
 * The deltas between two snapshots: the overall move, and every engine's move
 * for engines that answered BOTH sides. The engine deltas skip an engine
 * unmeasured on either side (below); the OVERALL is compared only when the
 * same engines answered both sides — the digest's rule — and is null with an
 * `overall_note` naming the engines when they did not. The two scores each
 * stand: only the subtraction is refused, because an overall averaged over a
 * different set of engines is a different quantity.
 */
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
  // SKIPPED, not summed. The same outage read on the overall is a delta no
  // engine moved: the previous snapshot's 60 was averaged over four engines
  // and this one's 45 over three, and "down 15" reported the denominator.
  // `sameEngines` decides; the note only puts the difference into words.
  const comparable = sameEngines(current.by_engine, previous.by_engine);
  return {
    score_delta: comparable ? current.score - previous.score : null,
    engine_changes,
    competitor_changes: [],
    new_issues: [],
    resolved_issues: [],
    ...(!comparable
      ? {
        overall_note:
          `The overall score is not compared: ${engineNames(previous.by_engine)} answered the earlier snapshot and `
          + `${engineNames(current.by_engine)} the later one, so the two scores were each computed over a different `
          + "set of engines. Engines that answered both are still compared one by one.",
      }
      : {}),
  };
}
