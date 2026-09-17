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

  it("a domain with no latest score says why, calling no audited domain unaudited and no claimed run an audit", async () => {
    // The same words at any age: nothing bounds how long a run takes after its
    // stamp, so the summary cannot tell a run still going from one that failed.
    const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const weekOld = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const storedNone = (domain: string, at: string) =>
      `${domain}: its scheduled run on ${at.slice(0, 10)} has stored no snapshot, so there is no score. `
      + "A run stores none while it is still going, if it fails, or if it is skipped.";
    const site = (over: object) => ({
      domain: "example.com",
      cadence: "weekly",
      active: true,
      last_audited_at: "2026-09-07T09:00:00Z",
      next_run_at: "2026-09-14T09:00:00Z",
      snapshots_count: 0,
      latest: null,
      previous: null,
      ...over,
    });
    const statusFn = vi.fn(async () => ({
      limit: 5,
      used: 5,
      remaining: 0,
      sites: [
        site({ domain: "shoes.com", snapshots_count: 3 }),
        site({ domain: "boots.com", snapshots_count: 1 }),
        site({ domain: "stored-none.com" }),
        site({ domain: "recent.com", last_audited_at: recent }),
        site({ domain: "week-old.com", last_audited_at: weekOld }),
        site({ domain: "counted-recent.com", snapshots_count: 3, last_audited_at: recent }),
        site({ domain: "hand-only.com", snapshots_count: 2, last_audited_at: null }),
        site({
          domain: "older-api.com",
          snapshots_count: 3,
          // Older than the last run, as when that run failed: the date is the snapshot's.
          latest: { score: null, by_engine: {}, captured_at: "2026-08-31T09:00:00Z", is_simulated: false },
          previous: { score: 55, by_engine: {}, captured_at: "2026-08-24T09:00:00Z", is_simulated: false },
        }),
      ],
    }));
    const res = await getMonitoringStatus({}, makeDeps({ tier: "pro", client: { getMonitoringStatus: statusFn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const summary = Object.fromEntries(res.data.sites.map((s) => [s.domain, s.summary]));
    expect(summary).toEqual({
      "shoes.com": "shoes.com: audited, but none of its 3 snapshots measured the business, so there is no score.",
      "boots.com": "boots.com: audited, but its one snapshot did not measure the business, so there is no score.",
      "stored-none.com": "stored-none.com: its scheduled run on 2026-09-07 has stored no snapshot, so there is no score. A run stores none while it is still going, if it fails, or if it is skipped.",
      "recent.com": storedNone("recent.com", recent),
      "week-old.com": storedNone("week-old.com", weekOld),
      "counted-recent.com": "counted-recent.com: audited, but none of its 3 snapshots measured the business, so there is no score.",
      "hand-only.com": "hand-only.com: audited, but none of its 2 snapshots measured the business, so there is no score.",
      "older-api.com": "older-api.com: its latest snapshot, on 2026-08-31, has no score.",
    });
    expect(res.data.sites.every((s) => s.latest_score === null && s.change === null)).toBe(true);
  });
});

describe("get_monitoring_status: a score older than the last scheduled run", () => {
  it("names that run and the score's date, so the score is not read as current", async () => {
    const site = (over: object) => ({
      domain: "example.com", cadence: "weekly", active: true, next_run_at: "2026-09-14T09:00:00Z", snapshots_count: 3,
      latest: snapshot(55, "2026-08-31T09:00:00Z"), previous: snapshot(50, "2026-08-24T09:00:00Z"),
      comparison: { status: "compared", skipped_snapshots: 0 },
      ...over,
    });
    const statusFn = vi.fn(async () => ({
      limit: 5, used: 2, remaining: 3,
      sites: [
        site({ domain: "stale.com", last_audited_at: "2026-09-07T09:00:00Z" }),
        site({ domain: "current.com", last_audited_at: "2026-08-31T09:00:00Z" }),
      ],
    }));
    const res = await getMonitoringStatus({}, makeDeps({ tier: "pro", client: { getMonitoringStatus: statusFn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const summary = Object.fromEntries(res.data.sites.map((s) => [s.domain, s.summary]));
    expect(summary).toEqual({
      "stale.com": "stale.com: AI visibility 55/100 (up 5 since 2026-08-24). That score is from 2026-08-31; "
        + "the scheduled run on 2026-09-07 has stored no measured snapshot.",
      "current.com": "current.com: AI visibility 55/100 (up 5 since 2026-08-24).",
    });
  });

  it("names a run claimed an hour after the score on the same day, beside no change", async () => {
    // The instants decide, not the dates: an audit at 08:00 whose snapshot is the site's baseline, then the weekly run
    // claimed at 09:00, which stored no measured snapshot.
    const statusFn = vi.fn(async () => ({
      limit: 5, used: 1, remaining: 4,
      sites: [{
        domain: "example.com", cadence: "weekly", active: true, next_run_at: "2026-09-14T09:00:00Z", snapshots_count: 1,
        last_audited_at: "2026-09-07T09:00:00Z", latest: snapshot(55, "2026-09-07T08:00:00Z"), previous: null,
        comparison: { status: "baseline" },
      }],
    }));
    const res = await getMonitoringStatus({}, makeDeps({ tier: "pro", client: { getMonitoringStatus: statusFn } }));
    if (!res.ok) throw new Error(`expected a result, got ${res.error.code}`);
    const site = res.data.sites[0]!;
    expect(site.change).toBeNull();
    expect(site.summary).toBe(
      "example.com: AI visibility 55/100 (baseline; no change yet). That score is from 2026-09-07; the scheduled run "
      + "on 2026-09-07 has stored no measured snapshot.");
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
      "Compared with 2026-09-01, the most recent snapshot that asked the same question; passed over in between: "
      + "1 snapshot that asked a different question or did not record what was asked.");
  });

  it("a re-baseline is said, not subtracted", async () => {
    const out = await run(site({
      latest: snapshot(70, "2026-09-08T09:00:00Z", ELSEWHERE),
      comparison: { status: "rebaselined", prior: { captured_at: "2026-09-01T09:00:00Z", question: ASKED } },
    }));
    expect(out.change).toBeNull();
    expect(out.summary).toBe("example.com: AI visibility 70/100 (re-baselined on 2026-09-08; no like-for-like change yet).");
    expect(out.note).toBe(
      'Re-baselined on 2026-09-08: it asked about the market "Honolulu, HI" rather than none, compared with the '
      + "snapshot on 2026-09-01, and no earlier snapshot asked the same question, so there is no like-for-like "
      + "change yet.");
  });

  it("never subtracts a pair it cannot confirm asked the same question, whichever API sent it", async () => {
    // An API from before the rule returns the snapshot just before, whatever it
    // asked, and no comparison at all.
    const different = await run(site({ previous: snapshot(20, "2026-09-01T09:00:00Z", ELSEWHERE) }));
    expect(different.change).toBeNull();
    expect(different.summary).toBe("example.com: AI visibility 70/100 (no like-for-like change yet).");
    expect(different.note).toBe(
      'The previous snapshot, on 2026-09-01, asked about the market "Honolulu, HI" rather than none, so no '
      + "like-for-like change can be shown.");

    const unrecorded = await run(site({
      latest: snapshot(70, "2026-09-08T09:00:00Z", null),
      previous: snapshot(20, "2026-09-01T09:00:00Z", null),
    }));
    expect(unrecorded.change).toBeNull();
    expect(unrecorded.note).toBe(
      "The latest snapshot does not record what it asked the assistants, so no like-for-like change can be shown.");
  });

  it("reads not_recorded and baseline as what they are", async () => {
    const notRecorded = await run(site({
      latest: snapshot(70, "2026-09-08T09:00:00Z", null), comparison: { status: "not_recorded" },
    }));
    expect(notRecorded.change).toBeNull();
    expect(notRecorded.summary).toBe("example.com: AI visibility 70/100 (no like-for-like change yet).");
    expect(notRecorded.note).toMatch(/^The latest snapshot does not record what it asked/);

    const baseline = await run(site({ comparison: { status: "baseline" }, snapshots_count: 1 }));
    expect(baseline.summary).toBe("example.com: AI visibility 70/100 (baseline; no change yet).");
    expect(baseline).not.toHaveProperty("note");
  });

  it("a re-baseline after snapshots that recorded nothing says so, and nothing it cannot know", async () => {
    const out = await run(site({
      comparison: { status: "rebaselined", prior: { captured_at: "2026-09-01T09:00:00Z", question: null } },
    }));
    expect(out.change).toBeNull();
    expect(out.note).toBe(
      "Re-baselined on 2026-09-08: the snapshots before it do not record what they asked, so there is no "
      + "like-for-like change yet.");
  });

  it("reads a malformed question as unrecorded, not as a re-baseline, and the other sites still report", async () => {
    const statusFn = vi.fn(async () => ({
      limit: 5,
      used: 2,
      remaining: 3,
      sites: [
        site({
          latest: snapshot(70, "2026-09-08T09:00:00Z", { key: 7, business_name: ["Example"], queries: "best example" }),
          comparison: { status: "rebaselined", prior: { captured_at: 42, question: "q-example" } },
        }),
        site({
          domain: "healthy.com",
          previous: snapshot(50, "2026-09-01T09:00:00Z"),
          comparison: { status: "compared", skipped_snapshots: 0 },
        }),
      ],
    }));
    const res = await getMonitoringStatus({}, makeDeps({ tier: "pro", client: { getMonitoringStatus: statusFn } }));
    if (!res.ok) throw new Error(`expected a result, got ${res.error.code}`);
    const [malformed, healthy] = res.data.sites;
    expect(malformed!.change).toBeNull();
    expect(malformed!.summary).toBe("example.com: AI visibility 70/100 (no like-for-like change yet).");
    expect(malformed!.note).toMatch(/^The latest snapshot does not record what it asked/);
    expect(healthy!.summary).toBe("healthy.com: AI visibility 70/100 (up 20 since 2026-09-01).");
  });

  it("says it is the previous snapshot that recorded nothing, when it is", async () => {
    // An API from before the rule hands over the snapshot just before, whatever it recorded.
    const out = await run(site({ previous: snapshot(20, "2026-09-01T09:00:00Z", null) }));
    expect(out.change).toBeNull();
    expect(out.note).toBe(
      "The previous snapshot, on 2026-09-01, does not record what it asked the assistants, so no like-for-like "
      + "change can be shown.");
  });
});

describe("get_monitoring_status: a change whose snapshots different engines answered", () => {
  // The digest refuses the overall for this (digest.js detectMeaningfulChange);
  // the status pull used to render it anyway, as "up 20" from an overall the
  // denominator of which changed. A snapshot here is the shared helper's but
  // with a claude-less week: nulls are how the monitoring path marks silence.
  const site = (over: Record<string, unknown>) => ({
    domain: "example.com",
    cadence: "weekly",
    active: true,
    last_audited_at: "2026-09-08T09:00:00Z",
    next_run_at: "2026-09-15T09:00:00Z",
    snapshots_count: 3,
    ...over,
  });
  const run = async (s: Record<string, unknown>) => {
    const statusFn = vi.fn(async () => ({ limit: 5, used: 1, remaining: 4, sites: [s] }));
    const res = await getMonitoringStatus({}, makeDeps({ tier: "pro", client: { getMonitoringStatus: statusFn } }));
    if (!res.ok) throw new Error(`expected a result, got ${res.error.code}`);
    return res.data.sites[0]!;
  };

  it("shows the per-engine changes only, and says which engines answered each snapshot", async () => {
    const out = await run(site({
      latest: {
        score: 70, by_engine: { chatgpt: 70, perplexity: 70, claude: null, gemini: 70 },
        captured_at: "2026-09-08T09:00:00Z", is_simulated: false, question: ASKED,
      },
      previous: snapshot(50, "2026-09-01T09:00:00Z"),
    }));
    expect(out.change!.score_delta).toBeNull(); // not 20: claude answered only the earlier snapshot
    expect(out.change!.from_captured_at).toBe("2026-09-01T09:00:00Z");
    expect(out.change!.to_captured_at).toBe("2026-09-08T09:00:00Z");
    expect(out.change!.overall_note).toBe(
      "The overall score is not compared: ChatGPT, Perplexity, Claude and Gemini answered the earlier snapshot and "
      + "ChatGPT, Perplexity and Gemini the later one, so the two scores were each computed over a different set of "
      + "engines. Engines that answered both are still compared one by one.");
    expect(out.change!.engine_changes).toEqual([
      { engine: "chatgpt", from: 50, to: 70, delta: 20 },
      { engine: "perplexity", from: 50, to: 70, delta: 20 },
      { engine: "gemini", from: 50, to: 70, delta: 20 },
    ]);
    expect(out.summary).toBe("example.com: AI visibility 70/100 (per-engine changes only since 2026-09-01).");
    expect(out.note).toBe(out.change!.overall_note);
  });

  it("joins the engine difference with what it passed over, when both apply", async () => {
    const out = await run(site({
      latest: {
        score: 70, by_engine: { chatgpt: 70, perplexity: 70, claude: null, gemini: 70 },
        captured_at: "2026-09-08T09:00:00Z", is_simulated: false, question: ASKED,
      },
      previous: snapshot(50, "2026-09-01T09:00:00Z"),
      comparison: { status: "compared", skipped_snapshots: 1 },
    }));
    expect(out.change!.score_delta).toBeNull();
    expect(out.change!.skipped_snapshots).toBe(1);
    expect(out.note).toBe(
      "The overall score is not compared: ChatGPT, Perplexity, Claude and Gemini answered the earlier snapshot and "
      + "ChatGPT, Perplexity and Gemini the later one, so the two scores were each computed over a different set of "
      + "engines. Engines that answered both are still compared one by one. "
      + "Compared with 2026-09-01, the most recent snapshot that asked the same question; passed over in between: "
      + "1 snapshot that asked a different question or did not record what was asked.");
  });

  it("an engine silent on both sides is not a change of engines, and the overall stands", async () => {
    const out = await run(site({
      latest: {
        score: 70, by_engine: { chatgpt: 70, perplexity: 70, claude: null, gemini: 70 },
        captured_at: "2026-09-08T09:00:00Z", is_simulated: false, question: ASKED,
      },
      previous: {
        score: 50, by_engine: { chatgpt: 50, perplexity: 50, claude: null, gemini: 50 },
        captured_at: "2026-09-01T09:00:00Z", is_simulated: false, question: ASKED,
      },
    }));
    expect(out.change!.score_delta).toBe(20);
    expect(out.change).not.toHaveProperty("overall_note");
    expect(out.summary).toBe("example.com: AI visibility 70/100 (up 20 since 2026-09-01).");
    expect(out.note).toBeUndefined();
  });
});

describe("get_monitoring_status: a score of 0 is a score", () => {
  // A 0 here is a measurement: the assistants answered and none named the
  // business. The API stores no score for a declined page, an invented name
  // scoring 0, an unscannable host or a run no engine answered, and sends as
  // latest and previous only snapshots that measured the business. Read as
  // none, a latest 0 would be summarized as a snapshot with no score, a previous
  // 0 would leave a like-for-like pair uncompared behind a note that it asked
  // something else, and an engine's 0 would drop out of the change.
  const site = (latest: unknown, previous: unknown) => ({
    domain: "example.com",
    cadence: "weekly",
    active: true,
    last_audited_at: "2026-09-08T09:00:00Z",
    next_run_at: "2026-09-15T09:00:00Z",
    snapshots_count: 2,
    latest,
    previous,
    comparison: { status: "compared", skipped_snapshots: 0 },
  });
  const run = async (s: Record<string, unknown>) => {
    const statusFn = vi.fn(async () => ({ limit: 5, used: 1, remaining: 4, sites: [s] }));
    const res = await getMonitoringStatus({}, makeDeps({ tier: "pro", client: { getMonitoringStatus: statusFn } }));
    if (!res.ok) throw new Error(`expected a result, got ${res.error.code}`);
    return res.data.sites[0]!;
  };
  // snapshot() scores every engine as the whole, so every engine moves with it.
  const everyEngine = (from: number, to: number) =>
    ["chatgpt", "perplexity", "claude", "gemini"].map((engine) => ({ engine, from, to, delta: to - from }));

  it("a latest snapshot that scored 0 has a score and a change, every engine's 0 included", async () => {
    const out = await run(site(snapshot(0, "2026-09-08T09:00:00Z"), snapshot(55, "2026-09-01T09:00:00Z")));
    expect(out.latest_score).toBe(0);
    expect(out.summary).toBe("example.com: AI visibility 0/100 (down 55 since 2026-09-01).");
    expect(out.change).not.toBeNull();
    expect(out.change!.score_delta).toBe(-55);
    expect(out.change!.engine_changes).toEqual(everyEngine(55, 0));
    expect(out.change!.from_captured_at).toBe("2026-09-01T09:00:00Z");
    expect(out.change!.to_captured_at).toBe("2026-09-08T09:00:00Z");
    expect(out).not.toHaveProperty("note");
  });

  it("a previous snapshot that scored 0 is compared with, every engine's 0 included, and no note says otherwise", async () => {
    const out = await run(site(snapshot(55, "2026-09-08T09:00:00Z"), snapshot(0, "2026-09-01T09:00:00Z")));
    expect(out.latest_score).toBe(55);
    expect(out.summary).toBe("example.com: AI visibility 55/100 (up 55 since 2026-09-01).");
    expect(out.change).not.toBeNull();
    expect(out.change!.score_delta).toBe(55);
    expect(out.change!.engine_changes).toEqual(everyEngine(0, 55));
    expect(out.change!.from_captured_at).toBe("2026-09-01T09:00:00Z");
    expect(out.change!.to_captured_at).toBe("2026-09-08T09:00:00Z");
    expect(out).not.toHaveProperty("note");
  });
});
