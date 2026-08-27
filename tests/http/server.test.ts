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
import {
  createWaHttpServer,
  httpOptionsFromEnv,
  mixedAuthSummary,
  portFromEnv,
  type HttpServerOptions,
} from "../../src/http.js";
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

  /**
   * The boot line that says whether Mixed Auth is actually on.
   *
   * It exists because a misconfigured Mixed Auth setup is invisible from
   * outside: an unconfigured server 404s the metadata path, which looks exactly
   * like an OLDER IMAGE that never had the route — the two were told apart by
   * the wording of a 404 body after a deploy shipped a stale `src/`. These
   * assertions are about what an operator can conclude from one log line.
   */
  it("says OFF — and why — for every configuration that leaves Mixed Auth off", () => {
    const off = /Mixed Auth OFF/;
    expect(mixedAuthSummary(loadConfig({}))).toMatch(off);
    // Half-configured is off, not half-on.
    expect(mixedAuthSummary(loadConfig({ WA_OAUTH_ISSUER: "https://api.example" }))).toMatch(off);
    expect(mixedAuthSummary(loadConfig({ WA_OAUTH_RESOURCE_URL: "https://mcp.example/mcp" }))).toMatch(off);
    // The silent one: both present, but a bare host is not an absolute URL, so
    // oauthEnabled rejects it and nothing downstream ever publishes a scheme.
    // Without this line that box looks identical to a stale deploy.
    expect(
      mixedAuthSummary(
        loadConfig({ WA_OAUTH_ISSUER: "api.example", WA_OAUTH_RESOURCE_URL: "https://mcp.example/mcp" }),
      ),
    ).toMatch(off);
    // …and names the two variables, since "OFF" alone tells nobody what to set.
    expect(mixedAuthSummary(loadConfig({}))).toMatch(/WA_OAUTH_ISSUER.*WA_OAUTH_RESOURCE_URL/);
  });

  it("reports the secret by LENGTH, never by value", () => {
    // Obviously fake, and 44 chars so the length assertion means something —
    // a realistic-looking base64 blob in a repo is a secret-scanner finding
    // whether or not it was ever live.
    const secret = "not-a-real-secret-only-its-length-matters-44";
    const line = mixedAuthSummary(
      loadConfig({
        WA_OAUTH_ISSUER: "https://api.example",
        WA_OAUTH_RESOURCE_URL: "https://mcp.example/mcp",
        WA_OAUTH_INTROSPECTION_SECRET: secret,
      }),
    );
    expect(line).toMatch(/Mixed Auth ON/);
    expect(line).toContain("https://api.example");
    expect(line).toContain("https://mcp.example/mcp");
    // The length is the point: a 23-char value against the server's 44-char one
    // was a real mismatch, and it cost a full verification cycle to find.
    expect(line).toContain(`${secret.length} chars`);
    // Cloud Run logs are not a vault. This is a shared HMAC key.
    expect(line).not.toContain(secret);
  });

  it("calls out a missing introspection secret, which oauthEnabled does not check", () => {
    // The nastiest state: metadata serves 200, every tool publishes a scheme,
    // the challenge is well-formed — and every real login dies at introspection,
    // because oauthEnabled() gates on the two URLs alone.
    const line = mixedAuthSummary(
      loadConfig({ WA_OAUTH_ISSUER: "https://api.example", WA_OAUTH_RESOURCE_URL: "https://mcp.example/mcp" }),
    );
    expect(line).toMatch(/Mixed Auth ON/);
    expect(line).toMatch(/WA_OAUTH_INTROSPECTION_SECRET MISSING/);
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

/**
 * Mixed Auth over the wire.
 *
 * The unit-level halves live in tests/auth/mixedAuth.test.ts; what matters here
 * is that they survive the transport — the metadata document is actually
 * reachable, securitySchemes actually reach a client through tools/list, and a
 * token is actually exchanged before a tenant bundle is minted.
 */
const MIXED_AUTH = {
  oauthIssuer: "https://api.website-auditor.io",
  oauthResourceUrl: "https://mcp.website-auditor.io/mcp",
  oauthScope: "audit",
};

describe("Mixed Auth over Streamable HTTP", () => {
  it("404s the metadata document when no OAuth is configured", async () => {
    const { url } = await listen({ depsFactory: recordingFactory().factory });
    const resp = await fetch(`${url}/.well-known/oauth-protected-resource`);
    expect(resp.status).toBe(404);
  });

  it("serves the RFC 9728 document, readable cross-origin, when OAuth is configured", async () => {
    const { url } = await listen({
      config: testConfig({ apiKey: undefined, ...MIXED_AUTH }),
      depsFactory: recordingFactory().factory,
    });
    const resp = await fetch(`${url}/.well-known/oauth-protected-resource`);
    expect(resp.status).toBe(200);
    // Public discovery metadata naming no secret — a host that cannot read it
    // cannot begin a login.
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    expect(await resp.json()).toEqual({
      resource: "https://mcp.website-auditor.io/mcp",
      authorization_servers: ["https://api.website-auditor.io"],
      scopes_supported: ["audit"],
      bearer_methods_supported: ["header"],
    });
  });

  it("publishes no securitySchemes at all on an unconfigured server", async () => {
    const { url } = await listen({ depsFactory: recordingFactory().factory });
    const client = await connectClient(url);
    const { tools } = await client.listTools();
    expect(tools.every((t) => t._meta?.securitySchemes === undefined)).toBe(true);
    await client.close();
  });

  it("marks the two free tools noauth and the other thirteen oauth2", async () => {
    const { url } = await listen({
      config: testConfig({ apiKey: undefined, ...MIXED_AUTH }),
      depsFactory: recordingFactory().factory,
    });
    const client = await connectClient(url);
    const { tools } = await client.listTools();
    const open = tools.filter((t) => JSON.stringify(t._meta?.securitySchemes).includes("noauth"));
    expect(open.map((t) => t.name).sort()).toEqual(["check_upgrade_status", "get_sample_audit"]);
    expect(tools.length - open.length).toBe(13);
    // The scope a protected tool asks for is the configured one, not a guess.
    const pro = tools.find((t) => t.name === "run_audit")!;
    expect(pro._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["audit"] }]);
    await client.close();
  });

  it("exchanges an opaque bearer for the account's key before minting a tenant", async () => {
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({
      config: testConfig({ apiKey: undefined, ...MIXED_AUTH }),
      depsFactory: factory,
      tokenExchange: { resolve: async (t) => (t === "opaque-token" ? "wa_from_token" : undefined) },
    });
    const client = await connectClient(url, { Authorization: "Bearer opaque-token" });
    await client.listTools();
    // The tenant is the RESOLVED key: bundles (and their 24h audit cache) are
    // keyed by account, so two tokens for one account must share one bundle.
    expect(seenKeys).toEqual(["wa_from_token"]);
    await client.close();
  });

  it("never sends a wa_ key to introspection — existing callers stay byte-identical", async () => {
    const { factory, seenKeys } = recordingFactory();
    let introspected = 0;
    const { url } = await listen({
      config: testConfig({ apiKey: undefined, ...MIXED_AUTH }),
      depsFactory: factory,
      tokenExchange: {
        resolve: async () => {
          introspected += 1;
          return undefined;
        },
      },
    });
    const client = await connectClient(url, { Authorization: "Bearer wa_direct_key" });
    await client.listTools();
    expect(seenKeys).toEqual(["wa_direct_key"]);
    expect(introspected).toBe(0);
    await client.close();
  });

  it("lands an unresolvable token on the keyless surface, never on the box's default identity", async () => {
    const { factory, seenKeys } = recordingFactory();
    const { url } = await listen({
      config: testConfig({ apiKey: undefined, ...MIXED_AUTH }),
      depsFactory: factory,
      defaultApiKey: "wa_box_identity",
      tokenExchange: { resolve: async () => undefined },
    });
    const client = await connectClient(url, { Authorization: "Bearer expired-token" });
    await client.listTools();
    // Presented-and-rejected is NOT presented-nothing: a caller who offered a
    // credential must never be handed the operator's account instead.
    expect(seenKeys).toEqual([undefined]);
    await client.close();
  });

  it("carries the login challenge in _meta on a protected tool called without a token", async () => {
    const { url } = await listen({
      config: testConfig({ apiKey: undefined, ...MIXED_AUTH }),
      depsFactory: (config: WaConfig): ToolDeps => ({
        ...makeDeps({ tier: config.apiKey ? "pro" : "none", config }),
        transport: "http",
      }),
    });
    const client = await connectClient(url);
    const res = await client.callTool({ name: "run_audit", arguments: { domain: "example.com" } });
    expect(res.isError).toBe(true);
    // Both halves, on the wire: without this the host never opens the login.
    expect(String(res._meta?.["mcp/www_authenticate"])).toContain("resource_metadata=");
    expect(JSON.stringify(res.structuredContent)).not.toContain("wwwAuthenticate");
    await client.close();
  });
});

describe("who gets the reconnect copy — the credential decides, not the config", () => {
  /** A server where every key resolves as revoked, so the rejection copy shows. */
  async function revokedKeyServer() {
    return listen({
      config: testConfig({ apiKey: undefined, ...MIXED_AUTH }),
      tokenExchange: { resolve: async (t) => (t === "opaque-token" ? "wa_from_token" : undefined) },
      depsFactory: (config: WaConfig): ToolDeps => ({
        ...makeDeps({
          config,
          subscriptions: {
            resolve: async () => ({ tier: "invalid", verified: true, rejection: "REVOKED_KEY" }),
          },
        }),
        transport: "http",
      }),
    });
  }

  it("an OAuth connection that died is offered the login again", async () => {
    const { url } = await revokedKeyServer();
    const client = await connectClient(url, { Authorization: "Bearer opaque-token" });
    const res = await client.callTool({ name: "run_audit", arguments: { domain: "example.com" } });
    expect((res.structuredContent as { code: string }).code).toBe("AUTH_REQUIRED");
    expect(String(res._meta?.["mcp/www_authenticate"])).toContain("resource_metadata=");
    await client.close();
  });

  it("a PASTED key that was revoked keeps the upstream answer, and gets no challenge", async () => {
    // The byte-identical promise http.ts makes to curl, Codex and the README:
    // their credential is a key, and "there is no key to paste — reconnect when
    // prompted" is a message for somebody else entirely.
    const { url } = await revokedKeyServer();
    const client = await connectClient(url, { Authorization: "Bearer wa_pasted_key" });
    const res = await client.callTool({ name: "run_audit", arguments: { domain: "example.com" } });
    expect((res.structuredContent as { code: string }).code).toBe("REVOKED_KEY");
    expect(res._meta?.["mcp/www_authenticate"]).toBeUndefined();
    await client.close();
  });
});

/**
 * The eight submitted OpenAI test cases, pinned against the KEYLESS surface.
 *
 * This is the guard whose absence caused the 2026-08-24 rejection.
 * docs/SUBMISSION-TESTS.md claimed results that required a Pro API key, on a
 * listing configured No Auth where no key could ever arrive — so five of the
 * eight cases answered AUTH_REQUIRED instead of what the document promised, and
 * nothing in the repo compared the two.
 *
 * These assertions describe what an anonymous caller actually gets. If the
 * submitted expectations drift from it again, this fails first.
 */
describe("submitted test cases, as an anonymous reviewer sees them", () => {
  async function keylessClient() {
    const { url } = await listen({
      depsFactory: (config: WaConfig): ToolDeps => ({
        ...makeDeps({ tier: config.apiKey ? "pro" : "none", config }),
        transport: "http",
      }),
    });
    return connectClient(url);
  }

  it("P1 get_sample_audit — the one positive case that always held", async () => {
    const client = await keylessClient();
    const res = await client.callTool({ name: "get_sample_audit", arguments: {} });
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as { is_sample: boolean; domain: string };
    expect(data.is_sample).toBe(true);
    expect(data.domain).toBe("example.com");
    await client.close();
  });

  it("P4 check_upgrade_status — answers tier none, NOT the pro/active the doc claimed", async () => {
    const client = await keylessClient();
    const res = await client.callTool({ name: "check_upgrade_status", arguments: {} });
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as { tier: string; status: string };
    expect(data.tier).toBe("none");
    expect(data.status).toBe("none");
    await client.close();
  });

  it("P2/P3/P5 and N2 — every Pro tool answers AUTH_REQUIRED, whatever the case claimed", async () => {
    const client = await keylessClient();
    for (const [name, args] of [
      ["get_ai_visibility", { domain: "website-auditor.io" }],
      ["run_audit", { domain: "website-auditor.io" }],
      ["get_monitoring_status", {}],
      // N2's documented UNREACHABLE_DOMAIN is unreachable keyless: gateProTool
      // runs before the domain is ever fetched, so the dead domain never gets
      // looked up. This is the case that most clearly could not pass as written.
      ["run_audit", { domain: "this-domain-does-not-exist-9483749.com" }],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBe(true);
      expect((res.structuredContent as { code: string }).code, name).toBe("AUTH_REQUIRED");
    }
    await client.close();
  });

  it("N1 — the keyless refusal names the sample and points at no checkout under info style", async () => {
    const { url } = await listen({
      config: testConfig({ apiKey: undefined, upsellStyle: "info", upsellInfoUrl: "https://website-auditor.io" }),
      depsFactory: (config: WaConfig): ToolDeps => ({
        ...makeDeps({ tier: "none", config }),
        transport: "http",
      }),
    });
    const client = await connectClient(url);
    const res = await client.callTool({ name: "get_ai_visibility", arguments: { domain: "example.com" } });
    const error = res.structuredContent as { code: string; message: string; upgrade_url: string };
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.message).toContain("get_sample_audit");
    expect(error.message).toContain("$10/month");
    // The deployed box runs WA_UPSELL_STYLE=info precisely so no response
    // carries a checkout link — the OpenAI guidelines forbid one.
    expect(error.upgrade_url).toContain("website-auditor.io");
    expect(error.upgrade_url).not.toContain("admin_portal");
    await client.close();
  });
});
