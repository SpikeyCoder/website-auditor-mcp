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
