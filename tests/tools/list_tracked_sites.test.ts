import { describe, it, expect, vi } from "vitest";
import { listTrackedSites } from "../../src/tools/listTrackedSites.js";
import { makeDeps } from "../helpers.js";

const site = (domain: string) => ({
  domain,
  cadence: "weekly",
  active: true,
  digest_enabled: true,
  last_audited_at: null,
  next_run_at: "2026-07-06T00:00:00Z",
});

describe("list_tracked_sites [Pro]", () => {
  it("free/no key -> PRO_REQUIRED, does not call the API", async () => {
    const listFn = vi.fn();
    const res = await listTrackedSites({}, makeDeps({ tier: "free", client: { listTrackedDomains: listFn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(listFn).not.toHaveBeenCalled();
  });

  it("Pro: reflects what is tracked, with slots used/remaining", async () => {
    const listFn = vi.fn(async () => ({ limit: 5, used: 2, remaining: 3, tracked: [site("a.com"), site("b.com")] }));
    const res = await listTrackedSites({}, makeDeps({ tier: "pro", client: { listTrackedDomains: listFn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.used).toBe(2);
    expect(res.data.remaining).toBe(3);
    expect(res.data.tracked.map((t) => t.domain)).toEqual(["a.com", "b.com"]);
    expect(res.data.summary).toMatch(/Monitoring 2 of 5/i);
  });

  it("Pro: empty state points the user at track_site", async () => {
    const listFn = vi.fn(async () => ({ limit: 5, used: 0, remaining: 5, tracked: [] }));
    const res = await listTrackedSites({}, makeDeps({ tier: "pro", client: { listTrackedDomains: listFn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.tracked).toEqual([]);
    expect(res.data.summary).toMatch(/no sites are being monitored yet/i);
    expect(res.data.summary).toMatch(/track_site/);
  });
});
