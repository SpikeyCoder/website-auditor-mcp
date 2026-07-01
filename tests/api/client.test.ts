import { describe, it, expect, vi } from "vitest";
import { WaApiClient } from "../../src/api/client.js";
import { WaApiError } from "../../src/api/errors.js";
import { reachableReport } from "../fixtures/reports.js";

function makeFetch(status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...extraHeaders },
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

describe("WaApiClient.runAudit — rate-limit headers", () => {
  it("parses X-RateLimit-* headers into rateLimit on a successful audit", async () => {
    const fetchMock = makeFetch(
      200,
      { success: true, run_id: "abc123def456", audit: reachableReport() },
      {
        "X-RateLimit-Limit": "5",
        "X-RateLimit-Remaining": "3",
        "X-RateLimit-Reset": "2026-06-30T23:59:59.999Z",
      },
    );
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const res = await client.runAudit({ domain: "example.com" });
    expect(res.rateLimit).toEqual({ limit: 5, remaining: 3, reset: "2026-06-30T23:59:59.999Z" });
  });

  it("leaves rateLimit undefined when the API sends no rate-limit headers", async () => {
    const fetchMock = makeFetch(200, { success: true, run_id: "x", audit: reachableReport() });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const res = await client.runAudit({ domain: "example.com" });
    expect(res.rateLimit).toBeUndefined();
  });
});

describe("WaApiClient.getRemainingQuota", () => {
  it("returns null because /api/subscription carries no audit-quota block (quota is learned from runAudit headers)", async () => {
    const client = new WaApiClient(baseCfg, { fetch: makeFetch(200, {}) as unknown as typeof fetch });
    await expect(client.getRemainingQuota()).resolves.toBeNull();
  });
});

describe("WaApiClient — endpoints not yet available in website-auditor-api", () => {
  const client = new WaApiClient(baseCfg, { fetch: makeFetch(200, {}) as unknown as typeof fetch });

  it("getChanges throws NOT_YET_AVAILABLE (delta endpoint pending)", async () => {
    await expect(client.getChanges({ domain: "example.com" })).rejects.toBeInstanceOf(WaApiError);
    await expect(client.getChanges({ domain: "example.com" })).rejects.toMatchObject({ code: "NOT_YET_AVAILABLE" });
  });
});

describe("WaApiClient.getSubscription — wired to GET /api/subscription", () => {
  it("GETs /api/subscription with the X-API-Key header and maps an active sub to Pro", async () => {
    const fetchMock = makeFetch(200, {
      success: true,
      tier: "pro",
      status: "active",
      current_period_end: "2026-12-31T00:00:00Z",
      cancel_at_period_end: false,
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const sub = await client.getSubscription();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("https://api.website-auditor.io/api/subscription");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({ "X-API-Key": "wa_valid_key" });
    expect(sub).toMatchObject({ tier: "pro", status: "active", current_period_end: "2026-12-31T00:00:00Z" });
  });

  it("maps a trialing subscription to Pro (active/trialing => pro)", async () => {
    const fetchMock = makeFetch(200, { success: true, tier: "pro", status: "trialing" });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getSubscription()).resolves.toMatchObject({ tier: "pro", status: "trialing" });
  });

  it("maps 'no subscription' (status none) to free", async () => {
    const fetchMock = makeFetch(200, { success: true, tier: "free", status: "none", current_period_end: null });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getSubscription()).resolves.toMatchObject({ tier: "free", status: "none" });
  });

  it("maps a lapsed (canceled) subscription to free while surfacing the real status", async () => {
    const fetchMock = makeFetch(200, { success: true, tier: "free", status: "canceled" });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getSubscription()).resolves.toMatchObject({ tier: "free", status: "canceled" });
  });

  it("derives tier from status even if the body's tier field disagrees (status is the source of truth)", async () => {
    const fetchMock = makeFetch(200, { success: true, tier: "pro", status: "canceled" });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getSubscription()).resolves.toMatchObject({ tier: "free", status: "canceled" });
  });

  it("maps HTTP 401 (revoked/invalid key) to INVALID_KEY", async () => {
    const fetchMock = makeFetch(401, { success: false, error: "This API key has been revoked." });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getSubscription()).rejects.toMatchObject({ code: "INVALID_KEY" });
  });

  it("maps HTTP 500 (lookup failure) to UPSTREAM_ERROR — the transient path callers fall back on", async () => {
    const fetchMock = makeFetch(500, { success: false, error: "Failed to look up subscription." });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getSubscription()).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("wraps a network failure as UPSTREAM_ERROR (transient)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getSubscription()).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});

describe("WaApiClient.getChanges — wired to /api/ai-visibility-history", () => {
  const history = (snapshots: unknown[]) => ({
    success: true,
    domain: "example.com",
    count: snapshots.length,
    insufficient_history: snapshots.length < 2,
    snapshots,
  });

  it("calls the history endpoint with the API key and computes the latest delta", async () => {
    const fetchMock = makeFetch(
      200,
      history([
        { captured_at: "2026-06-01T00:00:00Z", score: 50, by_engine: { chatgpt: 40, perplexity: 50, claude: 55, gemini: 45 } },
        { captured_at: "2026-06-08T00:00:00Z", score: 70, by_engine: { chatgpt: 75, perplexity: 60, claude: 70, gemini: 65 } },
      ]),
    );
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const changes = await client.getChanges({ domain: "example.com" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/ai-visibility-history");
    expect(String(url)).toContain("domain=example.com");
    expect((init as RequestInit).headers).toMatchObject({ "X-API-Key": "wa_valid_key" });
    // Latest move: 50 -> 70.
    expect(changes.score_delta).toBe(20);
    const chatgpt = changes.engine_changes.find((e) => e.engine === "chatgpt");
    expect(chatgpt).toMatchObject({ from: 40, to: 75, delta: 35 });
  });

  it("with a `since` cursor, spans the window (first-in-range vs latest)", async () => {
    const fetchMock = makeFetch(
      200,
      history([
        { captured_at: "2026-05-01T00:00:00Z", score: 30, by_engine: { chatgpt: 30, perplexity: 30, claude: 30, gemini: 30 } },
        { captured_at: "2026-06-01T00:00:00Z", score: 50, by_engine: { chatgpt: 50, perplexity: 50, claude: 50, gemini: 50 } },
        { captured_at: "2026-06-20T00:00:00Z", score: 60, by_engine: { chatgpt: 60, perplexity: 60, claude: 60, gemini: 60 } },
      ]),
    );
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const changes = await client.getChanges({ domain: "example.com", since: "2026-05-01T00:00:00Z" });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("since=");
    // Window: 30 -> 60 across the whole returned range.
    expect(changes.score_delta).toBe(30);
  });

  it("throws NOT_YET_AVAILABLE (not a fabricated delta) when there is only one snapshot", async () => {
    const fetchMock = makeFetch(
      200,
      history([{ captured_at: "2026-06-01T00:00:00Z", score: 50, by_engine: { chatgpt: 50, perplexity: 50, claude: 50, gemini: 50 } }]),
    );
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getChanges({ domain: "example.com" })).rejects.toMatchObject({ code: "NOT_YET_AVAILABLE" });
  });

  it("does NOT forward the 'last_check' sentinel as a since param", async () => {
    const fetchMock = makeFetch(
      200,
      history([
        { captured_at: "2026-06-01T00:00:00Z", score: 50, by_engine: { chatgpt: 50, perplexity: 50, claude: 50, gemini: 50 } },
        { captured_at: "2026-06-08T00:00:00Z", score: 55, by_engine: { chatgpt: 55, perplexity: 55, claude: 55, gemini: 55 } },
      ]),
    );
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await client.getChanges({ domain: "example.com", since: "last_check" });
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("since=");
  });
});

describe("WaApiClient tracked-domains (track_site enrollment)", () => {
  it("trackSite POSTs to /api/tracked-domains with the normalized domain + weekly cadence", async () => {
    const fetchMock = makeFetch(201, {
      success: true,
      created: true,
      already_tracked: false,
      tracked: { domain: "example.com", cadence: "weekly", active: true },
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const res = await client.trackSite({ domain: "https://WWW.Example.com/pricing" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/tracked-domains");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ domain: "example.com", cadence: "weekly" });
    expect(res).toMatchObject({ domain: "example.com", created: true, already_tracked: false });
  });

  it("maps HTTP 409 (cap reached) to LIMIT_REACHED", async () => {
    const fetchMock = makeFetch(409, { success: false, code: "LIMIT_REACHED", error: "You can track up to 5 domains. Untrack one before adding another." });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.trackSite({ domain: "sixth.com" })).rejects.toMatchObject({ code: "LIMIT_REACHED" });
  });

  it("maps HTTP 403 (free key) to PRO_REQUIRED", async () => {
    const fetchMock = makeFetch(403, { success: false, error: "This endpoint requires a Website Auditor Pro subscription." });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.trackSite({ domain: "example.com" })).rejects.toMatchObject({ code: "PRO_REQUIRED" });
  });

  it("untrackSite DELETEs /api/tracked-domains with the domain", async () => {
    const fetchMock = makeFetch(200, { success: true, removed: true });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const res = await client.untrackSite({ domain: "example.com" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/tracked-domains");
    expect((init as RequestInit).method).toBe("DELETE");
    expect(res).toEqual({ domain: "example.com", removed: true });
  });

  it("listTrackedDomains GETs the endpoint and returns cap accounting", async () => {
    const fetchMock = makeFetch(200, {
      success: true,
      limit: 5,
      used: 2,
      remaining: 3,
      tracked: [{ domain: "a.com", cadence: "weekly", active: true, digest_enabled: true, last_audited_at: null, next_run_at: null }],
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const res = await client.listTrackedDomains();
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("GET");
    expect(res).toMatchObject({ limit: 5, used: 2, remaining: 3 });
    expect(res.tracked[0]!.domain).toBe("a.com");
  });
});
