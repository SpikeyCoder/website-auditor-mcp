/**
 * Fixtures modelled on the REAL report shape returned by
 * website-auditor-api `GET /api/audit` → `audit` (which is chaos_tester's
 * `TestRun.to_dict()`), including the `ai_visibility` block produced by
 * modules/ai_visibility.py. Kept faithful to the upstream shapes so the
 * mappers are tested against reality, not an invented contract.
 */
import type { AuditReport } from "../../src/api/types.js";

/** A healthy, reachable site with real (non-simulated) AI-visibility data. */
export function reachableReport(overrides: Partial<AuditReport> = {}): AuditReport {
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

/**
 * An unreachable domain: the availability module could not load ANY page.
 * Every "Page load" result FAILED at the connection level (the availability
 * module tags these with the "connectivity or DNS resolution" recommendation),
 * and the ai_visibility block never populated (empty), because the homepage
 * fetch failed.
 */
export function unreachableReport(): AuditReport {
  return {
    run_id: "deadbeef0000",
    base_url: "https://not-a-real-domain-zzz.example",
    environment: "production",
    started_at: "2026-06-30T12:00:00.000Z",
    finished_at: "2026-06-30T12:00:05.000Z",
    duration_s: 5.0,
    status: "completed",
    summary: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, pass_rate: 0 },
    results: [
      {
        test_id: "ee55",
        module: "availability",
        name: "Page load: not-a-real-domain-zzz.example/",
        description: "GET https://not-a-real-domain-zzz.example/",
        status: "failed",
        severity: "high",
        url: "https://not-a-real-domain-zzz.example/",
        details: "ConnectionError: Failed to establish a new connection: [Errno 8] nodename nor servname provided",
        recommendation: "Investigate server connectivity or DNS resolution.",
      },
    ],
    performance_metrics: {},
    ai_visibility: {},
    ...({} as Partial<AuditReport>),
  };
}

/** A reachable homepage but a broken sub-page (should NOT count as unreachable). */
export function partialOutageReport(): AuditReport {
  const r = reachableReport();
  r.results = [
    {
      test_id: "ok01",
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
      test_id: "bad1",
      module: "availability",
      name: "Page load: example.com/broken",
      description: "GET https://example.com/broken",
      status: "failed",
      severity: "high",
      url: "https://example.com/broken",
      details: "ConnectionError on sub-resource",
      recommendation: "Investigate server connectivity or DNS resolution.",
    },
  ];
  return r;
}
