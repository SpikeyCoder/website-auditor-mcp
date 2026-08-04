/**
 * The MCP server's own build version, in one place.
 *
 * Lives here rather than in mcp/server.ts so that api/client.ts can stamp it
 * on every outbound request without importing the server module — server.ts
 * pulls in all 18 tool modules, and those reach back to the client, so that
 * import would close a cycle. mcp/server.ts re-exports this, so every existing
 * `import { SERVER_VERSION } from "../mcp/server.js"` keeps working.
 *
 * MUST stay in lockstep with package.json, package-lock.json, manifest.json
 * and server.json — tests/manifests.test.ts pins all six together, after a
 * bump once left the manifests behind at 1.0.7 while the code said otherwise.
 */
export const SERVER_VERSION = "1.0.11";

/** Header announcing which MCP build issued a request. */
export const VERSION_HEADER = "X-WA-MCP-Version";

/**
 * The version header, for spreading into a request's headers.
 *
 * Deliberately NOT gated on telemetry. mcp_events already carries
 * server_version, but WA_METRICS_DISABLED is a documented user_config option,
 * so a privacy-conscious user is indistinguishable there from a stale build —
 * which makes the telemetry useless for deciding whether a client is too old
 * to serve. This header identifies the build to the service it is calling, on
 * the request being served, and is unaffected by that preference.
 */
export function versionHeader(): Record<string, string> {
  return { [VERSION_HEADER]: SERVER_VERSION };
}
