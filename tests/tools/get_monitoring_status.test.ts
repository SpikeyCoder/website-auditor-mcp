import { describe, it, expect, vi } from "vitest";
import { getMonitoringStatus } from "../../src/tools/getMonitoringStatus.js";
import { makeDeps } from "../helpers.js";

const engines = (n: number) => ({ chatgpt: n, perplexity: n, claude: n, gemini: n });
// One question throughout unless a test says otherwise: a change is only shown
// between snapshots whose question keys match.
const ASKED = {
  key: "q-example", business_name: "Example", name_source: "detected",
  business_location: "", market_scope: "global", queries: ["best example"],
};
const snapshot = (score: number, captured_at: string, question: Record<string, unknown> | null = ASKED) => ({
  score,
  by_engine: engines(score),
  captured_at,
  is_simulated: false,
  question,
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

describe("get_monitoring_status: a change only between snapshots that asked the same question", () => {
  const ELSEWHERE = {
    ...ASKED, key: "q-honolulu", business_location: "Honolulu, HI", queries: ["best example in Honolulu, HI"],
  };
  const site = (over: Record<string, unknown>) => ({
    domain: "example.com",
    cadence: "weekly",
    active: true,
    last_audited_at: "2026-09-08T09:00:00Z",
    next_run_at: "2026-09-15T09:00:00Z",
    snapshots_count: 3,
    latest: snapshot(70, "2026-09-08T09:00:00Z"),
    previous: null,
    ...over,
  });
  const run = async (s: Record<string, unknown>) => {
    const statusFn = vi.fn(async () => ({ limit: 5, used: 1, remaining: 4, sites: [s] }));
    const res = await getMonitoringStatus({}, makeDeps({ tier: "pro", client: { getMonitoringStatus: statusFn } }));
    if (!res.ok) throw new Error(`expected a result, got ${res.error.code}`);
    return res.data.sites[0]!;
  };

  it("names the date it compares against, and what it passed over", async () => {
    const out = await run(site({
      previous: snapshot(50, "2026-09-01T09:00:00Z"),
      comparison: { status: "compared", skipped_snapshots: 1 },
    }));
    expect(out.change!.score_delta).toBe(20);
    expect(out.change!.from_captured_at).toBe("2026-09-01T09:00:00Z");
    expect(out.change!.to_captured_at).toBe("2026-09-08T09:00:00Z");
    expect(out.change!.skipped_snapshots).toBe(1);
    expect(out.summary).toBe("example.com: AI visibility 70/100 (up 20 since 2026-09-01).");
    expect(out.note).toBe(
      "Compared with 2026-09-01, the most recent snapshot that asked the same question; 1 snapshot in between "
      + "asked a different question and was not compared.");
  });

  it("a re-baseline is said, not subtracted", async () => {
    const out = await run(site({
      latest: snapshot(70, "2026-09-08T09:00:00Z", ELSEWHERE),
      comparison: { status: "rebaselined", prior: { captured_at: "2026-09-01T09:00:00Z", question: ASKED } },
    }));
    expect(out.change).toBeNull();
    expect(out.summary).toBe("example.com: AI visibility 70/100 (re-baselined on 2026-09-08; no like-for-like change yet).");
    expect(out.note).toBe(
      'Re-baselined on 2026-09-08: it asked about the market "Honolulu, HI" rather than none, and no earlier '
      + "snapshot asked the same question, so there is no like-for-like change yet.");
  });

  it("never subtracts a pair it cannot confirm asked the same question, whichever API sent it", async () => {
    // An API from before the rule returns the snapshot just before, whatever it
    // asked, and no comparison at all.
    const different = await run(site({ previous: snapshot(20, "2026-09-01T09:00:00Z", ELSEWHERE) }));
    expect(different.change).toBeNull();
    expect(different.summary).toBe("example.com: AI visibility 70/100 (no like-for-like change yet).");
    expect(different.note).toBe(
      'The previous snapshot asked about the market "Honolulu, HI" rather than none, so no like-for-like change '
      + "can be shown.");

    const unrecorded = await run(site({
      latest: snapshot(70, "2026-09-08T09:00:00Z", null),
      previous: snapshot(20, "2026-09-01T09:00:00Z", null),
    }));
    expect(unrecorded.change).toBeNull();
    expect(unrecorded.note).toMatch(/do not record what each audit asked/);
  });

  it("reads not_recorded and baseline as what they are", async () => {
    const notRecorded = await run(site({
      latest: snapshot(70, "2026-09-08T09:00:00Z", null), comparison: { status: "not_recorded" },
    }));
    expect(notRecorded.change).toBeNull();
    expect(notRecorded.summary).toBe("example.com: AI visibility 70/100 (no like-for-like change yet).");
    expect(notRecorded.note).toMatch(/do not record what each audit asked/);

    const baseline = await run(site({ comparison: { status: "baseline" }, snapshots_count: 1 }));
    expect(baseline.summary).toBe("example.com: AI visibility 70/100 (baseline; no change yet).");
    expect(baseline).not.toHaveProperty("note");
  });
});
