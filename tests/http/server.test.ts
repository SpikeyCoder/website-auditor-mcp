/**
 * The hosted Streamable HTTP entry point (src/http.ts) — the multi-tenant
 * surface the OpenAI plugin submission requires.
 *
 * Exercised over a REAL listening socket with the SDK's own
 * StreamableHTTPClientTransport, because the wire behavior — stateless POSTs,
 * bearer extraction, per-key bundle reuse — is exactly what a marketplace
 * client will hit.
 */
import { afterEach, describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createWaHttpServer, type HttpServerOptions } from "../../src/http.js";
import type { WaConfig } from "../../src/config.js";
import type { ToolDeps } from "../../src/tools/context.js";
import { makeDeps, testConfig, RecordingEventSink } from "../helpers.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function listen(options: Partial<HttpServerOptions> = {}): Promise<{ url: string }> {
  const server = createWaHttpServer({
    config: options.config ?? testConfig({ apiKey: undefined }),
    ...options,
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}` };
}

/** A deps factory that records which api keys reached it and serves mock deps. */
function recordingFactory(events?: RecordingEventSink) {
  const seenKeys: (string | undefined)[] = [];
  const factory = (config: WaConfig): ToolDeps => {
    seenKeys.push(config.apiKey);
    return {
      ...makeDeps({ tier: config.apiKey ? "pro" : "none", config, events }),
      transport: "http",
    };
  };
  return { factory, seenKeys };
}

async function connectClient(url: string, headers?: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "http-test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: headers ? { headers } : undefined,
  });
  await client.connect(transport);
  return client;
}

describe("MCP over Streamable HTTP", () => {
  it("serves initialize + tools/list to the SDK client — all 14 tools, correct identity", async () => {
    const { url } = await listen({ depsFactory: recordingFactory().factory });
    const client = await connectClient(url);
    const { tools } = await client.listTools();
    expect(tools.length).toBe(14);
    expect(client.getServerVersion()?.name).toBe("website-auditor");
    await client.close();
  });

  it("keyless calls work end to end: get_sample_audit answers with the sample report", async () => {
    const { url } = await listen({ depsFactory: recordingFactory().factory });
    const client = await connectClient(url);
    const res = await client.callTool({ name: "get_sample_audit", arguments: {} });
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as { is_sample: boolean; domain: string };
    expect(structured.is_sample).toBe(true);
    expect(structured.domain).toBe("example.com");
    await client.close();
  });

  it("extracts the tenant key from Authorization: Bearer", async () => {
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({ depsFactory: factory });
    const client = await connectClient(url, { Authorization: "Bearer wa_tenant_a" });
    await client.listTools();
    expect(seenKeys).toEqual(["wa_tenant_a"]);
    await client.close();
  });

  it("accepts X-API-Key as the fallback header curl habits expect", async () => {
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({ depsFactory: factory });
    const client = await connectClient(url, { "X-API-Key": "wa_tenant_x" });
    await client.listTools();
    expect(seenKeys).toEqual(["wa_tenant_x"]);
    await client.close();
  });

  it("reuses the tenant bundle across requests for the same key, builds a new one per key", async () => {
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({ depsFactory: factory });

    const a1 = await connectClient(url, { Authorization: "Bearer wa_a" });
    await a1.listTools();
    await a1.callTool({ name: "check_upgrade_status", arguments: {} });
    await a1.close();
    const a2 = await connectClient(url, { Authorization: "Bearer wa_a" });
    await a2.listTools();
    await a2.close();
    const b = await connectClient(url, { Authorization: "Bearer wa_b" });
    await b.listTools();
    await b.close();

    // Factory ran once per DISTINCT key, not once per request.
    expect(seenKeys).toEqual(["wa_a", "wa_b"]);
  });

  it("a stray apiKey on the base config never becomes the anonymous tenant's identity", async () => {
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({
      config: testConfig({ apiKey: "wa_leaked_from_env" }),
      depsFactory: factory,
    });
    const client = await connectClient(url);
    await client.listTools();
    expect(seenKeys).toEqual([undefined]);
    await client.close();
  });

  it("stamps telemetry events with transport: http", async () => {
    const events = new RecordingEventSink();
    const { url } = await listen({ depsFactory: recordingFactory(events).factory });
    const client = await connectClient(url);
    await client.callTool({ name: "get_sample_audit", arguments: {} });
    await client.close();
    const kinds = events.events.map((e) => e.event_type);
    expect(kinds).toContain("session_init");
    expect(kinds).toContain("tool_call");
    for (const event of events.events) expect(event.transport).toBe("http");
  });

  it("evicts idle tenant bundles instead of accumulating one per key forever", async () => {
    let at = 0;
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({ depsFactory: factory, idleTtlMs: 1000, now: () => at });

    const first = await connectClient(url, { Authorization: "Bearer wa_a" });
    await first.listTools();
    await first.close();
    at = 2000; // beyond idleTtlMs — the bundle for wa_a must be gone
    const second = await connectClient(url, { Authorization: "Bearer wa_a" });
    await second.listTools();
    await second.close();

    expect(seenKeys).toEqual(["wa_a", "wa_a"]);
  });
});

describe("plain HTTP surface", () => {
  it("GET /healthz reports ok + version", async () => {
    const { url } = await listen();
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("serves the domain-verification token exactly and alone", async () => {
    const { url } = await listen({ challengeToken: "tok_abc123" });
    const res = await fetch(`${url}/.well-known/openai-apps-challenge`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("tok_abc123");
  });

  it("404s the challenge path when no token is configured", async () => {
    const { url } = await listen();
    const res = await fetch(`${url}/.well-known/openai-apps-challenge`);
    expect(res.status).toBe(404);
  });

  it("rejects non-POST on /mcp — stateless means no SSE stream to GET", async () => {
    const { url } = await listen();
    const res = await fetch(`${url}/mcp`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
  });

  it("answers malformed JSON with a JSON-RPC parse error, not a crash", async () => {
    const { url } = await listen();
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("unknown paths 404", async () => {
    const { url } = await listen();
    expect((await fetch(`${url}/anything`)).status).toBe(404);
  });
});
