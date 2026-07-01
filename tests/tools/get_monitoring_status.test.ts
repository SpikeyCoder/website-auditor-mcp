import { describe, it, expect, vi } from "vitest";
import { getMonitoringStatus } from "../../src/tools/getMonitoringStatus.js";
import { makeDeps } from "../helpers.js";

const engines = (n: number) => ({ chatgpt: n, perplexity: n, claude: n, gemini: n });
const snapshot = (score: number, captured_at: string) => ({
  score,
  by_engine: engines(score),
  captured_at,
  is_simulated: false,
});

describe("get_monitoring_status [Pro]", () => {
  it("free/no key -> PRO_REQUIRED, does not call the API", async () => {
    const statusFn = vi.fn();
    const res = await getMonitoringStatus({}, makeDeps({ tier: "free", client: { getMonitoringStatus: statusFn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(statusFn).not.toHaveBeenCalled();
  });

  it("empty state: no tracked domains -> sites [] and a pointer to track_site", async () => {
    const statusFn = vi.fn(async () => ({ limit: 5, used: 0, remaining: 5, sites: [] }));
    const res = await getMonitoringStatus({}, makeDeps({ tier: "pro", client: { getMonitoringStatus: statusFn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.sites).toEqual([]);
    expect(res.data.used).toBe(0);
    expect(res.data.summary).toMatch(/no sites are being monitored yet/i);
  });

  it("returns latest score, next_run_at, and the most recent change per domain", async () => {
    const statusFn = vi.fn(async () => ({
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
          latest: snapshot(70, "2026-06-29T00:00:00Z"),
          previous: snapshot(50, "2026-06-22T00:00:00Z"),
        },
      ],
    }));
    const res = await getMonitoringStatus({}, makeDeps({ tier: "pro", client: { getMonitoringStatus: statusFn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const site = res.data.sites[0]!;
    expect(site.latest_score).toBe(70);
    expect(site.next_run_at).toBe("2026-07-06T00:00:00Z");
    expect(site.change).not.toBeNull();
    expect(site.change!.score_delta).toBe(20); // 50 -> 70
    expect(site.summary).toMatch(/up 20/);
  });

  it("a domain with only a baseline snapshot has a latest score but no change", async () => {
    const statusFn = vi.fn(async () => ({
      limit: 5,
      used: 1,
      remaining: 4,
      sites: [
        {
          domain: "fresh.com",
          cadence: "weekly",
          active: true,
          last_audited_at: "2026-06-29T00:00:00Z",
          next_run_at: "2026-07-06T00:00:00Z",
          snapshots_count: 1,
          latest: snapshot(88, "2026-06-29T00:00:00Z"),
          previous: null,
        },
      ],
    }));
    const res = await getMonitoringStatus({}, makeDeps({ tier: "pro", client: { getMonitoringStatus: statusFn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const site = res.data.sites[0]!;
    expect(site.latest_score).toBe(88);
    expect(site.change).toBeNull();
    expect(site.summary).toMatch(/baseline/i);
  });

  it("a not-yet-audited domain reports a null latest score", async () => {
    const statusFn = vi.fn(async () => ({
      limit: 5,
      used: 1,
      remaining: 4,
      sites: [
        {
          domain: "pending.com",
          cadence: "weekly",
          active: true,
          last_audited_at: null,
          next_run_at: "2026-07-06T00:00:00Z",
          snapshots_count: 0,
          latest: null,
          previous: null,
        },
      ],
    }));
    const res = await getMonitoringStatus({}, makeDeps({ tier: "pro", client: { getMonitoringStatus: statusFn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const site = res.data.sites[0]!;
    expect(site.latest_score).toBeNull();
    expect(site.change).toBeNull();
    expect(site.summary).toMatch(/not audited yet/i);
  });
});
