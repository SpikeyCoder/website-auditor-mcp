import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";
import { makeDeps, RecordingEventSink } from "../helpers.js";
import type { EventSink, McpEvent, ToolCallEvent, SessionInitEvent } from "../../src/telemetry/events.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

async function connect(opts: {
  events: EventSink;
  clientName?: string;
  clientVersion?: string;
  tier?: "none" | "free" | "pro";
}) {
  const deps = makeDeps({ tier: opts.tier ?? "free", events: opts.events });
  const server = createServer(deps);
  const client = new Client({ name: opts.clientName ?? "test-client", version: opts.clientVersion ?? "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await flush(); // let the initialized notification / oninitialized hook run
  return { client };
}

describe("MCP event instrumentation", () => {
  it("emits a session_init with clientInfo on the initialize handshake", async () => {
    const sink = new RecordingEventSink();
    await connect({ events: sink, clientName: "cursor", clientVersion: "1.2.3" });

    const init = sink.events.find((e) => e.event_type === "session_init") as SessionInitEvent | undefined;
    expect(init).toBeDefined();
    expect(init!.client_name).toBe("cursor");
    expect(init!.client_version).toBe("1.2.3");
    expect(init!.is_agent_originated).toBe(false); // cursor is human-facing
  });

  it("classifies an unknown/custom client as agent-originated at session_init", async () => {
    const sink = new RecordingEventSink();
    await connect({ events: sink, clientName: "my-autonomous-agent" });
    const init = sink.events.find((e) => e.event_type === "session_init") as SessionInitEvent;
    expect(init.is_agent_originated).toBe(true);
  });

  it("emits a tool_call with name, success, duration and client info on success", async () => {
    const sink = new RecordingEventSink();
    const { client } = await connect({ events: sink, clientName: "cursor", tier: "free" });
    await client.callTool({ name: "get_ai_visibility", arguments: { domain: "example.com" } });
    await flush();

    const call = sink.events.find((e) => e.event_type === "tool_call") as ToolCallEvent | undefined;
    expect(call).toBeDefined();
    expect(call!.tool_name).toBe("get_ai_visibility");
    expect(call!.success).toBe(true);
    expect(call!.error_code).toBeUndefined();
    expect(typeof call!.duration_ms).toBe("number");
    expect(call!.client_name).toBe("cursor");
    expect(call!.is_agent_originated).toBe(false);
  });

  it("emits a tool_call with success:false and the error_code on a gated failure", async () => {
    const sink = new RecordingEventSink();
    const { client } = await connect({ events: sink, tier: "free" });
    await client.callTool({ name: "get_changes", arguments: { domain: "example.com" } });
    await flush();

    const call = sink.events.find((e) => e.event_type === "tool_call" && e.tool_name === "get_changes") as ToolCallEvent;
    expect(call.success).toBe(false);
    expect(call.error_code).toBe("PRO_REQUIRED");
  });

  it("does NOT fail the tool call when the event sink throws", async () => {
    const throwingSink: EventSink = {
      emit(_event: McpEvent) {
        throw new Error("telemetry exploded");
      },
    };
    const { client } = await connect({ events: throwingSink, clientName: "cursor", tier: "free" });
    const res = await client.callTool({ name: "get_ai_visibility", arguments: { domain: "example.com" } });
    // The call still returns a valid, non-error result despite the broken sink.
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as { score: number };
    expect(structured.score).toBe(62);
  });
});
