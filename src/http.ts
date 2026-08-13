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
import { loadConfig, normalizeApiKey, type WaConfig } from "./config.js";
import { WaApiClient } from "./api/client.js";
import { DefaultSubscriptionProvider } from "./auth/entitlements.js";
import { InMemoryAuditCache } from "./auth/auditCache.js";
import { HttpEventSink } from "./telemetry/httpSink.js";
import { NoopEventSink } from "./telemetry/events.js";
import { createServer } from "./mcp/server.js";
import { SERVER_VERSION } from "./version.js";
import type { ToolDeps } from "./tools/context.js";

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
   */
  defaultApiKey?: string;
  /** Test seam. Production builds real deps; tests inject recorders/mocks. */
  depsFactory?: (config: WaConfig) => ToolDeps;
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

/** Per-key ToolDeps bundles with idle-TTL + size-bound eviction. */
class TenantDeps {
  private readonly bundles = new Map<string, { deps: ToolDeps; lastUsedAt: number }>();

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
      return existing.deps;
    }
    const deps = this.factory({ ...this.base, apiKey });
    this.bundles.set(mapKey, { deps, lastUsedAt: at });
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
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [key, entry] of this.bundles) {
        if (entry.lastUsedAt < oldestAt) {
          oldestAt = entry.lastUsedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      this.bundles.delete(oldestKey);
    }
  }
}

/**
 * Bearer first (what Codex's `bearer_token_env_var` and the MCP auth spec
 * send), then X-API-Key (what the wrapped API itself uses, so curl habits
 * carry over). Anything else is treated as unauthenticated, not an error —
 * the keyless surface is a feature, not a fallback.
 *
 * Both sources go through normalizeApiKey, the same function loadConfig uses,
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
    const bearer = normalizeApiKey(/^Bearer\s+(.+)$/i.exec(auth.trim())?.[1]);
    if (bearer) return bearer;
  }
  const headerKey = req.headers["x-api-key"];
  return normalizeApiKey(Array.isArray(headerKey) ? headerKey[0] : headerKey);
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

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, Mcp-Session-Id, MCP-Protocol-Version",
};

export function createWaHttpServer(options: HttpServerOptions): Server {
  const base: WaConfig = { ...options.config, apiKey: undefined };
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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (HEALTH_PATHS.has(url.pathname) && req.method === "GET") {
      sendJson(res, 200, { ok: true, version: SERVER_VERSION });
      return;
    }

    if (url.pathname === CHALLENGE_PATH && req.method === "GET") {
      if (!options.challengeToken) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("no challenge configured");
        return;
      }
      // The token, exactly and alone: the verifier rejects JSON wrappers.
      res.writeHead(200, { "Content-Type": "text/plain" }).end(options.challengeToken);
      return;
    }

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }

    for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);

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

    const deps = tenants.forKey(apiKeyFrom(req) ?? options.defaultApiKey);
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

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const port = Number.parseInt(process.env.WA_HTTP_PORT ?? process.env.PORT ?? "8787", 10);
  const server = createWaHttpServer({
    config,
    challengeToken: process.env.WA_APPS_CHALLENGE_TOKEN?.trim() || undefined,
    // normalizeApiKey, for the same reason apiKeyFrom uses it — and this one
    // matters more. It is the identity for callers who presented NOTHING, so
    // an unexpanded placeholder in a compose file or Cloud Run template does
    // not mis-serve one request: it makes every anonymous caller on the box
    // land on "Invalid API key format" instead of get_sample_audit, which is
    // the first thing a marketplace reviewer sees.
    defaultApiKey: normalizeApiKey(process.env.WA_HTTP_DEFAULT_KEY),
  });
  server.listen(port, () => {
    console.error(
      `[website-auditor-mcp] http ready on :${port} — POST ${MCP_PATH}, API ${config.apiBaseUrl}, upsell style ${config.upsellStyle}`,
    );
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
