/**
 * The declared output schemas, checked against what the tools actually return.
 *
 * These run through the REAL server over the in-memory transport rather than
 * calling handlers directly, because the thing under test is not the shape of
 * an object — it is the SDK's `validateToolOutput`, which parses every
 * successful `structuredContent` against the declared schema and throws
 * `McpError` when it does not match. A schema tightened past what a real
 * response carries does not report a problem there; it MANUFACTURES one, and
 * the tool that worked yesterday returns an error today. Only the real path
 * catches that.
 *
 * The fake client returns realistic payloads (populated lists, a nested
 * `change` block, a tri-state `sources` field) rather than the empty defaults,
 * because an empty array satisfies any element schema and would make this file
 * pass while proving nothing about the nested shapes.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";
import { SERVED_TOOLS } from "../../src/tools/registry.js";
import { OUTPUT_SCHEMAS } from "../../src/tools/outputSchemas.js";
import { makeDeps } from "../helpers.js";
import { reachableReport } from "../fixtures/reports.js";

/**
 * Overrides for the endpoints whose defaults are empty or throw.
 *
 * Empty is the enemy here: `list_tracked_sites` defaulting to `tracked: []`
 * would validate against a schema describing entirely the wrong element, so
 * every list gets at least one row and every nullable field is exercised in
 * both states across the suite.
 */
const richClient = {
  getChanges: async () => ({
    score_delta: -4,
    engine_changes: [{ engine: "chatgpt", from: 61, to: 57, delta: -4 }],
    competitor_changes: [],
    new_issues: [{ name: "Missing FAQ schema" }],
    resolved_issues: [],
  }),
  compareCompetitors: async () => ({
    ranking: [
      { domain: "example.com", score: 57 },
      { domain: "rival.com", score: null, note: "Audit failed; not ranked." },
    ],
    gaps: [{ engine: "perplexity", competitor: "rival.com" }],
    quota: {
      limit: 10,
      remaining: 7,
      audits_used: 2,
      audits_skipped: 1,
      cached_reused: 1,
      reset: "2026-08-28T00:00:00Z",
    },
    skipped: [{ domain: "down.example", reason: "unreachable", detail: "DNS failure" }],
    summary: "Compared 2 of 4 domains.",
  }),
  listTrackedDomains: async () => ({
    limit: 5,
    used: 1,
    remaining: 4,
    tracked: [{
      domain: "example.com",
      cadence: "weekly",
      active: true,
      digest_enabled: true,
      last_audited_at: "2026-08-20T00:00:00Z",
      next_run_at: "2026-08-27T00:00:00Z",
      created_at: null,
    }],
  }),
  getMonitoringStatus: async () => ({
    limit: 5,
    used: 1,
    remaining: 4,
    sites: [{
      domain: "example.com",
      cadence: "weekly",
      active: true,
      latest_score: 57,
      last_audited_at: "2026-08-20T00:00:00Z",
      next_run_at: "2026-08-27T00:00:00Z",
    }],
  }),
  getRecommendations: async () => ({
    recommendations: [
      { action: "Add FAQ schema", why: "Assistants quote FAQ blocks.", expected_impact: "high", effort: "low" },
    ],
  }),
  generateSchema: async () => ({
    jsonld: { "@context": "https://schema.org", "@type": "LocalBusiness" },
    placement_notes: "In the <head> of every page.",
  }),
  getReport: async () => ({ report_url: "https://website-auditor.io/r/abc", badge_html: "<a href='#'>badge</a>" }),
  getGtmPlan: async () => ({
    plan_markdown: "## Week 1\n- Claim listings",
    plan_sections: [{ title: "Week 1", body_lines: ["Claim listings"] }],
    sources_used: ["https://example.com/about"],
    model: "gpt-5",
  }),
  getSubscription: async () => ({ tier: "pro" as const, status: "active" }),
  runAudit: async () => ({ runId: "abc123def456", report: reachableReport(), raw: {} }),
};

/** The arguments each tool needs to reach a SUCCESS result. */
const ARGS: Record<string, Record<string, unknown>> = {
  get_ai_visibility: { domain: "example.com" },
  run_audit: { domain: "example.com" },
  get_changes: { domain: "example.com" },
  compare_competitors: { domain: "example.com", competitors: ["rival.com"] },
  track_site: { domain: "example.com" },
  untrack_site: { domain: "example.com" },
  list_tracked_sites: {},
  get_monitoring_status: {},
  get_benchmark: { domain: "example.com" },
  get_recommendations: { domain: "example.com" },
  generate_schema: { domain: "example.com" },
  get_report: { domain: "example.com" },
  get_gtm_plan: { domain: "example.com" },
  get_sample_audit: {},
  check_upgrade_status: {},
};

async function connect(deps = makeDeps({ tier: "pro", client: richClient })) {
  const server = createServer(deps);
  const client = new Client({ name: "output-schema-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("declared output schemas", () => {
  it("every served tool declares one", () => {
    // The portal flags each tool that does not, so a new tool landing without
    // an entry in OUTPUT_SCHEMAS should fail here rather than in review.
    const missing = SERVED_TOOLS.filter((t) => !t.outputSchema).map((t) => t.name);
    expect(missing).toEqual([]);
    expect(SERVED_TOOLS).toHaveLength(15);
  });

  it("is published on the wire, so a client can read it before calling", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      // Objects, per the MCP spec — `structuredContent` is an object, and a
      // non-object root would be unrepresentable.
      expect(tool.outputSchema?.type, tool.name).toBe("object");
    }
  });

  for (const spec of SERVED_TOOLS) {
    it(`${spec.name} returns something its own schema accepts`, async () => {
      const client = await connect();
      const result = await client.callTool({ name: spec.name, arguments: ARGS[spec.name] ?? {} });

      // An output-validation failure surfaces here, as an error result whose
      // message names it. Asserted explicitly because a bare `isError` check
      // would read the same for an unrelated upstream failure.
      const text = JSON.stringify(result);
      expect(text, `${spec.name} failed output validation`).not.toContain("Output validation error");
      expect(result.isError, `${spec.name}: ${text.slice(0, 300)}`).toBeFalsy();
      expect(result.structuredContent, spec.name).toBeDefined();

      // And again directly, so a failure names the offending field rather than
      // just reporting that the call errored.
      const parsed = z.object(OUTPUT_SCHEMAS[spec.name]).safeParse(result.structuredContent);
      expect(
        parsed.success ? null : JSON.stringify(parsed.error.issues, null, 2),
        `${spec.name} schema mismatch`,
      ).toBeNull();
    });
  }

  it("does NOT validate error results — the auth challenge is unaffected", async () => {
    // The SDK returns early on `isError` (server/mcp.js → validateToolOutput),
    // which is what lets a Pro tool answer AUTH_REQUIRED with an error payload
    // that looks nothing like its declared success shape. If that ever changed,
    // declaring output schemas would break every gated tool for every
    // unauthenticated caller — the exact population a marketplace reviewer is.
    const client = await connect(makeDeps({ tier: "none" }));
    const result = await client.callTool({ name: "get_ai_visibility", arguments: { domain: "example.com" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Output validation error");
    expect((result.structuredContent as { code?: string })?.code).toBe("AUTH_REQUIRED");
  });
});
