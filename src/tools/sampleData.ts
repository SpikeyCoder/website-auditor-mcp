/**
 * The canned audit behind `get_sample_audit` — the one thing a developer with
 * no API key can see.
 *
 * Faithful to the REAL shape returned by website-auditor-api `GET /api/audit` →
 * `audit` (chaos_tester's `TestRun.to_dict()`), including the `ai_visibility`
 * block from modules/ai_visibility.py. That fidelity is the entire point: the
 * demo exists so someone can judge whether this JSON fits their needs BEFORE
 * paying $10/mo, and a simplified stub would misrepresent what they'd buy.
 *
 * Lives in src/ rather than tests/ because package.json `files` ships only
 * `dist/**` — anything under tests/ is excluded from the published package.
 * tests/fixtures/reports.ts re-exports this so there is one source of truth and
 * the demo payload can never drift from what the mappers are tested against.
 *
 * Always example.com. `get_sample_audit` takes no domain argument, so this can
 * never be mistaken for a real audit of the caller's own site.
 */
import type { AuditReport } from "../api/types.js";

/** A healthy, reachable site with real (non-simulated) AI-visibility data. */
export function sampleAuditReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    run_id: "abc123def456",
    base_url: "https://example.com",
    environment: "production",
    started_at: "2026-06-30T12:00:00.000Z",
    finished_at: "2026-06-30T12:02:33.000Z",
    duration_s: 153.0,
    status: "completed",
    summary: { total: 20, passed: 16, failed: 2, warnings: 2, errors: 0, pass_rate: 80.0 },
    results: [
      {
        test_id: "aa11",
        module: "availability",
        name: "Page load: example.com/",
        description: "GET https://example.com/",
        status: "passed",
        severity: "info",
        url: "https://example.com/",
        details: "HTTP 200 OK",
        recommendation: "",
      },
      {
        test_id: "bb22",
        module: "security",
        name: "Missing HSTS header",
        description: "Strict-Transport-Security not set",
        status: "failed",
        severity: "high",
        url: "https://example.com/",
        details: "No Strict-Transport-Security header present.",
        recommendation: "Add a Strict-Transport-Security header.",
      },
      {
        test_id: "cc33",
        module: "links",
        name: "Broken link",
        description: "GET https://example.com/old",
        status: "failed",
        severity: "high",
        url: "https://example.com/old",
        details: "HTTP 404 Not Found",
        recommendation: "Remove or fix dead link; add a custom 404 page.",
      },
      {
        test_id: "dd44",
        module: "performance",
        name: "Slow page",
        description: "example.com/heavy",
        status: "warning",
        severity: "medium",
        url: "https://example.com/heavy",
        details: "4200ms load",
        recommendation: "Optimize assets.",
      },
    ],
    performance_metrics: { lcp_ms: 2600, cls: 0.03 },
    ai_visibility: {
      business_info: { business_name: "Example Inc", sector: "technology", industry: "technology", location: "Seattle, WA" },
      overall_score: 62,
      total_queries: 32,
      total_appearances: 20,
      platform_scores: {
        ChatGPT: { score: 75, appearances: 6, total: 8, results: [
          { platform: "ChatGPT", query: "best tech company in Seattle, WA", recommended: ["Example Inc", "Globex", "Initech"], client_appears: true, position: 1, competitors: ["Globex", "Initech"], is_simulated: false },
          { platform: "ChatGPT", query: "top rated tech company near Seattle, WA", recommended: ["Globex", "Example Inc"], client_appears: true, position: 2, competitors: ["Globex"], is_simulated: false },
        ] },
        Perplexity: { score: 62, appearances: 5, total: 8, results: [
          { platform: "Perplexity", query: "best tech company in Seattle, WA", recommended: ["Globex", "Initech", "Example Inc"], client_appears: true, position: 3, competitors: ["Globex", "Initech"], is_simulated: false },
        ] },
        Claude: { score: 50, appearances: 4, total: 8, results: [
          { platform: "Claude", query: "best tech company in Seattle, WA", recommended: ["Globex", "Initech"], client_appears: false, position: 0, competitors: ["Globex", "Initech"], is_simulated: false },
        ] },
        Gemini: { score: 62, appearances: 5, total: 8, results: [
          { platform: "Gemini", query: "best tech company in Seattle, WA", recommended: ["Globex", "Example Inc"], client_appears: true, position: 2, competitors: ["Globex"], is_simulated: false },
        ] },
      },
      queries: ["best tech company in Seattle, WA"],
      // The flattened per-answer table, exactly as chaos_tester's flatten emits
      // it: one row per platform_scores result (same queries and positions as
      // above), `recommended`/`competitors` comma-JOINED STRINGS here — not the
      // arrays the platform_scores rows carry — and `citations` holding the raw
      // grounded-source evidence. Presentation-only keys (platform_logo_url,
      // platform_color) are elided, matching this fixture's essential-keys
      // precedent. The citations below are what `sources` ranks: upstream only
      // ever injects `sources` when at least one of these rows has a readable
      // citations container, so the two must stay consistent — the fidelity
      // tests recompute one from the other.
      all_results: [
        {
          platform: "ChatGPT", query: "best tech company in Seattle, WA",
          recommended: "Example Inc, Globex, Initech", client_appears: true, position: 1,
          competitors: "Globex, Initech", visibility_score: 100, is_real: true,
          query_failed: false, failure_reason: null,
          citations: [
            // ChatGPT appends ?utm_source=openai to every link; the ranked
            // `sources.url` is the same page with the query string stripped.
            { url: "https://www.techreview.example/best-tech-companies-seattle/?utm_source=openai", title: "Best Tech Companies In Seattle 2026" },
            { url: "https://example.com/about?utm_source=openai", title: "About Example Inc" },
          ],
        },
        {
          platform: "ChatGPT", query: "top rated tech company near Seattle, WA",
          recommended: "Globex, Example Inc", client_appears: true, position: 2,
          competitors: "Globex", visibility_score: 75, is_real: true,
          query_failed: false, failure_reason: null,
          citations: [
            { url: "https://www.techreview.example/best-tech-companies-seattle/?utm_source=openai", title: "Best Tech Companies In Seattle 2026" },
          ],
        },
        {
          platform: "Perplexity", query: "best tech company in Seattle, WA",
          recommended: "Globex, Initech, Example Inc", client_appears: true, position: 3,
          competitors: "Globex, Initech", visibility_score: 75, is_real: true,
          query_failed: false, failure_reason: null,
          citations: [
            { url: "https://www.techreview.example/best-tech-companies-seattle/", title: "Best Tech Companies In Seattle 2026" },
            { url: "https://globex.example/customers", title: "Globex — Customer Stories" },
          ],
        },
        {
          platform: "Claude", query: "best tech company in Seattle, WA",
          recommended: "Globex, Initech", client_appears: false, position: 0,
          competitors: "Globex, Initech", visibility_score: 0, is_real: true,
          query_failed: false, failure_reason: null,
          citations: [
            { url: "https://www.techreview.example/best-tech-companies-seattle/", title: "Best Tech Companies In Seattle 2026" },
          ],
        },
        {
          platform: "Gemini", query: "best tech company in Seattle, WA",
          recommended: "Globex, Example Inc", client_appears: true, position: 2,
          competitors: "Globex", visibility_score: 75, is_real: true,
          query_failed: false, failure_reason: null,
          citations: [
            // Gemini cites through Google's grounding redirect: the domain is
            // attributed from the bare-domain title, but there is no linkable
            // page — hence bizdirectory.example's url:null / title:"" in `sources`.
            { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbCdEfSample123", title: "bizdirectory.example" },
          ],
        },
      ],
      // The ranked list `all_results[].citations` produces (chaos_tester #447):
      // deduplicated by domain, ordered by cross-engine agreement, then answer
      // count, then domain; `answers` counts ANSWERS, not citation entries.
      // Tri-state key: this array; null = recorded answers cited nothing
      // attributable; ABSENT = no readable citation records at all.
      sources: [
        { domain: "techreview.example", answers: 4, platforms: ["ChatGPT", "Perplexity", "Claude"], ownership: "third_party", url: "https://www.techreview.example/best-tech-companies-seattle/", title: "Best Tech Companies In Seattle 2026" },
        { domain: "bizdirectory.example", answers: 1, platforms: ["Gemini"], ownership: "third_party", url: null, title: "" },
        { domain: "example.com", answers: 1, platforms: ["ChatGPT"], ownership: "yours", url: "https://example.com/about", title: "About Example Inc" },
        { domain: "globex.example", answers: 1, platforms: ["Perplexity"], ownership: "competitor", url: "https://globex.example/customers", title: "Globex — Customer Stories" },
      ],
      identification: { candidates: [], lookup_source: "structured_data" },
      is_simulated: false,
      has_api_key: true,
      site_signals: {
        robots_txt_present: true,
        robots_txt_blocks_all: false,
        ai_bots_blocked: [],
        sitemap_present: true,
        sitemap_referenced_in_robots: true,
        has_structured_data: true,
        structured_data_types: ["Organization"],
        has_local_business_schema: false,
        has_meta_description: true,
        has_open_graph: true,
      },
    },
    ...overrides,
  };
}
