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
import { createWaHttpServer, httpOptionsFromEnv, portFromEnv, type HttpServerOptions } from "../../src/http.js";
import { loadConfig, type WaConfig } from "../../src/config.js";
import type { ToolDeps } from "../../src/tools/context.js";
import { makeDeps, testConfig, RecordingEventSink, UNEXPANDED_PLACEHOLDERS } from "../helpers.js";

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
  it("serves initialize + tools/list to the SDK client — all 15 tools, correct identity", async () => {
    const { url } = await listen({ depsFactory: recordingFactory().factory });
    const client = await connectClient(url);
    const { tools } = await client.listTools();
    expect(tools.length).toBe(15);
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

  // An unexpanded placeholder is the ABSENCE of a key, and stdio has treated it
  // that way since the Cursor 3.15.19 finding. This path did not, so one broken
  // config produced onboarding over stdio and "Invalid API key format" over
  // HTTP. Codex's bearer_token_env_var is the same hazard on this side.
  it("treats an unexpanded placeholder Bearer as no key, not a bad one", async () => {
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({ depsFactory: factory });
    const client = await connectClient(url, { Authorization: "Bearer ${WA_API_KEY}" });
    await client.listTools();
    expect(seenKeys).toEqual([undefined]);
    await client.close();
  });

  it("lets a placeholder Bearer fall through to a real X-API-Key", async () => {
    // "Bearer first" means first among the keys actually presented — a
    // placeholder must not win the slot and shadow a key that IS there.
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({ depsFactory: factory });
    const client = await connectClient(url, {
      Authorization: "Bearer ${WA_API_KEY}",
      "X-API-Key": "wa_the_real_one",
    });
    await client.listTools();
    expect(seenKeys).toEqual(["wa_the_real_one"]);
    await client.close();
  });

  it("still passes a merely-wrong key through, so the typo can be named", async () => {
    // The line the normalization must not cross. A key that is present and
    // wrong has to reach the malformed-key answer naming the wa_ prefix;
    // recoding it to "unset" would tell someone who pasted the wrong string
    // that they had configured nothing, stranding them a step earlier.
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({ depsFactory: factory });
    const client = await connectClient(url, { Authorization: "Bearer sk-proj-not-ours" });
    await client.listTools();
    expect(seenKeys).toEqual(["sk-proj-not-ours"]);
    await client.close();
  });

  it("discards exactly what loadConfig discards", async () => {
    // The anti-drift assertion: both transports call normalizeEnvValue, so this
    // fails if either grows its own idea of what counts as a key. Iterates the
    // SHARED list config.test.ts uses — it used to hand-copy a subset, which
    // silently left `${input:apiKey}` unverified over HTTP and made "exactly"
    // a claim the test could not back.
    for (const placeholder of UNEXPANDED_PLACEHOLDERS) {
      expect(loadConfig({ WA_API_KEY: placeholder }).apiKey, `stdio: ${placeholder}`).toBeUndefined();

      // BOTH headers, not just Bearer. The X-API-Key branch had no placeholder
      // coverage at all: reverting its normalization left the entire suite
      // green, so a refactor could have dropped it and reinstated the bug this
      // PR exists to remove, with CI passing.
      for (const headers of [{ Authorization: `Bearer ${placeholder}` }, { "X-API-Key": placeholder }]) {
        const label = `${Object.keys(headers)[0]}: ${placeholder}`;
        const { factory, seenKeys } = recordingFactory();
        const { url } = await listen({ depsFactory: factory });
        const client = await connectClient(url, headers);
        await client.listTools();
        expect(seenKeys, label).toEqual([undefined]);
        await client.close();
      }
    }
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

describe("defaultApiKey (single-tenant/demo deployments)", () => {
  it("credential-less requests act as the configured key; presented keys still win", async () => {
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({ depsFactory: factory, defaultApiKey: "wa_demo_default" });
    const anon = await connectClient(url);
    await anon.listTools();
    await anon.close();
    const keyed = await connectClient(url, { Authorization: "Bearer wa_their_own" });
    await keyed.listTools();
    await keyed.close();
    expect(seenKeys).toEqual(["wa_demo_default", "wa_their_own"]);
  });

  it("normalizes a raw placeholder passed straight to the factory", async () => {
    // createWaHttpServer is a published entry (dist/**/*.js ships, no exports
    // map) and the listen guard exists so wrappers can import it. A wrapper
    // passing env through unnormalized must not be able to reinstate the bug,
    // so the invariant holds at the consumer rather than only in
    // httpOptionsFromEnv one layer above it.
    //
    // This replaced a test that fed an already-normalized value back in: with
    // the option resolving to undefined, that server was configured identically
    // to the plain keyless case already covered above, so it could only fail
    // when another test already had.
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({ depsFactory: factory, defaultApiKey: "${WA_HTTP_DEFAULT_KEY}" });
    const anon = await connectClient(url);
    const res = await anon.callTool({ name: "get_sample_audit", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(seenKeys).toEqual([undefined]);
    await anon.close();
  });

  it("a placeholder Bearer counts as no credentials, so it reaches the default key", async () => {
    // Intended consequence of normalizing, pinned so it stays a decision. A
    // placeholder is the ABSENCE of a credential, and this option's contract is
    // "callers with no credentials act as this key" — so they land here, where
    // before the truthy placeholder blocked the fallback and produced a
    // malformed-key answer. Only reachable on a box that opted in; the public
    // multi-tenant endpoint leaves defaultApiKey unset.
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({ depsFactory: factory, defaultApiKey: "wa_demo_default" });
    const client = await connectClient(url, { Authorization: "Bearer ${WA_API_KEY}" });
    await client.listTools();
    expect(seenKeys).toEqual(["wa_demo_default"]);
    await client.close();
  });
});

describe("plain HTTP surface", () => {
  it("GET /health and /healthz report ok + version (GFE swallows /healthz on run.app)", async () => {
    const { url } = await listen();
    for (const path of ["/health", "/healthz"]) {
      const res = await fetch(`${url}${path}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; version: string };
      expect(body.ok).toBe(true);
      expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
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

/**
 * The env → options/port mapping main() performs.
 *
 * Its own describe rather than living under defaultApiKey: portFromEnv has
 * nothing to do with that option, and filing it there meant deleting the
 * single-tenant feature would have deleted the only guard against a
 * blank-WA_HTTP_PORT boot crash along with it.
 */
describe("httpOptionsFromEnv / portFromEnv (what main() reads)", () => {
  it("applies the placeholder rule to EVERY env value, not just the key", () => {
    // Asserts the WIRING, not a reconstruction of it. The first version of this
    // test called normalizeEnvValue itself and passed the result in, so it
    // stayed green when the unnormalized env read was put back — it checked
    // normalizeEnvValue, which has its own tests, and nothing about http.ts.
    for (const placeholder of UNEXPANDED_PLACEHOLDERS) {
      const opts = httpOptionsFromEnv({
        WA_HTTP_DEFAULT_KEY: placeholder,
        WA_APPS_CHALLENGE_TOKEN: placeholder,
        WA_API_KEY: placeholder,
      });
      expect(opts.defaultApiKey, placeholder).toBeUndefined();
      // Unexpanded, this is truthy, so the well-known route answers 200 with
      // the literal `${...}` and OpenAI's verifier reports a token MISMATCH —
      // pointing the operator at a wrong value instead of the 404 that says
      // "no challenge configured".
      expect(opts.challengeToken, placeholder).toBeUndefined();
    }
  });

  it("strips a stray WA_API_KEY from the returned config", () => {
    // HttpServerOptions.config's contract: a stray env key "must never become
    // the fallback identity for unauthenticated callers". The factory strips
    // it, but this is exported too, so a wrapper reading .config — or logging
    // the options on boot — must not be handed the operator's live key.
    expect(httpOptionsFromEnv({ WA_API_KEY: "wa_operator_secret" }).config.apiKey).toBeUndefined();
  });

  it("strips a stray WA_DEV_TIER too", () => {
    // The one that actually grants access. resolve() consults devTier before
    // the wa_ prefix check and before any network call, so an inherited devTier
    // turns `Bearer anything` into a passing Pro gate for every tenant on the
    // box. Asserted here as well as at the factory because this function is
    // exported and a wrapper may never touch createWaHttpServer's own strip.
    expect(httpOptionsFromEnv({ WA_DEV_TIER: "pro" }).config.devTier).toBeUndefined();
    expect(httpOptionsFromEnv({ WA_DEV_TIER: "free" }).config.devTier).toBeUndefined();
  });

  it("passes real values through untouched", () => {
    const opts = httpOptionsFromEnv({ WA_HTTP_DEFAULT_KEY: "  wa_demo  ", WA_APPS_CHALLENGE_TOKEN: " tok-123 " });
    expect(opts.defaultApiKey).toBe("wa_demo");
    expect(opts.challengeToken).toBe("tok-123");
    expect(httpOptionsFromEnv({}).defaultApiKey).toBeUndefined();
    expect(httpOptionsFromEnv({}).challengeToken).toBeUndefined();
  });

  it("treats a blank port as unset at every level of the chain", () => {
    // `??` counted "" as present, so parseInt("") → NaN → listen(NaN) throws
    // ERR_SOCKET_BAD_PORT on boot. .env.example ships `WA_HTTP_PORT=`, so a
    // compose env_file exported exactly that — and it also swallowed the PORT
    // Cloud Run injects, which the Dockerfile promises is honored.
    expect(portFromEnv({ WA_HTTP_PORT: "", PORT: "8080" })).toBe(8080);
    expect(portFromEnv({ WA_HTTP_PORT: "   ", PORT: "8080" })).toBe(8080);
    expect(portFromEnv({ WA_HTTP_PORT: "", PORT: "" })).toBe(8787);
    expect(portFromEnv({})).toBe(8787);
    expect(portFromEnv({ WA_HTTP_PORT: "9001", PORT: "8080" })).toBe(9001);
    expect(portFromEnv({ PORT: "8080" })).toBe(8080);
  });

  it("refuses a port that would crash or silently mis-bind, naming the value", () => {
    // A plain int parse fixes the blank case and leaves the crash: 70000 and -1
    // are finite, and listen() rejects both the same way. 0.5 truncating to 0
    // is worse — it binds a random ephemeral port no health probe will find —
    // and "havoc" silently becoming 8787 puts a box behind a proxy on a port
    // nobody asked for, 502ing with nothing in the log.
    //
    // The hex/binary/exponent forms are the same class one layer down: Number()
    // reads 0x1F90 as 8080 and 0b1111 as 15 (a privileged bind), both integers,
    // both in range, neither what the operator wrote.
    for (const bad of ["70000", "-1", "0", "0.5", "havoc", "8080abc", "0x1F90", "0b1111", "1e4"]) {
      expect(() => portFromEnv({ WA_HTTP_PORT: bad }), bad).toThrow(/Invalid/);
      expect(() => portFromEnv({ WA_HTTP_PORT: bad }), bad).toThrow(new RegExp(bad.replace(".", "\\.")));
    }
  });

  it("names WHICH variable was bad, since the reader is staring at two of them", () => {
    expect(() => portFromEnv({ WA_HTTP_PORT: "havoc" })).toThrow(/WA_HTTP_PORT/);
    expect(() => portFromEnv({ PORT: "havoc" })).toThrow(/\bPORT\b/);
  });

  it("lets an explicit WA_HTTP_PORT override a junk PORT instead of dying", () => {
    // The regression this replaces. `parsePort(WA_HTTP_PORT, parsePort(PORT, …))`
    // reads like the documented chain but cannot behave like it: JS evaluates
    // arguments eagerly, so the inner call ran even when WA_HTTP_PORT was a
    // perfectly good port, and threw from a branch nothing was going to use.
    // The operator who set WA_HTTP_PORT *specifically to escape a bad PORT* was
    // the one it stranded — the process exited at boot.
    expect(portFromEnv({ WA_HTTP_PORT: "9001", PORT: "havoc" })).toBe(9001);
    expect(portFromEnv({ WA_HTTP_PORT: "9001", PORT: "${PORT}" })).toBe(9001);
    expect(portFromEnv({ WA_HTTP_PORT: "9001", PORT: "tcp://10.0.0.5:8080" })).toBe(9001);
    // …and a junk PORT still fails loudly when it IS the value being used.
    expect(() => portFromEnv({ PORT: "havoc" })).toThrow(/Invalid/);
  });
});

/**
 * Guards mutation testing found missing after the placeholder work — each of
 * these mutations left the whole suite green.
 */
describe("hosted transport: invariants nothing was asserting", () => {
  it("prefers a real Bearer over a real X-API-Key", async () => {
    // "Bearer first" was untested with TWO real keys. The existing case sends a
    // placeholder Bearer plus a real X-API-Key, whose expected result is
    // identical under fall-through and under "X-API-Key always wins" — so it
    // could not tell the orders apart. Swapping the branches stayed green.
    // Getting this wrong serves the WRONG TENANT on a multi-tenant endpoint to
    // any client that sends both (a connector auth field plus a curl-habit
    // header, or a proxy injecting a static one).
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({ depsFactory: factory });
    const client = await connectClient(url, {
      Authorization: "Bearer wa_from_bearer",
      "X-API-Key": "wa_from_header",
    });
    await client.listTools();
    expect(seenKeys).toEqual(["wa_from_bearer"]);
    await client.close();
  });

  it("never lets an operator config key become an anonymous caller's identity", async () => {
    // The interface's stated security invariant. Deliberately NOT labelled as a
    // guard on the `apiKey: undefined` strip in createWaHttpServer: TenantDeps
    // .forKey spreads `{ ...base, apiKey }`, so the per-request value overrides
    // base unconditionally and removing that strip is invisible here — verified
    // by mutation, it stays green. The strip is belt-and-braces; THIS asserts
    // the property both it and forKey exist to produce.
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({
      depsFactory: factory,
      config: testConfig({ apiKey: "wa_operator_secret" }),
    });
    const anon = await connectClient(url);
    await anon.listTools();
    expect(seenKeys).toEqual([undefined]);
    await anon.close();
  });

  it("strips a stray devTier too — it grants a tier without looking at the key", async () => {
    // Worse than apiKey: resolve() consults devTier BEFORE the wa_ prefix check
    // and before any network call, so on a hosted box with WA_DEV_TIER set,
    // `Bearer anything-at-all` walked straight through gateProTool.
    const seen: Array<string | undefined> = [];
    const { url } = await listen({
      config: testConfig({ apiKey: undefined, devTier: "pro" }),
      depsFactory: (config) => {
        seen.push(config.devTier);
        return { ...makeDeps({ config }), transport: "http" as const };
      },
    });
    const client = await connectClient(url, { Authorization: "Bearer not-a-wa-key" });
    await client.listTools();
    expect(seen).toEqual([undefined]);
    await client.close();
  });

  it("merges nothing: duplicate X-API-Key headers take the first, not the join", async () => {
    // Node joins repeated headers with ", ", so two X-API-Key headers arrived
    // as "wa_alice, wa_bob" — its own tenant bundle, forwarded verbatim.
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({ depsFactory: factory });
    const client = await connectClient(url, { "X-API-Key": "wa_alice, wa_bob" });
    await client.listTools();
    expect(seenKeys).toEqual(["wa_alice"]);
    await client.close();
  });

  it("serves a placeholder challenge token as 404, through the factory too", async () => {
    // The factory-level guard, matching defaultApiKey. Unexpanded, the token is
    // truthy: the route answered 200 with the literal `${...}` and the verifier
    // reported a MISMATCH instead of naming the real cause.
    const { url } = await listen({ challengeToken: "${WA_APPS_CHALLENGE_TOKEN}" });
    const res = await fetch(`${url}/.well-known/openai-apps-challenge`);
    expect(res.status).toBe(404);

    const ok = await listen({ challengeToken: " tok-123 " });
    const served = await fetch(`${ok.url}/.well-known/openai-apps-challenge`);
    expect(served.status).toBe(200);
    expect((await served.text()).trim()).toBe("tok-123");
  });
});

/**
 * Two pre-existing weaknesses the parallel security review surfaced. Both are
 * the same shape: something granted on the basis of ambient server state rather
 * than anything the caller proved.
 */
describe("hosted transport: an anonymous caller cannot spend a subscriber's money", () => {
  it("evicts the bundle with the least to lose, not simply the oldest", async () => {
    // The attack the flat cap allowed: a bundle is minted for ANY distinct
    // credential, including one that can never authenticate, so flooding
    // maxTenants distinct bearer tokens evicted every real tenant. Bundles hold
    // the 24h audit cache, so the subscriber's next compare_competitors
    // re-audits domains they already paid for — an anonymous request forcing
    // someone else to spend quota.
    const built: string[] = [];
    const { url } = await listen({
      maxTenants: 4,
      depsFactory: (config) => {
        built.push(config.apiKey ?? "(anon)");
        return { ...makeDeps({ config }), transport: "http" as const };
      },
    });

    // A working tenant with a session behind it.
    for (let i = 0; i < 3; i++) {
      const sub = await connectClient(url, { Authorization: "Bearer wa_subscriber" });
      await sub.listTools();
      await sub.close();
    }
    expect(built.filter((k) => k === "wa_subscriber")).toHaveLength(1);

    // Now flood with single-request junk keys, well past the cap.
    for (let i = 0; i < 12; i++) {
      const junk = await connectClient(url, { Authorization: `Bearer wa_flood_${i}` });
      await junk.listTools();
      await junk.close();
    }

    // The subscriber's bundle survived: asking again does not rebuild it.
    const again = await connectClient(url, { Authorization: "Bearer wa_subscriber" });
    await again.listTools();
    await again.close();
    expect(built.filter((k) => k === "wa_subscriber")).toHaveLength(1);
  });
});

describe("hosted transport: CORS does not lend the box's identity to a web page", () => {
  const origin = { Origin: "https://evil.example" };

  it("still answers * on the public endpoint, which lends no identity", async () => {
    // A browser page here gets the keyless surface exactly like curl — it must
    // present a key to be anybody, and CORS never hands it one.
    const { url } = await listen({});
    const res = await fetch(`${url}/mcp`, { method: "OPTIONS", headers: origin });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("withholds the origin when defaultApiKey makes credential-less requests somebody", async () => {
    // With an ambient identity configured, `*` let any page the operator
    // visited drive their demo box as that account and read the results back.
    const { url } = await listen({ defaultApiKey: "wa_demo_default" });
    const res = await fetch(`${url}/mcp`, { method: "OPTIONS", headers: origin });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    // The rest of the preflight is unchanged — this is about who may READ.
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("lets an operator opt specific origins back in", async () => {
    const { url } = await listen({
      defaultApiKey: "wa_demo_default",
      allowedOrigins: ["https://ops.example"],
    });
    const allowed = await fetch(`${url}/mcp`, { method: "OPTIONS", headers: { Origin: "https://ops.example" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://ops.example");
    expect(allowed.headers.get("vary")).toContain("Origin");

    const denied = await fetch(`${url}/mcp`, { method: "OPTIONS", headers: origin });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never blanket-allows just because an allowlist exists", async () => {
    // The allowlist must not be read as "CORS is configured, so * is fine".
    const { url } = await listen({
      defaultApiKey: "wa_demo_default",
      allowedOrigins: ["https://ops.example"],
    });
    const noOrigin = await fetch(`${url}/mcp`, { method: "OPTIONS" });
    expect(noOrigin.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("reads the allowlist from WA_HTTP_ALLOWED_ORIGINS, placeholder-safe", () => {
    expect(httpOptionsFromEnv({ WA_HTTP_ALLOWED_ORIGINS: "https://a.test, https://b.test" }).allowedOrigins)
      .toEqual(["https://a.test", "https://b.test"]);
    expect(httpOptionsFromEnv({ WA_HTTP_ALLOWED_ORIGINS: "${WA_HTTP_ALLOWED_ORIGINS}" }).allowedOrigins)
      .toBeUndefined();
    expect(httpOptionsFromEnv({}).allowedOrigins).toBeUndefined();
  });
});
