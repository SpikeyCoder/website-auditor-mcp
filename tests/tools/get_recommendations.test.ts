import { describe, it, expect, vi } from "vitest";
import { getRecommendations } from "../../src/tools/getRecommendations.js";
import { makeDeps, fixedResolution } from "../helpers.js";

// Since website-auditor-api #131 (card 227) the API answers ANY valid key:
// the audit service builds the list from the stored audit's evidence and
// decides the tier itself — Pro gets the whole list, a key without Pro the
// free one (findings, citation evidence, the listing tasks as a count). So
// this tool needs a key, not a subscription: the pre-flight refuses no key
// and a bad key, and lets the API answer everyone else.

const PRO_LIST = {
  run_id: "a1b2c3d4e5f6",
  tier: "pro" as const,
  recommendations: [
    {
      action: "Unblock AI crawlers in robots.txt",
      why: "Your robots.txt turns away GPTBot. GPTBot is the crawler behind ChatGPT, and ChatGPT named you in 0 of 8 answers.",
      expected_impact: "high",
      effort: "low",
      source: "ai_crawler_block",
      evidence: { blocked: ["GPTBot"], assistants: ["ChatGPT"], named: { ChatGPT: { named: 0, answers: 8 } } },
    },
    {
      action: "Add JSON-LD structured data to your homepage",
      why: "No schema.org markup was found on Riverside Bakery's homepage.",
      expected_impact: "high",
      effort: "low",
      source: "missing_schema",
      evidence: { has_structured_data: false, structured_data_types: [] },
      fix_id: "snippets/structured-data-template.html",
    },
  ],
};

const FREE_LIST = {
  run_id: "a1b2c3d4e5f6",
  tier: "free" as const,
  recommendations: [
    {
      action: "Unlock the 3 places AI checks that don't list you yet",
      why: "The assistants cited them while answering your questions, and your competitors are listed on them. Pro shows which ones.",
      expected_impact: "high",
      effort: "medium",
      source: "authority_count",
      evidence: { places: 3 },
      locked: true,
    },
  ],
};

describe("get_recommendations [any key]", () => {
  it("no key -> AUTH_REQUIRED with upgrade URL (does not run)", async () => {
    const fn = vi.fn();
    const res = await getRecommendations({ domain: "example.com" }, makeDeps({ tier: "none", client: { getRecommendations: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("AUTH_REQUIRED");
    expect(res.error.upgrade_url).toContain("website-auditor.io");
    expect(fn).not.toHaveBeenCalled();
  });

  it("a rejected key -> INVALID_KEY, not an upsell (does not run)", async () => {
    const fn = vi.fn();
    const res = await getRecommendations(
      { domain: "example.com" },
      makeDeps({
        subscriptions: fixedResolution({ tier: "invalid", verified: true, message: "This key was revoked." }),
        client: { getRecommendations: fn },
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_KEY");
    expect(fn).not.toHaveBeenCalled();
  });

  it("a key without Pro is answered with the free list, not PRO_REQUIRED", async () => {
    const fn = vi.fn(async () => FREE_LIST);
    const res = await getRecommendations({ domain: "example.com" }, makeDeps({ tier: "free", client: { getRecommendations: fn } }));
    expect(fn).toHaveBeenCalledWith({ domain: "example.com" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual(FREE_LIST);
    expect(res.data.recommendations[0]).toMatchObject({ locked: true, evidence: { places: 3 } });
  });

  it("an unverifiable subscription (outage) still asks: the API decides the tier", async () => {
    const fn = vi.fn(async () => FREE_LIST);
    const res = await getRecommendations(
      { domain: "example.com" },
      makeDeps({ subscriptions: fixedResolution({ tier: "free", verified: false }), client: { getRecommendations: fn } }),
    );
    expect(fn).toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it("Pro: the evidence-based list comes through whole — source, evidence, fix_id", async () => {
    const fn = vi.fn(async () => PRO_LIST);
    const res = await getRecommendations({ domain: "example.com" }, makeDeps({ tier: "pro", client: { getRecommendations: fn } }));
    expect(fn).toHaveBeenCalledWith({ domain: "example.com" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual(PRO_LIST);
    expect(res.data.recommendations[1]).toMatchObject({ fix_id: "snippets/structured-data-template.html" });
  });

  it("propagates an upstream error as a ToolError (e.g. no audit on record)", async () => {
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
