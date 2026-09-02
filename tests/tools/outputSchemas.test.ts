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
import { makeDeps, errorPayload } from "../helpers.js";
import { reachableReport } from "../fixtures/reports.js";
import { PRICE } from "../../src/tools/upgrade.js";

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
    // Nulls, not omissions — the engine builds each card with
    // dict.fromkeys and fills a field only when the plan wrote it. A schema
    // declaring these as plain strings would fail HERE rather than in front
    // of a customer who has already been billed for the plan.
    plan_phases: [
      {
        phase: 30,
        range: "Days 1–30",
        name: "Foundation",
        short: "30 Days",
        headline: "Get listed where the assistants look",
        focus: null,
        actions: [
          {
            title: "Claim the Yelp listing",
            effort: "2 hours",
            priority: "High",
            why: null,
            goal: null,
            steps: ["Open the claim form"],
          },
          // The card the plan wrote as a bare heading: every optional field
          // null, steps empty. This is the ordinary case, not an edge one —
          // parse_plan_actions fills a field only when the plan wrote it —
          // and without a row like this the schema's nullability is never
          // actually exercised here.
          { title: "Add FAQ schema", effort: null, priority: null, why: null, goal: null, steps: [] },
        ],
      },
      {
        phase: 60,
        range: "Days 31–60",
        name: "Authority",
        short: "60 Days",
        headline: null,
        focus: null,
        actions: [],
      },
    ],
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
  // ARMS THE CLIENT-SIDE VALIDATOR, and that is the point of this line.
  //
  // The SDK client caches an output validator per tool from the tools/list
  // response, and runs it in callTool only if that cache was ever filled. A
  // client that never lists is therefore validating nothing — which is what
  // this suite used to be, and why it could assert that error results "are not
  // validated" while every real client, all of which list before they call, was
  // getting an McpError instead of the payload. Listing here makes the fake
  // client behave like the real ones, on BOTH paths below.
  await client.listTools();
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

  /**
   * The PUBLISHED schema, not the Zod object — the only check a real client runs.
   *
   * The loop above validates two ways and neither is what a client does. The
   * SDK server parses with Zod; the direct `z.object(...).safeParse` here uses
   * Zod's default object mode, which STRIPS an undeclared key instead of
   * failing on it. A real client compiles the JSON Schema this server
   * PUBLISHES and runs Ajv against it — and that schema's root carries
   * `additionalProperties: false`, so a root key nobody declared passes both
   * checks above and is rejected on every client in the field.
   *
   * That is not hypothetical for this tool: `plan_phases` was new output, and
   * hanging it off the result root rather than inside `plan` (declared, and
   * `.passthrough()`) would have shipped green. The client only compiles its
   * validators after `listTools`, which the helper above deliberately does not
   * call — so this connects its own client and calls it.
   */
  it("get_gtm_plan's phase cards pass the schema a client actually compiles", async () => {
    const server = createServer(makeDeps({ tier: "pro", client: richClient }));
    const client = new Client({ name: "published-schema-test", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    // Caches the tool metadata, which is what arms the client-side validator.
    await client.listTools();

    // Throws McpError("Structured content does not match the tool's output
    // schema") if the payload violates the published schema — nulls inside a
    // card, an undeclared root key, anything.
    const result = await client.callTool({ name: "get_gtm_plan", arguments: ARGS.get_gtm_plan });
    expect(result.isError, JSON.stringify(result).slice(0, 300)).toBeFalsy();
    const plan = (result.structuredContent as { plan: { phases: unknown[] } }).plan;
    expect(plan.phases).toHaveLength(2);
  });

  /**
   * The rows a real response can actually carry, as opposed to the ones I wrote.
   *
   * This exists because the suite above could not have caught the bug it was
   * meant to: `richClient` replaces WaApiClient entirely, so every payload it
   * returns is complete BY CONSTRUCTION — the same assumption the schemas were
   * written under. A code review found five schemas requiring fields the client
   * passes through unnormalized, and all five were invisible here.
   *
   * So these payloads carry only what the code genuinely guarantees: whatever a
   * mapper computes, plus the keys a row cannot exist without. Everything else
   * is absent — not null, ABSENT, which is the case `.nullable()` does not
   * cover.
   */
  const sparseClient = {
    getSubscription: async () => ({ tier: "pro" as const, status: "active" }),
    // No name/url/details/recommendation: toAuditSummary copies them verbatim.
    runAudit: async () => ({
      runId: "abc123def456",
      report: { ...reachableReport(), results: [{ severity: "critical", module: "seo" }] },
      raw: {},
    }),
    getChanges: async () => ({
      score_delta: -4, engine_changes: [], competitor_changes: [], new_issues: [], resolved_issues: [],
    }),
    compareCompetitors: async () => ({
      ranking: [{ domain: "rival.com", score: null }],
      gaps: [], quota: { limit: null, remaining: null, audits_used: 0, audits_skipped: 0, cached_reused: 0, reset: null },
      skipped: [], summary: "",
    }),
    // A freshly-enrolled row: no next_run_at, no last_audited_at, no digest flag.
    listTrackedDomains: async () => ({ limit: 5, used: 1, remaining: 4, tracked: [{ domain: "example.com" }] }),
    // Two rows: one with no `latest` at all, and one whose latest snapshot
    // carries no score — the case that reaches the tool as `undefined` rather
    // than null, which the previous fixture missed entirely by omitting
    // `latest` and so only ever exercised the null path.
    getMonitoringStatus: async () => ({
      limit: 5,
      used: 2,
      remaining: 3,
      sites: [
        { domain: "example.com" },
        { domain: "scoreless.example", latest: { by_engine: {} } },
      ],
    }),
    getRecommendations: async () => ({ recommendations: [{ action: "Add FAQ schema" }] }),
    generateSchema: async () => ({ jsonld: {}, placement_notes: "" }),
    getReport: async () => ({ report_url: "", badge_html: "" }),
    // A heading with no body — the LLM-derived shape behind an unchecked cast.
    getGtmPlan: async () => ({
      plan_markdown: "## Week 1", plan_sections: [{ title: "Week 1" }], sources_used: [], model: "gpt-5",
    }),
  };

  for (const spec of SERVED_TOOLS) {
    it(`${spec.name} accepts a MINIMAL upstream payload, not just a complete one`, async () => {
      const client = await connect(makeDeps({ tier: "pro", client: sparseClient }));
      const result = await client.callTool({ name: spec.name, arguments: ARGS[spec.name] ?? {} });
      const text = JSON.stringify(result);
      expect(text, `${spec.name} rejects a payload the client can really produce`)
        .not.toContain("Output validation error");
      expect(result.isError, `${spec.name}: ${text.slice(0, 300)}`).toBeFalsy();
    });
  }

  /**
   * The half of validation that is NOT symmetric, and that this suite asserted
   * backwards for as long as it existed.
   *
   * The SDK server skips output validation when `isError` is set (server/mcp.js
   * → validateToolOutput). The SDK client does not: callTool validates whenever
   * `structuredContent` is PRESENT, under a comment claiming it skips errors —
   *
   *     // Only validate structured content if present (not when there's an error)
   *     if (result.structuredContent) { ... }
   *
   * — a check on `isError` the code never performs. So while the server was
   * happily returning an AUTH_REQUIRED body under a schema describing a score
   * report, every listing client turned it into a thrown McpError. Declaring
   * output schemas had broken every gated tool for every unauthenticated
   * caller: the exact population a marketplace reviewer is, and the exact
   * funnel failure src/mcp/instructions.ts records twice.
   *
   * The fix is that error results carry no structuredContent at all
   * (src/mcp/server.ts → toCallResult). These tests hold that line from the
   * outside: they assert on what a real client RECEIVES, so the asymmetry
   * cannot come back silently.
   */
  const KEYLESS_OK = new Set(["get_sample_audit", "check_upgrade_status"]);

  for (const spec of SERVED_TOOLS) {
    if (KEYLESS_OK.has(spec.name)) continue;
    it(`${spec.name}: its keyless refusal REACHES a validator-armed client`, async () => {
      const client = await connect(makeDeps({ tier: "none" }));

      // Not `.rejects` — the whole bug was that this line threw. A refusal is a
      // result, and it has to arrive as one.
      const result = await client.callTool({ name: spec.name, arguments: ARGS[spec.name] ?? {} });

      expect(result.isError, spec.name).toBe(true);
      expect(result.structuredContent, `${spec.name} must not carry a schema-violating body`).toBeUndefined();

      // The payload the model reads, intact, in the field no validator inspects.
      const payload = errorPayload(result);
      expect(payload.code, spec.name).toBe("AUTH_REQUIRED");
      expect(payload.upgrade_url, spec.name).toContain("website-auditor.io");
      // The three actionable things a keyless user is owed. Their absence is
      // not a formatting regression — it IS the funnel failure.
      expect(payload.message, `${spec.name} must name the free sample`).toContain("get_sample_audit");
      expect(payload.message, `${spec.name} must state the price`).toContain(PRICE);
      expect(payload.message, `${spec.name} must offer the trial`).toContain("free trial");
    });
  }

  it("the two keyless-capable tools still answer normally to the same client", async () => {
    // The guard against fixing the above by making everything an error: these
    // two are a marketplace reviewer's only working calls without a key, and
    // they validate on the client like any other success.
    const client = await connect(makeDeps({ tier: "none" }));
    for (const name of KEYLESS_OK) {
      const result = await client.callTool({ name, arguments: ARGS[name] ?? {} });
      expect(result.isError, name).toBeFalsy();
      expect(result.structuredContent, name).toBeDefined();
    }
  });
});
