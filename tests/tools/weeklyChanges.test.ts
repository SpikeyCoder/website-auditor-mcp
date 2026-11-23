/**
 * `weekly_changes` on the main tools' replies while the account is in a trial
 * (src/tools/weeklyChanges.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildWeeklyChanges,
  clearWeeklyChangesCache,
  weeklyChangesCacheSize,
  invalidateWeeklyChanges,
  weeklyChangesField,
  WEEKLY_MAX_ENTRIES,
  WEEKLY_READ_TIMEOUT_MS,
  WEEKLY_TOTAL_TIMEOUT_MS,
  WEEKLY_TTL_MS,
} from "../../src/tools/weeklyChanges.js";
import { compareCompetitors } from "../../src/tools/compareCompetitors.js";
import { runAudit } from "../../src/tools/runAudit.js";
import { getAiVisibility } from "../../src/tools/getAiVisibility.js";
import { getRecommendations } from "../../src/tools/getRecommendations.js";
import { getMonitoringStatus } from "../../src/tools/getMonitoringStatus.js";
import { getReport } from "../../src/tools/getReport.js";
import { checkUpgradeStatus } from "../../src/tools/checkUpgradeStatus.js";
import { trackSite } from "../../src/tools/trackSite.js";
import { WaApiError } from "../../src/api/errors.js";
import { OUTPUT_SCHEMAS } from "../../src/tools/outputSchemas.js";
import type { MonitoringSite, MonitoringStatus } from "../../src/api/types.js";
import { fixedResolution, makeDeps } from "../helpers.js";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";
import { buildInstructions } from "../../src/mcp/instructions.js";
import { startWeeklyChanges } from "../../src/tools/weeklyChanges.js";
import { describeSite } from "../../src/tools/getMonitoringStatus.js";
import { WaApiClient } from "../../src/api/client.js";
import { testConfig } from "../helpers.js";

const by = (o: Partial<Record<string, number | null>> = {}) => ({
  chatgpt: 50, perplexity: 50, claude: 50, gemini: 50, google_ai_overviews: null, copilot: null, ...o,
});
const q = { key: "k1", business_name: "Acme", queries: ["a"] };
const snap = (score: number, at: string, eng = by()) => ({
  score, captured_at: at, by_engine: eng, question: q, run_id: "r", is_simulated: false,
} as unknown as MonitoringSite["latest"]);

function site(domain: string, over: Partial<MonitoringSite> = {}): MonitoringSite {
  return {
    domain, cadence: "weekly", active: true, last_audited_at: "2026-11-16T00:00:00Z",
    next_run_at: "2999-01-01T00:00:00Z", snapshots_count: 2,
    latest: snap(60, "2026-11-16T00:00:00Z", by({ perplexity: 60 })),
    previous: snap(55, "2026-11-09T00:00:00Z"),
    ...over,
  } as MonitoringSite;
}
const status = (...sites: MonitoringSite[]): MonitoringStatus => ({ limit: 5, used: sites.length, remaining: 5 - sites.length, sites });

const trial = { tier: "pro", verified: true, trialing: true } as const;
const paid = { tier: "pro", verified: true } as const;

function deps(resolution: Parameters<typeof fixedResolution>[0], getMonitoringStatus: () => Promise<MonitoringStatus>, apiKey = "wa_trial_1") {
  return makeDeps({
    subscriptions: fixedResolution(resolution),
    client: { getMonitoringStatus: vi.fn(getMonitoringStatus) },
    config: { apiKey },
  });
}

beforeEach(() => {
  clearWeeklyChangesCache();
  // The fixtures are dated: pin the clock (Date only) so "this week" stays true.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("weeklyChangesField: who gets it", () => {
  it("a trial account gets the block with what moved and the next check", async () => {
    const d = deps(trial, async () => status(site("example.com")));
    const { weekly_changes: w } = await weeklyChangesField(d);
    expect(w?.tracking).toBe(true);
    expect(w?.summary).toContain("example.com: AI visibility 60/100 (up 5 since 2026-11-09).");
    expect(w?.summary).toContain("By assistant: Perplexity up 10.");
    expect(w?.sites[0]!.detail).toBeUndefined();
    expect(w?.summary).toContain("Next weekly check: 2999-01-01.");
    expect(w?.summary).not.toMatch(/this week/i);
    expect(w?.sites[0]).toMatchObject({ domain: "example.com", latest_score: 60, score_delta: 5, since: "2026-11-09" });
    expect(w?.next_check_at).toBe("2999-01-01T00:00:00Z");
  });

  it("a paying (non-trial) account gets nothing and costs no read", async () => {
    const d = deps(paid, async () => status(site("example.com")));
    expect(await weeklyChangesField(d)).toEqual({});
    expect(d.client.getMonitoringStatus).not.toHaveBeenCalled();
  });

  it("a free, unverified or keyless caller gets nothing", async () => {
    for (const r of [{ tier: "free", verified: true }, { tier: "free", verified: false }, { tier: "none", verified: true }] as const) {
      const d = deps(r, async () => status(site("example.com")));
      expect(await weeklyChangesField(d)).toEqual({});
      expect(d.client.getMonitoringStatus).not.toHaveBeenCalled();
    }
    const keyless = makeDeps({ subscriptions: fixedResolution(trial), config: { apiKey: undefined } });
    expect(await weeklyChangesField(keyless)).toEqual({});
  });
});

const cfg = () => ({ config: makeDeps().config });
const quietSite = (d: string) => site(d, { latest: snap(55, "2026-11-16T00:00:00Z"), previous: snap(55, "2026-11-09T00:00:00Z") });

describe("weeklyChangesField: what it says", () => {
  it("every active site compared and quiet: says no tracked site has changed, with each site's own since", async () => {
    const { weekly_changes: w } = await weeklyChangesField(deps(trial, async () => status(quietSite("example.com"))));
    expect(w?.summary).toMatch(/^No tracked site has changed — example\.com: AI visibility 55\/100 \(unchanged since 2026-11-09\)/);
  });

  it("no tracked site gives the one-line nudge; neutral copy names no tool", async () => {
    const { weekly_changes: w } = await weeklyChangesField(deps(trial, async () => status()));
    expect(w).toMatchObject({ tracking: false, next_check_at: null, sites: [] });
    expect(w?.summary).toContain("track_site");
    clearWeeklyChangesCache();
    const neutral = makeDeps({
      subscriptions: fixedResolution(trial),
      client: { getMonitoringStatus: vi.fn(async () => status()) },
      config: { toolCopy: "neutral" },
    });
    const n = (await weeklyChangesField(neutral)).weekly_changes;
    expect(n?.tracking).toBe(false);
    expect(n?.summary).not.toMatch(/track_site/);
  });

  it("a baseline is not 'no change'; assess's own words carry it", () => {
    const w = buildWeeklyChanges([site("shop.example.org", { previous: null })], cfg(), Date.now());
    expect(w.summary).toMatch(/^Weekly tracking — shop\.example\.org: AI visibility 60\/100 \(baseline; no change yet\)\./);
    expect(w.summary).not.toMatch(/Latest changes/);
    expect(w.sites[0]!.score_delta).toBeNull();
  });

  it("a re-baselined site and a changed question read as get_monitoring_status words them", () => {
    const rebased = site("a.example.com", {
      previous: null,
      comparison: { status: "rebaselined", prior: snap(40, "2026-11-02T00:00:00Z") } as unknown as MonitoringSite["comparison"],
    });
    const changedQ = site("b.example.com", {
      previous: { ...snap(50, "2026-11-09T00:00:00Z"), question: { key: "k2", business_name: "Acme", queries: ["b"] } } as unknown as MonitoringSite["previous"],
    });
    const w = buildWeeklyChanges([rebased, changedQ], cfg(), Date.now());
    expect(w.summary).toContain("a.example.com: AI visibility 60/100 (re-baselined on 2026-11-16; no like-for-like change yet).");
    expect(w.sites[0]!.detail).toContain("Re-baselined on 2026-11-16");
    expect(w.summary).toContain("b.example.com: AI visibility 60/100 (no like-for-like change yet).");
    expect(w.summary).not.toMatch(/^No tracked site has changed/);
  });

  it("every tracked site paused: its own line, tracking true, no nudge", () => {
    const w = buildWeeklyChanges([site("a.example.com", { active: false }), site("b.example.com", { active: false })], cfg(), Date.now());
    expect(w).toMatchObject({ tracking: true, sites: [] });
    expect(w.summary).toBe("Weekly checks are paused for your tracked sites.");
    const one = buildWeeklyChanges([site("a.example.com", { active: false })], cfg(), Date.now());
    expect(one.summary).toBe("Weekly checks are paused for your tracked site.");
    expect(buildWeeklyChanges([site("bad domain")], cfg(), Date.now()).summary).toBe("1 tracked site can't be shown here (get_monitoring_status lists it).");
    expect(w.summary).not.toMatch(/track_site|No site is tracked/);
  });

  it("only unreadable domains tracked: tracking true, no nudge", () => {
    const w = buildWeeklyChanges([site("bad domain")], cfg(), Date.now());
    expect(w.tracking).toBe(true);
    expect(w.summary).not.toMatch(/track_site|No site is tracked/);
  });

  it("hidden sites that were only never compared are not 'some with changes'", () => {
    const baseline = (d: string) => site(d, { previous: null });
    const w = buildWeeklyChanges([quietSite("a.example.com"), quietSite("b.example.com"), quietSite("c.example.com"), baseline("d.example.com"), baseline("e.example.com")], cfg(), Date.now());
    expect(w.summary).toContain("2 more tracked.");
    expect(w.summary).not.toMatch(/some with changes/);
  });

  it("a site with the older-score caveat is not quiet, and not compared", () => {
    const stale = site("a.example.com", { latest: snap(55, "2026-11-16T00:00:00Z"), previous: snap(55, "2026-11-09T00:00:00Z"), last_audited_at: "2026-11-20T00:00:00Z" });
    const w = buildWeeklyChanges([stale], cfg(), Date.now());
    expect(w.summary).not.toMatch(/No (active )?tracked site has changed/);
    expect(w.summary).toContain("That score is from 2026-11-16");
    expect(w.summary).toMatch(/^Weekly tracking —/);
  });

  it("an overdue check keeps its timestamp and says so", () => {
    const past = site("a.example.com", { next_run_at: "2026-11-16T00:00:00Z" });
    const w = buildWeeklyChanges([past], cfg(), Date.parse("2026-11-18T00:00:00Z"));
    expect(w.next_check_at).toBe("2026-11-16T00:00:00Z");
    expect(w.next_check_due).toBe(true);
    const ahead = buildWeeklyChanges([site("a.example.com")], cfg(), Date.parse("2026-11-18T00:00:00Z"));
    expect(ahead).not.toHaveProperty("next_check_due");
  });

  it("any run already past makes the check overdue, naming the earliest", () => {
    const w = buildWeeklyChanges([site("a.example.com", { next_run_at: "2026-11-16T00:00:00Z" }), site("b.example.com")], cfg(), Date.parse("2026-11-18T00:00:00Z"));
    expect(w.next_check_due).toBe(true);
    expect(w.next_check_at).toBe("2026-11-16T00:00:00Z");
  });

  it("when every next run is past, the earliest is still reported, as due", () => {
    const past = (d: string, t: string) => site(d, { next_run_at: t });
    const w = buildWeeklyChanges([past("a.example.com", "2026-11-17T00:00:00Z"), past("b.example.com", "2026-11-16T00:00:00Z")], cfg(), Date.parse("2026-11-18T00:00:00Z"));
    expect(w.next_check_at).toBe("2026-11-16T00:00:00Z");
    expect(w.summary).toContain("Next weekly check: due now (scheduled 2026-11-16).");
  });

  it("the headline stays short: engines and notes are in detail, the older-score caveat stays in the line", () => {
    const w = buildWeeklyChanges([site("example.com", { last_audited_at: "2026-11-20T00:00:00Z" })], cfg(), Date.now());
    expect(w.summary).not.toMatch(/passed over/);
    expect(w.summary).toContain("By assistant: Perplexity up 10.");
    expect(w.sites[0]!.detail).toBeUndefined();
    expect(w.summary.length).toBeLessThan(260);
  });

  it("no overall (different engines): the top two engine moves are in the line", () => {
    const s = site("example.com", {
      latest: snap(60, "2026-11-16T00:00:00Z", by({ copilot: 70, chatgpt: 70, perplexity: 20 })),
    });
    const w = buildWeeklyChanges([s], cfg(), Date.now());
    const line = w.summary.match(/By assistant: ([^.]*)\./)![1]!;
    expect(line.split(", ")).toHaveLength(2);
    expect(w.sites[0]!.score_delta).toBeNull();
  });

  it("an extra engine beyond two goes to detail as 'Also'", () => {
    const s = site("example.com", {
      latest: snap(60, "2026-11-16T00:00:00Z", by({ copilot: 70, chatgpt: 80, perplexity: 20, claude: 70 })),
    });
    const w = buildWeeklyChanges([s], cfg(), Date.now());
    expect(w.sites[0]!.engines).toHaveLength(3);
    expect(w.sites[0]!.detail).toMatch(/^Also: Claude up 20\. /);
  });

  it("unreadable active domains count as tracked and block the no-change lead", () => {
    const w = buildWeeklyChanges([quietSite("a.example.com"), site("bad domain")], cfg(), Date.now());
    expect(w.summary).toContain("1 more tracked.");
    expect(w.summary).not.toMatch(/No (active )?tracked site has changed/);
  });

  it("a mix of paused and unreadable sites is not called 'paused'", () => {
    const w = buildWeeklyChanges([site("a.example.com", { active: false }), site("bad domain")], cfg(), Date.now());
    expect(w.summary).toBe("Your tracked sites: 1 paused; 1 can't be shown here (get_monitoring_status lists it).");
    const two = buildWeeklyChanges([site("bad domain"), site("also bad")], cfg(), Date.now());
    expect(two.summary).toBe("2 tracked sites can't be shown here (get_monitoring_status lists them).");
    expect(two.summary).not.toMatch(/no weekly result/);
    const neutral = buildWeeklyChanges([site("bad domain")], { config: makeDeps({ config: { toolCopy: "neutral" } }).config }, Date.now());
    expect(neutral.summary).toBe("1 tracked site can't be shown here.");
  });

  it("paused sites are counted beside the active ones, and change the lead", () => {
    const w = buildWeeklyChanges([quietSite("a.example.com"), site("b.example.com", { active: false })], cfg(), Date.now());
    expect(w.summary).toMatch(/^No active tracked site has changed — a\.example\.com/);
    expect(w.summary).toContain("1 paused.");
    const none = buildWeeklyChanges([quietSite("a.example.com")], cfg(), Date.now());
    expect(none.summary).toMatch(/^No tracked site has changed/);
    expect(none.summary).not.toMatch(/paused/);
  });

  it("the first-check branch carries the same more-tracked and paused suffix", () => {
    const none = (d: string) => site(d, { latest: null, previous: null, snapshots_count: 0, last_audited_at: null });
    const w = buildWeeklyChanges(
      [none("a.example.com"), none("b.example.com"), none("c.example.com"), none("d.example.com"), none("e.example.com"), site("f.example.com", { active: false })],
      cfg(), Date.now());
    expect(w.summary).toBe("The first weekly check hasn't run yet. 2 more tracked, 1 paused. Next weekly check: 2999-01-01.");
  });

  it("the first check has not run: no snapshot and no run on any active site", () => {
    const none = (d: string) => site(d, { latest: null, previous: null, snapshots_count: 0, last_audited_at: null });
    const w = buildWeeklyChanges([none("a.example.com"), none("b.example.com")], cfg(), Date.now());
    expect(w.summary).toBe("The first weekly check hasn't run yet. Next weekly check: 2999-01-01.");
    expect(w.tracking).toBe(true);
    expect(w.sites).toHaveLength(2);
  });

  it("an unscored site keeps its reason: unmeasured snapshots, and a run that stored none", () => {
    const unmeasured = site("a.example.com", { latest: null, previous: null, snapshots_count: 3 });
    const ranNoSnapshot = site("b.example.com", { latest: null, previous: null, snapshots_count: 0 });
    const w = buildWeeklyChanges([unmeasured, ranNoSnapshot], cfg(), Date.now());
    expect(w.summary).toContain("a.example.com: audited, but none of its 3 snapshots measured the business, so there is no score.");
    expect(w.summary).toContain("b.example.com: its scheduled run on 2026-11-16 has stored no snapshot");
    expect(w.summary).not.toMatch(/first weekly check/);
  });

  it("a score older than the last run says so", () => {
    const stale = site("example.com", { last_audited_at: "2026-11-20T00:00:00Z" });
    const w = buildWeeklyChanges([stale], cfg(), Date.now());
    expect(w.summary).toContain("(up 5 since 2026-11-09). That score is from 2026-11-16; the scheduled run on 2026-11-20 has stored no measured snapshot.");
  });

  it("an on-demand audit's snapshot is worded by its own date, not as 'this week'", () => {
    const w = buildWeeklyChanges([site("example.com", { previous: snap(55, "2026-11-17T09:00:00Z") })], cfg(), Date.now());
    expect(w.summary).toContain("up 5 since 2026-11-17");
    expect(w.summary).not.toMatch(/this week/i);
  });

  it("snapshots passed over keep their note", () => {
    const w = buildWeeklyChanges([
      site("example.com", { comparison: { status: "compared", skipped_snapshots: 2 } as unknown as MonitoringSite["comparison"] }),
    ], cfg(), Date.now());
    expect(w.sites[0]!.detail).toContain("passed over in between: 2 snapshots");
    expect(w.summary).not.toContain("passed over");
  });

  it("different engines on the two snapshots: engine moves and the note, never 'unchanged'", () => {
    const s = site("example.com", { latest: snap(60, "2026-11-16T00:00:00Z", by({ copilot: 70 })) });
    const w = buildWeeklyChanges([s], cfg(), Date.now());
    expect(w.sites[0]!.score_delta).toBeNull();
    expect(w.sites[0]!.since).toBe("2026-11-09");
    expect(w.summary).toContain("per-engine changes only since 2026-11-09");
    expect(w.summary).not.toMatch(/unchanged|No tracked site has changed/);
  });

  it("a site that moved is shown even when it is fourth in the list", () => {
    const mover = site("zzz.example.com");
    const w = buildWeeklyChanges(
      [quietSite("a.example.com"), quietSite("b.example.com"), quietSite("c.example.com"), mover],
      cfg(), Date.now());
    expect(w.sites.map((s) => s.domain)).toEqual(["zzz.example.com", "a.example.com", "b.example.com"]);
    expect(w.summary).toMatch(/^Latest changes — zzz\.example\.com: AI visibility 60\/100 \(up 5/);
    expect(w.summary).toContain("1 more tracked.");
    expect(w.summary).not.toMatch(/No tracked site has changed/);
  });

  it("a hidden mover is named as such, without a tool name under neutral copy", () => {
    const movers = ["a", "b", "c", "d"].map((x) => site(`${x}.example.com`));
    const full = buildWeeklyChanges(movers, cfg(), Date.now());
    expect(full.summary).toContain("1 more tracked, with changes (get_monitoring_status lists all).");
    const five = buildWeeklyChanges(["a", "b", "c", "d", "e"].map((x) => site(`${x}.example.com`)), cfg(), Date.now());
    expect(five.summary).toContain("2 more tracked, some with changes (get_monitoring_status lists all).");
    const neutral = buildWeeklyChanges(movers, { config: makeDeps({ config: { toolCopy: "neutral" } }).config }, Date.now());
    expect(neutral.summary).toContain("1 more tracked, with changes.");
    expect(neutral.summary).not.toMatch(/get_monitoring_status/);
  });

  it("is compact: three sites at most, three engines at most, inactive and unreadable sites left out", () => {
    const wide = by({ chatgpt: 60, perplexity: 40, claude: 70, gemini: 30 });
    const many = ["a", "b", "c", "d"].map((x) => site(`${x}.example.com`, { latest: snap(60, "2026-11-16T00:00:00Z", wide) }));
    const w = buildWeeklyChanges(
      [site("off.example.com", { active: false }), site("bad domain <script>"), ...many], cfg(), Date.now());
    expect(w.sites.map((s) => s.domain)).toEqual(["a.example.com", "b.example.com", "c.example.com"]);
    expect(w.sites[0]!.engines).toHaveLength(3);
    expect(w.summary).not.toMatch(/off\.example|script/);
  });

  it("per-site text is exactly what get_monitoring_status says for the same fixture", async () => {
    const fixtures = [
      site("a.example.com"),
      site("b.example.com", { previous: null }),
      site("c.example.com", { latest: null, previous: null, snapshots_count: 3 }),
    ];
    const st = status(...fixtures);
    const monitoring = await getMonitoringStatus({}, makeDeps({
      tier: "pro", client: { getMonitoringStatus: vi.fn(async () => st), listTrackedDomains: vi.fn(async () => ({ limit: 5, used: 0, remaining: 5, tracked: [] })) },
    }));
    if (!monitoring.ok) throw new Error("monitoring failed");
    const w = buildWeeklyChanges(fixtures, cfg(), Date.now());
    for (const ms of monitoring.data.sites) {
      const mine = w.sites.find((x) => x.domain === ms.domain)!;
      const headline = ms.summary.slice(0, ms.summary.indexOf(". ", ms.summary.indexOf(": ")) + 1 || undefined);
      expect(w.summary).toContain(headline);
      expect(ms.summary.startsWith(headline)).toBe(true);
      // The rest of get_monitoring_status's text (and its note) is the site's detail.
      const rest = ms.summary.slice(headline.length).trim();
      if (rest) expect(mine.detail).toContain(rest);
      if (ms.note) expect(mine.detail).toContain(ms.note);
    }
  });

  it("never says price, plan or trial", async () => {
    const { weekly_changes: w } = await weeklyChangesField(deps(trial, async () => status(site("example.com"))));
    expect(JSON.stringify(w)).not.toMatch(/\b(trial|price|plan|upgrade|subscri|\$)/i);
  });
});

describe("weeklyChangesField: cost and failure", () => {
  it("a second reply is served from the cache: one fetch", async () => {
    const d = deps(trial, async () => status(site("example.com")));
    const a = await weeklyChangesField(d);
    const b = await weeklyChangesField(d);
    expect(b).toEqual(a);
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T00:00:00Z"));
    const d = deps(trial, async () => status(site("example.com")));
    await weeklyChangesField(d);
    vi.setSystemTime(Date.now() + WEEKLY_TTL_MS + 1000);
    await weeklyChangesField(d);
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(2);
  });

  it("accounts never share an entry", async () => {
    const a = deps(trial, async () => status(site("alpha.example.com")), "wa_account_a");
    const b = deps(trial, async () => status(site("beta.example.com")), "wa_account_b");
    const ra = await weeklyChangesField(a);
    const rb = await weeklyChangesField(b);
    expect(JSON.stringify(ra)).toContain("alpha.example.com");
    expect(JSON.stringify(ra)).not.toContain("beta.example.com");
    expect(JSON.stringify(rb)).toContain("beta.example.com");
    expect(JSON.stringify(rb)).not.toContain("alpha.example.com");
  });

  it("a failed lookup leaves the reply unchanged, and is not retried on every reply", async () => {
    const d = deps(trial, async () => { throw new WaApiError("UPSTREAM_ERROR", "down"); });
    expect(await weeklyChangesField(d)).toEqual({});
    expect(await weeklyChangesField(d)).toEqual({});
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(1);
  });

  it("a slow lookup is given up on", async () => {
    vi.useFakeTimers();
    const d = deps(trial, () => new Promise<MonitoringStatus>(() => {}));
    const p = weeklyChangesField(d);
    await vi.advanceTimersByTimeAsync(WEEKLY_READ_TIMEOUT_MS + 10);
    expect(await p).toEqual({});
  });

  it("a failing subscription lookup leaves the reply unchanged", async () => {
    const d = makeDeps({ subscriptions: { resolve: async () => { throw new Error("boom"); } } });
    expect(await weeklyChangesField(d)).toEqual({});
  });

  it("a lookup in flight when the sites change cannot store its stale answer", async () => {
    let release!: (v: MonitoringStatus) => void;
    let calls = 0;
    const d = deps(trial, () => {
      calls += 1;
      return calls === 1 ? new Promise<MonitoringStatus>((r) => { release = r; }) : Promise.resolve(status(site("new.example.com")));
    });
    const first = weeklyChangesField(d);
    await vi.waitFor(() => expect(calls).toBe(1));
    invalidateWeeklyChanges(d);
    release(status());
    await first;
    const second = await weeklyChangesField(d);
    expect(calls).toBe(2);
    expect(JSON.stringify(second)).toContain("new.example.com");
  });

  it("concurrent callers for one account share one read", async () => {
    let release!: (v: MonitoringStatus) => void;
    const d = deps(trial, () => new Promise<MonitoringStatus>((r) => { release = r; }));
    const calls = [weeklyChangesField(d), weeklyChangesField(d), weeklyChangesField(d)];
    await vi.waitFor(() => expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(1));
    release(status(site("example.com")));
    const out = await Promise.all(calls);
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(1);
    expect(out[1]).toEqual(out[0]);
    expect(out[2]).toEqual(out[0]);
    expect(out[0].weekly_changes).toBeDefined();
  });

  it("clearing the cache also drops a lookup in flight", async () => {
    let release!: (v: MonitoringStatus) => void;
    let calls = 0;
    const d = deps(trial, () => {
      calls += 1;
      return calls === 1 ? new Promise<MonitoringStatus>((r) => { release = r; }) : Promise.resolve(status());
    });
    const first = weeklyChangesField(d);
    await vi.waitFor(() => expect(calls).toBe(1));
    clearWeeklyChangesCache();
    release(status(site("example.com")));
    await first;
    await weeklyChangesField(d);
    expect(calls).toBe(2);
  });

  it("the whole call is bounded: a slow subscription lookup is given up on", async () => {
    vi.useFakeTimers();
    const d = makeDeps({ subscriptions: { resolve: () => new Promise(() => {}) }, config: { apiKey: "wa_slow" } });
    const p = weeklyChangesField(d);
    await vi.advanceTimersByTimeAsync(WEEKLY_TOTAL_TIMEOUT_MS + 10);
    expect(await p).toEqual({});
  });

  it("the cache is bounded", async () => {
    const make = (i: number) => deps(trial, async () => status(site("example.com")), `wa_bound_${i}`);
    const first = make(0);
    await weeklyChangesField(first);
    for (let i = 1; i <= WEEKLY_MAX_ENTRIES; i++) await weeklyChangesField(make(i));
    // The oldest entry was dropped, so it reads again.
    await weeklyChangesField(first);
    expect(first.client.getMonitoringStatus).toHaveBeenCalledTimes(2);
  });

  it("tracking or untracking a site drops the entry", async () => {
    const d = deps(trial, async () => status());
    await weeklyChangesField(d);
    invalidateWeeklyChanges(d);
    await weeklyChangesField(d);
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(2);

    const t = makeDeps({
      subscriptions: fixedResolution(trial),
      client: { getMonitoringStatus: vi.fn(async () => status()) },
    });
    await weeklyChangesField(t);
    await trackSite({ domain: "example.com" }, t);
    await weeklyChangesField(t);
    expect(t.client.getMonitoringStatus).toHaveBeenCalledTimes(2);
  });
});

describe("the tools carry it", () => {
  const trialDeps = (over: Parameters<typeof makeDeps>[0] = {}) => makeDeps({
    subscriptions: fixedResolution(trial),
    client: {
      getMonitoringStatus: vi.fn(async () => status(site("example.com"))),
      getSubscription: vi.fn(async () => ({ tier: "pro" as const, status: "trialing" })),
      ...(over.client ?? {}),
    },
    ...("config" in over ? { config: over.config } : {}),
  });

  it.each([
    ["run_audit", (d: ReturnType<typeof makeDeps>) => runAudit({ domain: "other.example.net" }, d)],
    ["get_ai_visibility", (d: ReturnType<typeof makeDeps>) => getAiVisibility({ domain: "other.example.net" }, d)],
    ["get_report", (d: ReturnType<typeof makeDeps>) => getReport({ domain: "other.example.net" }, d)],
    ["get_recommendations", (d: ReturnType<typeof makeDeps>) => getRecommendations({ domain: "other.example.net" }, d)],
    ["check_upgrade_status", (d: ReturnType<typeof makeDeps>) => checkUpgradeStatus({}, d)],
  ] as const)("%s: a trial account gets it, a paying one does not, and the reply still matches its schema", async (name, call) => {
    const withTrial = await call(trialDeps());
    expect(withTrial.ok).toBe(true);
    const data = (withTrial as { data: Record<string, unknown> }).data;
    expect(data.weekly_changes).toBeDefined();
    const schema = z.object(OUTPUT_SCHEMAS[name]!).strict();
    expect(schema.safeParse(JSON.parse(JSON.stringify(data))).success).toBe(true);

    clearWeeklyChangesCache();
    const payingDeps = makeDeps({
      subscriptions: fixedResolution(paid),
      client: {
        getMonitoringStatus: vi.fn(async () => status(site("example.com"))),
        getSubscription: vi.fn(async () => ({ tier: "pro" as const, status: "active" })),
      },
    });
    const paying = await call(payingDeps);
    expect(paying.ok).toBe(true);
    expect((paying as { data: Record<string, unknown> }).data).not.toHaveProperty("weekly_changes");
    expect(payingDeps.client.getMonitoringStatus).not.toHaveBeenCalled();
  });

  it("a failed lookup leaves run_audit's reply exactly as it was", async () => {
    const failing = trialDeps({ client: { getMonitoringStatus: vi.fn(async () => { throw new Error("x"); }) } });
    const plain = makeDeps({ subscriptions: fixedResolution(paid) });
    const a = (await runAudit({ domain: "other.example.net" }, failing)) as { data: Record<string, unknown> };
    const b = (await runAudit({ domain: "other.example.net" }, plain)) as { data: Record<string, unknown> };
    expect(a.data).not.toHaveProperty("weekly_changes");
    expect(Object.keys(a.data).sort()).toEqual(Object.keys(b.data).sort());
  });

  it("get_report starts the weekly read beside the report read", async () => {
    const order: string[] = [];
    const d = trialDeps({ client: {
      getReport: vi.fn(async () => { order.push("report-start"); await Promise.resolve(); order.push("report-end"); return { report_url: "u", badge_html: "b" }; }),
      getMonitoringStatus: vi.fn(async () => { order.push("weekly-start"); return status(site("example.com")); }),
    } });
    const r = await getReport({ domain: "example.com" }, d);
    expect(r.ok).toBe(true);
    expect(order.indexOf("weekly-start")).toBeGreaterThan(-1);
    expect(order.indexOf("weekly-start")).toBeLessThan(order.indexOf("report-end"));
  });

  const audits = [
    ["run_audit", (d: ReturnType<typeof makeDeps>, dom: string) => runAudit({ domain: dom }, d)],
    ["get_ai_visibility", (d: ReturnType<typeof makeDeps>, dom: string) => getAiVisibility({ domain: dom }, d)],
  ] as const;

  it.each(audits)("%s: auditing a tracked site leaves it out of the block, with no extra read", async (_n, call) => {
    const d = trialDeps({ client: { getMonitoringStatus: vi.fn(async () => status(site("example.com"), site("other.example.org", { previous: null }))) } });
    await weeklyChangesField(d); // warm the cache
    const r = await call(d, "www.example.com"); // normalized
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(1);
    const w = (r as { data: { weekly_changes?: { summary: string; sites: { domain: string }[] } } }).data.weekly_changes;
    expect(w?.sites.map((x) => x.domain)).toEqual(["other.example.org"]);
    expect(w?.summary).not.toMatch(/example\.com/);
    expect(w?.summary).not.toMatch(/more tracked|paused/);
  });

  it.each(audits)("%s: auditing an untracked site leaves the block as it is", async (_n, call) => {
    const d = trialDeps();
    const r = await call(d, "rival.example.net");
    const w = (r as { data: { weekly_changes?: { sites: { domain: string }[] } } }).data.weekly_changes;
    expect(w?.sites.map((x) => x.domain)).toEqual(["example.com"]);
  });

  it.each(audits)("%s: auditing the only tracked site gives no block", async (_n, call) => {
    const d = trialDeps();
    const r = await call(d, "example.com");
    expect(r.ok).toBe(true);
    expect((r as { data: Record<string, unknown> }).data).not.toHaveProperty("weekly_changes");
  });

  it("an untracked-account nudge is not removed by an audit", async () => {
    const d = trialDeps({ client: { getMonitoringStatus: vi.fn(async () => status()) } });
    const r = await runAudit({ domain: "example.com" }, d);
    expect((r as { data: { weekly_changes?: { tracking: boolean } } }).data.weekly_changes?.tracking).toBe(false);
  });

  it.each([
    ["get_report", (d: ReturnType<typeof makeDeps>, dom: string) => getReport({ domain: dom }, d)],
    ["get_recommendations", (d: ReturnType<typeof makeDeps>, dom: string) => getRecommendations({ domain: dom }, d)],
  ] as const)("%s: keeps every tracked site in the block (the reply carries no score)", async (_n, call) => {
    const d = trialDeps({ client: { getMonitoringStatus: vi.fn(async () => status(site("example.com"), site("other.example.org"))) } });
    const r = await call(d, "example.com");
    const w = (r as { data: { weekly_changes?: { sites: { domain: string }[] } } }).data.weekly_changes;
    expect(w?.sites.map((x) => x.domain).sort()).toEqual(["example.com", "other.example.org"]);
  });

  it("a failed read that began before an audit cannot overwrite a newer successful one", async () => {
    let releaseOld!: (e: Error) => void;
    let calls = 0;
    const d = trialDeps({ client: { getMonitoringStatus: vi.fn(() => {
      calls += 1;
      if (calls === 1) return new Promise<MonitoringStatus>((_r, rej) => { releaseOld = rej; });
      return Promise.resolve(status(site("b.example.org")));
    }) } });
    const first = weeklyChangesField(d);                 // read 1 starts (pre-audit)
    await vi.waitFor(() => expect(calls).toBe(1));
    invalidateWeeklyChanges(d);                          // an audit ended
    await weeklyChangesField(d);                         // read 2 succeeds and is stored
    releaseOld(new Error("late failure"));
    await first;
    const again = await weeklyChangesField(d);           // still served from read 2
    expect(calls).toBe(2);
    expect(again.weekly_changes?.sites.map((x) => x.domain)).toEqual(["b.example.org"]);
  });

  it("after an audit of a tracked site, the others are worded as 'other'", async () => {
    const d = trialDeps({ client: { getMonitoringStatus: vi.fn(async () => status(quietSite("example.com"), quietSite("b.example.org"))) } });
    const r = await runAudit({ domain: "example.com" }, d);
    const w = (r as { data: { weekly_changes?: { summary: string } } }).data.weekly_changes;
    expect(w?.summary).toMatch(/^No other tracked site has changed — b\.example\.org/);
    const none = (x: string) => site(x, { latest: null, previous: null, snapshots_count: 0, last_audited_at: null });
    const d2 = trialDeps({ client: { getMonitoringStatus: vi.fn(async () => status(none("example.com"), none("b.example.org"))) } });
    clearWeeklyChangesCache();
    const r2 = await runAudit({ domain: "example.com" }, d2);
    expect((r2 as { data: { weekly_changes?: { summary: string } } }).data.weekly_changes?.summary)
      .toMatch(/^The first weekly check hasn't run yet on your other tracked site\./);
  });

  it.each(audits)("%s: an audit that fails is still attempted, so the cached read is dropped", async (_n, call) => {
    const d = trialDeps({ client: { runAudit: vi.fn(async () => { throw new WaApiError("UPSTREAM_ERROR", "x"); }) } });
    await weeklyChangesField(d);
    await call(d, "other.example.net");
    await weeklyChangesField(d);
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(2); // warm, then fresh after the drop
  });

  it("run_audit then get_report on a different tracked site reads fresh data", async () => {
    let n = 0;
    const d = trialDeps({ client: {
      getMonitoringStatus: vi.fn(async () => { n += 1; return status(site("a.example.com"), site("b.example.org", { latest: snap(60 + n, "2026-11-17T00:00:00Z") })); }),
    } });
    await runAudit({ domain: "a.example.com" }, d);
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(1);
    const r = await getReport({ domain: "other.example.net" }, d);
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(2); // the audit dropped the pre-audit read
    expect(JSON.stringify((r as { data: unknown }).data)).toContain("62/100");
  });

  it("a read in flight when the audit ends is used for that reply but not stored", async () => {
    let release!: (v: MonitoringStatus) => void;
    let calls = 0;
    const d = trialDeps({ client: {
      getMonitoringStatus: vi.fn(() => { calls += 1; return calls === 1 ? new Promise<MonitoringStatus>((r) => { release = r; }) : Promise.resolve(status(site("b.example.org"))); }),
    } });
    const audit = runAudit({ domain: "a.example.com" }, d);
    await vi.waitFor(() => expect(calls).toBe(1));
    setTimeout(() => release(status(site("a.example.com"), site("b.example.org"))), 5);
    const r = await audit;
    const w = (r as { data: { weekly_changes?: { sites: { domain: string }[] } } }).data.weekly_changes;
    expect(w?.sites.map((x) => x.domain)).toEqual(["b.example.org"]);
    await weeklyChangesField(d);
    expect(calls).toBe(2);
  });

  it("an audit of the only active site leaves no block, even beside paused ones", async () => {
    const d = trialDeps({ client: { getMonitoringStatus: vi.fn(async () => status(site("example.com"), site("old.example.org", { active: false }), site("bad domain"))) } });
    const r = await runAudit({ domain: "example.com" }, d);
    expect((r as { data: Record<string, unknown> }).data).not.toHaveProperty("weekly_changes");
  });

  it("a track during a flight: joiners get nothing and nothing is stored", async () => {
    let release!: (v: MonitoringStatus) => void;
    const d = deps(trial, () => new Promise<MonitoringStatus>((r) => { release = r; }));
    const a = weeklyChangesField(d);
    const b = weeklyChangesField(d);
    await vi.waitFor(() => expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(1));
    invalidateWeeklyChanges(d, { discard: true });
    release(status(site("example.com")));
    expect(await a).toEqual({});
    expect(await b).toEqual({});
    expect(weeklyChangesCacheSize()).toBe(0);
  });

  it("an audit during a flight: joiners still render what they awaited, and nothing is stored", async () => {
    let release!: (v: MonitoringStatus) => void;
    const d = deps(trial, () => new Promise<MonitoringStatus>((r) => { release = r; }));
    const a = weeklyChangesField(d);
    const b = weeklyChangesField(d);
    await vi.waitFor(() => expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(1));
    invalidateWeeklyChanges(d);
    release(status(site("example.com")));
    expect((await a).weekly_changes?.sites[0]?.domain).toBe("example.com");
    expect((await b).weekly_changes?.sites[0]?.domain).toBe("example.com");
    expect(weeklyChangesCacheSize()).toBe(0);
  });

  it("engine moves carry the display label beside the raw key", () => {
    const w = buildWeeklyChanges([site("example.com")], cfg(), Date.now());
    expect(w.sites[0]!.engines).toEqual([{ engine: "perplexity", label: "Perplexity", delta: 10 }]);
  });

  it("an outage: plain replies share one failure window, each audit costs one read", async () => {
    const d = trialDeps({ client: { getMonitoringStatus: vi.fn(async () => { throw new Error("down"); }) } });
    await weeklyChangesField(d);
    await weeklyChangesField(d);
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(1);
    // The first audit rides the failure window then drops it; the next must read again.
    for (let i = 0; i < 2; i++) await runAudit({ domain: "other.example.net" }, d);
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(2);
  });

  it("an audit's own reply has its own read, and nothing is cached afterwards", async () => {
    const d = trialDeps();
    const r = await runAudit({ domain: "other.example.net" }, d);
    expect((r as { data: Record<string, unknown> }).data).toHaveProperty("weekly_changes");
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(1);
    expect(weeklyChangesCacheSize()).toBe(0);
    await weeklyChangesField(d);
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(2);
  });

  it("audits by accounts not in a trial leave the cache size unchanged", async () => {
    const before = weeklyChangesCacheSize();
    const paying = makeDeps({ subscriptions: fixedResolution(paid), client: { getMonitoringStatus: vi.fn(async () => status(site("example.com"))) } });
    await runAudit({ domain: "other.example.net" }, paying);
    await getAiVisibility({ domain: "other.example.net" }, paying);
    expect(weeklyChangesCacheSize()).toBe(before);
    expect(paying.client.getMonitoringStatus).not.toHaveBeenCalled();
  });

  it("compare_competitors carries no block, makes no weekly read, and drops the cache only when an audit ran", async () => {
    const d = trialDeps();
    await weeklyChangesField(d); // warm: one read
    const r = await compareCompetitors({ domain: "example.com", competitors: ["rival.example.net"] }, d);
    expect(r.ok).toBe(true);
    expect((r as { data: Record<string, unknown> }).data).not.toHaveProperty("weekly_changes");
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(1);
    expect(weeklyChangesCacheSize()).toBe(0); // audits ran
    await weeklyChangesField(d);
    // Fully cached comparison: no audit runs, so the cache stays.
    await compareCompetitors({ domain: "example.com", competitors: ["rival.example.net"] }, d);
    expect(weeklyChangesCacheSize()).toBe(1);
    // An invalid call and a refused one touch nothing.
    await compareCompetitors({ domain: "example.com", competitors: [] }, d);
    const free = makeDeps({ tier: "free" });
    await compareCompetitors({ domain: "example.com", competitors: ["rival.example.net"] }, free);
    expect(weeklyChangesCacheSize()).toBe(1);
  });

  it.each(audits)("%s: an unusable domain and a refused gate neither read nor invalidate", async (_n, call) => {
    const d = trialDeps();
    await weeklyChangesField(d);
    const bad = await call(d, "not a domain");
    expect(bad.ok).toBe(false);
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(1);
    expect(weeklyChangesCacheSize()).toBe(1);
    const free = makeDeps({ tier: "free", client: { getMonitoringStatus: vi.fn(async () => status()) } });
    expect((await call(free, "other.example.net")).ok).toBe(false);
    expect(free.client.getMonitoringStatus).not.toHaveBeenCalled();
  });

  it("every read is kept for five minutes, whatever it holds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
    for (const [k, st] of [
      ["wa_a", status(site("a.example.com"))],
      ["wa_b", status(site("a.example.com", { latest: null, previous: null, snapshots_count: 0, last_audited_at: null }))],
      ["wa_c", status()],
    ] as const) {
      const d = deps(trial, async () => st, k);
      await weeklyChangesField(d);
      vi.setSystemTime(Date.now() + WEEKLY_TTL_MS - 1000);
      await weeklyChangesField(d);
      expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 2000);
      await weeklyChangesField(d);
      expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(2);
    }
    expect(WEEKLY_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("compare_competitors invalidates once an audit was sent, even if it failed", async () => {
    const d = trialDeps({ client: { runAudit: vi.fn(async () => { throw new WaApiError("UPSTREAM_ERROR", "x"); }) } });
    await weeklyChangesField(d);
    await compareCompetitors({ domain: "example.com", competitors: ["rival.example.net"] }, d);
    expect(weeklyChangesCacheSize()).toBe(0);
  });

  it.each(audits)("%s: a refused audit returns without waiting on a slow weekly read", async (_n, call) => {
    vi.useRealTimers();
    const d = trialDeps({ client: {
      runAudit: vi.fn(async () => { throw new WaApiError("UPSTREAM_ERROR", "x"); }),
      getMonitoringStatus: vi.fn(() => new Promise<MonitoringStatus>(() => {})),
    } });
    const t0 = Date.now();
    const r = await call(d, "other.example.net");
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it.each([
    ["track", (d: ReturnType<typeof makeDeps>) => trackSite({ domain: "example.com" }, d)],
    ["stop", (d: ReturnType<typeof makeDeps>) => trackSite({ domain: "example.com", enabled: false }, d)],
  ] as const)("track_site (%s) drops the cached read even when the API call fails", async (_n, call) => {
    const d = trialDeps({ client: {
      trackSite: vi.fn(async () => { throw new WaApiError("UPSTREAM_ERROR", "x"); }),
      untrackSite: vi.fn(async () => { throw new WaApiError("UPSTREAM_ERROR", "x"); }),
    } });
    await weeklyChangesField(d);
    expect(weeklyChangesCacheSize()).toBe(1);
    const r = await call(d);
    expect(r.ok).toBe(false);
    expect(weeklyChangesCacheSize()).toBe(0);
  });

  it("a failed read is remembered for a minute only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
    const d = deps(trial, async () => { throw new Error("down"); }, "wa_fail60");
    await weeklyChangesField(d);
    vi.setSystemTime(Date.now() + 59_000);
    await weeklyChangesField(d);
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2_000);
    await weeklyChangesField(d);
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(2);
  });

  it("a failed gate gains no read", async () => {
    const d = makeDeps({
      tier: "free",
      client: { getMonitoringStatus: vi.fn(async () => status(site("example.com"))) },
    });
    const r = await runAudit({ domain: "example.com" }, d);
    expect(r.ok).toBe(false);
    expect(d.client.getMonitoringStatus).not.toHaveBeenCalled();
  });

  it("check_upgrade_status carries the block from one read", async () => {
    const d = trialDeps();
    const r = await checkUpgradeStatus({}, d);
    expect(r.ok).toBe(true);
    expect(d.client.getMonitoringStatus).toHaveBeenCalledTimes(1);
  });
});

describe("published words and the client read", () => {
  const SIGNUP = "https://api.website-auditor.io/admin_portal/";
  const BANNED = /\b(trials?|trialing|plans?|pric(e|es|ing)|subscri\w*|upgrad\w*)\b/i;
  const variants = [
    { upsellStyle: "link" as const },
    { upsellStyle: "info" as const },
    { toolCopy: "neutral" as const },
    { upsellStyle: "info" as const, toolCopy: "neutral" as const },
  ];
  const strings = (o: unknown, out: string[] = []): string[] => {
    if (typeof o === "string") out.push(o);
    else if (o && typeof o === "object") for (const v of Object.values(o)) strings(v, out);
    return out;
  };

  it.each(variants)("tools/list weekly_changes and the instructions carry no trial, plan or price words (%o)", async (cfg) => {
    const d = makeDeps({ tier: "pro", config: cfg });
    const server = createServer(d);
    const client = new Client({ name: "t", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();
    let seen = 0;
    for (const t of tools) {
      const props = (t.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      if (!("weekly_changes" in props)) continue;
      seen += 1;
      for (const str of strings(props.weekly_changes)) expect(str, `${t.name}: ${str}`).not.toMatch(BANNED);
    }
    expect(seen).toBe(5);
    const para = (client.getInstructions() ?? "").split("\n\n").find((p) => p.startsWith("TRACKED SITES."));
    expect(para).toBeDefined();
    expect(para!).not.toMatch(BANNED);
    await client.close();
  });

  it("the neutral instructions describe the field and give no directive", () => {
    const text = (t: string) => t.split("\n\n").find((p) => p.startsWith("TRACKED SITES."))!;
    const neutral = text(buildInstructions(SIGNUP, "link", "http", true, "neutral"));
    expect(neutral).toContain("`weekly_changes`");
    expect(neutral).not.toMatch(/\b(relay|mention|tell|offer|always|must|should|do not|once)\b/i);
    const full = text(buildInstructions(SIGNUP));
    expect(full).toMatch(/relay `weekly_changes\.summary`/);
  });

  it("a monitoring answer with no sites array is a failure, not 'no sites'", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, limit: 5 }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new WaApiClient(testConfig(), { fetch: fetchMock as unknown as typeof fetch });
    expect((await client.getMonitoringStatus()).sites).toEqual([]);
    await expect(client.getMonitoringStatus({ requireSites: true })).rejects.toThrow(/no sites/);
    const d = makeDeps({ subscriptions: fixedResolution(trial), config: { apiKey: "wa_nosites" } });
    d.client = client;
    expect(await weeklyChangesField(d)).toEqual({});
  });

  it("the weekly read passes its own timeout to the client", async () => {
    const d = deps(trial, async () => status(site("example.com")), "wa_timeout");
    await weeklyChangesField(d);
    expect(d.client.getMonitoringStatus).toHaveBeenCalledWith({ timeoutMs: WEEKLY_READ_TIMEOUT_MS, requireSites: true });
  });

  it("passed-over snapshots keep the lead from saying nothing changed", () => {
    const skipped = site("a.example.com", {
      latest: snap(55, "2026-11-16T00:00:00Z"), previous: snap(55, "2026-11-09T00:00:00Z"),
      comparison: { status: "compared", skipped_snapshots: 2 } as unknown as MonitoringSite["comparison"],
    });
    const w = buildWeeklyChanges([skipped], { config: makeDeps().config }, Date.now());
    expect(w.summary).toMatch(/^Latest changes \u2014 /);
    expect(w.summary).not.toMatch(/has changed/);
  });
});

describe("await-point deadline and structured parts", () => {
  it("the two-second cap runs from the await, not from launch", async () => {
    vi.useFakeTimers();
    const slow = <T,>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
    const d = makeDeps({
      subscriptions: { resolve: () => slow(1000, trial) },
      client: { getMonitoringStatus: vi.fn(() => slow(1000, status(site("example.com")))) },
      config: { apiKey: "wa_awaitpoint" },
    });
    const pending = startWeeklyChanges(d);
    await vi.advanceTimersByTimeAsync(2500); // an audit took a while; the read finished meanwhile
    expect((await pending.result()).weekly_changes).toBeDefined();
  });

  it("once awaited, a read that never finishes is still given up on after two seconds", async () => {
    vi.useFakeTimers();
    const d = makeDeps({ subscriptions: { resolve: () => new Promise(() => {}) }, config: { apiKey: "wa_never" } });
    const pending = startWeeklyChanges(d);
    const p = pending.result();
    await vi.advanceTimersByTimeAsync(WEEKLY_TOTAL_TIMEOUT_MS + 10);
    expect(await p).toEqual({});
  });

  it("describeSite hands back its parts, and the published summary is headline + caveat + rest", () => {
    const stale = describeSite(site("example.com", { last_audited_at: "2026-11-20T00:00:00Z" }));
    expect(stale.headline).toBe("example.com: AI visibility 60/100 (up 5 since 2026-11-09).");
    expect(stale.olderCaveat).toMatch(/^That score is from 2026-11-16;/);
    expect(stale.stale).toBe(true);
    expect(stale.site.summary).toBe(`${stale.headline} ${stale.olderCaveat}`);
    const none = describeSite(site("example.com", { latest: null, previous: null, snapshots_count: 0 }));
    expect(none.rest).toMatch(/^A run stores none/);
    expect(none.site.summary).toBe(`${none.headline} ${none.rest}`);
  });
});

describe("round 17: body deadline, unparsable dates, refusals", () => {
  it("the weekly read's own timeout also covers a body that stalls", async () => {
    const stalling = vi.fn(async (_url: unknown, init: { signal: AbortSignal }) => {
      const stream = new ReadableStream({
        start(ctrl) {
          init.signal.addEventListener("abort", () => ctrl.error(Object.assign(new Error("aborted"), { name: "AbortError" })));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new WaApiClient(testConfig({ requestTimeoutMs: 120000 }), { fetch: stalling as unknown as typeof fetch });
    await expect(client.getMonitoringStatus({ timeoutMs: 50, requireSites: true })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("since is null unless the earlier snapshot's date parses", () => {
    const bad = site("example.com", { previous: snap(55, "not a date, at all") });
    const w = buildWeeklyChanges([bad], { config: makeDeps().config }, Date.now());
    expect(w.sites[0]!.since).toBeNull();
    const good = buildWeeklyChanges([site("example.com")], { config: makeDeps().config }, Date.now());
    expect(good.sites[0]!.since).toBe("2026-11-09");
  });

  it("compare_competitors: a quota refusal leaves the cache; a timeout drops it", async () => {
    const mk = (err: WaApiError) => makeDeps({
      subscriptions: fixedResolution(trial),
      client: {
        getMonitoringStatus: vi.fn(async () => status(site("example.com"))),
        runAudit: vi.fn(async () => { throw err; }),
      },
      config: { apiKey: "wa_cmp_refusal" },
    });
    const refused = mk(new WaApiError("OVER_QUOTA", "daily cap"));
    await weeklyChangesField(refused);
    await compareCompetitors({ domain: "example.com", competitors: ["rival.example.net"] }, refused);
    expect(weeklyChangesCacheSize()).toBe(1);
    clearWeeklyChangesCache();
    const timedOut = mk(new WaApiError("TIMEOUT", "slow"));
    await weeklyChangesField(timedOut);
    await compareCompetitors({ domain: "example.com", competitors: ["rival.example.net"] }, timedOut);
    expect(weeklyChangesCacheSize()).toBe(0);
  });

  it.each([
    ["run_audit", (d: ReturnType<typeof makeDeps>) => runAudit({ domain: "other.example.net" }, d)],
    ["get_ai_visibility", (d: ReturnType<typeof makeDeps>) => getAiVisibility({ domain: "other.example.net" }, d)],
  ] as const)("%s: a quota refusal (429) leaves the cache intact; a timeout drops it", async (_n, call) => {
    const mk = (err: WaApiError) => makeDeps({
      subscriptions: fixedResolution(trial),
      client: {
        getMonitoringStatus: vi.fn(async () => status(site("example.com"))),
        runAudit: vi.fn(async () => { throw err; }),
      },
      config: { apiKey: "wa_refusal" },
    });
    const refused = mk(new WaApiError("OVER_QUOTA", "daily cap"));
    await weeklyChangesField(refused);
    await call(refused);
    expect(weeklyChangesCacheSize()).toBe(1);
    clearWeeklyChangesCache();
    const timedOut = mk(new WaApiError("TIMEOUT", "slow"));
    await weeklyChangesField(timedOut);
    await call(timedOut);
    expect(weeklyChangesCacheSize()).toBe(0);
  });
});
