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

function engineScore(av: AiVisibilityBlock, key: EngineKey): number {
  return av.platform_scores?.[key]?.score ?? 0;
}

/**
 * Whether the site appeared on an engine at all. Upstream aggregates the
 * per-query `client_appears` flags into `appearances` (count of appearing
 * queries), so `appearances > 0` is the faithful per-engine appearance signal;
 * when that count is absent we fall back to the raw per-result `client_appears`.
 */
function engineAppears(av: AiVisibilityBlock, key: EngineKey): boolean {
  const ps = av.platform_scores?.[key];
  if (!ps) return false;
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

export function toAiVisibility(report: AuditReport): AiVisibility {
  const av = report.ai_visibility ?? {};
  const score = av.overall_score ?? 0;
  const by_engine = {
    chatgpt: engineScore(av, "ChatGPT"),
    perplexity: engineScore(av, "Perplexity"),
    claude: engineScore(av, "Claude"),
    gemini: engineScore(av, "Gemini"),
  };
  const appears_by_engine = {
    chatgpt: engineAppears(av, "ChatGPT"),
    perplexity: engineAppears(av, "Perplexity"),
    claude: engineAppears(av, "Claude"),
    gemini: engineAppears(av, "Gemini"),
  };
  const competitor = topCompetitor(av);
  const name = av.business_info?.business_name ?? report.base_url;
  const simulatedNote = av.is_simulated ? " (estimated — live AI queries were unavailable)" : "";
  const summary =
    competitor && competitor.length > 0
      ? `${name} scores ${score}/100 for AI visibility; the competitor most often surfaced instead is ${competitor}.${simulatedNote}`
      : `${name} scores ${score}/100 for AI visibility across ChatGPT, Perplexity, Claude and Gemini.${simulatedNote}`;

  return { score, by_engine, appears_by_engine, top_competitor: competitor, summary };
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

  return {
    scores: {
      ai_visibility: av.overall_score ?? null,
      seo: seoProxyScore(av),
      security: modulePassRate(report, "security"),
      performance: modulePassRate(report, "performance"),
    },
    top_issues,
    report_url,
  };
}

/**
 * Compute AI-visibility deltas between two snapshots. This is the delta logic
 * for `get_changes`, kept pure and tested so the tool is ready the moment
 * website-auditor-api exposes a history/delta endpoint (PRD open question #2).
 */
export function computeChanges(
  current: { score: number; by_engine: Record<string, number> },
  previous: { score: number; by_engine: Record<string, number> },
): Changes {
  const engine_changes: EngineChange[] = [];
  for (const engine of Object.keys(current.by_engine)) {
    const to = current.by_engine[engine] ?? 0;
    const from = previous.by_engine[engine] ?? 0;
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
