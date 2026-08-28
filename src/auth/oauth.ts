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
 * The well-known segment of the metadata URL — not, by itself, where the
 * document is served.
 *
 * This used to say: "hosts probe the root first and it is the only one the Apps
 * SDK documents, so this server publishes exactly one location rather than two
 * that could disagree." Cloud Run logs of a real ChatGPT scan say otherwise. It
 * requests the PATH-INSERTED form first, takes the 404 we answered with, and
 * only then falls back to the root:
 *
 *     GET /.well-known/oauth-protected-resource/mcp   404   ← first
 *     GET /mcp/.well-known/oauth-protected-resource   404
 *     GET /.well-known/oauth-protected-resource       200   ← fallback
 *
 * RFC 9728 §3.1 agrees with the client, not with the old comment: when the
 * resource identifier carries a path, the metadata URL is formed by inserting
 * this segment BETWEEN the host and that path. The discovery only worked
 * because ChatGPT guesses further than the spec requires; a client that builds
 * the URL correctly and stops there never finds the authorization server, and
 * the failure is indistinguishable from OAuth being switched off.
 *
 * See resourceMetadataPaths() for the locations actually served, and
 * protectedResourceMetadataUrl() for the one advertised in a challenge.
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
 * The metadata document's path for a given resource identifier, per RFC 9728
 * §3.1: the well-known segment inserted between the host and the resource's
 * own path, with any terminating slash removed first.
 *
 * Null when the resource identifier will not parse — a boot-time
 * misconfiguration, but this runs on the request path, so callers degrade
 * rather than throwing from inside a mapper.
 *
 * A path-less resource is not a special case: the rule simply has nothing to
 * insert before, and produces the root form.
 */
function resourceMetadataPath(resourceUrl: string): string | null {
  let path: string;
  try {
    path = new URL(resourceUrl).pathname;
  } catch {
    return null;
  }
  // "any terminating / MUST be removed before inserting" — otherwise the same
  // resource spelled two ways yields two metadata URLs, only one of them served.
  const trimmed = path.replace(/\/+$/, "");
  return `${PROTECTED_RESOURCE_PATH}${trimmed}`;
}

/**
 * Every path this server answers the metadata document on, most-correct first.
 *
 * TWO, deliberately. The path-inserted form is what RFC 9728 specifies and what
 * clients build; the root form is what this server has always served and what
 * ChatGPT currently reaches by falling back. Dropping the root to fix the spec
 * URL would trade a regression for a fix — anything that already discovered the
 * document there would break.
 *
 * The old comment worried about "two locations that could disagree". They
 * cannot: both routes answer from one protectedResourceMetadata() call, so
 * there is one document served twice, not two documents. A test asserts the
 * bodies are byte-identical.
 *
 * Deduplicated. For a path-less resource the two forms ARE the same string, and
 * a function whose contract is "every path this is served on" must not name one
 * twice — a caller counting entries, listing them, or registering them as
 * routes would be misled. It changes nothing for the current caller, which only
 * asks whether a path is a member, so the dedupe is pinned by its own test
 * rather than left to be discovered as incidental.
 *
 * Answers the root form for an unset or unparseable resource too. OAuth is off
 * in that case and the handler replies `no oauth configured` — but it has to be
 * REACHED to say so. Falling through to the generic `not found` instead would
 * lose the distinction between "this server has no OAuth" and "this build
 * predates the OAuth code", which is the whole diagnosis when discovery 404s.
 */
export function resourceMetadataPaths(resourceUrl: string | undefined): string[] {
  const specPath = resourceUrl === undefined ? null : resourceMetadataPath(resourceUrl);
  if (specPath === null) return [PROTECTED_RESOURCE_PATH];
  return specPath === PROTECTED_RESOURCE_PATH ? [specPath] : [specPath, PROTECTED_RESOURCE_PATH];
}

/**
 * The absolute URL a `WWW-Authenticate` challenge points a client at.
 *
 * The spec form, because this parameter is the only thing telling a client
 * where to look — serving the correct URL while advertising the other one would
 * leave the fix inert for every client that trusts the challenge.
 *
 * Derived rather than separately configured because the two cannot legally
 * disagree: the document describes the resource, so its location follows from
 * the resource identifier. Making it a third env var would only create a way to
 * get it wrong.
 */
export function protectedResourceMetadataUrl(resourceUrl: string): string {
  const path = resourceMetadataPath(resourceUrl);
  // Unparseable: return the bare path so the challenge stays well-formed and
  // relative rather than carrying a broken absolute URL.
  if (path === null) return PROTECTED_RESOURCE_PATH;
  return new URL(path, new URL(resourceUrl).origin).toString();
}

/** The RFC 9728 protected-resource metadata document, served verbatim as JSON. */
export function protectedResourceMetadata(config: WaConfig): Record<string, unknown> | undefined {
  if (!oauthEnabled(config)) return undefined;
  return {
    resource: config.oauthResourceUrl,
    authorization_servers: [config.oauthIssuer],
    // Every scope the authorization requests for this resource use, not just
    // the one a tool needs. It published `["audit"]` alone, which under-declares
    // the resource: ChatGPT reads this document to learn what it may ask for, so
    // omitting the identity scopes is one of the ways a connector ends up unable
    // to offer enterprise domain restrictions. See oauthScopes in config.ts.
    scopes_supported: config.oauthScopes,
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
    // Every scope the grant has to cover, not just the audit capability. RFC
    // 6750 §3 defines this as "the scope of access required", so a conforming
    // client requests exactly what is named here — and naming `audit` alone
    // meant nothing ever asked for the identity scopes the connector needs.
    // Defaults to the audit scope, so an unconfigured server is unchanged.
    `scope="${config.oauthScopes.join(" ")}"`,
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
    // config.oauthScopes, for the same reason as the challenge above: this is
    // read during a tool scan to decide what the connector will ask for, and a
    // tool needing only `audit` to RUN does not make `audit` the whole of what
    // the one connector-wide grant must cover.
    ? [{ type: "oauth2", scopes: config.oauthScopes }]
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
