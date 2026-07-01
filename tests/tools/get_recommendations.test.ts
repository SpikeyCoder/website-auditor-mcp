import { describe, it, expect, vi } from "vitest";
import { getRecommendations } from "../../src/tools/getRecommendations.js";
import { makeDeps, fixedResolution } from "../helpers.js";

describe("get_recommendations [Pro]", () => {
  it("no key -> PRO_REQUIRED with upgrade URL (does not run)", async () => {
    const fn = vi.fn();
    const res = await getRecommendations({ domain: "example.com" }, makeDeps({ tier: "none", client: { getRecommendations: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(res.error.upgrade_url).toContain("website-auditor.io");
    expect(fn).not.toHaveBeenCalled();
  });

  it("free key (verified) -> PRO_REQUIRED (does not run)", async () => {
    const fn = vi.fn();
    const res = await getRecommendations({ domain: "example.com" }, makeDeps({ tier: "free", client: { getRecommendations: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(fn).not.toHaveBeenCalled();
  });

  it("subscription unverifiable (outage) -> SUBSCRIPTION_UNVERIFIED", async () => {
    const fn = vi.fn();
    const res = await getRecommendations(
      { domain: "example.com" },
      makeDeps({ subscriptions: fixedResolution({ tier: "free", verified: false }), client: { getRecommendations: fn } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("SUBSCRIPTION_UNVERIFIED");
    expect(fn).not.toHaveBeenCalled();
  });

  it("valid Pro key: returns the documented ranked-actions shape", async () => {
    const recommendations = [
      { action: "Add Organization JSON-LD", why: "AI assistants read structured data", expected_impact: "+8 AI visibility", effort: "low" },
      { action: "Fix broken links", why: "Broken links hurt crawlability", expected_impact: "+3 SEO", effort: "medium" },
    ];
    const fn = vi.fn(async () => ({ recommendations }));
    const res = await getRecommendations({ domain: "example.com" }, makeDeps({ tier: "pro", client: { getRecommendations: fn } }));
    expect(fn).toHaveBeenCalledWith({ domain: "example.com" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.recommendations).toHaveLength(2);
    expect(res.data.recommendations[0]).toMatchObject({ action: "Add Organization JSON-LD", effort: "low" });
  });

  it("propagates an upstream error as a ToolError (e.g. endpoint not deployed yet)", async () => {
    const { WaApiError } = await import("../../src/api/errors.js");
    const fn = vi.fn(async () => {
      throw new WaApiError("UPSTREAM_ERROR", "Website Auditor API returned HTTP 404.");
    });
    const res = await getRecommendations({ domain: "example.com" }, makeDeps({ tier: "pro", client: { getRecommendations: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("UPSTREAM_ERROR");
  });
});
