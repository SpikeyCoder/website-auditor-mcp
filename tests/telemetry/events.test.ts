import { describe, it, expect, vi } from "vitest";
import { classifyAgentOrigin, NoopEventSink } from "../../src/telemetry/events.js";
import { HttpEventSink } from "../../src/telemetry/httpSink.js";
import { testConfig } from "../helpers.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("classifyAgentOrigin (agent-origin heuristic)", () => {
  it.each(["claude-ai", "Claude-AI", "cursor", "Cursor", "windsurf", "vscode", "Visual Studio Code", "zed"])(
    "treats known human-facing client %s as NOT agent-originated",
    (name) => {
      expect(classifyAgentOrigin(name)).toBe(false);
    },
  );

  it.each(["my-custom-agent", "langchain", "openai-sdk", "some-headless-runner", "mcp"])(
    "treats unknown/SDK/custom client %s as agent-originated",
    (name) => {
      expect(classifyAgentOrigin(name)).toBe(true);
    },
  );

  it("treats a missing client name as agent-originated (no human identity)", () => {
    expect(classifyAgentOrigin(undefined)).toBe(true);
    expect(classifyAgentOrigin("")).toBe(true);
  });
});

describe("HttpEventSink", () => {
  it("POSTs the event to /api/mcp-events with the API key header and JSON body", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    const sink = new HttpEventSink(testConfig({ apiKey: "wa_secret", apiBaseUrl: "https://api.example.com" }), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    sink.emit({ event_type: "session_init", client_name: "cursor", client_version: "1.0", is_agent_originated: false });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/api/mcp-events");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("wa_secret");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toMatchObject({
      event_type: "session_init",
      client_name: "cursor",
      is_agent_originated: false,
    });
  });

  it("omits the API-key header when no key is configured (no-key installs still count)", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    const sink = new HttpEventSink(testConfig({ apiKey: undefined }), { fetch: fetchMock as unknown as typeof fetch });
    sink.emit({ event_type: "session_init", is_agent_originated: true });
    await flush();
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty("X-API-Key");
  });

  it("swallows a failing POST — emit never throws and the rejection is handled", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const sink = new HttpEventSink(testConfig(), { fetch: fetchMock as unknown as typeof fetch });
    expect(() =>
      sink.emit({ event_type: "tool_call", tool_name: "run_audit", is_agent_originated: true, success: true, duration_ms: 5 }),
    ).not.toThrow();
    await flush(); // if the rejection were unhandled, this test run would flag it
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("NoopEventSink", () => {
  it("accepts events without doing anything or throwing", () => {
    const sink = new NoopEventSink();
    expect(() => sink.emit({ event_type: "session_init", is_agent_originated: false })).not.toThrow();
  });
});
