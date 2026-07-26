import { describe, it, expect, vi } from "vitest";
import { checkUpgradeStatus } from "../../src/tools/checkUpgradeStatus.js";
import { makeDeps } from "../helpers.js";
import { WaApiError } from "../../src/api/errors.js";

describe("check_upgrade_status [Free]", () => {
  it("no API key -> tier none with the portal URL and setup guidance (not an error)", async () => {
    const res = await checkUpgradeStatus({}, makeDeps({ config: { apiKey: undefined } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.tier).toBe("none");
    expect(res.data.upgrade_url).toContain("admin_portal");
    expect(res.data.message).toContain("WA_API_KEY");
  });

  it("active Pro -> tier pro with renewal date, no upsell language", async () => {
    const client = {
      getSubscription: vi.fn(async () => ({
        tier: "pro" as const,
        status: "active",
        current_period_end: "2026-08-26T00:00:00Z",
      })),
    };
    const res = await checkUpgradeStatus({}, makeDeps({ client }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.tier).toBe("pro");
    expect(res.data.current_period_end).toBe("2026-08-26T00:00:00Z");
    expect(res.data.message).toContain("renews");
  });

  it("trialing -> message names the trial end and auto-conversion", async () => {
    const client = {
      getSubscription: vi.fn(async () => ({
        tier: "pro" as const,
        status: "trialing",
        current_period_end: "2026-08-02T00:00:00Z",
      })),
    };
    const res = await checkUpgradeStatus({}, makeDeps({ client }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("trialing");
    expect(res.data.message).toContain("2026-08-02");
    expect(res.data.message).toContain("unless canceled");
  });

  it("pro set to cancel -> canceling flag + resubscribe pointer", async () => {
    const client = {
      getSubscription: vi.fn(async () => ({
        tier: "pro" as const,
        status: "active",
        current_period_end: "2026-08-26T00:00:00Z",
        cancel_at_period_end: true,
      })),
    };
    const res = await checkUpgradeStatus({}, makeDeps({ client }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.cancel_at_period_end).toBe(true);
    expect(res.data.message).toContain("set to end");
  });

  it("never subscribed -> free-tier upsell naming the trial prerequisites", async () => {
    const res = await checkUpgradeStatus({}, makeDeps({}));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.tier).toBe("free");
    expect(res.data.status).toBe("none");
    expect(res.data.message).toContain("no free API tier");
    expect(res.data.message).toContain("payment method");
    expect(res.data.message).toContain("Terms");
  });

  it("lapsed subscription -> real status surfaced, resubscribe pointer", async () => {
    const client = {
      getSubscription: vi.fn(async () => ({ tier: "free" as const, status: "canceled" })),
    };
    const res = await checkUpgradeStatus({}, makeDeps({ client }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("canceled");
    expect(res.data.message).toContain("lapsed");
  });

  it("invalid key -> INVALID_KEY error with upgrade_url", async () => {
    const client = {
      getSubscription: vi.fn(async () => {
        throw new WaApiError("INVALID_KEY", "Invalid API key.");
      }),
    };
    const res = await checkUpgradeStatus({}, makeDeps({ client }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_KEY");
    expect(res.error.upgrade_url).toBeTruthy();
  });

  it("consumes no audit quota and runs no audit", async () => {
    const runAudit = vi.fn();
    const res = await checkUpgradeStatus({}, makeDeps({ client: { runAudit } }));
    expect(res.ok).toBe(true);
    expect(runAudit).not.toHaveBeenCalled();
  });

  it("trial canceled mid-trial -> no auto-conversion promise; resubscribe pointer instead", async () => {
    const client = {
      getSubscription: vi.fn(async () => ({
        tier: "pro" as const,
        status: "trialing",
        current_period_end: "2026-08-02T00:00:00Z",
        cancel_at_period_end: true,
      })),
    };
    const res = await checkUpgradeStatus({}, makeDeps({ client }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.cancel_at_period_end).toBe(true);
    expect(res.data.message).toContain("not to convert");
    expect(res.data.message).toContain("Resubscribe");
    expect(res.data.message).not.toContain("starts automatically");
  });

  it("active Pro message carries no upsell or trial language", async () => {
    const client = {
      getSubscription: vi.fn(async () => ({
        tier: "pro" as const,
        status: "active",
        current_period_end: "2026-08-26T00:00:00Z",
      })),
    };
    const res = await checkUpgradeStatus({}, makeDeps({ client }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.message).not.toContain("Subscribe at");
    expect(res.data.message).not.toContain("trial");
  });

  it("never-subscribed message hedges the trial ('eligible') rather than promising one", async () => {
    const res = await checkUpgradeStatus({}, makeDeps({}));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.message).toContain("eligible new customers");
    expect(res.data.message).not.toMatch(/you (get|will get|receive) a .*trial/i);
  });
});
