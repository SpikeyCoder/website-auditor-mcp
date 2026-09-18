import { describe, it, expect, vi } from "vitest";
import { generateSchema } from "../../src/tools/generateSchema.js";
import { makeDeps, fixedResolution } from "../helpers.js";

describe("generate_schema [Pro]", () => {
  it("no key -> AUTH_REQUIRED with upgrade URL (does not run)", async () => {
    const fn = vi.fn();
    const res = await generateSchema({ domain: "example.com" }, makeDeps({ tier: "none", client: { generateSchema: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("AUTH_REQUIRED");
    expect(res.error.upgrade_url).toContain("website-auditor.io");
    expect(fn).not.toHaveBeenCalled();
  });

  it("free key (verified) -> PRO_REQUIRED (does not run)", async () => {
    const fn = vi.fn();
    const res = await generateSchema({ domain: "example.com" }, makeDeps({ tier: "free", client: { generateSchema: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(fn).not.toHaveBeenCalled();
  });

  it("subscription unverifiable (outage) -> SUBSCRIPTION_UNVERIFIED", async () => {
    const fn = vi.fn();
    const res = await generateSchema(
      { domain: "example.com" },
      makeDeps({ subscriptions: fixedResolution({ tier: "free", verified: false }), client: { generateSchema: fn } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("SUBSCRIPTION_UNVERIFIED");
    expect(fn).not.toHaveBeenCalled();
  });

  it("valid Pro key: returns the documented { jsonld, placement_notes } shape and forwards the type", async () => {
    // PR #97 in website-auditor-api: the endpoint now returns a DRAFT — the
    // name field is a placeholder the owner must replace, and placement_notes
    // asks for that replacement before it says where to embed.
    const jsonld = { "@context": "https://schema.org", "@type": "Organization", name: "Your Business Name" };
    const placement_notes =
      'Replace "Your Business Name" with the business\'s name as customers know it, confirmed with the owner, ' +
      "then embed this in a <script type=\"application/ld+json\"> tag in the <head> of every page.";
    const fn = vi.fn(async () => ({ jsonld, placement_notes }));
    const res = await generateSchema(
      { domain: "example.com", type: "Organization" },
      makeDeps({ tier: "pro", client: { generateSchema: fn } }),
    );
    expect(fn).toHaveBeenCalledWith({ domain: "example.com", type: "Organization" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.jsonld).toEqual(jsonld);
    expect(res.data.jsonld.name).toBe("Your Business Name");
    expect(res.data.placement_notes).toMatch(/Replace "Your Business Name"/);
    expect(res.data.placement_notes).toMatch(/confirmed with the owner/);
    expect(res.data.placement_notes).toMatch(/<head>/);
  });

  it("propagates an upstream error as a ToolError (e.g. endpoint not deployed yet)", async () => {
    const { WaApiError } = await import("../../src/api/errors.js");
    const fn = vi.fn(async () => {
      throw new WaApiError("UPSTREAM_ERROR", "Website Auditor API returned HTTP 404.");
    });
    const res = await generateSchema({ domain: "example.com" }, makeDeps({ tier: "pro", client: { generateSchema: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("UPSTREAM_ERROR");
  });
});
