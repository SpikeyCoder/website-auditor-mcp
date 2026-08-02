import { describe, it, expect, beforeEach } from "vitest";
import { HttpEventSink } from "../../src/telemetry/httpSink.js";
import { SERVER_VERSION } from "../../src/mcp/server.js";
import { __resetInstallIdCacheForTests } from "../../src/telemetry/installId.js";
import type { WaConfig } from "../../src/config.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The ingest payload is the contract with website-auditor-api. These pin the
 * fields the API cannot infer for itself.
 *
 * server_version exists because client_name/client_version describe the HOST
 * ('claude-ai' 0.1.0), not this server — so telemetry alone could not answer
 * "which build emitted this?". Diagnosing a missing field previously meant
 * unpacking published tarballs; it should be a GROUP BY.
 */
const cfg = (over: Partial<WaConfig> = {}) =>
  ({
    apiBaseUrl: "https://api.example.test",
    apiKey: "wa_test",
    metricsEnabled: true,
    ...over,
  }) as WaConfig;

/** Capture the JSON body of the single POST the sink makes. */
function captureFetch() {
  const calls: Array<Record<string, unknown>> = [];
  const fake = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  return { calls, fake };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("HttpEventSink payload", () => {
  beforeEach(() => __resetInstallIdCacheForTests());

  it("stamps the MCP's own build as server_version", async () => {
    const { calls, fake } = captureFetch();
    const sink = new HttpEventSink(cfg(), { fetch: fake });

    sink.emit({ event_type: "session_init", client_name: "claude-ai", client_version: "0.1.0" } as never);
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].server_version).toBe(SERVER_VERSION);
  });

  it("does not conflate the host's version with its own", async () => {
    const { calls, fake } = captureFetch();
    const sink = new HttpEventSink(cfg(), { fetch: fake });

    sink.emit({ event_type: "session_init", client_name: "claude-ai", client_version: "0.1.0" } as never);
    await flush();

    expect(calls[0].client_version).toBe("0.1.0"); // the host
    expect(calls[0].server_version).toBe(SERVER_VERSION); // us
    expect(calls[0].server_version).not.toBe(calls[0].client_version);
  });

  it("stamps it on tool_call events too, not just the handshake", async () => {
    const { calls, fake } = captureFetch();
    const sink = new HttpEventSink(cfg(), { fetch: fake });

    sink.emit({ event_type: "tool_call", tool_name: "run_audit", success: true } as never);
    await flush();

    expect(calls[0].server_version).toBe(SERVER_VERSION);
  });

  it("sends it even when the install id is unavailable", async () => {
    // The two are independent: a sandboxed filesystem yields no install_id, but
    // the build is still knowable and is exactly what you need to diagnose that
    // situation. This is the case that made the field necessary.
    const { calls, fake } = captureFetch();

    // Force resolveInstallId down its unusable-storage path. The directory's
    // PARENT is a regular file, so mkdir fails with ENOTDIR immediately on any
    // platform and any uid — see the matching note in installId.test.ts. Do not
    // use /proc here: it does not exist on macOS and hangs on Linux CI.
    const unwritable = join(mkdtempSync(join(tmpdir(), "wa-sandboxed-")), "a-file-not-a-dir");
    writeFileSync(unwritable, "");

    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(unwritable, "child");
    __resetInstallIdCacheForTests();
    const sandboxed = new HttpEventSink(cfg(), { fetch: fake });
    // Restoring with `= saved` would write the STRING "undefined" when the var
    // was unset, silently redirecting every later resolution to a relative path.
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;

    sandboxed.emit({ event_type: "session_init", client_name: "claude-ai" } as never);
    await flush();

    expect(calls[0].install_id).toBeUndefined();
    expect(calls[0].server_version).toBe(SERVER_VERSION);
  });
});
