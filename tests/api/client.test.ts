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
  upgradeUrl: "https://api.website-auditor.io/admin_portal/",
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
      error: "Rate limit exceeded. You can make 10 requests per day.",
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

  it("sends only the domain when the caller named neither business nor city", async () => {
    // REPLACES "derives businessName from the domain and sends a
    // validation-safe businessCity". Both workarounds are gone.
    //
    // The derived name was not harmless filler: upstream, a supplied
    // business_name OVERRIDES detection and is stamped `user_supplied`, so
    // "Acme-corp" was scored and reported as though a human had confirmed it,
    // and chaos_tester #334's name_warning could never fire. The " " city
    // existed to satisfy a naive `if (!businessCity)` check that was hardened
    // on 2026-08-01, turning the sentinel into a guaranteed 400.
    //
    // api PR #42 makes both optional and normalises blank to absent, so the
    // honest request is the minimal one. See tests/api/businessParams.test.ts.
    const fetchMock = makeFetch(200, { success: true, run_id: "x", audit: reachableReport() });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await client.runAudit({ domain: "acme-corp.com" });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.has("businessName")).toBe(false);
    expect(url.searchParams.has("businessCity")).toBe(false);
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

// What a fixture snapshot asked unless a test says otherwise. get_changes only
// subtracts snapshots whose question keys match (sameQuestion in mappers.ts).
const ASKED = {
  key: "q-example", business_name: "Example", name_source: "detected",
  business_location: "", market_scope: "global", queries: ["best example"],
};

describe("WaApiClient.getChanges — wired to /api/ai-visibility-history", () => {
  const history = (snapshots: Array<Record<string, unknown>>) => ({
    success: true,
    domain: "example.com",
    count: snapshots.length,
    insufficient_history: snapshots.length < 2,
    snapshots: snapshots.map((s) => ({ question: ASKED, ...s })),
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
    // The whole history is read and the window applied here: which snapshots
    // form the series depends on weekly re-audits older than any window.
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("since=");
    // Window: 30 -> 60 across the whole range since the cursor.
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

describe("WaApiClient monitoring-status + idempotent untrack", () => {
  it("getMonitoringStatus GETs /api/monitoring-status and returns the per-site shape", async () => {
    const fetchMock = makeFetch(200, {
      success: true,
      limit: 5,
      used: 1,
      remaining: 4,
      sites: [
        {
          domain: "example.com",
          cadence: "weekly",
          active: true,
          last_audited_at: "2026-06-29T00:00:00Z",
          next_run_at: "2026-07-06T00:00:00Z",
          snapshots_count: 2,
          latest: { score: 70, by_engine: { chatgpt: 75, perplexity: 65, claude: 70, gemini: 60 }, captured_at: "2026-06-29T00:00:00Z", is_simulated: false },
          previous: { score: 50, by_engine: { chatgpt: 40, perplexity: 50, claude: 55, gemini: 45 }, captured_at: "2026-06-22T00:00:00Z", is_simulated: false },
        },
      ],
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const res = await client.getMonitoringStatus();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/monitoring-status");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({ "X-API-Key": "wa_valid_key" });
    expect(res.used).toBe(1);
    expect(res.sites[0]!.latest!.score).toBe(70);
    expect(res.sites[0]!.previous!.score).toBe(50);
  });

  it("untrackSite parses the idempotent response incl. slot accounting", async () => {
    const fetchMock = makeFetch(200, { success: true, removed: false, limit: 5, used: 2, remaining: 3 });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const res = await client.untrackSite({ domain: "example.com" });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
    expect(res).toMatchObject({ domain: "example.com", removed: false, limit: 5, used: 2, remaining: 3 });
  });
});

describe("WaApiClient.getBenchmark — wired to GET /api/benchmark", () => {
  it("GETs the endpoint with the API key and strips the success envelope", async () => {
    const fetchMock = makeFetch(200, {
      success: true,
      percentile: 82,
      peer_median: 54,
      sample_size: 137,
      position_summary: "Top 18% for legal services in TX.",
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const res = await client.getBenchmark({ domain: "example.com" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/benchmark");
    expect(String(url)).toContain("domain=example.com");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({ "X-API-Key": "wa_valid_key" });
    expect(res).toEqual({ percentile: 82, peer_median: 54, sample_size: 137, position_summary: "Top 18% for legal services in TX." });
    expect(res).not.toHaveProperty("success");
  });

  it("forwards optional industry/geo when provided, omits them otherwise", async () => {
    const fetchMock = makeFetch(200, { success: true, percentile: 50, peer_median: 50, sample_size: 10, position_summary: "" });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });

    await client.getBenchmark({ domain: "example.com", industry: "legal", geo: "TX" });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("industry")).toBe("legal");
    expect(url.searchParams.get("geo")).toBe("TX");

    await client.getBenchmark({ domain: "example.com" });
    const url2 = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(url2.searchParams.has("industry")).toBe(false);
    expect(url2.searchParams.has("geo")).toBe(false);
  });

  it("maps HTTP 403 (free key) to PRO_REQUIRED", async () => {
    const fetchMock = makeFetch(403, { success: false, error: "This endpoint requires a Website Auditor Pro subscription." });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getBenchmark({ domain: "example.com" })).rejects.toMatchObject({ code: "PRO_REQUIRED" });
  });
});

describe("WaApiClient.getRecommendations — wired to GET /api/recommendations", () => {
  it("GETs the endpoint and returns the ranked recommendations, envelope stripped", async () => {
    const recommendations = [
      { action: "Add Organization JSON-LD", why: "AI reads structured data", expected_impact: "+8 AI visibility", effort: "low" },
    ];
    const fetchMock = makeFetch(200, { success: true, recommendations });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const res = await client.getRecommendations({ domain: "example.com" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/recommendations");
    expect(String(url)).toContain("domain=example.com");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({ "X-API-Key": "wa_valid_key" });
    expect(res).toEqual({ recommendations });
    expect(res).not.toHaveProperty("success");
  });

  it("defaults to an empty list when the API omits recommendations", async () => {
    const fetchMock = makeFetch(200, { success: true });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const res = await client.getRecommendations({ domain: "example.com" });
    expect(res).toEqual({ recommendations: [] });
  });
});

describe("WaApiClient.generateSchema — wired to GET /api/schema", () => {
  it("GETs the endpoint with the type param and returns { jsonld, placement_notes }", async () => {
    const jsonld = { "@context": "https://schema.org", "@type": "Organization", name: "Example" };
    const fetchMock = makeFetch(200, { success: true, jsonld, placement_notes: "Paste into <head>." });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const res = await client.generateSchema({ domain: "example.com", type: "Organization" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/schema");
    expect(String(url)).toContain("domain=example.com");
    expect(new URL(String(url)).searchParams.get("type")).toBe("Organization");
    expect((init as RequestInit).method).toBe("GET");
    expect(res).toEqual({ jsonld, placement_notes: "Paste into <head>." });
    expect(res).not.toHaveProperty("success");
  });

  it("omits the type param when not provided", async () => {
    const fetchMock = makeFetch(200, { success: true, jsonld: {}, placement_notes: "" });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await client.generateSchema({ domain: "example.com" });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.has("type")).toBe(false);
  });
});

describe("WaApiClient.getReport — wired to GET /api/report", () => {
  it("GETs the endpoint and returns { report_url, badge_html }, envelope stripped", async () => {
    const fetchMock = makeFetch(200, {
      success: true,
      report_url: "https://website-auditor.io/r/abc123",
      badge_html: '<a href="https://website-auditor.io/r/abc123">Audited by Website Auditor</a>',
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const res = await client.getReport({ domain: "example.com" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/report");
    expect(String(url)).toContain("domain=example.com");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({ "X-API-Key": "wa_valid_key" });
    expect(res.report_url).toBe("https://website-auditor.io/r/abc123");
    expect(res.badge_html).toContain("Audited by Website Auditor");
    expect(res).not.toHaveProperty("success");
  });
});

describe("WaApiClient.getAiVisibilityHistory — raw snapshot series for trend", () => {
  it("returns oldest-first snapshots with captured_at/is_simulated preserved", async () => {
    const fetchMock = makeFetch(200, {
      success: true,
      domain: "example.com",
      count: 2,
      insufficient_history: false,
      snapshots: [
        { captured_at: "2026-07-01T00:00:00Z", score: 50, by_engine: { chatgpt: 40 }, is_simulated: true },
        { captured_at: "2026-07-20T00:00:00Z", run_id: "run-2", score: 70, by_engine: { chatgpt: 75 }, is_simulated: false },
      ],
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const snaps = await client.getAiVisibilityHistory({ domain: "example.com" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/ai-visibility-history");
    expect(String(url)).toContain("domain=example.com");
    expect((init as RequestInit).headers).toMatchObject({ "X-API-Key": "wa_valid_key" });

    expect(snaps).toHaveLength(2);
    // No run_id, source or question on the wire reads as null: a snapshot that
    // recorded nothing compares with nothing.
    expect(snaps[0]).toEqual({
      captured_at: "2026-07-01T00:00:00Z",
      run_id: null,
      score: 50,
      by_engine: { chatgpt: 40 },
      is_simulated: true,
      source: null,
      question: null,
    });
    expect(snaps[1]!.is_simulated).toBe(false);
    expect(snaps[1]!.run_id).toBe("run-2");
  });

  it("drops rows with null scores or missing timestamps instead of inventing zeros", async () => {
    const fetchMock = makeFetch(200, {
      success: true,
      snapshots: [
        { captured_at: "2026-07-01T00:00:00Z", score: null, by_engine: {} },
        { score: 50, by_engine: {} },
        { captured_at: "2026-07-10T00:00:00Z", score: 60, by_engine: { chatgpt: 55, perplexity: null } },
      ],
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const snaps = await client.getAiVisibilityHistory({ domain: "example.com" });
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.by_engine).toEqual({ chatgpt: 55 }); // null engine dropped too
  });

  it("does NOT throw on short history — trend logic owns that decision", async () => {
    const fetchMock = makeFetch(200, { success: true, snapshots: [] });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getAiVisibilityHistory({ domain: "example.com" })).resolves.toEqual([]);
  });

  it("maps 403 to PRO_REQUIRED like other Pro endpoints", async () => {
    const fetchMock = makeFetch(403, { success: false, error: "Endpoint requires an active Pro subscription" });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getAiVisibilityHistory({ domain: "example.com" })).rejects.toMatchObject({
      code: "PRO_REQUIRED",
    });
  });
});

describe("WaApiClient.getAiVisibilityHistory since param", () => {
  it("forwards since as a query param when provided, omits it otherwise", async () => {
    const fetchMock = makeFetch(200, { success: true, snapshots: [] });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await client.getAiVisibilityHistory({ domain: "example.com", since: "2026-07-01T00:00:00Z" });
    await client.getAiVisibilityHistory({ domain: "example.com" });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("since=2026-07-01");
    expect(String(fetchMock.mock.calls[1]![0])).not.toContain("since=");
  });
});

describe("WaApiClient.getChanges — only between snapshots that asked the same question", () => {
  const ELSEWHERE = {
    ...ASKED, key: "q-honolulu", business_location: "Honolulu, HI", queries: ["best example in Honolulu, HI"],
  };
  const row = (captured_at: string, score: number, question: unknown = ASKED) => ({
    captured_at, score, by_engine: { chatgpt: score, claude: score }, is_simulated: false, question,
  });
  const clientFor = (snapshots: unknown[]) =>
    new WaApiClient(baseCfg, { fetch: makeFetch(200, { success: true, snapshots }) as unknown as typeof fetch });
  const failure = (pending: Promise<unknown>) => pending.then(
    () => { throw new Error("expected get_changes to refuse"); },
    (e: unknown) => e as WaApiError,
  );
  const weekly = (captured_at: string, score: number, question: unknown = ASKED) =>
    ({ ...row(captured_at, score, question), source: "scheduled" });
  const byHand = (captured_at: string, score: number, question: unknown = ASKED) =>
    ({ ...row(captured_at, score, question), source: null });

  it("passes over a snapshot that asked another question, names both dates, and says what it passed over", async () => {
    const changes = await clientFor([
      row("2026-09-01T09:00:00Z", 40),
      row("2026-09-04T12:00:00Z", 90, ELSEWHERE),
      row("2026-09-08T09:00:00Z", 55),
    ]).getChanges({ domain: "example.com" });
    expect(changes.score_delta).toBe(15); // 55 - 40, not 55 - 90
    expect(changes.from_captured_at).toBe("2026-09-01T09:00:00Z");
    expect(changes.to_captured_at).toBe("2026-09-08T09:00:00Z");
    expect(changes.skipped_snapshots).toBe(1);
    expect(changes.note).toBe(
      "Compared with 2026-09-01, the most recent snapshot that asked the same question; passed over in between: "
      + "1 snapshot that asked a different question.");
  });

  it("reports a re-baseline, its date and what changed, instead of a number", async () => {
    const error = await failure(clientFor([
      row("2026-09-01T09:00:00Z", 40),
      row("2026-09-08T09:00:00Z", 90, ELSEWHERE),
    ]).getChanges({ domain: "example.com" }));
    expect(error).toBeInstanceOf(WaApiError);
    expect(error.code).toBe("NOT_YET_AVAILABLE");
    expect(error.details).toEqual({ reason: "question_changed", rebaselined_at: "2026-09-08T09:00:00Z" });
    expect(error.message).toBe(
      "AI visibility for example.com re-baselined on 2026-09-08: that day's snapshot asked about the market "
      + '"Honolulu, HI" rather than none, compared with the snapshot on 2026-09-01, and no earlier snapshot '
      + "asked the same question, so there is no like-for-like change for it yet.");
  });

  it("a snapshot that recorded nothing compares with nothing, on either side", async () => {
    const latest = await failure(clientFor([row("2026-09-01T09:00:00Z", 40), row("2026-09-08T09:00:00Z", 60, null)])
      .getChanges({ domain: "example.com" }));
    expect(latest.code).toBe("NOT_YET_AVAILABLE");
    expect(latest.details).toEqual({ reason: "question_not_recorded" });

    const before = await failure(clientFor([row("2026-09-01T09:00:00Z", 40, null), row("2026-09-08T09:00:00Z", 60)])
      .getChanges({ domain: "example.com" }));
    expect(before.message).toContain("the snapshots before it do not record what they asked");

    // An API that sends no question at all reads the same way: no fabricated delta.
    const silent = await failure(clientFor([
      { captured_at: "2026-09-01T09:00:00Z", score: 40, by_engine: {} },
      { captured_at: "2026-09-08T09:00:00Z", score: 60, by_engine: {} },
    ]).getChanges({ domain: "example.com" }));
    expect(silent.code).toBe("NOT_YET_AVAILABLE");
  });

  it("with a window, compares with the earliest snapshot in it that asked the same question", async () => {
    const changes = await clientFor([
      row("2026-09-01T09:00:00Z", 90, ELSEWHERE),
      row("2026-09-03T09:00:00Z", 30),
      row("2026-09-05T09:00:00Z", 70, ELSEWHERE),
      row("2026-09-08T09:00:00Z", 50),
    ]).getChanges({ domain: "example.com", since: "2026-09-01T00:00:00Z" });
    expect(changes.score_delta).toBe(20); // 50 - 30
    expect(changes.from_captured_at).toBe("2026-09-03T09:00:00Z");
    expect(changes.skipped_snapshots).toBe(2);
    expect(changes.note).toContain("the earliest snapshot in the window that asked the same question");
  });

  it("with a window that holds no match, says so without claiming a re-baseline", async () => {
    // An older snapshot outside the window may well have asked it.
    const error = await failure(clientFor([row("2026-09-05T09:00:00Z", 70, ELSEWHERE), row("2026-09-08T09:00:00Z", 50)])
      .getChanges({ domain: "example.com", since: "2026-09-05T00:00:00Z" }));
    expect(error.code).toBe("NOT_YET_AVAILABLE");
    expect(error.details).toEqual({ reason: "question_changed", since: "2026-09-05T00:00:00Z" });
    expect(error.message).toContain("since 2026-09-05");
    expect(error.message).not.toMatch(/re-baselined/i);
  });

  it("compares with the NEWEST earlier snapshot that asked the same question, not the oldest", async () => {
    const changes = await clientFor([
      row("2026-09-01T09:00:00Z", 30),
      row("2026-09-04T09:00:00Z", 50),
      row("2026-09-06T09:00:00Z", 90, ELSEWHERE),
      row("2026-09-08T09:00:00Z", 55),
    ]).getChanges({ domain: "example.com" });
    expect(changes.score_delta).toBe(5); // 55 - 50
    expect(changes.from_captured_at).toBe("2026-09-04T09:00:00Z");
    expect(changes.skipped_snapshots).toBe(1);
  });

  it("names both reasons a snapshot was passed over, and counts each", async () => {
    const changes = await clientFor([
      row("2026-09-01T09:00:00Z", 40),
      row("2026-09-03T09:00:00Z", 90, ELSEWHERE),
      row("2026-09-05T09:00:00Z", 70, null),
      row("2026-09-08T09:00:00Z", 55),
    ]).getChanges({ domain: "example.com" });
    expect(changes.skipped_snapshots).toBe(2);
    expect(changes.note).toBe(
      "Compared with 2026-09-01, the most recent snapshot that asked the same question; passed over in between: "
      + "1 snapshot that asked a different question and 1 snapshot that does not record what it asked.");
  });

  it("leaves out an audit that asked what the weekly re-audits do not, says so, and still shows the weekly change", async () => {
    const series = [weekly("2026-09-01T09:00:00Z", 40), weekly("2026-09-08T09:00:00Z", 30)];
    for (const source of [null, "extension"]) {
      const changes = await clientFor([...series, { ...row("2026-09-10T12:00:00Z", 20, ELSEWHERE), source }])
        .getChanges({ domain: "example.com" });
      expect(changes.score_delta).toBe(-10);
      expect(changes.to_captured_at).toBe("2026-09-08T09:00:00Z");
      expect(changes.note).toBe(
        "Left out as not part of the weekly series: 1 snapshot that asked a different question, newer than "
        + "2026-09-08. The newest of them that records its question, on 2026-09-10, asked about the market "
        + '"Honolulu, HI" rather than none.');
    }

    // The weekly re-audit itself asking something new does start the series again.
    const moved = await failure(clientFor([...series, weekly("2026-09-15T09:00:00Z", 20, ELSEWHERE)])
      .getChanges({ domain: "example.com" }));
    expect(moved.details).toEqual({
      reason: "question_changed",
      rebaselined_at: "2026-09-15T09:00:00Z",
      previous_change: { from_captured_at: "2026-09-01T09:00:00Z", to_captured_at: "2026-09-08T09:00:00Z", score_delta: -10 },
    });
    expect(moved.message).toMatch(/^AI visibility for example\.com re-baselined on 2026-09-15: /);
  });

  it("explains a re-baseline against the newest snapshot that recorded its question", async () => {
    const error = await failure(clientFor([
      row("2026-09-01T09:00:00Z", 40),
      row("2026-09-04T09:00:00Z", 50, null),
      row("2026-09-08T09:00:00Z", 60, ELSEWHERE),
    ]).getChanges({ domain: "example.com" }));
    expect(error.message).toContain(
      'asked about the market "Honolulu, HI" rather than none, compared with the snapshot on 2026-09-01,');
  });

  it("a simulated snapshot is no comparison point", async () => {
    const changes = await clientFor([
      row("2026-09-01T09:00:00Z", 40),
      { ...row("2026-09-04T09:00:00Z", 95), is_simulated: true },
      row("2026-09-08T09:00:00Z", 60),
    ]).getChanges({ domain: "example.com" });
    expect(changes.score_delta).toBe(20);
    expect(changes.skipped_snapshots).toBe(0);

    const alone = await failure(clientFor([
      { ...row("2026-09-01T09:00:00Z", 40), is_simulated: true },
      row("2026-09-08T09:00:00Z", 60),
    ]).getChanges({ domain: "example.com" }));
    expect(alone.code).toBe("NOT_YET_AVAILABLE");
    expect(alone.message).toContain("at least two measured snapshots");
  });

  it("drops a null row, and refuses a since that is not a date", async () => {
    const changes = await clientFor([null, row("2026-09-01T09:00:00Z", 40), row("2026-09-08T09:00:00Z", 60)])
      .getChanges({ domain: "example.com" });
    expect(changes.score_delta).toBe(20);

    const error = await failure(clientFor([row("2026-09-05T09:00:00Z", 70, ELSEWHERE), row("2026-09-08T09:00:00Z", 50)])
      .getChanges({ domain: "example.com", since: "last-week" }));
    expect(error.code).toBe("INVALID_INPUT");
  });

  // ── the series, as /api/monitoring-status reads it ────────────────────────

  it("takes a newer audit that asked the weekly question as the latest", async () => {
    const changes = await clientFor([
      weekly("2026-08-30T09:00:00Z", 60), weekly("2026-09-06T09:00:00Z", 30), byHand("2026-09-10T12:00:00Z", 80),
    ]).getChanges({ domain: "example.com" });
    expect(changes.score_delta).toBe(50);
    expect(changes.from_captured_at).toBe("2026-09-06T09:00:00Z");
  });

  it("has nothing to compare when the weekly series is one measured re-audit and the rest asked something else", async () => {
    const error = await failure(clientFor([weekly("2026-09-01T09:00:00Z", 40), byHand("2026-09-05T12:00:00Z", 60, ELSEWHERE)])
      .getChanges({ domain: "example.com" }));
    expect(error.code).toBe("NOT_YET_AVAILABLE");
    expect(error.message).toBe(
      "Not enough history in the weekly series for example.com yet: its only measured re-audit so far, on "
      + "2026-09-01, has no measured snapshot before it to compare with. Left out as not part of the weekly series: "
      + "1 snapshot that asked a different question, newer than 2026-09-01. The newest of them that records its "
      + 'question, on 2026-09-05, asked about the market "Honolulu, HI" rather than none.');
  });

  it("names the like-for-like change among what the weekly series leaves out, beside an unmeasured week", async () => {
    // A weekly re-audit that measured nothing came first, so the measured one is not the only one.
    const error = await failure(clientFor([
      { ...weekly("2026-08-18T09:00:00Z", 30), source: "scheduled_unmeasured" },
      weekly("2026-08-25T09:00:00Z", 40),
      byHand("2026-08-28T12:00:00Z", 20, ELSEWHERE), byHand("2026-09-02T12:00:00Z", 60, ELSEWHERE),
    ]).getChanges({ domain: "example.com" }));
    expect(error.message).toBe(
      "Not enough history in the weekly series for example.com yet: its only measured re-audit so far, on "
      + "2026-08-25, has no measured snapshot before it to compare with. Left out as not part of the weekly series: "
      + "2 snapshots that asked a different question, newer than 2026-08-25. The newest of them that records its "
      + 'question, on 2026-09-02, asked about the market "Honolulu, HI" rather than none. The most recent '
      + "like-for-like change among them was up 40, from 2026-08-28 to 2026-09-02.");
  });

  it("compares with the snapshot that asked the question most recently, whoever wrote it, as monitoring does", async () => {
    const changes = await clientFor([
      weekly("2026-09-07T09:00:00Z", 40),
      byHand("2026-09-10T12:00:00Z", 70),
      weekly("2026-09-14T09:00:00Z", 50, { ...ASKED, key: "q-ltd", business_name: "Example Co Ltd" }),
      weekly("2026-09-21T09:00:00Z", 45),
    ]).getChanges({ domain: "example.com" });
    expect(changes.score_delta).toBe(-25);
    expect(changes.from_captured_at).toBe("2026-09-10T12:00:00Z");
    expect(changes.skipped_snapshots).toBe(1);

    // An audit that asked what a later weekly re-audit asks is its base, not a re-baseline.
    const moved = await clientFor([
      byHand("2026-09-01T12:00:00Z", 30, ELSEWHERE),
      weekly("2026-09-02T09:00:00Z", 40),
      weekly("2026-09-09T09:00:00Z", 50, ELSEWHERE),
    ]).getChanges({ domain: "example.com" });
    expect(moved.score_delta).toBe(20);
    expect(moved.from_captured_at).toBe("2026-09-01T12:00:00Z");

    // A snapshot beside the series, between two that asked the same question, is passed over and counted.
    const between = await clientFor([
      weekly("2026-09-01T09:00:00Z", 40), byHand("2026-09-04T12:00:00Z", 90, ELSEWHERE), weekly("2026-09-08T09:00:00Z", 30),
    ]).getChanges({ domain: "example.com" });
    expect(between.skipped_snapshots).toBe(1);
    expect(between.note).toBe(
      "Compared with 2026-09-01, the most recent snapshot that asked the same question; passed over in between: "
      + "1 snapshot that asked a different question.");
  });

  it("explains a weekly re-baseline against the weekly re-audits, not an audit beside them", async () => {
    const error = await failure(clientFor([
      weekly("2026-09-07T09:00:00Z", 40),
      byHand("2026-09-10T12:00:00Z", 60, ELSEWHERE),
      weekly("2026-09-14T09:00:00Z", 50, { ...ASKED, key: "q-category", queries: ["best example store"] }),
    ]).getChanges({ domain: "example.com" }));
    expect(error.details).toEqual({ reason: "question_changed", rebaselined_at: "2026-09-14T09:00:00Z" });
    expect(error.message).toContain("compared with the snapshot on 2026-09-07");
    expect(error.message).not.toContain("Honolulu");
  });

  it("gives the weekly re-audits' last like-for-like change before a re-baseline, not a newer pair beside them", async () => {
    const error = await failure(clientFor([
      weekly("2026-09-01T09:00:00Z", 40),
      weekly("2026-09-08T09:00:00Z", 30),
      byHand("2026-09-10T12:00:00Z", 60, ELSEWHERE),
      byHand("2026-09-12T12:00:00Z", 70, ELSEWHERE),
      weekly("2026-09-15T09:00:00Z", 20, { ...ASKED, key: "q-category", queries: ["best example store"] }),
    ]).getChanges({ domain: "example.com" }));
    expect((error.details as { previous_change?: unknown }).previous_change).toEqual({
      from_captured_at: "2026-09-01T09:00:00Z", to_captured_at: "2026-09-08T09:00:00Z", score_delta: -10,
    });
    expect(error.message).toContain(
      "The weekly series' most recent like-for-like change before it was down 10, from 2026-09-01 to 2026-09-08.");
  });

  it("re-baselines on the weekly re-audit that did, and names the newer audit it leaves out", async () => {
    const error = await failure(clientFor([
      weekly("2026-09-01T09:00:00Z", 40, null),
      weekly("2026-09-08T09:00:00Z", 50),
      byHand("2026-09-10T12:00:00Z", 60, ELSEWHERE),
    ]).getChanges({ domain: "example.com" }));
    expect(error.details).toEqual({ reason: "earlier_not_recorded", rebaselined_at: "2026-09-08T09:00:00Z" });
    expect(error.message).toBe(
      "AI visibility for example.com re-baselined on 2026-09-08: the snapshots before it do not record what they "
      + "asked, so there is no like-for-like change for it yet. Left out as not part of the weekly series: 1 "
      + "snapshot that asked a different question, newer than 2026-09-08. The newest of them that records its "
      + 'question, on 2026-09-10, asked about the market "Honolulu, HI" rather than none.');
  });

  it("skips a weekly re-audit that measured nothing of the business, whatever its score", async () => {
    const changes = await clientFor([
      weekly("2026-09-07T09:00:00Z", 40),
      weekly("2026-09-14T09:00:00Z", 30),
      { ...row("2026-09-21T09:00:00Z", 25), source: "scheduled_unmeasured" },
    ]).getChanges({ domain: "example.com" });
    expect(changes.score_delta).toBe(-10);
    expect(changes).not.toHaveProperty("note");
  });

  it("still gives the change before a latest snapshot that records nothing", async () => {
    const error = await failure(clientFor([
      weekly("2026-09-01T09:00:00Z", 40), weekly("2026-09-08T09:00:00Z", 30), weekly("2026-09-15T09:00:00Z", 20, null),
    ]).getChanges({ domain: "example.com" }));
    expect(error.details).toEqual({
      reason: "question_not_recorded",
      previous_change: { from_captured_at: "2026-09-01T09:00:00Z", to_captured_at: "2026-09-08T09:00:00Z", score_delta: -10 },
    });
    expect(error.message).toBe(
      "The latest AI-visibility snapshot for example.com, on 2026-09-15, does not record what it asked the "
      + "assistants, so it can't be compared like for like. The most recent like-for-like change before it was "
      + "down 10, from 2026-09-01 to 2026-09-08.");
  });

  it("takes a later audit of the weekly question past a weekly re-audit that recorded nothing", async () => {
    const changes = await clientFor([
      weekly("2026-09-07T09:00:00Z", 60), weekly("2026-09-14T09:00:00Z", 30, null),
      byHand("2026-09-15T12:00:00Z", 80), byHand("2026-09-16T12:00:00Z", 20),
    ]).getChanges({ domain: "example.com" });
    expect(changes.score_delta).toBe(-60);
    expect(changes.from_captured_at).toBe("2026-09-15T12:00:00Z");
  });

  it("says nothing of what newer snapshots asked beside a weekly re-audit that recorded nothing", async () => {
    const error = await failure(clientFor([
      weekly("2026-09-01T09:00:00Z", 40), weekly("2026-09-08T09:00:00Z", 30, null), byHand("2026-09-10T12:00:00Z", 60, ELSEWHERE),
    ]).getChanges({ domain: "example.com" }));
    expect(error.details).toEqual({ reason: "question_not_recorded" });
    expect(error.message).toBe(
      "The newest AI-visibility snapshot in the weekly series for example.com, on 2026-09-08, does not record what "
      + "it asked the assistants, so it can't be compared like for like. Left out as not part of the weekly series: "
      + "1 newer snapshot, on 2026-09-10.");
  });

  it("reads the whole history for a window, so a weekly re-audit before it still counts", async () => {
    const fetchMock = makeFetch(200, {
      success: true,
      snapshots: [
        weekly("2026-09-01T09:00:00Z", 40), weekly("2026-09-08T09:00:00Z", 30), byHand("2026-09-10T12:00:00Z", 60, ELSEWHERE),
      ],
    });
    const error = await failure(new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch })
      .getChanges({ domain: "example.com", since: "2026-09-05T00:00:00Z" }));
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("since=");
    expect(error.details).toEqual({ reason: "not_in_window", since: "2026-09-05T00:00:00Z" });
    expect(error.message).toBe(
      "No earlier AI-visibility snapshot for example.com since 2026-09-05 asked the question the one on 2026-09-08 "
      + "asked; the most recent that did is from 2026-09-01, before the window, so there is no like-for-like change "
      + "for it in the window. Left out as not part of the weekly series: 1 snapshot that asked a different question, newer than "
      + '2026-09-08. The newest of them that records its question, on 2026-09-10, asked about the market "Honolulu, '
      + 'HI" rather than none.');
  });

  it("refuses a window that starts after the series' latest, and names the change outside the series", async () => {
    const error = await failure(clientFor([
      weekly("2026-09-01T09:00:00Z", 40), weekly("2026-09-08T09:00:00Z", 30),
      byHand("2026-09-10T12:00:00Z", 20, ELSEWHERE), byHand("2026-09-12T12:00:00Z", 90, ELSEWHERE),
    ]).getChanges({ domain: "example.com", since: "2026-09-09T00:00:00Z" }));
    expect(error.code).toBe("NOT_YET_AVAILABLE");
    expect(error.message).toBe(
      "No AI-visibility snapshot in the weekly series for example.com since 2026-09-09: the series' latest is from "
      + "2026-09-08, so the series has no change in that window. Left out as not part of the weekly series: 2 "
      + "snapshots that asked a different question, newer than 2026-09-08. The newest of them that records its "
      + 'question, on 2026-09-12, asked about the market "Honolulu, HI" rather than none. The most recent '
      + "like-for-like change among them was up 70, from 2026-09-10 to 2026-09-12.");
  });

  it("says there is no change in a window after the newest snapshot when nothing is left out", async () => {
    const error = await failure(clientFor([weekly("2026-09-01T09:00:00Z", 40), weekly("2026-09-08T09:00:00Z", 30)])
      .getChanges({ domain: "example.com", since: "2026-09-09T00:00:00Z" }));
    expect(error.message).toBe(
      "No AI-visibility snapshot for example.com to compare since 2026-09-09: the latest is from 2026-09-08, so "
      + "there is no change in that window.");
  });

  it("scopes a windowed refusal to the latest's question when the window holds another question's change", async () => {
    const OTHER = { ...ASKED, key: "q-inc", business_name: "Example Inc", queries: ["best example inc"] };
    const error = await failure(clientFor([
      weekly("2026-08-01T09:00:00Z", 40), weekly("2026-09-02T09:00:00Z", 50, OTHER),
      weekly("2026-09-06T09:00:00Z", 55, OTHER), weekly("2026-09-09T09:00:00Z", 60),
    ]).getChanges({ domain: "example.com", since: "2026-09-01T00:00:00Z" }));
    expect(error.details).toEqual({
      reason: "not_in_window",
      since: "2026-09-01T00:00:00Z",
      previous_change: { from_captured_at: "2026-09-02T09:00:00Z", to_captured_at: "2026-09-06T09:00:00Z", score_delta: 5 },
    });
    expect(error.message).toBe(
      "No earlier AI-visibility snapshot for example.com since 2026-09-01 asked the question the one on 2026-09-09 "
      + "asked; the most recent that did is from 2026-08-01, before the window, so there is no like-for-like change "
      + "for it in the window. The most recent like-for-like change before it was up 5, from 2026-09-02 to "
      + "2026-09-06.");
  });

  it("gives a first recorded question its own reason in a window too", async () => {
    const error = await failure(clientFor([weekly("2026-09-01T09:00:00Z", 40, null), weekly("2026-09-08T09:00:00Z", 50)])
      .getChanges({ domain: "example.com", since: "2026-09-05T00:00:00Z" }));
    expect(error.details).toEqual({ reason: "earlier_not_recorded", since: "2026-09-05T00:00:00Z" });
    expect(error.message).toBe(
      "No earlier AI-visibility snapshot for example.com since 2026-09-05 asked the question the one on 2026-09-08 "
      + "asked (the snapshots before it do not record what they asked), so there is no like-for-like change for it "
      + "in that window.");
  });

  it("keeps following the weekly question while an audit of it is current, past one audit in another market", async () => {
    // Untracked after two weekly re-audits; its owner audits the weekly market by
    // hand, then once another market, a month after the last weekly re-audit.
    const changes = await clientFor([
      weekly("2026-07-25T09:00:00Z", 40), weekly("2026-08-01T09:00:00Z", 45),
      byHand("2026-08-22T12:00:00Z", 50), byHand("2026-08-29T12:00:00Z", 70),
      byHand("2026-09-01T12:00:00Z", 20, ELSEWHERE),
    ]).getChanges({ domain: "example.com" });
    expect(changes.score_delta).toBe(20);
    expect(changes.from_captured_at).toBe("2026-08-22T12:00:00Z");
    expect(changes.to_captured_at).toBe("2026-08-29T12:00:00Z");
    expect(changes.note).toBe(
      "Left out as not part of the weekly series: 1 snapshot that asked a different question, newer than "
      + '2026-08-29. The newest of them that records its question, on 2026-09-01, asked about the market "Honolulu, '
      + 'HI" rather than none.');
  });

  it("stops following weekly re-audits months behind the newest snapshot, and reports what changed since", async () => {
    // Tracked until February, then untracked, then audited by hand in September.
    const changes = await clientFor([
      weekly("2026-02-01T09:00:00Z", 40), weekly("2026-02-08T09:00:00Z", 50),
      byHand("2026-09-01T12:00:00Z", 60, ELSEWHERE), byHand("2026-09-10T12:00:00Z", 75, ELSEWHERE),
    ]).getChanges({ domain: "example.com" });
    expect(changes.score_delta).toBe(15);
    expect(changes.from_captured_at).toBe("2026-09-01T12:00:00Z");
    expect(changes).not.toHaveProperty("note");
  });
});

describe("WaApiClient.getAiVisibilityHistory — what each snapshot asked", () => {
  it("maps source and question, and reads a malformed question as unrecorded", async () => {
    const fetchMock = makeFetch(200, {
      success: true,
      snapshots: [
        { captured_at: "2026-09-01T09:00:00Z", score: 40, by_engine: {}, source: "scheduled", question: ASKED },
        { captured_at: "2026-09-08T09:00:00Z", score: 60, by_engine: {}, source: 7, question: { key: 42, queries: "x" } },
      ],
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const [first, second] = await client.getAiVisibilityHistory({ domain: "example.com" });
    expect(first!.source).toBe("scheduled");
    expect(first!.question).toEqual(ASKED);
    expect(second!.source).toBeNull();
    expect(second!.question).toEqual({
      key: null, business_name: null, name_source: null, business_location: null, market_scope: null, queries: null,
    });
  });
});

describe("WaApiClient.getGtmPlan waits on the plan's own clock", () => {
  // The serving chain is engine <= 240s, Node proxy <= 250s — each outer
  // layer waits longer than the inner one so the inner verdict always
  // arrives first. The shared 120s requestTimeoutMs sat BELOW both: a plan
  // in the 120-240s band aborted client-side as TIMEOUT while the proxy
  // charged the quota slot and the engine finished (and billed) a
  // deliverable nobody received.

  const PLAN_BODY = {
    success: true,
    plan_markdown: "# Plan",
    plan_sections: [],
    sources_used: [],
    model: "claude-sonnet-4-6",
  };

  function slowFetch(resolveAfterMs: number | null) {
    return vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
          if (resolveAfterMs !== null) {
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify(PLAN_BODY), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                  }),
                ),
              resolveAfterMs,
            );
          }
        }),
    );
  }

  const TURN = [{ role: "user" as const, content: "make the plan" }];

  it("a plan arriving at 260s is delivered, not aborted at the shared 120s", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = slowFetch(260_000);
      const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
      const pending = client.getGtmPlan({ domain: "acme.com", messages: TURN });
      pending.catch(() => {}); // observed below; silence early-abort unhandled-rejection noise
      await vi.advanceTimersByTimeAsync(260_000);
      const plan = await pending;
      expect(plan.plan_markdown).toBe("# Plan");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still aborts eventually, from ABOVE the proxy's 250s clock", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = slowFetch(null); // never resolves
      const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
      const pending = client.getGtmPlan({ domain: "acme.com", messages: TURN });
      const observed = pending.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(280_000);
      const err = await observed;
      expect(err).toBeInstanceOf(WaApiError);
      expect((err as WaApiError).code).toBe("TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("other endpoints keep the shared clock — the lift is plan-only", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = slowFetch(null);
      const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
      const pending = client.getReport({ domain: "acme.com" });
      const observed = pending.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(121_000);
      const err = await observed;
      expect(err).toBeInstanceOf(WaApiError);
      expect((err as WaApiError).code).toBe("TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WaApiClient.getGtmPlan surfaces the proxy's own refusals", () => {
  const TURN2 = [{ role: "user" as const, content: "make the plan" }];

  it("a plan quota 429 carries its reset time, under the field the proxy sends", async () => {
    // The proxy names the block after the route (gtm_plan_limit), not
    // rate_limit — so reading only rate_limit dropped the entire remedy:
    // the user was told "blocked" with no "until when".
    const fetchMock = makeFetch(429, {
      success: false,
      error: "Daily GTM plan limit reached. You can make 5 of these requests per API key per day.",
      gtm_plan_limit: { limit: 5, remaining: 0, resets_at: "2026-08-26T00:00:00.000Z" },
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const err = await client.getGtmPlan({ domain: "acme.com", messages: TURN2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaApiError);
    expect((err as WaApiError).code).toBe("OVER_QUOTA");
    expect((err as WaApiError).message).toContain("2026-08-26T00:00:00.000Z");
  });

  it("a slow charged 502 keeps its cause instead of being relabelled a timeout", async () => {
    // The gateway-timeout heuristic reads any 502 after 30s as a timeout —
    // sound for audits, wrong for a plan that is DESIGNED to run minutes.
    // It erased both the real cause and the proxy's notice that the request
    // counted toward the daily allowance.
    vi.useFakeTimers();
    try {
      const slow = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(
                    JSON.stringify({
                      success: false,
                      error:
                        "The GTM service reported an error while executing the request. Because the model may have been queried, this request counted toward your daily allowance.",
                    }),
                    { status: 502, headers: { "content-type": "application/json" } },
                  ),
                ),
              45_000,
            );
          }),
      );
      const client = new WaApiClient(baseCfg, { fetch: slow as unknown as typeof fetch });
      const pending = client.getGtmPlan({ domain: "acme.com", messages: TURN2 });
      const observed = pending.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(45_000);
      const err = await observed;
      expect(err).toBeInstanceOf(WaApiError);
      expect((err as WaApiError).code).toBe("UPSTREAM_ERROR");
      expect((err as WaApiError).message).toMatch(/counted toward your daily allowance/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("other endpoints keep the gateway-timeout heuristic", async () => {
    vi.useFakeTimers();
    try {
      const slow = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify({ success: false, error: "bad gateway" }), {
                    status: 502,
                    headers: { "content-type": "application/json" },
                  }),
                ),
              45_000,
            );
          }),
      );
      const client = new WaApiClient(baseCfg, { fetch: slow as unknown as typeof fetch });
      const observed = client.getReport({ domain: "acme.com" }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(45_000);
      expect((await observed as WaApiError).code).toBe("TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WaApiClient.getChanges — snapshots without a usable score", () => {
  /**
   * Subtracting an absent score yields NaN, and NaN is not merely untidy: it
   * serialises to `null` in the text content and fails the tool's declared
   * output schema outright, so a successful call came back as an
   * "Output validation error" naming neither the domain nor the bad row.
   *
   * getAiVisibilityHistory already filters this exact endpoint for this exact
   * reason ("rather than inventing zeros that would poison deltas"); getChanges
   * simply did not.
   */
  const cfg = { ...baseCfg };

  it("drops them rather than producing a NaN delta", async () => {
    const fetchImpl = makeFetch(200, {
      snapshots: [
        { captured_at: "2026-06-01T00:00:00Z", score: 40, by_engine: { chatgpt: 40 }, question: ASKED },
        { captured_at: "2026-06-04T00:00:00Z", score: null, by_engine: {}, question: ASKED },
        { captured_at: "2026-06-08T00:00:00Z", score: 55, by_engine: { chatgpt: 55 }, question: ASKED },
      ],
    });
    const client = new WaApiClient(cfg, { fetch: fetchImpl as unknown as typeof fetch });
    const changes = await client.getChanges({ domain: "example.com" });
    expect(Number.isNaN(changes.score_delta)).toBe(false);
    expect(changes.score_delta).toBe(15);
  });

  it("still reports insufficient history when filtering leaves fewer than two", async () => {
    // The filter must not turn "not enough history" into a silent zero delta.
    const fetchImpl = makeFetch(200, {
      snapshots: [
        { captured_at: "2026-06-01T00:00:00Z", score: 40, by_engine: {}, question: ASKED },
        { captured_at: "2026-06-08T00:00:00Z", score: null, by_engine: {}, question: ASKED },
      ],
    });
    const client = new WaApiClient(cfg, { fetch: fetchImpl as unknown as typeof fetch });
    await expect(client.getChanges({ domain: "example.com" })).rejects.toMatchObject({
      code: "NOT_YET_AVAILABLE",
    });
  });
});

// ── the growth-plan contract (website-auditor-api PR #84) ────────────
// The plan ships under a second name. /api/gtm-plan stays mounted for
// already-installed builds, but /api/growth-plan is the one to build
// against — and the two names differ in exactly one byte of the envelope:
// the 429's quota block is named for the path you called. Moving the path
// without moving that read would silently drop the "until when" from every
// spent-allowance message on the route.

describe("WaApiClient.getGtmPlan — the growth-plan contract", () => {
  const TURN = [{ role: "user" as const, content: "make the plan" }];
  const PLAN_BODY = {
    success: true,
    plan_markdown: "# Plan",
    plan_sections: [{ title: "Days 1–30", body_lines: ["Claim listings"] }],
    sources_used: ["forbes.com"],
    model: "claude-sonnet-4-6",
    growth_plan_limit: { limit: 5, remaining: 4, resets_at: "2026-09-03T00:00:00.000Z" },
  };

  it("POSTs to /api/growth-plan, the name the proxy asks callers to build against", async () => {
    const fetchMock = makeFetch(200, PLAN_BODY);
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await client.getGtmPlan({ domain: "acme.com", messages: TURN });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.website-auditor.io/api/growth-plan");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ domain: "acme.com", messages: TURN });
  });

  it("sends the domain handle alone — exactly one of run_id|domain, and it never invents a run_id", async () => {
    // The proxy refuses a body carrying both, and an MCP caller holds no
    // run_id: run_audit hands back report_url, which carries reports.id —
    // a disjoint id space. `domain` resolves the caller's latest run
    // server-side, which is the whole reason the handle exists.
    const fetchMock = makeFetch(200, PLAN_BODY);
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    await client.getGtmPlan({ domain: "acme.com", messages: TURN });
    const sent = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(sent).not.toHaveProperty("run_id");
    expect(sent.domain).toBe("acme.com");
  });

  it("relays plan_phases when the engine parsed cards, nulls and all", async () => {
    // parse_plan_actions builds each action with dict.fromkeys(_ACTION_FIELDS),
    // so a field the plan did not write arrives as JSON null — PRESENT and
    // empty, not omitted. Coercing those to "" would put a commitment on the
    // customer's calendar that no model produced.
    const phases = [
      {
        phase: 30,
        range: "Days 1–30",
        name: "Foundation",
        short: "30 Days",
        headline: "Get listed where the assistants already look",
        focus: null,
        actions: [
          {
            title: "Claim the Yelp listing",
            effort: "2 hours",
            priority: "High",
            why: null,
            goal: null,
            steps: ["Open the claim form", "Verify by phone"],
          },
        ],
      },
    ];
    const fetchMock = makeFetch(200, { ...PLAN_BODY, plan_phases: phases });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const plan = await client.getGtmPlan({ domain: "acme.com", messages: TURN });
    expect(plan.plan_phases).toEqual(phases);
  });

  it("keeps [] and absent apart — they are different answers about the engine", async () => {
    // [] means THIS engine parsed no cards and the caller should render the
    // markdown; absent means an engine older than the one that added them.
    // Defaulting absent to [] would report a plan that failed the card
    // contract when no engine ever tried.
    const client = (body: unknown) =>
      new WaApiClient(baseCfg, { fetch: makeFetch(200, body) as unknown as typeof fetch });

    const empty = await client({ ...PLAN_BODY, plan_phases: [] }).getGtmPlan({ domain: "acme.com", messages: TURN });
    expect(empty.plan_phases).toEqual([]);

    const older = await client(PLAN_BODY).getGtmPlan({ domain: "acme.com", messages: TURN });
    expect(older.plan_phases).toBeUndefined();
    expect("plan_phases" in older).toBe(false);
  });

  it("relays the rows verbatim, including ones it cannot make sense of", async () => {
    // The ARRAY is checked; its ELEMENTS deliberately are not. Every sibling
    // field here coerces, so filtering these is exactly the instinct that
    // will one day be applied to them too — and it would be wrong twice
    // over: `[null]` filtered down to `[]` reads as "this engine parsed no
    // cards", a different claim and a false one, and dropping one bad row
    // out of three serves two thirds of a paid plan as though it were all of
    // it. A row of the wrong shape is refused later, by name, by the declared
    // output schema (tests/tools/outputSchemas.test.ts). Nothing else pins
    // this layer.
    const rows = [null, "Days 31-60", { phase: 30, actions: [] }];
    const fetchMock = makeFetch(200, { ...PLAN_BODY, plan_phases: rows });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const plan = await client.getGtmPlan({ domain: "acme.com", messages: TURN });
    expect(plan.plan_phases).toEqual(rows);
  });

  it("a non-array plan_phases is dropped rather than passed through", async () => {
    // Every other field here is coerced defensively; a malformed one must not
    // reach the declared output schema, which would turn a served plan into
    // an McpError.
    const fetchMock = makeFetch(200, { ...PLAN_BODY, plan_phases: "Days 1-30" });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const plan = await client.getGtmPlan({ domain: "acme.com", messages: TURN });
    expect(plan.plan_phases).toBeUndefined();
  });

  it("a growth-plan quota 429 carries its reset time, under the field THAT path sends", async () => {
    // The limit block is named for the route called. Reading gtm_plan_limit
    // alone after the path moved would leave a spent allowance reported as
    // "blocked" with no "until when" — the exact remedy the 429 exists to give.
    const fetchMock = makeFetch(429, {
      success: false,
      error: "Daily growth plan limit reached. You can make 5 of these requests per API key per day.",
      growth_plan_limit: { limit: 5, remaining: 0, resets_at: "2026-09-03T00:00:00.000Z" },
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const err = await client.getGtmPlan({ domain: "acme.com", messages: TURN }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaApiError);
    expect((err as WaApiError).code).toBe("OVER_QUOTA");
    expect((err as WaApiError).message).toContain("2026-09-03T00:00:00.000Z");
  });

  it("still reads gtm_plan_limit, because the old name is still mounted and still answers", async () => {
    const fetchMock = makeFetch(429, {
      success: false,
      error: "Daily GTM plan limit reached.",
      gtm_plan_limit: { limit: 5, remaining: 0, resets_at: "2026-09-03T00:00:00.000Z" },
    });
    const client = new WaApiClient(baseCfg, { fetch: fetchMock as unknown as typeof fetch });
    const err = await client.getGtmPlan({ domain: "acme.com", messages: TURN }).catch((e: unknown) => e);
    expect((err as WaApiError).message).toContain("2026-09-03T00:00:00.000Z");
  });
});
