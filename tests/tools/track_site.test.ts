import { describe, it, expect, vi } from "vitest";
import { trackSite } from "../../src/tools/trackSite.js";
import { WaApiError } from "../../src/api/errors.js";
import { makeDeps } from "../helpers.js";

describe("track_site [Pro]", () => {
  it("no key -> PRO_REQUIRED, does not enroll", async () => {
    const client = { trackSite: vi.fn() };
    const res = await trackSite({ domain: "example.com" }, makeDeps({ tier: "none", client }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(res.error.upgrade_url).toContain("website-auditor.io");
    expect(client.trackSite).not.toHaveBeenCalled();
  });

  it("free key -> PRO_REQUIRED, does not enroll", async () => {
    const client = { trackSite: vi.fn() };
    const res = await trackSite({ domain: "example.com" }, makeDeps({ tier: "free", client }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(client.trackSite).not.toHaveBeenCalled();
  });

  it("Pro key: enrolls a new domain weekly", async () => {
    const trackSiteFn = vi.fn(async () => ({
      domain: "example.com",
      cadence: "weekly",
      active: true,
      created: true,
      already_tracked: false,
    }));
    const res = await trackSite({ domain: "example.com" }, makeDeps({ tier: "pro", client: { trackSite: trackSiteFn } }));
    expect(trackSiteFn).toHaveBeenCalledWith({ domain: "example.com", cadence: "weekly" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.tracking).toBe(true);
    expect(res.data.created).toBe(true);
    expect(res.data.cadence).toBe("weekly");
  });

  it("Pro key: re-enrolling an already-tracked domain is a friendly no-op", async () => {
    const trackSiteFn = vi.fn(async () => ({
      domain: "example.com",
      cadence: "weekly",
      active: true,
      created: false,
      already_tracked: true,
    }));
    const res = await trackSite({ domain: "example.com" }, makeDeps({ tier: "pro", client: { trackSite: trackSiteFn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.tracking).toBe(true);
    expect(res.data.already_tracked).toBe(true);
    expect(res.data.message).toMatch(/already being monitored/i);
  });

  it("Pro key: enabled=false stops monitoring (calls untrackSite, not trackSite)", async () => {
    const trackSiteFn = vi.fn();
    const untrackFn = vi.fn(async () => ({ domain: "example.com", removed: true }));
    const res = await trackSite(
      { domain: "example.com", enabled: false },
      makeDeps({ tier: "pro", client: { trackSite: trackSiteFn, untrackSite: untrackFn } }),
    );
    expect(untrackFn).toHaveBeenCalledWith({ domain: "example.com" });
    expect(trackSiteFn).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.tracking).toBe(false);
    expect(res.data.removed).toBe(true);
  });

  it("the 5-domain cap surfaces as a clean LIMIT_REACHED error (no upgrade prompt)", async () => {
    const trackSiteFn = vi.fn(async () => {
      throw new WaApiError("LIMIT_REACHED", "You can track up to 5 domains. Untrack one before adding another.", {
        status: 409,
      });
    });
    const res = await trackSite({ domain: "sixth.com" }, makeDeps({ tier: "pro", client: { trackSite: trackSiteFn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("LIMIT_REACHED");
    expect(res.error.message).toMatch(/untrack one/i);
    // Already Pro — this is not an upgrade situation.
    expect(res.error.upgrade_url).toBeUndefined();
  });

  it("rejects a non-weekly cadence with INVALID_INPUT (weekly-only in v1)", async () => {
    const trackSiteFn = vi.fn();
    const res = await trackSite(
      { domain: "example.com", cadence: "daily" as unknown as "weekly" },
      makeDeps({ tier: "pro", client: { trackSite: trackSiteFn } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_INPUT");
    expect(trackSiteFn).not.toHaveBeenCalled();
  });
});
