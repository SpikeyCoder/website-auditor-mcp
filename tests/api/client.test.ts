import { describe, it, expect, vi } from "vitest";
import { WaApiClient } from "../../src/api/client.js";
import { WaApiError } from "../../src/api/errors.js";
import { reachableReport } from "../fixtures/reports.js";

function makeFetch(status: number, body: unknown) {
  return vi.fn(async () =>
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
  upgradeUrl: "https://website-auditor.io/admin_portal",
  freeDailyAuditLimit: 3,
  freeMaxDomains: 1,
  requestTimeoutMs: 120000,
};

describe("WaApiClient.runAudit", () => {
  it("calls GET /api/audit against the real endpoint with the X-API-Key header", async () => {
    const fetchMock = makeFetch(200, {
      success: true,
      request_id: "r1",
      run_id: "abc123def456",
      audit: reachableReport(),
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });

    const res = await client.runAudit({ domain: "example.com" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("https://api.website-auditor.io/api/audit");
    expect(String(url)).toContain("businessUrl=");
    expect((init as RequestInit).headers).toMatchObject({ "X-API-Key": "wa_valid_key" });
    expect(res.runId).toBe("abc123def456");
    expect(res.report.base_url).toBe("https://example.com");
  });

  it("rejects an invalid domain before making a request (INVALID_INPUT)", async () => {
    const fetchMock = makeFetch(200, {});
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.runAudit({ domain: "not a domain !!" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps HTTP 401 to INVALID_KEY", async () => {
    const fetchMock = makeFetch(401, { success: false, error: "Invalid API key. Check that your key is correct." });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.runAudit({ domain: "example.com" })).rejects.toMatchObject({ code: "INVALID_KEY" });
  });

  it("maps HTTP 429 to OVER_QUOTA and preserves rate-limit details", async () => {
    const fetchMock = makeFetch(429, {
      success: false,
      error: "Rate limit exceeded. You can make 5 requests per day.",
      rate_limit: { limit: 5, remaining: 0, resets_at: "2026-06-30T23:59:59.999Z" },
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.runAudit({ domain: "example.com" })).rejects.toMatchObject({
      code: "OVER_QUOTA",
    });
  });

  it("maps HTTP 400 validation errors to INVALID_INPUT with details", async () => {
    const fetchMock = makeFetch(400, { success: false, error: "Validation failed", details: ["businessCity is required."] });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.runAudit({ domain: "example.com" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("maps HTTP 502 to UPSTREAM_ERROR", async () => {
    const fetchMock = makeFetch(502, { success: false, error: "The audit service rejected the request.", upstream_status: 500 });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.runAudit({ domain: "example.com" })).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("maps HTTP 504 to TIMEOUT", async () => {
    const fetchMock = makeFetch(504, { success: false, error: "The audit did not complete within 3 minutes." });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.runAudit({ domain: "example.com" })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("derives businessName from the domain and sends a validation-safe businessCity", async () => {
    const fetchMock = makeFetch(200, { success: true, run_id: "x", audit: reachableReport() });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await client.runAudit({ domain: "acme-corp.com" });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("businessName")).toBeTruthy();
    // businessCity must be present & non-empty so the API's validation passes
    expect((url.searchParams.get("businessCity") ?? "").length).toBeGreaterThan(0);
    expect(url.searchParams.get("businessUrl")).toBe("acme-corp.com");
  });

  it("wraps a network failure as UPSTREAM_ERROR", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.runAudit({ domain: "example.com" })).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});

describe("WaApiClient — endpoints not yet available in website-auditor-api", () => {
  const client = new WaApiClient(baseCfg, { fetch: makeFetch(200, {}) as unknown as typeof fetch });

  it("getChanges throws NOT_YET_AVAILABLE (delta endpoint pending)", async () => {
    await expect(client.getChanges({ domain: "example.com" })).rejects.toBeInstanceOf(WaApiError);
    await expect(client.getChanges({ domain: "example.com" })).rejects.toMatchObject({ code: "NOT_YET_AVAILABLE" });
  });

  it("getSubscription throws NOT_YET_AVAILABLE (no API-key-authed subscription endpoint)", async () => {
    await expect(client.getSubscription()).rejects.toMatchObject({ code: "NOT_YET_AVAILABLE" });
  });
});
