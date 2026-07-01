import { describe, it, expect, vi } from "vitest";
import { getBenchmark } from "../../src/tools/getBenchmark.js";
import { makeDeps, fixedResolution } from "../helpers.js";

describe("get_benchmark [Pro]", () => {
  it("no key -> PRO_REQUIRED with upgrade URL (does not run)", async () => {
    const getBenchmarkFn = vi.fn();
    const res = await getBenchmark({ domain: "example.com" }, makeDeps({ tier: "none", client: { getBenchmark: getBenchmarkFn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(res.error.upgrade_url).toContain("website-auditor.io");
    expect(getBenchmarkFn).not.toHaveBeenCalled();
  });

  it("free key (verified) -> PRO_REQUIRED (does not run)", async () => {
    const getBenchmarkFn = vi.fn();
    const res = await getBenchmark({ domain: "example.com" }, makeDeps({ tier: "free", client: { getBenchmark: getBenchmarkFn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(getBenchmarkFn).not.toHaveBeenCalled();
  });

  it("subscription unverifiable (outage) -> SUBSCRIPTION_UNVERIFIED, not a false 'not subscribed'", async () => {
    const getBenchmarkFn = vi.fn();
    const res = await getBenchmark(
      { domain: "example.com" },
      makeDeps({ subscriptions: fixedResolution({ tier: "free", verified: false }), client: { getBenchmark: getBenchmarkFn } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("SUBSCRIPTION_UNVERIFIED");
    expect(getBenchmarkFn).not.toHaveBeenCalled();
  });

  it("valid Pro key: returns the documented percentile/peer shape and forwards optional industry/geo", async () => {
    const benchmark = { percentile: 82, peer_median: 54, sample_size: 137, position_summary: "Top 18% for legal services in TX." };
    const getBenchmarkFn = vi.fn(async () => benchmark);
    const res = await getBenchmark(
      { domain: "example.com", industry: "legal", geo: "TX" },
      makeDeps({ tier: "pro", client: { getBenchmark: getBenchmarkFn } }),
    );
    expect(getBenchmarkFn).toHaveBeenCalledWith({ domain: "example.com", industry: "legal", geo: "TX" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual(benchmark);
  });

  it("propagates an upstream error as a ToolError (e.g. endpoint not deployed yet)", async () => {
    const { WaApiError } = await import("../../src/api/errors.js");
    const getBenchmarkFn = vi.fn(async () => {
      throw new WaApiError("UPSTREAM_ERROR", "Website Auditor API returned HTTP 404.");
    });
    const res = await getBenchmark({ domain: "example.com" }, makeDeps({ tier: "pro", client: { getBenchmark: getBenchmarkFn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("UPSTREAM_ERROR");
  });
});
