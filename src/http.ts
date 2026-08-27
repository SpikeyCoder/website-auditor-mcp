#!/usr/bin/env node
/**
 * Hosted entry point: the same server, multi-tenant, over Streamable HTTP.
 *
 * The stdio entry (index.ts) is single-user — WA_API_KEY arrives via env at
 * startup and one ToolDeps serves the process. Here the key arrives per
 * request (`Authorization: Bearer wa_…`), so deps are per TENANT: one bundle
 * per key, built on first sight and reused after, because two of its members
 * are load-bearing caches —
 *
 *   - the audit cache (24h): compare_competitors relies on it to not re-spend
 *     daily quota on recently-audited domains. Rebuilding per request would
 *     silently multiply quota burn.
 *   - the subscription cache (60s): without reuse every tool call pays a
 *     subscription round-trip.
 *
 * Bundles are keyed by the key itself and NEVER shared across keys — audit
 * reuse across tenants would let one account ride another's quota spend.
 * A request with no credentials gets the keyless bundle: get_sample_audit
 * works, everything else answers AUTH_REQUIRED — identical to a keyless
 * install, and exactly what a marketplace reviewer should see first.
 *
 * Transport is STATELESS (no session ids): each POST gets a fresh McpServer +
 * StreamableHTTPServerTransport pair over the tenant's deps, so any replica
 * can serve any request and restarts lose nothing. The known cost: clientInfo
 * arrives only in the `initialize` request, so tool_call telemetry from this
 * entry point usually has no client_name (session_init still records it).
 *
 * Also served, because the OpenAI plugin submission requires them on this
 * host:
 *   GET /.well-known/openai-apps-challenge — the domain-verification token,
 *       exactly and alone (the portal rejects JSON or token lists).
 *   GET /healthz — deploy probe.
 */
import { createServer as createNodeServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, normalizeEnvValue, parsePort, type WaConfig } from "./config.js";
import { WaApiClient } from "./api/client.js";
import { DefaultSubscriptionProvider } from "./auth/entitlements.js";
import { InMemoryAuditCache } from "./auth/auditCache.js";
import { HttpEventSink } from "./telemetry/httpSink.js";
import { NoopEventSink } from "./telemetry/events.js";
import { createServer } from "./mcp/server.js";
import { SERVER_VERSION } from "./version.js";
import type { ToolDeps } from "./tools/context.js";
import { PROTECTED_RESOURCE_PATH, looksLikeApiKey, oauthEnabled, protectedResourceMetadata } from "./auth/oauth.js";
import { IntrospectionTokenExchange, type TokenExchange } from "./auth/tokenExchange.js";

const MCP_PATH = "/mcp";
const CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
// Both spellings: Google's frontend intercepts /healthz on run.app hosts and
// answers its own 404 before the request reaches the container — /health is
// the one probes must use there. /healthz kept for everything that isn't GFE.
const HEALTH_PATHS = new Set(["/health", "/healthz"]);
/** JSON-RPC over HTTP has no business being large; audits carry domains, not payloads. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpServerOptions {
  /**
   * Base config for every tenant. Its `apiKey` is DISCARDED: on a hosted box a
   * stray WA_API_KEY in the environment must never become the fallback
   * identity for unauthenticated callers.
   */
  config: WaConfig;
  /** Served verbatim at the well-known path; unset ⇒ the route 404s. */
  challengeToken?: string;
  /**
   * SINGLE-TENANT DEPLOYMENTS ONLY (demo instances, personal self-hosting):
   * requests carrying no credentials act as this key instead of getting the
   * anonymous surface. Requests that DO present a key still use their own.
   * Never set this on the public multi-tenant endpoint — it would hand every
   * anonymous caller the configured account, which is exactly the accident
   * the base-config apiKey strip above exists to prevent. The strip still
   * applies: an env WA_API_KEY is discarded; only this explicit option (env
   * WA_HTTP_DEFAULT_KEY) opts in.
   *
   * "No credentials" INCLUDES an unexpanded placeholder, since apiKeyFrom
   * normalizes one to undefined — so on a box with this set, a caller sending
   * `Bearer ${WA_API_KEY}` acts as this key, where before they got the
   * malformed-key answer. That follows from a placeholder being the absence of
   * a value rather than a bad one, and it only reaches an operator who already
   * opted into "anonymous callers act as this account"; on the public
   * multi-tenant endpoint this option is unset and nothing changes. Stated
   * because it widens who lands on the configured identity, which is worth
   * being a decision rather than a side effect. Pinned by a test.
   */
  defaultApiKey?: string;
  /**
   * Origins allowed to READ responses cross-origin from a browser (env
   * WA_HTTP_ALLOWED_ORIGINS, comma-separated). Only meaningful alongside
   * defaultApiKey: without it the endpoint lends no identity and answers `*`,
   * and with it a blanket `*` would let any page the operator visits act as the
   * configured account. Non-browser clients ignore CORS entirely, so this
   * restricts nothing a real MCP client does. See allowedOriginFor.
   */
  allowedOrigins?: readonly string[];
  /** Test seam. Production builds real deps; tests inject recorders/mocks. */
  depsFactory?: (config: WaConfig) => ToolDeps;
  /**
   * Test seam for the OAuth token → API key exchange. Production builds an
   * IntrospectionTokenExchange from config; only consulted when Mixed Auth is
   * configured, so an unconfigured server never constructs or calls one.
   */
  tokenExchange?: TokenExchange;
  /** Tenant-bundle bounds. Oldest-idle bundles are dropped past either. */
  maxTenants?: number;
  idleTtlMs?: number;
  now?: () => number;
}

function defaultDepsFactory(config: WaConfig): ToolDeps {
  const client = new WaApiClient(config);
  return {
    config,
    client,
    subscriptions: new DefaultSubscriptionProvider(config, client),
    cache: new InMemoryAuditCache({ ttlMs: config.auditCacheTtlMs }),
    events: config.metricsEnabled ? new HttpEventSink(config) : new NoopEventSink(),
    transport: "http",
  };
}

/**
 * Per-key ToolDeps bundles with idle-TTL + size-bound eviction.
 *
 * Eviction picks the bundle with the LEAST TO LOSE, not simply the oldest.
 * Oldest-first made the cap an attack surface: a bundle is minted for any
 * distinct credential, including one that can never authenticate, so an
 * unauthenticated caller sending maxTenants distinct bearer tokens evicted
 * every real tenant. The bundle holds the 24h audit cache, and losing it makes
 * the subscriber's next compare_competitors re-audit domains it had already
 * paid for — an anonymous request forcing someone else to spend quota.
 *
 * Request count is the proxy for stored value, because it is the one signal
 * available here synchronously: a bundle that has served one request has an
 * empty audit cache and an unresolved subscription, so dropping it costs
 * nothing, while a subscriber mid-session has both. Flood bundles sit at one
 * request each and are therefore always evicted ahead of a working tenant.
 * lastUsedAt still breaks ties, which keeps the old behaviour among equals.
 *
 * The residual: an attacker willing to spend N requests per junk key can climb
 * the ranking. That costs them linearly for a bundle holding nothing, and it no
 * longer buys the cheap eviction the flat cap handed out — see the test.
 */
class TenantDeps {
  private readonly bundles = new Map<string, { deps: ToolDeps; lastUsedAt: number; requests: number }>();

  constructor(
    private readonly base: WaConfig,
    private readonly factory: (config: WaConfig) => ToolDeps,
    private readonly maxTenants: number,
    private readonly idleTtlMs: number,
    private readonly now: () => number,
  ) {}

  forKey(apiKey: string | undefined): ToolDeps {
    const mapKey = apiKey ?? "";
    const at = this.now();
    this.evict(at);
    const existing = this.bundles.get(mapKey);
    if (existing) {
      existing.lastUsedAt = at;
      existing.requests += 1;
      return existing.deps;
    }
    const deps = this.factory({ ...this.base, apiKey });
    this.bundles.set(mapKey, { deps, lastUsedAt: at, requests: 1 });
    return deps;
  }

  /** Currently-live tenant count (post-eviction), for tests and health output. */
  size(): number {
    return this.bundles.size;
  }

  private evict(at: number): void {
    for (const [key, entry] of this.bundles) {
      if (at - entry.lastUsedAt > this.idleTtlMs) this.bundles.delete(key);
    }
    while (this.bundles.size >= this.maxTenants) {
      // Fewest requests first, oldest as the tie-break — "least to lose", not
      // "least recently seen". See the class comment for why the flat
      // oldest-first rule let an anonymous caller spend a subscriber's quota.
      let victimKey: string | undefined;
      let victimRequests = Infinity;
      let victimAt = Infinity;
      for (const [key, entry] of this.bundles) {
        if (entry.requests < victimRequests || (entry.requests === victimRequests && entry.lastUsedAt < victimAt)) {
          victimRequests = entry.requests;
          victimAt = entry.lastUsedAt;
          victimKey = key;
        }
      }
      if (victimKey === undefined) break;
      this.bundles.delete(victimKey);
    }
  }
}

/**
 * Bearer first (what Codex's `bearer_token_env_var` and the MCP auth spec
 * send), then X-API-Key (what the wrapped API itself uses, so curl habits
 * carry over). Anything else is treated as unauthenticated, not an error —
 * the keyless surface is a feature, not a fallback.
 *
 * Both sources go through normalizeEnvValue, the same function loadConfig uses,
 * so the two transports cannot answer "is this a key?" differently. They did:
 * stdio has discarded unexpanded placeholders since the Cursor 3.15.19 finding
 * (a first-run install spawns the server with the literal `${WA_API_KEY}`) and
 * this path did not, so one broken client config landed on the keyless
 * onboarding surface over stdio and on "Invalid API key format. Keys start
 * with wa_." over HTTP. Codex's `bearer_token_env_var` is the same hazard on
 * this side: an unset variable is exactly what arrives here unexpanded.
 *
 * A placeholder Bearer therefore falls THROUGH to X-API-Key instead of
 * winning as a bad value, which is what "Bearer first" always meant — first
 * among the keys actually presented.
 *
 * A token that is merely not ours still comes through verbatim, and should.
 * On this endpoint the Bearer IS the Website Auditor key, so a typo in it has
 * to reach the malformed-key answer that names the `wa_` prefix rather than
 * being recoded as "you configured nothing" — a placeholder is the absence of
 * a value, a typo is a wrong one, and only the first is safe to erase.
 */
function apiKeyFrom(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth) {
    const bearer = normalizeEnvValue(/^Bearer\s+(.+)$/i.exec(auth.trim())?.[1]);
    if (bearer) return bearer;
  }
  // Node joins repeated headers with ", " for everything except set-cookie —
  // it never hands us an array here, so the Array.isArray branch this replaces
  // was dead and its "take the first" intent never ran. Two X-API-Key headers
  // arrived as the single string "wa_alice, wa_bob", which is wa_-prefixed
  // enough to reach the network, minted its own tenant bundle, and was
  // forwarded verbatim upstream. Splitting restores the intended semantics for
  // the case that actually occurs. (Authorization is different: Node keeps
  // only the first, so duplicates never reach us at all.)
  const headerKey = req.headers["x-api-key"];
  const first = (Array.isArray(headerKey) ? headerKey[0] : headerKey)?.split(",")[0];
  return normalizeEnvValue(first);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** JSON-RPC-shaped error for transport-level failures outside the SDK's reach. */
function sendRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

const CORS_METHODS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, Mcp-Session-Id, MCP-Protocol-Version",
};

/**
 * Which origin may READ the response — the one CORS decision that matters here.
 *
 * `*` is correct on the public multi-tenant endpoint and wrong on a box with
 * defaultApiKey, and the difference is not the origin, it is whether the server
 * has an identity of its own to lend. Publicly, a browser page that calls this
 * endpoint gets the keyless surface, exactly like curl: it must present a key
 * to be anybody, and CORS never hands it one. With defaultApiKey set, a
 * credential-less request IS the configured account — so `*` lets any page the
 * operator happens to visit drive their demo box as that tenant and read the
 * results back. Classic confused deputy: no credential is stolen, the server
 * simply supplies one to a caller who asked for nothing.
 *
 * `Allow-Credentials` is never sent, so cookies were never the vector, and
 * withholding the header costs non-browser clients nothing — curl, the MCP SDK
 * and every real client ignore CORS entirely. What it stops is a WEB PAGE
 * reading the response.
 *
 * An operator who genuinely wants browser access to a single-tenant box names
 * the origins (WA_HTTP_ALLOWED_ORIGINS) instead of getting a blanket `*` by
 * default — opt in, and specific.
 */
function allowedOriginFor(
  origin: string | undefined,
  lendsAmbientIdentity: boolean,
  allowlist: readonly string[],
): string | undefined {
  if (origin && allowlist.includes(origin)) return origin;
  return lendsAmbientIdentity ? undefined : "*";
}

export function createWaHttpServer(options: HttpServerOptions): Server {
  // devTier is stripped for the same reason apiKey is, and it is the more
  // dangerous of the two. WA_DEV_TIER is a local escape hatch that grants a
  // tier outright, and DefaultSubscriptionProvider.resolve consults it BEFORE
  // the `wa_` prefix check and before any network call — so on a hosted box
  // where the operator set it (it is in .env.example), every tenant bundle
  // inherited it and any caller sending `Bearer anything-at-all` resolved to
  // that tier and walked through gateProTool. The upstream API still refuses
  // the bogus key, so no audit data was served, but the client-side gate was
  // fully bypassed and any tool answering locally would leak outright.
  //
  // Single-tenant env values must never become the authority for a per-request
  // tenant. That is the interface contract on `config` above; it named apiKey
  // because apiKey was the only one thought of.
  // Note the asymmetry, so nobody "cleans up" the wrong half: TenantDeps.forKey
  // spreads `{ ...base, apiKey }`, so base.apiKey is ALWAYS overridden by the
  // per-request key and stripping it here changes nothing observable — it is
  // belt-and-braces against a future edit to forKey, and no test can tell it
  // from its absence. devTier has no such override, so its strip is the guard
  // actually holding the boundary, and its removal IS caught.
  const base: WaConfig = { ...options.config, apiKey: undefined, devTier: undefined };
  // Normalized at the consumer for the same reason defaultApiKey is: this
  // factory is a published entry, and the guard one layer up in
  // httpOptionsFromEnv does not travel with it. Unexpanded, the token is
  // truthy, so the well-known route answers 200 with the literal `${...}` and
  // the verifier reports a MISMATCH instead of the 404 naming the real cause.
  const challengeToken = normalizeEnvValue(options.challengeToken);
  // Normalized HERE, not only where main() reads the env, because this factory
  // is a published entry — package.json ships dist/**/*.js with no exports map,
  // and the listen guard below exists precisely so wrappers can import it. A
  // wrapper writing `{ defaultApiKey: env.WA_HTTP_DEFAULT_KEY }` — verbatim the
  // line httpOptionsFromEnv replaced — would otherwise reinstate the bug this
  // PR removes, and no test would catch it, because the guard would live one
  // layer above the only code that consumes the value.
  const defaultApiKey = normalizeEnvValue(options.defaultApiKey);
  // Normalized like every other configured value: an unexpanded template would
  // otherwise become an "allowed origin" no browser will ever send, which fails
  // closed but reads to the operator as a working allowlist.
  const allowedOrigins = (options.allowedOrigins ?? [])
    .map((o) => normalizeEnvValue(o))
    .filter((o): o is string => Boolean(o));
  // Built only when Mixed Auth is configured. An unconfigured server never
  // constructs one, never calls introspection, and cannot be slowed down or
  // broken by an endpoint it does not use.
  const tokenExchange: TokenExchange | undefined = oauthEnabled(base)
    ? (options.tokenExchange ?? new IntrospectionTokenExchange(base))
    : undefined;
  const tenants = new TenantDeps(
    base,
    options.depsFactory ?? defaultDepsFactory,
    options.maxTenants ?? 500,
    options.idleTtlMs ?? 30 * 60 * 1000,
    options.now ?? Date.now,
  );

  return createNodeServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) sendRpcError(res, 500, -32603, "Internal error");
      console.error("[website-auditor-mcp http] request failed:", err);
    });
  });

  /**
   * Which API key this request acts as: its own, the box's default, or none.
   *
   * Three inputs reach the same header now, and they are not interchangeable:
   *
   *   NOTHING PRESENTED  → the box's defaultApiKey (single-tenant demo boxes)
   *                        or the keyless surface. Unchanged, and it still
   *                        counts an unexpanded placeholder as nothing.
   *   A `wa_` BEARER     → itself, verbatim. Every existing caller — curl,
   *                        Codex's bearer_token_env_var, the README examples —
   *                        is on this path and must stay byte-identical.
   *   ANYTHING ELSE      → an OAuth access token, exchanged for the account's
   *                        key, but ONLY when Mixed Auth is configured.
   *
   * That last guard is the whole reason this is a function rather than a `??`.
   * With OAuth off, a non-`wa_` bearer keeps passing through VERBATIM, because
   * on this endpoint the bearer has always been the key and a typo in one has
   * to reach the malformed-key answer that names the `wa_` prefix — recoding it
   * as "you configured nothing" strands the reader a step earlier than the
   * truth. That behaviour is pinned by a test and predates OAuth entirely.
   *
   * With OAuth ON the same string is ambiguous — an expired token and a typo'd
   * key are indistinguishable here — and the two possible answers cannot both
   * be right. It resolves to "not authenticated", which carries the login
   * challenge, rather than to the malformed-key sentence. On a Mixed Auth
   * endpoint the overwhelming majority of callers never paste a key at all, and
   * "connect an account" is at worst imprecise for the curl user while
   * "Invalid API key format. Keys start with wa_." is actively wrong for the
   * OAuth one — the direction that misleads fewer people, stated because it IS
   * a trade rather than an oversight.
   */
  async function credentialFor(
    req: IncomingMessage,
  ): Promise<{ key: string | undefined; authVia: ToolDeps["authVia"] }> {
    const presented = apiKeyFrom(req);
    // Presented nothing: the default identity applies, exactly as before. A
    // caller who DID present something never lands on the box's account.
    // A configured default is a KEY, not a connection — nobody logged in to
    // produce it, so its failures must read as key failures.
    if (presented === undefined) {
      return { key: defaultApiKey, authVia: defaultApiKey ? "key" : undefined };
    }
    if (!tokenExchange || looksLikeApiKey(presented)) {
      return { key: presented, authVia: "key" };
    }
    const resolved = await tokenExchange.resolve(presented);
    // Unresolvable is not "authenticated via OAuth" — it is nobody, and the
    // keyless surface's own copy is the right answer.
    return { key: resolved, authVia: resolved ? "oauth" : undefined };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (HEALTH_PATHS.has(url.pathname) && req.method === "GET") {
      sendJson(res, 200, { ok: true, version: SERVER_VERSION });
      return;
    }

    if (url.pathname === CHALLENGE_PATH && req.method === "GET") {
      if (!challengeToken) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("no challenge configured");
        return;
      }
      // The token, exactly and alone: the verifier rejects JSON wrappers.
      res.writeHead(200, { "Content-Type": "text/plain" }).end(challengeToken);
      return;
    }

    if (url.pathname === PROTECTED_RESOURCE_PATH && req.method === "GET") {
      const metadata = protectedResourceMetadata(base);
      if (!metadata) {
        // A 404 is the honest answer for a server with no OAuth configured, and
        // it is what a host's discovery probe expects — serving an empty or
        // half-filled document instead would advertise an authorization server
        // that does not exist and fail later, further from the cause.
        res.writeHead(404, { "Content-Type": "text/plain" }).end("no oauth configured");
        return;
      }
      // Readable cross-origin unconditionally: it is public discovery metadata
      // naming no secret, and a host that cannot read it cannot start a login.
      res.setHeader("Access-Control-Allow-Origin", "*");
      sendJson(res, 200, metadata);
      return;
    }

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }

    for (const [name, value] of Object.entries(CORS_METHODS_HEADERS)) res.setHeader(name, value);
    const allowOrigin = allowedOriginFor(req.headers.origin, Boolean(defaultApiKey), allowedOrigins);
    if (allowOrigin) res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    // Vary whenever the answer could depend on the request's Origin, so a
    // shared cache cannot serve one origin's allowance to another.
    if (allowedOrigins.length) res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "POST") {
      // Stateless: no SSE stream to GET, no session to DELETE.
      res.setHeader("Allow", "POST, OPTIONS");
      sendRpcError(res, 405, -32000, "Method not allowed — POST JSON-RPC to this endpoint");
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(await readBody(req));
    } catch {
      sendRpcError(res, 400, -32700, "Parse error");
      return;
    }

    const { key, authVia } = await credentialFor(req);
    // Spread, not mutate: the bundle is CACHED and shared across every request
    // for this key, while authVia describes THIS request. The copy is shallow
    // on purpose — client, caches and sink stay the same objects, which is the
    // whole reason the bundle is reused.
    const deps: ToolDeps = { ...tenants.forKey(key), authVia };
    // Fresh server+transport per request over long-lived tenant deps: the
    // stateless Streamable HTTP pattern. Closed with the response so an
    // abandoned connection cannot leak either.
    const server = createServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  }
}

/**
 * The env → options mapping, separated from main() so it can be tested.
 *
 * main() is unreachable from a test: it is gated behind the import.meta/argv
 * guard below, so a test can only RECONSTRUCT this mapping — and a test that
 * reconstructs the thing it is checking proves nothing about the wiring. The
 * first WA_HTTP_DEFAULT_KEY test did exactly that (it called normalizeEnvValue
 * itself and passed the result in) and stayed green when the unnormalized line
 * it existed to protect was put back. Takes `env` for the same reason
 * loadConfig does.
 */
export function httpOptionsFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): HttpServerOptions {
  return {
    // apiKey and devTier stripped HERE as well as in createWaHttpServer,
    // because this is now exported: the interface's own contract is that a
    // stray WA_API_KEY "must never become the fallback identity for
    // unauthenticated callers", and a wrapper reading
    // `httpOptionsFromEnv().config` to build its own deps — or simply logging
    // the options on boot — would otherwise be handed the operator's live key.
    // devTier grants a tier outright and is checked before the key is even
    // looked at; see the factory for why that is the worse of the two.
    config: { ...loadConfig(env), apiKey: undefined, devTier: undefined },
    // Every value below takes normalizeEnvValue. The challenge token is not a
    // credential, but it has the identical failure: unexpanded, it is truthy,
    // so the well-known route answers 200 with the literal `${...}` and
    // OpenAI's verifier reports a token MISMATCH — sending the operator to hunt
    // a wrong value instead of the 404 that says "no challenge configured".
    challengeToken: normalizeEnvValue(env.WA_APPS_CHALLENGE_TOKEN),
    // The one that matters most: this is the identity for callers who presented
    // NOTHING, so an unexpanded placeholder in a compose file or Cloud Run
    // template does not mis-serve one request — it makes every anonymous caller
    // on the box land on "Invalid API key format" instead of get_sample_audit,
    // which is the first thing a marketplace reviewer sees.
    defaultApiKey: normalizeEnvValue(env.WA_HTTP_DEFAULT_KEY),
    allowedOrigins: normalizeEnvValue(env.WA_HTTP_ALLOWED_ORIGINS)
      ?.split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  };
}

/**
 * Listening port, with the same env-is-testable treatment as the options.
 *
 * WA_HTTP_PORT wins, then Cloud Run's injected PORT, then 8787 — the chain the
 * Dockerfile promises. Blank at either level means "not set" and falls through
 * rather than poisoning the result, which the previous `??` chain could not
 * express; anything present but not a real port stops the process with the
 * value quoted. See parsePort for why each of those is a boot failure someone
 * would otherwise have to diagnose from a silent 502.
 *
 * The chain PICKS first and validates second, which is not a style choice. The
 * previous shape — `parsePort(WA_HTTP_PORT, parsePort(PORT, 8787))` — read like
 * the chain above but could not behave like it: JS evaluates arguments eagerly,
 * so the inner call ran even when WA_HTTP_PORT was a perfectly good port, and a
 * junk PORT threw from a branch nothing was going to use. WA_HTTP_PORT=9001
 * with PORT=havoc (or an un-interpolated `${PORT}`, or Docker's link-style
 * `tcp://10.0.0.5:8080`) killed the process at boot. That is worse than what it
 * replaced: the operator who set WA_HTTP_PORT *specifically to escape a bad
 * PORT* is the one it strands.
 */
export function portFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): number {
  const explicit = env.WA_HTTP_PORT?.trim();
  return explicit
    ? parsePort(explicit, 8787, "WA_HTTP_PORT")
    : parsePort(env.PORT, 8787, "PORT");
}

/**
 * What Mixed Auth is doing, for the boot log.
 *
 * The secret is reported by LENGTH, never by value: it is a shared HMAC key and
 * the log is not the place for it, but a length is enough to catch the mismatch
 * that actually happened — a 23-character local value against a 44-character
 * one on the server — without printing anything worth stealing.
 */
export function mixedAuthSummary(config: WaConfig): string {
  if (!oauthEnabled(config)) {
    return "Mixed Auth OFF — set WA_OAUTH_ISSUER and WA_OAUTH_RESOURCE_URL (both absolute http(s) URLs) to enable it";
  }
  const secret = config.oauthIntrospectionSecret;
  return (
    `Mixed Auth ON — issuer ${config.oauthIssuer}, resource ${config.oauthResourceUrl}, ` +
    `introspection ${config.oauthIntrospectionUrl} ` +
    (secret
      ? `(secret set, ${secret.length} chars — it must match the API's byte for byte)`
      : "(WA_OAUTH_INTROSPECTION_SECRET MISSING — every login will fail at introspection)")
  );
}

async function main(): Promise<void> {
  const options = httpOptionsFromEnv(process.env);
  const port = portFromEnv(process.env);
  const server = createWaHttpServer(options);
  server.listen(port, () => {
    console.error(
      `[website-auditor-mcp] http ready on :${port} — POST ${MCP_PATH}, API ${options.config.apiBaseUrl}, upsell style ${options.config.upsellStyle}`,
    );
    // Mixed Auth fails SILENTLY in both directions — an unconfigured server
    // serves a 404 at the metadata path and publishes no scheme, which is
    // indistinguishable on the wire from an older image that never had the
    // route, and a configured one with the wrong introspection secret looks
    // perfect until a real user tries to log in. Neither shows up anywhere in
    // the logs, so a deploy that shipped the wrong thing had to be diagnosed
    // from the shape of a 404 body. One line at boot answers it instead.
    console.error(`[website-auditor-mcp] ${mixedAuthSummary(options.config)}`);
  });
}

// Listen only when executed directly — importing the factory (tests, future
// serverless wrappers) must not bind a port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[website-auditor-mcp] fatal:", err);
    process.exit(1);
  });
}
