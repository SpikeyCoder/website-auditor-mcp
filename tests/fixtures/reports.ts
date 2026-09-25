/**
 * Fixtures modelled on the REAL report shape returned by
 * website-auditor-api `GET /api/audit` → `audit` (which is chaos_tester's
 * `TestRun.to_dict()`), including the `ai_visibility` block produced by
 * modules/ai_visibility.py. Kept faithful to the upstream shapes so the
 * mappers are tested against reality, not an invented contract.
 */
import type { AuditReport } from "../../src/api/types.js";
import { sampleAuditReport } from "../../src/tools/sampleData.js";

/** A healthy, reachable site with real (non-simulated) AI-visibility data. */
export function reachableReport(overrides: Partial<AuditReport> = {}): AuditReport {
  // Re-exported from src/ so the shipped demo payload and the shape the mappers
  // are tested against can never drift apart. See src/tools/sampleData.ts.
  return sampleAuditReport(overrides);
}

/**
 * An unreachable site: the domain resolves (one that does not is refused by
 * the engine at /run, a 400 the MCP reports as INVALID_INPUT, before any
 * report exists), but no page loaded. Every "Page load" result FAILED at the
 * connection level, here a timeout, with the engine's own remedy for the cause
 * (chaos_tester safe_http; since #429 it names the cause and no longer says
 * "connectivity or DNS resolution").
 */
export function unreachableReport(): AuditReport {
  return {
    run_id: "deadbeef0000",
    base_url: "https://dead-bakery.example",
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
        name: "Page load: dead-bakery.example/",
        description: "GET https://dead-bakery.example/",
        status: "failed",
        severity: "high",
        url: "https://dead-bakery.example/",
        details: "The server did not respond in time.",
        recommendation: "Check server load and response times.",
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
      recommendation: "Check server load and response times.",
    },
  ];
  return r;
}
