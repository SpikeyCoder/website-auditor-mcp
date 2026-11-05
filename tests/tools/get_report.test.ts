import { describe, it, expect, vi } from "vitest";
import { getReport } from "../../src/tools/getReport.js";
import { makeDeps, fixedResolution } from "../helpers.js";

describe("get_report [Pro]", () => {
  it("no key -> AUTH_REQUIRED with upgrade URL (does not run)", async () => {
    const fn = vi.fn();
    const res = await getReport({ domain: "example.com" }, makeDeps({ tier: "none", client: { getReport: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("AUTH_REQUIRED");
    expect(res.error.upgrade_url).toContain("website-auditor.io");
    expect(fn).not.toHaveBeenCalled();
  });

  it("free key (verified) -> PRO_REQUIRED (does not run)", async () => {
    const fn = vi.fn();
    const res = await getReport({ domain: "example.com" }, makeDeps({ tier: "free", client: { getReport: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(fn).not.toHaveBeenCalled();
  });

  it("subscription unverifiable (outage) -> SUBSCRIPTION_UNVERIFIED", async () => {
    const fn = vi.fn();
    const res = await getReport(
      { domain: "example.com" },
      makeDeps({ subscriptions: fixedResolution({ tier: "free", verified: false }), client: { getReport: fn } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("SUBSCRIPTION_UNVERIFIED");
    expect(fn).not.toHaveBeenCalled();
  });

  it("valid Pro key: returns the documented { report_url, badge_html } shape", async () => {
    const report = {
      report_url: "https://website-auditor.io/r/abc123",
      badge_html: '<a href="https://website-auditor.io/r/abc123"><img src="https://website-auditor.io/badge.svg" alt="Audited by Website Auditor"></a>',
    };
    const fn = vi.fn(async () => report);
    const res = await getReport({ domain: "example.com" }, makeDeps({ tier: "pro", client: { getReport: fn } }));
    expect(fn).toHaveBeenCalledWith({ domain: "example.com" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.report_url).toBe(report.report_url);
    expect(res.data.badge_html).toContain("Audited by Website Auditor");
  });

  it("propagates an upstream error as a ToolError (e.g. endpoint not deployed yet)", async () => {
    const { WaApiError } = await import("../../src/api/errors.js");
    const fn = vi.fn(async () => {
      throw new WaApiError("UPSTREAM_ERROR", "Website Auditor API returned HTTP 404.");
    });
    const res = await getReport({ domain: "example.com" }, makeDeps({ tier: "pro", client: { getReport: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("UPSTREAM_ERROR");
  });

  describe("the API's 404 \"No audit on record\"", () => {
    const NO_AUDIT = "No audit on record for acme.com. Run an audit first to get a shareable report.";
    const throw404 = async (message: string) => {
      const { WaApiError } = await import("../../src/api/errors.js");
      return vi.fn(async () => {
        throw new WaApiError("UPSTREAM_ERROR", message, { status: 404 });
      });
    };

    it("is NOT_FOUND, naming the site and run_audit", async () => {
      const fn = await throw404(NO_AUDIT);
      const res = await getReport({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getReport: fn } }));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("NOT_FOUND");
      expect(res.error.message).toBe("No audit of acme.com is on record yet. Run run_audit for acme.com first, then ask again.");
    });

    it("info style: same words, no price or trial", async () => {
      const fn = await throw404(NO_AUDIT);
      const res = await getReport(
        { domain: "acme.com" },
        makeDeps({ tier: "pro", client: { getReport: fn }, config: { upsellStyle: "info", upsellInfoUrl: "https://website-auditor.io" } }),
      );
      if (res.ok) throw new Error("expected an error");
      expect(res.error.code).toBe("NOT_FOUND");
      expect(res.error.message).not.toMatch(/\$\d|\btrial\b|\bsubscribe\b|\bupgrade\b/i);
    });

    it("a 404 that is not that refusal stays UPSTREAM_ERROR and does not say to run an audit", async () => {
      const fn = await throw404("Not found");
      const res = await getReport({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getReport: fn } }));
      if (res.ok) throw new Error("expected an error");
      expect(res.error.code).toBe("UPSTREAM_ERROR");
      expect(res.error.message).not.toMatch(/run_audit/);
    });
  });
});
