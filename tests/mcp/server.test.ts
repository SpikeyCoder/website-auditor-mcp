import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";
import { makeDeps } from "../helpers.js";

async function connect(deps = makeDeps({ tier: "pro" })) {
  const server = createServer(deps);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("MCP server (end-to-end over in-memory transport)", () => {
  it("lists all 14 served tools (Phase-0 + scheduled-monitoring + Phase-1 reads + check_upgrade_status + get_sample_audit) with verbatim names", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "check_upgrade_status",
        "compare_competitors",
        "generate_schema",
        "get_ai_visibility",
        "get_benchmark",
        "get_changes",
        "get_monitoring_status",
        "get_recommendations",
        "get_report",
        "get_sample_audit",
        "list_tracked_sites",
        "run_audit",
        "track_site",
        "untrack_site",
      ].sort(),
    );
    const av = tools.find((t) => t.name === "get_ai_visibility")!;
    expect(av.description).toContain("does ChatGPT/Perplexity/Claude/Gemini recommend");
  });

  it("marks track_site + untrack_site as mutating (readOnlyHint false); reads stay read-only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const name of ["track_site", "untrack_site"]) {
      expect(tools.find((t) => t.name === name)!.annotations?.readOnlyHint).toBe(false);
    }
    for (const name of [
      "get_ai_visibility",
      "list_tracked_sites",
      "get_monitoring_status",
      "get_benchmark",
      "get_recommendations",
      "generate_schema",
      "get_report",
    ]) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.openWorldHint).toBe(true);
    }
  });

  it("calls get_ai_visibility and returns structured content on success", async () => {
    const { client } = await connect(makeDeps({ tier: "pro" }));
    const res = await client.callTool({ name: "get_ai_visibility", arguments: { domain: "example.com" } });
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as { score: number; by_engine: Record<string, number> };
    expect(structured.score).toBe(62);
    expect(structured.by_engine.chatgpt).toBe(75);
  });

  it("surfaces a Pro-gated tool failure as an MCP error result with upgrade URL", async () => {
    const { client } = await connect(makeDeps({ tier: "free" }));
    const res = await client.callTool({ name: "get_changes", arguments: { domain: "example.com" } });
    expect(res.isError).toBe(true);
    const errObj = res.structuredContent as { code: string; upgrade_url?: string };
    expect(errObj.code).toBe("PRO_REQUIRED");
    expect(errObj.upgrade_url).toContain("website-auditor.io");
  });

  it("rejects unknown/misspelled tool names", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "get_ai_visibilty", arguments: { domain: "example.com" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("not found");
  });
});

describe("keyless discovery — what a developer with no API key can actually do", () => {
  // The funnel problem this suite guards. The server's `instructions` string is
  // injected into the model's system prompt at handshake, and it used to say
  // "Every tool requires an active Website Auditor subscription — there is no
  // free API tier." A model reading that with no key configured simply tells the
  // user to subscribe WITHOUT calling anything: no tool call, no error payload,
  // no upgrade link in the chat, and no telemetry row. Production bore that out
  // — 102 keyless sessions produced 1 tool call.
  const keyless = () => makeDeps({ config: { apiKey: undefined } as never });

  it("registers every tool with no key configured, so the surface is discoverable", async () => {
    const { client } = await connect(keyless());
    const { tools } = await client.listTools();
    expect(tools.length).toBe(14);
  });

  it("instructions point a keyless model at the free demo instead of refusing", async () => {
    const server = createServer(keyless());
    const instructions = (server as unknown as { server: { _instructions?: string } }).server._instructions ?? "";
    expect(instructions).toContain("get_sample_audit");
    expect(instructions).toContain("$10");
    // Must not read as a flat "everything is blocked" — that is what suppressed
    // the tool call in the first place.
    expect(instructions).not.toMatch(/Every tool requires an active Website Auditor subscription/);
  });

  it("the demo tool advertises itself as needing no key, in the text the model reads", async () => {
    const { client } = await connect(keyless());
    const { tools } = await client.listTools();
    const sample = tools.find((t) => t.name === "get_sample_audit")!;
    expect(sample).toBeDefined();
    expect(sample.description.toLowerCase()).toMatch(/no api key|without an api key|no key/);
  });
});
