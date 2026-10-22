import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, MAX_TOOL_INPUT_ELEMENTS } from "../../src/mcp/server.js";
import { makeDeps } from "../helpers.js";

/**
 * GHSA-46jr-4wx8-v453: upgrading the SDK alone does not close it. The fix is
 * McpServer's maxToolInputElements option, off by default, so these pin that
 * createServer() turns it on.
 */
async function connect() {
  const server = createServer(makeDeps({ tier: "pro" }));
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** The text of a tools/call outcome, whether it rejected or returned isError. */
async function outcome(call: Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await call);
  } catch (err) {
    return String(err);
  }
}

describe("tools/call input size limit", () => {
  it("rejects arguments with more elements than the limit, before validating them", async () => {
    const client = await connect();
    const competitors = Array.from({ length: MAX_TOOL_INPUT_ELEMENTS + 500 }, (_, i) => i);

    const started = Date.now();
    const text = await outcome(
      client.callTool({ name: "compare_competitors", arguments: { domain: "example.com", competitors } }),
    );

    expect(text).toContain(`maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`);
    // Rejected up front: no per-element zod report echoed back.
    expect(text.length).toBeLessThan(2_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("leaves an ordinary call alone", async () => {
    const client = await connect();
    const competitors = Array.from({ length: 20 }, (_, i) => `rival${i}.com`);

    const text = await outcome(
      client.callTool({ name: "compare_competitors", arguments: { domain: "example.com", competitors } }),
    );

    expect(text).not.toContain("maximum of");
  });
});
