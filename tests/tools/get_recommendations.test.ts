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
    // The list is the API's, untouched; a Pro caller also gets the dashboard link.
    const { dashboard, ...list } = res.data;
    expect(list).toEqual(PRO_LIST);
    expect(dashboard?.url).toContain("/dashboard?src=mcp-get_recommendations");
    expect(res.data.recommendations[1]).toMatchObject({ fix_id: "snippets/structured-data-template.html" });
  });

  describe("the API's 404 \"No audit on record\"", () => {
    const NO_AUDIT = "No audit on record for acme.com. Run an audit first, then request recommendations.";
    const throw404 = async (message: string) => {
      const { WaApiError } = await import("../../src/api/errors.js");
      return vi.fn(async () => {
        throw new WaApiError("UPSTREAM_ERROR", message, { status: 404 });
      });
    };

    it("Pro: NOT_FOUND, naming the site and run_audit", async () => {
      const fn = await throw404(NO_AUDIT);
      const res = await getRecommendations({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getRecommendations: fn } }));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("NOT_FOUND");
      expect(res.error.message).toBe("No audit of acme.com is on record yet. Run run_audit for acme.com first, then ask again.");
    });

    it("a full URL is reported as its hostname", async () => {
      const fn = await throw404(NO_AUDIT);
      const res = await getRecommendations({ domain: "https://www.acme.com/pricing" }, makeDeps({ tier: "pro", client: { getRecommendations: fn } }));
      if (res.ok) throw new Error("expected an error");
      expect(res.error.message).toContain("No audit of acme.com is on record yet.");
    });

    it("verified non-Pro, info style: NOT_FOUND that does not send them to run_audit, and no price or trial", async () => {
      const fn = await throw404(NO_AUDIT);
      const res = await getRecommendations(
        { domain: "acme.com" },
        makeDeps({ tier: "free", client: { getRecommendations: fn }, config: { upsellStyle: "info", upsellInfoUrl: "https://website-auditor.io" } }),
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("NOT_FOUND");
      expect(res.error.message).toContain("No audit of acme.com is on record yet");
      expect(res.error.message).toContain("Plans are described at");
      expect(res.error.message).toContain("get_sample_audit");
      expect(res.error.message).not.toMatch(/run_audit/);
      expect(res.error.message).not.toMatch(/\$\d/);
      expect(res.error.message).not.toMatch(/\btrial\b|\bsubscribe\b|\bupgrade\b/i);
    });

    it("verified non-Pro, link style: says what running one takes, not to run it", async () => {
      const fn = await throw404(NO_AUDIT);
      const res = await getRecommendations({ domain: "acme.com" }, makeDeps({ tier: "free", client: { getRecommendations: fn } }));
      if (res.ok) throw new Error("expected an error");
      expect(res.error.code).toBe("NOT_FOUND");
      expect(res.error.message).toContain("requires an active Website Auditor subscription");
      expect(res.error.message).not.toMatch(/run_audit/);
      expect(res.error.upgrade_url).toBeDefined();
    });

    it("subscription unverifiable: told to run the audit, not that their plan lacks it", async () => {
      const fn = await throw404(NO_AUDIT);
      const res = await getRecommendations(
        { domain: "acme.com" },
        makeDeps({ subscriptions: fixedResolution({ tier: "free", verified: false }), client: { getRecommendations: fn } }),
      );
      if (res.ok) throw new Error("expected an error");
      expect(res.error.code).toBe("NOT_FOUND");
      expect(res.error.message).toContain("Run run_audit for acme.com first");
    });

    it("a 404 that is not that refusal (unmounted route) stays UPSTREAM_ERROR and does not send anyone to run_audit", async () => {
      const fn = await throw404("Not found");
      const res = await getRecommendations({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getRecommendations: fn } }));
      if (res.ok) throw new Error("expected an error");
      expect(res.error.code).toBe("UPSTREAM_ERROR");
      expect(res.error.message).not.toMatch(/run_audit/);
    });
  });

  it("propagates any other upstream error as a ToolError", async () => {
    const { WaApiError } = await import("../../src/api/errors.js");
    const fn = vi.fn(async () => {
      throw new WaApiError("UPSTREAM_ERROR", "Website Auditor API returned HTTP 500.", { status: 500 });
    });
    const res = await getRecommendations({ domain: "example.com" }, makeDeps({ tier: "pro", client: { getRecommendations: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("UPSTREAM_ERROR");
  });
});
