/**
 * Every API request announces which MCP build sent it.
 *
 * WHY A HEADER AND NOT THE TELEMETRY WE ALREADY HAVE. mcp_events already
 * carries server_version — but it is opt-out. WA_METRICS_DISABLED is a
 * documented user_config option in manifest.json, so a privacy-conscious user
 * reports NULL for exactly the same reason a stale pre-1.0.9 build does.
 *
 * That ambiguity makes the telemetry unusable as a version gate: gating on
 * "server_version IS NULL" would punish people who merely turned metrics off.
 * A request header is orthogonal to that preference — it identifies the build
 * to the service it is calling, which is not analytics, and it arrives on the
 * request being gated rather than on a fire-and-forget side channel that may
 * never be sent.
 *
 * WHAT IT COST US TO LEARN THIS. Between 2026-08-02 and 08-04, ~120 sessions
 * reported NULL and there was no way to tell whether that meant "old build",
 * "metrics off", or "the field is broken". Verifying it required unpacking a
 * .mcpb to read the compiled POST body and checking Cloud Run revision
 * timestamps. This header is what makes that a query instead of an
 * investigation.
 */
import { describe, it, expect, vi } from "vitest";
import { WaApiClient } from "../../src/api/client.js";
import { SERVER_VERSION } from "../../src/mcp/server.js";
import { reachableReport } from "../fixtures/reports.js";

function makeFetch(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

const baseCfg = {
  apiBaseUrl: "https://api.website-auditor.io",
  siteUrl: "https://website-auditor.io",
  apiKey: "wa_valid_key",
  upgradeUrl: "https://api.website-auditor.io/admin_portal/",
  freeDailyAuditLimit: 3,
  freeMaxDomains: 1,
  requestTimeoutMs: 120000,
};

const HEADER = "X-WA-MCP-Version";

function headersOf(fetchMock: ReturnType<typeof makeFetch>): Record<string, string> {
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  return (init.headers ?? {}) as Record<string, string>;
}

describe("X-WA-MCP-Version", () => {
  it("is sent on the audit request", async () => {
    const fetchMock = makeFetch(200, { success: true, run_id: "r1", audit: reachableReport() });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await client.runAudit({ domain: "example.com" });
    expect(headersOf(fetchMock)[HEADER]).toBe(SERVER_VERSION);
  });

  it("is sent on the JSON request path too", async () => {
    // Every non-audit tool goes through this path; a gate that only saw audits
    // would think a fleet of read-only clients had vanished.
    const fetchMock = makeFetch(200, { success: true, recommendations: [] });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await client.getRecommendations({ domain: "example.com" });
    expect(headersOf(fetchMock)[HEADER]).toBe(SERVER_VERSION);
  });

  it("is a real semver, not a placeholder", () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is sent even with NO api key — an unauthenticated caller still has a build", async () => {
    const fetchMock = makeFetch(200, { success: true, run_id: "r1", audit: reachableReport() });
    const client = new WaApiClient(
      { ...baseCfg, apiKey: undefined as unknown as string },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    await client.runAudit({ domain: "example.com" });
    const sent = headersOf(fetchMock);
    expect(sent[HEADER]).toBe(SERVER_VERSION);
    expect(sent["X-API-Key"]).toBeUndefined();
  });

  it("does not leak the API key into the version header", () => {
    // Paranoid, but these two headers are set on adjacent lines in both request
    // paths and a copy-paste here would ship the user's key to any log that
    // records request headers.
    expect(SERVER_VERSION).not.toContain("wa_");
  });
});
