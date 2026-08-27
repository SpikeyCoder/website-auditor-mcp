/**
 * Mixed Auth for the hosted transport: the two halves ChatGPT needs, in one place.
 *
 * The OpenAI Apps SDK will not show its account-linking UI unless BOTH of these
 * are present, and each is useless alone:
 *
 *   1. DECLARATIVE — `securitySchemes` on every tool (which ones need OAuth and
 *      for what scope), plus an RFC 9728 protected-resource metadata document
 *      naming the authorization server.
 *   2. RUNTIME — the error a protected tool returns when the caller has no
 *      usable token must carry `_meta["mcp/www_authenticate"]`, a challenge
 *      pointing back at that metadata document.
 *
 * A server with only (1) advertises a login the host never offers; with only
 * (2) it emits a challenge for an authorization server the host cannot
 * discover. Both failures are silent — the tool simply answers "not
 * authenticated" forever — which is why they live together in this file rather
 * than beside the code that happens to emit each one.
 *
 * ALL OF IT IS OFF BY DEFAULT. Mixed Auth requires both an issuer and a
 * resource identifier to be configured; absent either, `oauthEnabled` is false,
 * no metadata route is served, no scheme is published, no challenge is
 * attached, and the server behaves exactly as it did before this module
 * existed. That is what keeps every stdio install and every existing
 * `Authorization: Bearer wa_…` caller byte-identical — see looksLikeApiKey.
 */
import type { WaConfig } from "../config.js";
import { API_KEY_PREFIX } from "./entitlements.js";
import type { ToolTier } from "../tools/registry.js";

/**
 * Where the metadata document is served. RFC 9728 defines both a root and a
 * path-inserted form; hosts probe the root first and it is the only one the
 * Apps SDK documents, so this server publishes exactly one location rather
 * than two that could disagree.
 */
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/**
 * Mixed Auth is configured. Both halves are required by RFC 9728 — a document
 * without `resource` or without `authorization_servers` cannot complete
 * discovery — so a half-set pair is treated as unset rather than published as
 * a document that fails at the client.
 */
export function oauthEnabled(config: WaConfig): config is WaConfig & {
  oauthIssuer: string;
  oauthResourceUrl: string;
} {
  if (!config.oauthIssuer || !config.oauthResourceUrl) return false;
  // PARSEABLE, not merely present. A truthy-only test turned Mixed Auth fully
  // on for a resource URL that is not a URL — serving a 200 metadata document
  // with an invalid `resource`, and challenges whose resource_metadata was the
  // bare relative path, which no client can resolve. That is the one-sided
  // configuration this file's header calls silent: the host sees an offer it
  // can never complete. Nothing validates these at boot, so it is checked here.
  return isAbsoluteUrl(config.oauthIssuer) && isAbsoluteUrl(config.oauthResourceUrl);
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * The absolute URL of this server's metadata document, derived from the
 * resource identifier's ORIGIN.
 *
 * Derived rather than separately configured because the two cannot legally
 * disagree: the document describes the resource, and a client that found the
 * resource at one origin will look for its metadata at that same origin. Making
 * it a third env var would only create a way to get it wrong.
 */
export function protectedResourceMetadataUrl(resourceUrl: string): string {
  try {
    return new URL(PROTECTED_RESOURCE_PATH, new URL(resourceUrl).origin).toString();
  } catch {
    // A resource URL that will not parse is a boot-time misconfiguration, but
    // this function is on the request path — returning the bare path keeps the
    // challenge well-formed and relative rather than throwing inside a mapper.
    return PROTECTED_RESOURCE_PATH;
  }
}

/** The RFC 9728 protected-resource metadata document, served verbatim as JSON. */
export function protectedResourceMetadata(config: WaConfig): Record<string, unknown> | undefined {
  if (!oauthEnabled(config)) return undefined;
  return {
    resource: config.oauthResourceUrl,
    authorization_servers: [config.oauthIssuer],
    scopes_supported: [config.oauthScope],
    // Header only. This server reads the token from `Authorization` (see
    // apiKeyFrom in http.ts); it has never accepted a token in a query string
    // or form body, and advertising either would invite a caller to put a
    // credential somewhere it gets logged.
    bearer_methods_supported: ["header"],
  };
}

/**
 * The `WWW-Authenticate` challenge carried on an unauthenticated tool error.
 *
 * `resource_metadata` is the load-bearing parameter — it is how the host
 * discovers which authorization server to send the user to. `error` and
 * `error_description` accompany it because the Apps SDK requires both before it
 * will render the linking UI.
 *
 * `invalid_token` is used for a MISSING token as well as a rejected one, which
 * is a deliberate deviation from RFC 6750 (where a request bearing no
 * credential should get a bare challenge with no `error`). Hosts treat
 * `invalid_token` as "this user needs to (re)authorize" and treat the bare form
 * as "this resource is open", so the strictly-correct challenge is the one that
 * never opens the login. Noted because it looks like a bug to anyone reading
 * the RFC alongside it.
 */
export function wwwAuthenticateChallenge(config: WaConfig, description: string): string | undefined {
  if (!oauthEnabled(config)) return undefined;
  const metadataUrl = protectedResourceMetadataUrl(config.oauthResourceUrl);
  // Quotes in the description would terminate the quoted-string early and
  // corrupt every parameter after it, so they are folded to apostrophes rather
  // than escaped — the challenge is read by parsers, not people.
  const params = [
    `resource_metadata="${metadataUrl}"`,
    `scope="${config.oauthScope}"`,
    `error="invalid_token"`,
    `error_description="${description.replace(/"/g, "'")}"`,
  ];
  return `Bearer ${params.join(", ")}`;
}

/**
 * A tool's declared authentication policy, as the Apps SDK reads it.
 *
 * Derived from the registry's existing `tier` rather than a parallel list. The
 * free/pro split is already the source of truth for gating (gateProTool),
 * for the published `server.json` `_meta`, and for the listing copy — a second
 * list of "which tools need OAuth" would be one more surface to drift, and the
 * drift would be invisible until a reviewer found a tool that gates at runtime
 * but advertises itself as open.
 */
export function securitySchemesFor(
  tier: ToolTier,
  config: WaConfig,
  transport?: "stdio" | "http",
): unknown[] | undefined {
  // Transport-gated for the same reason the runtime challenge is, and it was a
  // real gap that only this half was not: a stdio process that happens to have
  // the OAuth variables set advertised `oauth2` on thirteen tools while being
  // structurally unable to ever emit a challenge — a client offered a login
  // that cannot exist. Half a Mixed Auth setup fails silently, so both halves
  // answer to the same condition.
  if (transport !== "http" || !oauthEnabled(config)) return undefined;
  return tier === "pro"
    ? [{ type: "oauth2", scopes: [config.oauthScope] }]
    : [{ type: "noauth" }];
}

/**
 * Is this bearer our own API key, or an OAuth access token?
 *
 * The hosted endpoint has always treated `Authorization: Bearer` as the
 * Website Auditor key itself, and real callers depend on that — Codex's
 * `bearer_token_env_var`, every curl example in the README, and the
 * keySetupNote this package prints on every auth error. Mixed Auth introduces a
 * SECOND kind of bearer at the same header, so the two have to be told apart
 * without breaking the first.
 *
 * The `wa_` prefix does it, and does it reliably in the direction that matters:
 * the API mints every key with that prefix and rejects anything else before it
 * looks the value up (see entitlements.ts), while an OAuth access token is
 * issued by the authorization server and has no reason to carry it. A token
 * that somehow did would be indistinguishable — accepted as a key, then
 * rejected upstream as an unknown one, which is the same answer it would have
 * got from introspection.
 */
export function looksLikeApiKey(bearer: string): boolean {
  return bearer.startsWith(API_KEY_PREFIX);
}
