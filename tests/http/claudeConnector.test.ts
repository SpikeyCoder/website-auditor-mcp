/**
 * The Claude connector box: WA_AUTH_CHALLENGE=http (lazy authentication) and
 * WA_TOOL_COPY=neutral.
 *
 * Claude starts sign-in ONLY when the HTTP request itself fails with 401 and a
 * WWW-Authenticate header; a 200 carrying the challenge reaches the model as
 * text and the user never gets a Connect button
 * (claude.com/docs/connectors/building/lazy-authentication). Every assertion
 * that matters here is therefore about the WIRE — status, header, which
 * requests get through — so the server runs on a real socket and most calls are
 * raw fetches, not the SDK client, which would turn a 401 into an exception and
 * hide the header.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createWaHttpServer, mixedAuthSummary, type HttpServerOptions } from "../../src/http.js";
import type { TokenExchange } from "../../src/auth/tokenExchange.js";
import { loadConfig, type WaConfig } from "../../src/config.js";
import type { ToolDeps } from "../../src/tools/context.js";
import { NEUTRAL_EDITS, SERVED_TOOLS, descriptionFor, titleFor } from "../../src/tools/registry.js";
import { IntrospectionTokenExchange, type TokenResolution } from "../../src/auth/tokenExchange.js";
import { buildInstructions } from "../../src/mcp/instructions.js";
import { NEUTRAL_SCHEMA_EDITS } from "../../src/tools/neutralSchemas.js";
import { makeDeps, testConfig, RecordingEventSink, UNEXPANDED_PLACEHOLDERS } from "../helpers.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const MIXED_AUTH = {
  oauthIssuer: "https://api.website-auditor.io",
  oauthResourceUrl: "https://claude-mcp.website-auditor.io/mcp",
  oauthScope: "audit",
  oauthScopes: ["audit", "openid", "email"],
};

const CLAUDE: Partial<WaConfig> = { ...MIXED_AUTH, authChallenge: "http", toolCopy: "neutral" };

/** Everything the deps factory built, so a test can prove a handler never ran. */
function trackingFactory() {
  const built: ToolDeps[] = [];
  const events = new RecordingEventSink();
  const factory = (config: WaConfig): ToolDeps => {
    const deps: ToolDeps = { ...makeDeps({ tier: config.apiKey ? "pro" : "none", config, events }), transport: "http" };
    built.push(deps);
    return deps;
  };
  return { factory, built, events };
}

async function listen(options: Partial<HttpServerOptions> & { config?: WaConfig }): Promise<string> {
  const server = createWaHttpServer({ config: options.config ?? testConfig({ apiKey: undefined }), ...options });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function claudeServer(over: Partial<HttpServerOptions> = {}) {
  const tracking = trackingFactory();
  const url = listen({
    config: testConfig({ apiKey: undefined, ...CLAUDE }),
    depsFactory: tracking.factory,
    tokenExchange: { resolve: async (t) => (t === "good-token" ? "wa_from_token" : undefined) },
    ...over,
  });
  return { url, ...tracking };
}

function rpc(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

const call = (name: string, args: Record<string, unknown> = {}, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("Claude lazy authentication: the HTTP 401 gate (WA_AUTH_CHALLENGE=http)", () => {
  it("lets initialize, tools/list and the open tools through with no token", async () => {
    const { url } = claudeServer();
    const base = await url;
    // The SDK client connecting at all proves initialize + tools/list answered
    // 200: a 401 there would make connect() throw.
    const client = new Client({ name: "claude-ai", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(SERVED_TOOLS.length);
    const sample = await client.callTool({ name: "get_sample_audit", arguments: {} });
    expect(sample.isError).toBeFalsy();
    await client.close();

    const status = await rpc(base, call("check_upgrade_status"));
    expect(status.status).toBe(200);
    expect(status.headers.get("www-authenticate")).toBeNull();
  });

  it("refuses an account-only tool with no token as a 401 Claude can follow, before the tool runs", async () => {
    const { url, built, events } = claudeServer();
    const base = await url;
    const resp = await rpc(base, call("run_audit", { domain: "example.com" }));

    expect(resp.status).toBe(401);
    const challenge = resp.headers.get("www-authenticate") ?? "";
    // The pointer Claude discovers the authorization server from — the RFC 9728
    // path-inserted URL for THIS box's resource, not the ChatGPT box's.
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(
      'resource_metadata="https://claude-mcp.website-auditor.io/.well-known/oauth-protected-resource/mcp"',
    );
    expect(challenge).toContain('scope="audit openid email"');
    expect(challenge).toContain('error="invalid_token"');
    expect(resp.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate");
    expect(await resp.json()).toEqual({
      error: "invalid_token",
      error_description: "Sign in to Website Auditor to use this tool.",
    });

    // No audit started. (The 401 status above is what proves the gate ran
    // before the SDK; without it the tool would have answered a 200.)
    for (const deps of built) expect(deps.client.runAudit).not.toHaveBeenCalled();
    // And recorded like the 200 path records its AUTH_REQUIRED.
    expect(events.events).toContainEqual(
      expect.objectContaining({ event_type: "tool_call", tool_name: "run_audit", success: false, error_code: "AUTH_REQUIRED" }),
    );
  });

  it("answers a token that did not resolve with a 401 too, so Claude refreshes and retries", async () => {
    const { url } = claudeServer();
    const resp = await rpc(await url, call("run_audit", { domain: "example.com" }), {
      Authorization: "Bearer expired-token",
    });
    expect(resp.status).toBe(401);
    expect(resp.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect((await resp.json()).error_description).toMatch(/could not be verified/);
  });

  it("gates even the open tools for a rejected token: the 401 is how Claude refreshes a dead one", async () => {
    const { url } = claudeServer();
    const base = await url;
    const headers = { Authorization: "Bearer expired-token" };
    expect((await rpc(base, call("check_upgrade_status"), headers)).status).toBe(401);
    expect((await rpc(base, call("get_sample_audit"), headers)).status).toBe(401);
    // initialize / tools/list still answer, so the connector itself stays up.
    const list = await rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, headers);
    expect(list.status).toBe(200);
  });

  it("does NOT 401 when introspection could not answer — that would loop every user through reconnect", async () => {
    const outage: TokenExchange = {
      resolve: async () => undefined,
      resolveDetailed: async (): Promise<TokenResolution> => ({ status: "unavailable" }),
    };
    const { url } = claudeServer({ tokenExchange: outage });
    const resp = await rpc(await url, call("run_audit", { domain: "example.com" }), {
      Authorization: "Bearer some-token",
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("www-authenticate")).toBeNull();
    // The answer every other box gives: could not verify, try again.
    expect(JSON.stringify(await resp.json())).toContain("unverified");
  });

  it("lets a browser client read the 401: the origin is allowed and the header exposed", async () => {
    const { url } = claudeServer();
    const resp = await rpc(await url, call("run_audit", { domain: "example.com" }), { Origin: "https://inspector.example" });
    expect(resp.status).toBe(401);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    expect(resp.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate");
  });

  it("runs the tool for a token that resolves — the gate does nothing once signed in", async () => {
    const { url, built } = claudeServer();
    const resp = await rpc(await url, call("run_audit", { domain: "example.com" }), {
      Authorization: "Bearer good-token",
    });
    expect(resp.status).toBe(200);
    expect(built.some((d) => vi.mocked(d.client.runAudit).mock.calls.length === 1)).toBe(true);
  });

  it("never gates a presented wa_ key, even a wrong one: that is a key answer, not a login", async () => {
    const { url } = claudeServer();
    const resp = await rpc(await url, call("run_audit", { domain: "example.com" }), {
      Authorization: "Bearer wa_some_key",
    });
    expect(resp.status).toBe(200);
  });

  it("does not gate a box whose credential-less callers act as its default key", async () => {
    const { url } = claudeServer({ defaultApiKey: "wa_box_identity" });
    expect((await rpc(await url, call("run_audit", { domain: "example.com" }))).status).toBe(200);
  });

  it("refuses a batch that calls any account-only tool — a status belongs to the whole response", async () => {
    const { url } = claudeServer();
    const resp = await rpc(await url, [call("get_sample_audit", {}, 1), call("track_site", { domain: "a.com" }, 2)]);
    expect(resp.status).toBe(401);
  });

  it("gates exactly the tools tools/list advertises as needing sign-in — the two cannot drift", async () => {
    const { url } = claudeServer();
    const base = await url;
    const client = new Client({ name: "c", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { tools } = await client.listTools();
    await client.close();
    for (const tool of tools) {
      const advertised = JSON.stringify(tool._meta?.securitySchemes).includes("oauth2");
      const status = (await rpc(base, call(tool.name, { domain: "example.com" }))).status;
      expect(status === 401, tool.name).toBe(advertised);
    }
  });

  it("passes an unknown tool name through to the SDK's own error, not a login", async () => {
    const { url } = claudeServer();
    expect((await rpc(await url, call("no_such_tool"))).status).toBe(200);
  });
});

describe("the ChatGPT box is unchanged", () => {
  it("default challenge mode answers in the tool result, never a 401", async () => {
    const tracking = trackingFactory();
    const base = await listen({
      config: testConfig({ apiKey: undefined, ...MIXED_AUTH }),
      depsFactory: tracking.factory,
    });
    const resp = await rpc(base, call("run_audit", { domain: "example.com" }));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("www-authenticate")).toBeNull();
    expect(JSON.stringify(await resp.json())).toContain("mcp/www_authenticate");
  });

  it("the http flag does nothing without Mixed Auth: there is no login for a 401 to start", async () => {
    const tracking = trackingFactory();
    const base = await listen({
      config: testConfig({ apiKey: undefined, authChallenge: "http" }),
      depsFactory: tracking.factory,
    });
    expect((await rpc(base, call("run_audit", { domain: "example.com" }))).status).toBe(200);
  });
});

describe("neutral tool copy (WA_TOOL_COPY=neutral)", () => {
  // The directory's compliance step: "Tool descriptions contain no
  // instructions about model behavior, other tools, or external instruction
  // sources" (claude.ai/directory/manage, 2026-10-15). "Use this when…" says
  // when the tool applies and stays; telling the model what to do or say, or
  // pointing it at another tool, does not.
  const INSTRUCTION = [
    /\brelay\b/i,
    /\bdo not\b/i,
    /\bdon't\b/i,
    /\boffer to\b/i,
    /\btreat\b/i,
    /\bso use this\b/i,
    /\bnever guessed\b/i,
    /\bcall \w+ first\b/i,
    /\binstead of refusing\b/i,
  ];

  for (const style of ["link", "info"] as const) {
    it(`no description instructs the model (${style} style)`, () => {
      for (const spec of SERVED_TOOLS) {
        const text = descriptionFor(spec, style, "neutral");
        for (const pattern of INSTRUCTION) expect(text, `${spec.name} ${pattern}`).not.toMatch(pattern);
      }
    });

    it(`no description points at another tool (${style} style)`, () => {
      const names = SERVED_TOOLS.map((s) => s.name);
      for (const spec of SERVED_TOOLS) {
        const text = descriptionFor(spec, style, "neutral");
        for (const other of names.filter((n) => n !== spec.name)) {
          expect(text.includes(other), `${spec.name} mentions ${other}`).toBe(false);
        }
      }
    });
  }

  it("every neutral edit still finds its phrase — an edited source cannot silently undo one", () => {
    for (const [name, edits] of Object.entries(NEUTRAL_EDITS)) {
      const spec = SERVED_TOOLS.find((s) => s.name === name);
      expect(spec, name).toBeDefined();
      for (const [from] of edits ?? []) expect(spec!.description, `${name}: ${from.slice(0, 40)}`).toContain(from);
    }
  });

  it("the rewrites keep the facts the instructions rested on", () => {
    const d = (name: string) => descriptionFor(SERVED_TOOLS.find((s) => s.name === name)!, "link", "neutral");
    expect(d("get_ai_visibility")).toContain("re-running with the business's real name as `business_name` measures that business");
    expect(d("generate_schema")).toContain("which the tool does not know");
    expect(d("get_changes")).toContain("scheduled monitoring adds weekly re-audits to the series but is not required");
    expect(d("generate_schema")).toContain("the draft is not meant to be used as returned");
    expect(d("track_site")).toContain("Passing enabled: false stops monitoring by deleting the enrollment.");
  });

  it("the full copy keeps its guidance — only the Claude box drops it", () => {
    const d = (name: string) => descriptionFor(SERVED_TOOLS.find((s) => s.name === name)!, "link");
    expect(d("generate_schema")).toContain("do not tell the user to paste the draft as returned");
    expect(d("run_audit")).toContain("is returned by get_ai_visibility, not by this tool");
    expect(d("get_changes")).toContain("so do not track a site just to answer a change question");
  });

  const PITCH = [
    /\$\d/,
    /trial/i,
    /call get_sample_audit/i,
    /suggesting an upgrade/i,
    /instead of refusing/i,
    /subscribing to/i,
  ];

  for (const style of ["link", "info"] as const) {
    it(`publishes no price, trial or call-to-action in any description (${style} style)`, () => {
      for (const spec of SERVED_TOOLS) {
        const text = descriptionFor(spec, style, "neutral");
        // "is my trial still active" is a trigger phrase in check_upgrade_status,
        // not a pitch; it is the one place the word may stand.
        const checked = spec.name === "check_upgrade_status" ? text.replace(/is my trial still active/, "") : text;
        for (const pattern of PITCH) expect(checked, `${spec.name} ${pattern}`).not.toMatch(pattern);
      }
    });
  }

  it("still says what a gated tool needs", () => {
    const run = SERVED_TOOLS.find((s) => s.name === "run_audit")!;
    expect(descriptionFor(run, "link", "neutral")).toMatch(/Requires a Website Auditor subscription\.$/);
    expect(descriptionFor(run, "info", "neutral")).toMatch(/Requires a Website Auditor plan\.$/);
  });

  it("leaves the default copy as it was — every phrase neutral removes is still there", () => {
    const spec = (name: string) => SERVED_TOOLS.find((s) => s.name === name)!;
    // Pinned by content, not by comparing the default to itself: an edit that
    // leaked into the full path must fail here.
    expect(descriptionFor(spec("run_audit"), "link")).toMatch(/\$\d.*7-day free trial.*call get_sample_audit first/);
    expect(descriptionFor(spec("check_upgrade_status"), "link")).toContain('," or before suggesting an upgrade.');
    expect(descriptionFor(spec("get_sample_audit"), "link")).toContain(
      "worth subscribing to — and use it INSTEAD of refusing when no API key is configured.",
    );
    expect(titleFor(spec("check_upgrade_status"), "link")).toBe("Check upgrade status");
    expect(titleFor(spec("check_upgrade_status"), "info")).toBe("Check plan status");
    expect(descriptionFor(spec("run_audit"), "info")).toContain("call get_sample_audit first");
    const full = buildInstructions("https://x.example/?source=mcp", "link", "http", true);
    for (const phrase of ["WHEN TO OFFER THIS without being asked", "Call it instead of declining", "Offer it\nin one sentence"]) {
      expect(full.replace(/\n/g, " ")).toContain(phrase.replace(/\n/g, " "));
    }
  });

  it("titles the status tool as a status check, not an upgrade", () => {
    const status = SERVED_TOOLS.find((s) => s.name === "check_upgrade_status")!;
    expect(titleFor(status, "link", "neutral")).toBe("Check subscription status");
    // info keeps its own wording.
    expect(titleFor(status, "info", "neutral")).toBe("Check plan status");
  });

  it("describes rather than prescribes: no unasked offers, no 'call it instead', no pitch", () => {
    for (const style of ["link", "info"] as const) {
      const text = buildInstructions("https://x.example/?source=mcp", style, "http", true, "neutral");
      for (const pattern of [/without being asked/i, /instead of declining/i, /offer it/i, /raise it once/i]) {
        expect(text, `${style} ${pattern}`).not.toMatch(pattern);
      }
      // The scope, the consumer carve-out and the keyless path survive as facts.
      expect(text).toContain("WHAT IT IS FOR");
      expect(text).toMatch(/not\s+for answering a consumer's request/);
      expect(text).toContain("get_sample_audit needs no account");
      expect(text).toContain("get_gtm_plan");
    }
  });

  it("drops the terms from the billing paragraph, but keeps relaying the paywall answer", () => {
    const text = buildInstructions("https://x.example/?source=mcp", "link", "http", true, "neutral");
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toMatch(/7-day/);
    // The paywall guidance is the "link style in paywall answers" half: when a
    // tool answers PRO_REQUIRED, its own payload states the terms.
    expect(text).toContain("PRO_REQUIRED");
    expect(text).toMatch(/give the price, the trial/);
    expect(buildInstructions("https://x.example/?source=mcp", "link", "http", true)).toMatch(/\$\d/);
  });

  /** tools/list as a box with this config serves it, over a real socket. */
  async function wireTools(config: Partial<WaConfig>) {
    const tracking = trackingFactory();
    const base = await listen({ config: testConfig({ apiKey: undefined, ...MIXED_AUTH, ...config }), depsFactory: tracking.factory });
    const client = new Client({ name: "c", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { tools } = await client.listTools();
    return { tools, client };
  }

  /** Every description string anywhere in a tool: its own and every schema field's. */
  function descriptionsOf(tool: unknown, path = ""): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const walk = (o: unknown, at: string) => {
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (k === "description" && typeof v === "string") out.push([at, v]);
        else walk(v, `${at}.${k}`);
      }
    };
    walk(tool, path);
    return out;
  }

  const stripDescriptions = (o: unknown): unknown =>
    Array.isArray(o) ? o.map(stripDescriptions)
      : o && typeof o === "object"
        ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== "description").map(([k, v]) => [k, stripDescriptions(v)]))
        : o;

  // Schema fields state facts in the negative ("snapshots that do not record
  // what they asked"), so there only the imperative "do not <verb>" counts.
  const WIRE_INSTRUCTION = [
    ...INSTRUCTION.filter((p) => p.source !== "\\bdo not\\b"),
    /\bdo not (report|tell|track|render|present|call|use|say|show|paste)\b/i,
    /\bmust\b/i,
    /\bshould\b/i,
    /\btell the user\b/i,
    /\bask the user\b/i,
    /\bmake sure\b/i,
    /\bif you know\b/i,
    /\bsupply one\b/i,
    /\bnever (render|present)\b/i,
    /\brender `?\w+`? instead\b/i,
  ];

  it("on the wire, no description at any depth instructs the model — schema fields included", async () => {
    const { tools, client } = await wireTools({ toolCopy: "neutral" });
    await client.close();
    expect(tools).toHaveLength(SERVED_TOOLS.length);
    for (const tool of tools) {
      for (const [at, text] of descriptionsOf({ description: tool.description, in: tool.inputSchema, out: tool.outputSchema }, tool.name)) {
        // Quoted user phrases ("what should I change") are what someone asks,
        // not what the model is told. They live in a tool's own description
        // ("Use this when someone asks …"); a schema field's quotes are kept,
        // so an instruction cannot hide inside them.
        const said = at === tool.name ? text.replace(/"[^"]*"/g, '""') : text;
        for (const pattern of WIRE_INSTRUCTION) expect(said, `${at} ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("the neutral schemas differ from the full ones in their words only — validation cannot change", async () => {
    const neutral = await wireTools({ toolCopy: "neutral" });
    const full = await wireTools({});
    await neutral.client.close();
    await full.client.close();
    const shapes = (tools: typeof full.tools) =>
      tools.map((t) => ({ name: t.name, in: stripDescriptions(t.inputSchema), out: stripDescriptions(t.outputSchema) }));
    expect(shapes(neutral.tools)).toEqual(shapes(full.tools));
    // And the words did change somewhere, or this proves nothing.
    expect(JSON.stringify(neutral.tools)).not.toEqual(JSON.stringify(full.tools));
  });

  it("every schema edit still finds its phrase on the full copy — a reworded field cannot silently undo one", async () => {
    const { tools, client } = await wireTools({});
    await client.close();
    const all = tools.flatMap((t) => descriptionsOf({ in: t.inputSchema, out: t.outputSchema }).map(([, d]) => d)).join("\n");
    for (const [from] of NEUTRAL_SCHEMA_EDITS) expect(all, from.slice(0, 50)).toContain(from);
  });

  it("the walker reaches lazy, union and discriminated-union children, and they still validate", async () => {
    const { z } = await import("zod");
    const { neutralSchema } = await import("../../src/tools/neutralSchemas.js");
    const leaf = () => z.string().describe("A note. Relay it.");
    const lazy = neutralSchema(z.lazy(() => z.object({ n: leaf() })));
    const du = neutralSchema(z.discriminatedUnion("k", [
      z.object({ k: z.literal("a"), n: leaf() }),
      z.object({ k: z.literal("b"), m: z.number() }),
    ]));
    const union = neutralSchema(z.union([leaf(), z.number()]));
    const descOf = (s: unknown): string[] => {
      const out: string[] = [];
      const walk = (x: any) => {
        if (!x || typeof x !== "object") return;
        if (x._def) {
          if (typeof x._def.description === "string") out.push(x._def.description);
          for (const v of Object.values(x._def)) {
            if (v instanceof Map) [...v.values()].forEach(walk);
            else if (Array.isArray(v)) v.forEach(walk);
            else if (typeof v === "function" && (x._def.shape === v)) Object.values((v as () => object)()).forEach(walk);
            else if (typeof v === "function" && x._def.getter === v) walk((v as () => unknown)());
            else walk(v);
          }
        }
      };
      walk(s);
      return out;
    };
    for (const s of [lazy, du, union]) {
      for (const d of descOf(s)) expect(d).not.toMatch(/Relay it/);
    }
    expect(lazy.safeParse({ n: "x" }).success).toBe(true);
    expect(du.safeParse({ k: "a", n: "x" }).success).toBe(true);
    expect(du.safeParse({ k: "b", n: "x" }).success).toBe(false);
    expect(union.safeParse(3).success).toBe(true);
  });

  it("a neutral box still validates real results against its schemas", async () => {
    const { client } = await wireTools({ toolCopy: "neutral" });
    // listTools above armed the client's output validator: a schema that no
    // longer matched what the tool returns would throw here.
    const sample = await client.callTool({ name: "get_sample_audit", arguments: {} });
    expect(sample.isError).toBeFalsy();
    expect(sample.structuredContent).toBeTruthy();
    await client.close();
  });

  it("reaches the wire: tools/list on a neutral box carries the neutral descriptions", async () => {
    const tracking = trackingFactory();
    const base = await listen({ config: testConfig({ apiKey: undefined, ...CLAUDE }), depsFactory: tracking.factory });
    const client = new Client({ name: "c", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { tools } = await client.listTools();
    const instructions = client.getInstructions() ?? "";
    await client.close();
    expect(tools.find((t) => t.name === "run_audit")!.description).toMatch(/subscription\.$/);
    expect(tools.some((t) => /\$\d/.test(t.description ?? ""))).toBe(false);
    expect(instructions).not.toMatch(/\$\d/);
  });

  it("states the price in the PRO_REQUIRED answer itself — the half that stays", async () => {
    const base = await listen({
      config: testConfig({ apiKey: undefined, ...CLAUDE }),
      depsFactory: (config: WaConfig): ToolDeps => ({
        ...makeDeps({ tier: config.apiKey ? "free" : "none", config }),
        transport: "http",
      }),
      tokenExchange: { resolve: async () => "wa_free_account" },
    });
    const resp = await rpc(base, call("run_audit", { domain: "example.com" }), { Authorization: "Bearer good-token" });
    expect(resp.status).toBe(200);
    const text = JSON.stringify(await resp.json());
    expect(text).toContain("PRO_REQUIRED");
    expect(text).toMatch(/\$\d/);
  });
});

describe("configuration", () => {
  it("reads both switches, and anything but the opt-in value is the default", () => {
    expect(loadConfig({ WA_AUTH_CHALLENGE: "http", WA_TOOL_COPY: "neutral" })).toMatchObject({
      authChallenge: "http",
      toolCopy: "neutral",
    });
    expect(loadConfig({ WA_AUTH_CHALLENGE: " HTTP ", WA_TOOL_COPY: "Neutral" })).toMatchObject({
      authChallenge: "http",
      toolCopy: "neutral",
    });
    for (const raw of [undefined, "", "401", "neutrall", ...UNEXPANDED_PLACEHOLDERS]) {
      expect(loadConfig({ WA_AUTH_CHALLENGE: raw, WA_TOOL_COPY: raw })).toMatchObject({
        authChallenge: "result",
        toolCopy: "full",
      });
    }
  });

  it("names the sign-in challenge in the boot line, since a wrong one fails silently", () => {
    const on = testConfig({ ...MIXED_AUTH, oauthIntrospectionSecret: "s" });
    expect(mixedAuthSummary({ ...on, authChallenge: "http" })).toContain("HTTP 401 (Claude)");
    expect(mixedAuthSummary(on)).toContain("in the tool result (ChatGPT)");
  });
});

describe("IntrospectionTokenExchange tells 'signed out' from 'could not check'", () => {
  const cfg = testConfig({ ...MIXED_AUTH, oauthIntrospectionUrl: "https://api.test/introspect" });
  const answering = (impl: () => Promise<Response>) =>
    new IntrospectionTokenExchange(cfg, impl as unknown as typeof fetch);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it.each<[string, () => Promise<Response>, TokenResolution["status"]]>([
    ["an active token with a key", async () => json({ active: true, api_key: "wa_k" }), "active"],
    ["active: false", async () => json({ active: false }), "inactive"],
    ["active without a key (no audit scope)", async () => json({ active: true }), "inactive"],
    ["a non-2xx (a wrong secret answers 401)", async () => new Response("no", { status: 401 }), "unavailable"],
    ["a body that is not JSON", async () => new Response("<html>", { status: 200 }), "unavailable"],
    ["a network failure", async () => { throw new TypeError("fetch failed"); }, "unavailable"],
  ])("%s", async (_label, impl, status) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await answering(impl).resolveDetailed("t")).status).toBe(status);
    } finally {
      warn.mockRestore();
    }
  });

  it("retries an outage within seconds, not after the minute a good answer is kept", async () => {
    // Cached like an inactive token (5s), never like an active one (60s): an
    // outage held for a minute would keep every user on "could not verify"
    // long after the endpoint recovered.
    let t = 0;
    let calls = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ex = new IntrospectionTokenExchange(
        cfg,
        (async () => {
          calls += 1;
          if (calls === 1) throw new TypeError("fetch failed");
          return json({ active: true, api_key: "wa_k" });
        }) as unknown as typeof fetch,
        () => t,
      );
      expect((await ex.resolveDetailed("tok")).status).toBe("unavailable");
      t = 4_000;
      expect((await ex.resolveDetailed("tok")).status).toBe("unavailable");
      expect(calls).toBe(1);
      t = 6_000;
      expect(await ex.resolveDetailed("tok")).toEqual({ status: "active", key: "wa_k" });
      expect(calls).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("resolve() is unchanged: the key, or nothing", async () => {
    expect(await answering(async () => json({ active: true, api_key: "wa_k" })).resolve("t")).toBe("wa_k");
    expect(await answering(async () => json({ active: false })).resolve("t")).toBeUndefined();
  });
});
