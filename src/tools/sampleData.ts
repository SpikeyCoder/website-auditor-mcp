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
      all_results: [],
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
