import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";
import { makeDeps } from "../helpers.js";

async function connect(deps = makeDeps({ tier: "free" })) {
  const server = createServer(deps);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("MCP server (end-to-end over in-memory transport)", () => {
  it("lists all 12 served tools (Phase-0 + scheduled-monitoring + Phase-1 reads) with verbatim names", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "compare_competitors",
        "generate_schema",
        "get_ai_visibility",
        "get_benchmark",
        "get_changes",
        "get_monitoring_status",
        "get_recommendations",
        "get_report",
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
    const { client } = await connect(makeDeps({ tier: "free" }));
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
