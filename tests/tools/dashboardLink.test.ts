/**
 * The dashboard link on seven tools' success replies (src/tools/dashboardLink.ts).
 *
 * What these pin, because each is a way the link could do harm:
 *   - it names a site only when the member tracks it (the dashboard opens a
 *     different site for an untracked `?site=`);
 *   - it is for Pro members only, with no line about it for anyone else;
 *   - it never costs a reply: no read on a failed tool, no failure from a
 *     failed or slow read;
 *   - its `src` label is a closed set that never holds the domain;
 *   - its words stay free of price, trial and upgrade.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  dashboardLink,
  linkLabel,
  TRACKED_READ_TIMEOUT_MS,
  DASHBOARD_LINK_TOOLS,
} from "../../src/tools/dashboardLink.js";
import { loadConfig } from "../../src/config.js";
import { runAudit } from "../../src/tools/runAudit.js";
import { getAiVisibility } from "../../src/tools/getAiVisibility.js";
import { getMonitoringStatus } from "../../src/tools/getMonitoringStatus.js";
import { compareCompetitors } from "../../src/tools/compareCompetitors.js";
import { getRecommendations } from "../../src/tools/getRecommendations.js";
import { getGtmPlan } from "../../src/tools/getGtmPlan.js";
import { trackSite } from "../../src/tools/trackSite.js";
import { WaApiError } from "../../src/api/errors.js";
import { makeDeps } from "../helpers.js";

const tracked = (...domains: string[]) => ({
  limit: 5,
  used: domains.length,
  remaining: 5 - domains.length,
  tracked: domains.map((domain) => ({
    domain, cadence: "weekly", active: true, digest_enabled: true, last_audited_at: null, next_run_at: null,
  })),
});
const listing = (...domains: string[]) => vi.fn(async () => tracked(...domains));

afterEach(() => {
  vi.useRealTimers();
});

describe("dashboardLink: the link itself", () => {
  it("a tracked site: ?site=<host>&src=<label>, from config.siteUrl", async () => {
    const deps = makeDeps({ tier: "pro", client: { listTrackedDomains: listing("example.com") } });
    const link = await dashboardLink(deps, "run_audit", "example.com");
    expect(link?.url).toBe("https://website-auditor.io/dashboard?site=example.com&src=mcp-run_audit");
    expect(link?.note).toContain("Your dashboard for example.com");
    expect(link?.note).toContain(link!.url);
  });

  it("uses siteUrl from config, not a fixed host", async () => {
    const deps = makeDeps({
      tier: "pro", config: { siteUrl: "https://staging.example.test" },
      client: { listTrackedDomains: listing("example.com") },
    });
    const link = await dashboardLink(deps, "run_audit", "example.com");
    expect(link?.url.startsWith("https://staging.example.test/dashboard?")).toBe(true);
  });

  it("normalises the host: www., a URL, and upper case all match the tracked domain", async () => {
    const deps = makeDeps({ tier: "pro", client: { listTrackedDomains: listing("www.Example.com") } });
    for (const input of ["www.example.com", "https://Example.com/pricing", "EXAMPLE.COM"]) {
      const link = await dashboardLink(deps, "run_audit", input);
      expect(link?.url, input).toBe("https://website-auditor.io/dashboard?site=example.com&src=mcp-run_audit");
    }
  });

  it("an untracked site: the plain dashboard and a track-it note, never ?site=", async () => {
    const deps = makeDeps({ tier: "pro", client: { listTrackedDomains: listing("mine.com") } });
    const link = await dashboardLink(deps, "get_ai_visibility", "other.com");
    expect(link?.url).toBe("https://website-auditor.io/dashboard?src=mcp-get_ai_visibility");
    expect(link?.url).not.toContain("site=");
    expect(link?.url).not.toContain("other.com");
    expect(link?.note).toMatch(/^Track other\.com first to see it on your dashboard/);
  });

  it("a Pro member with no tracked site: the plain dashboard and a track-it note", async () => {
    const deps = makeDeps({ tier: "pro", client: { listTrackedDomains: listing() } });
    const link = await dashboardLink(deps, "run_audit", "example.com");
    expect(link?.url).toBe("https://website-auditor.io/dashboard?src=mcp-run_audit");
    expect(link?.note).toContain("Track example.com first");
  });

  it("no domain, nothing tracked: the plain dashboard, a note that names no site", async () => {
    const deps = makeDeps({ tier: "pro", client: { listTrackedDomains: listing() } });
    const link = await dashboardLink(deps, "get_monitoring_status");
    expect(link?.url).toBe("https://website-auditor.io/dashboard?src=mcp-get_monitoring_status");
    expect(link?.note).toMatch(/^Track a site first/);
  });

  it("no domain, sites tracked: the plain dashboard, which lists them, naming no one site", async () => {
    const deps = makeDeps({ tier: "pro", client: { listTrackedDomains: listing("a.com", "b.com") } });
    const link = await dashboardLink(deps, "get_monitoring_status");
    expect(link?.url).toBe("https://website-auditor.io/dashboard?src=mcp-get_monitoring_status");
    expect(link?.note).toMatch(/^Your dashboard shows the AI crawler check/);
    expect(link?.note).not.toMatch(/a\.com|b\.com/);
  });

  it("the notes never name a tool", async () => {
    const deps = makeDeps({ tier: "pro", client: { listTrackedDomains: listing("a.com") } });
    // The words before the URL; the URL's own `src` carries the tool name.
    const words = (l: { note: string; url: string } | null) => l!.note.replace(l!.url, "");
    for (const d of ["a.com", "z.com", undefined]) {
      expect(words(await dashboardLink(deps, "run_audit", d))).not.toMatch(/track_site|get_|run_audit/);
    }
    const none = makeDeps({ tier: "pro", client: { listTrackedDomains: listing() } });
    expect(words(await dashboardLink(none, "run_audit", "z.com"))).not.toMatch(/track_site/);
    expect(words(await dashboardLink(none, "run_audit"))).not.toMatch(/track_site/);
  });

  it("an inactive tracked site does not count as tracked", async () => {
    const list = vi.fn(async () => ({
      ...tracked("example.com"),
      tracked: [{ domain: "example.com", cadence: "weekly", active: false, digest_enabled: true, last_audited_at: null, next_run_at: null }],
    }));
    const deps = makeDeps({ tier: "pro", client: { listTrackedDomains: list } });
    const link = await dashboardLink(deps, "run_audit", "example.com");
    expect(link?.url).not.toContain("site=");
  });

  it("an unusable domain argument never becomes ?site=", async () => {
    const deps = makeDeps({ tier: "pro", client: { listTrackedDomains: listing("example.com") } });
    const link = await dashboardLink(deps, "run_audit", "not a domain");
    expect(link?.url).toBe("https://website-auditor.io/dashboard?src=mcp-run_audit");
  });

  it("never carries refresh=1, a token or the domain in src", async () => {
    const deps = makeDeps({ tier: "pro", client: { listTrackedDomains: listing("example.com") } });
    const link = await dashboardLink(deps, "run_audit", "example.com");
    const u = new URL(link!.url);
    expect([...u.searchParams.keys()].sort()).toEqual(["site", "src"]);
    expect(u.searchParams.get("src")).not.toContain("example");
    expect(link!.url).not.toContain("refresh");
    expect(link!.url).not.toContain("wa_test");
  });

  it("no Pro, no link, and no read", async () => {
    for (const tier of ["free", "none"] as const) {
      const list = listing("example.com");
      const deps = makeDeps({ tier, client: { listTrackedDomains: list } });
      expect(await dashboardLink(deps, "run_audit", "example.com")).toBeNull();
      expect(list).not.toHaveBeenCalled();
    }
  });

  it("a read that throws means no link, not a thrown error", async () => {
    const list = vi.fn(async () => { throw new WaApiError("UPSTREAM_ERROR", "down"); });
    const deps = makeDeps({ tier: "pro", client: { listTrackedDomains: list } });
    await expect(dashboardLink(deps, "run_audit", "example.com")).resolves.toBeNull();
  });

  it("a read that hangs is given up on after the timeout", async () => {
    vi.useFakeTimers();
    const list = vi.fn(() => new Promise<never>(() => {}));
    const deps = makeDeps({ tier: "pro", client: { listTrackedDomains: list } });
    const pending = dashboardLink(deps, "run_audit", "example.com");
    await vi.advanceTimersByTimeAsync(TRACKED_READ_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBeNull();
  });

  it("makes at most one read, and none when the caller passes the list", async () => {
    const list = listing("example.com");
    const deps = makeDeps({ tier: "pro", client: { listTrackedDomains: list } });
    await dashboardLink(deps, "run_audit", "example.com");
    expect(list).toHaveBeenCalledTimes(1);
    const link = await dashboardLink(deps, "track_site", "example.com", { tracked: ["example.com"] });
    expect(list).toHaveBeenCalledTimes(1);
    expect(link?.url).toContain("site=example.com");
  });

  it("the note names what the page shows and has no price, trial or upgrade words", async () => {
    const deps = makeDeps({ tier: "pro", client: { listTrackedDomains: listing("example.com") } });
    const notes = [
      (await dashboardLink(deps, "run_audit", "example.com"))!.note,
      (await dashboardLink(deps, "run_audit", "other.com"))!.note,
      (await dashboardLink(deps, "get_monitoring_status"))!.note,
    ];
    for (const note of notes) {
      expect(note).toMatch(/AI crawler check/);
      expect(note).toMatch(/competitors/);
      expect(note).toMatch(/visits from AI assistants/);
      expect(note).not.toMatch(/\$|price|trial|upgrade|subscri|free|plan\b|pro\b|always/i);
    }
  });
});

describe("dashboardLink: the label", () => {
  it("is <channel>-<tool>", () => {
    expect(linkLabel("chatgpt", "run_audit")).toBe("chatgpt-run_audit");
    expect(linkLabel("claude", "track_site")).toBe("claude-track_site");
    expect(linkLabel("mcp", "get_gtm_plan")).toBe("mcp-get_gtm_plan");
  });

  it("falls back to mcp for no channel or an unknown one", () => {
    expect(linkLabel(undefined, "run_audit")).toBe("mcp-run_audit");
    expect(linkLabel("slack", "run_audit")).toBe("mcp-run_audit");
  });

  it("is a closed set: an unknown tool reads as other, and nothing else gets in", () => {
    expect(linkLabel("chatgpt", "get_report")).toBe("chatgpt-other");
    expect(linkLabel("chatgpt", "example.com&refresh=1")).toBe("chatgpt-other");
    expect(linkLabel("chatgpt&x=1", "run_audit")).toBe("mcp-run_audit");
  });

  it("every linked tool has its own label", () => {
    expect(new Set(DASHBOARD_LINK_TOOLS.map((t) => linkLabel("claude", t))).size).toBe(7);
  });

  it("WA_LINK_CHANNEL sets the channel; anything else is mcp", () => {
    expect(loadConfig({ WA_LINK_CHANNEL: "chatgpt" }).linkChannel).toBe("chatgpt");
    expect(loadConfig({ WA_LINK_CHANNEL: " Claude " }).linkChannel).toBe("claude");
    expect(loadConfig({}).linkChannel).toBe("mcp");
    expect(loadConfig({ WA_LINK_CHANNEL: "" }).linkChannel).toBe("mcp");
    expect(loadConfig({ WA_LINK_CHANNEL: "${WA_LINK_CHANNEL}" }).linkChannel).toBe("mcp");
    expect(loadConfig({ WA_LINK_CHANNEL: "email" }).linkChannel).toBe("mcp");
  });

  it("the channel from config reaches the link", async () => {
    const deps = makeDeps({
      tier: "pro", config: { linkChannel: "chatgpt" }, client: { listTrackedDomains: listing("example.com") },
    });
    const link = await dashboardLink(deps, "get_gtm_plan", "example.com");
    expect(link?.url).toContain("src=chatgpt-get_gtm_plan");
  });
});

// ── the seven tools ──────────────────────────────────────────────────────

const SITE = { domain: "example.com", cadence: "weekly", active: true, last_audited_at: null, next_run_at: null, snapshots_count: 0, latest: null };

interface Case {
  tool: string;
  /** Runs the tool; `fail` makes the tool's own API call throw. */
  run: (deps: ReturnType<typeof makeDeps>) => Promise<{ ok: boolean; data?: any; error?: any }>;
  failing: Record<string, unknown>;
  /** The reply carries a `summary` the note is folded into. */
  summary: boolean;
  /** Needs the member to track example.com for ?site=. Tools that know it need no read. */
  reads: boolean;
}
const boom = () => vi.fn(async () => { throw new WaApiError("UPSTREAM_ERROR", "boom"); });
const CASES: Case[] = [
  { tool: "run_audit", summary: false, reads: true, failing: { runAudit: boom() },
    run: (d) => runAudit({ domain: "example.com" }, d) },
  { tool: "get_ai_visibility", summary: true, reads: true, failing: { runAudit: boom() },
    run: (d) => getAiVisibility({ domain: "example.com" }, d) },
  { tool: "get_monitoring_status", summary: true, reads: false, failing: { getMonitoringStatus: boom() },
    run: (d) => getMonitoringStatus({}, d) },
  { tool: "compare_competitors", summary: true, reads: true, failing: { runAudit: boom() },
    run: (d) => compareCompetitors({ domain: "example.com", competitors: ["rival.com"] }, d) },
  { tool: "get_recommendations", summary: false, reads: true, failing: { getRecommendations: boom() },
    run: (d) => getRecommendations({ domain: "example.com" }, d) },
  { tool: "get_gtm_plan", summary: true, reads: true, failing: { getGtmPlan: boom() },
    run: (d) => getGtmPlan({ domain: "example.com" }, d) },
  { tool: "track_site", summary: false, reads: false, failing: { trackSite: boom() },
    run: (d) => trackSite({ domain: "example.com" }, d) },
];

function deps(c: Case, over: { tier?: "pro" | "free" | "none"; tracked?: string[]; client?: Record<string, unknown>; channel?: "chatgpt" | "claude" } = {}) {
  const list = listing(...(over.tracked ?? ["example.com"]));
  return {
    list,
    deps: makeDeps({
      tier: over.tier ?? "pro",
      config: { linkChannel: over.channel },
      client: {
        listTrackedDomains: list,
        getMonitoringStatus: vi.fn(async () => ({ limit: 5, used: 1, remaining: 4, sites: [SITE] })),
        ...over.client,
      },
    }),
  };
}

describe.each(CASES)("$tool: the dashboard link", (c) => {
  it("Pro, tracked site: the reply carries the link, labelled with the channel and tool", async () => {
    const { deps: d } = deps(c, { channel: "chatgpt" });
    const res = await c.run(d);
    expect(res.ok).toBe(true);
    // Monitoring is about all of the member's sites, so it links the page that lists them.
    const named = c.tool !== "get_monitoring_status";
    expect(res.data.dashboard).toEqual({
      url: `https://website-auditor.io/dashboard?${named ? "site=example.com&" : ""}src=chatgpt-${c.tool}`,
      note: expect.stringContaining(named ? "Your dashboard for example.com shows the AI crawler check" : "Your dashboard shows the AI crawler check"),
    });
  });

  it("makes at most one tracked-domains read", async () => {
    const { deps: d, list } = deps(c);
    await c.run(d);
    expect(list).toHaveBeenCalledTimes(c.reads ? 1 : 0);
  });

  it("an untracked site gets the plain dashboard and the track-it note", async () => {
    // monitoring names no site of its own; track_site has just tracked it.
    if (c.tool === "get_monitoring_status" || c.tool === "track_site") return;
    const { deps: d } = deps(c, { tracked: ["other.com"] });
    const res = await c.run(d);
    expect(res.ok).toBe(true);
    expect(res.data.dashboard.url).toBe(`https://website-auditor.io/dashboard?src=mcp-${c.tool}`);
    expect(res.data.dashboard.note).toContain("Track example.com first");
  });

  it("folds the note into summary where the reply has one, and leaves the rest of the reply alone", async () => {
    const { deps: d } = deps(c);
    const res = await c.run(d);
    if (c.summary) {
      expect(res.data.summary).toContain(res.data.dashboard.note);
    } else if ("summary" in res.data) {
      expect(res.data.summary).not.toContain("dashboard");
    }
    if (c.tool === "track_site") expect(res.data.message).toContain(res.data.dashboard.note);
  });

  it("a read that fails does not fail the tool, and adds no key", async () => {
    const { deps: d } = deps(c, { client: { listTrackedDomains: boom() } });
    const res = await c.run(d);
    if (!c.reads) return; // these never read
    expect(res.ok).toBe(true);
    expect("dashboard" in res.data).toBe(false);
  });

  it("an error reply carries no link and costs no read", async () => {
    const { deps: d, list } = deps(c, { client: c.failing });
    const res = await c.run(d);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain("/dashboard");
    expect(list).not.toHaveBeenCalled();
  });

  it("not Pro: nothing is added, and nothing is read for it", async () => {
    const { deps: d, list } = deps(c, { tier: "free" });
    const res = await c.run(d);
    // get_recommendations answers a key without Pro with the free list; the
    // others refuse. Either way, no link and no line about one.
    if (res.ok) expect("dashboard" in res.data).toBe(false);
    expect(JSON.stringify(res)).not.toContain("/dashboard");
    expect(list).not.toHaveBeenCalled();
  });
});

describe("the dashboard link in particular tools", () => {
  it("get_recommendations with a free key still returns the list, with no dashboard", async () => {
    const d = makeDeps({
      tier: "free",
      client: {
        listTrackedDomains: listing("example.com"),
        getRecommendations: vi.fn(async () => ({ tier: "free" as const, recommendations: [] })),
      },
    });
    const res = await getRecommendations({ domain: "example.com" }, d);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ tier: "free", recommendations: [] });
  });

  it("track_site: stopping monitoring adds no link", async () => {
    const d = makeDeps({ tier: "pro", client: { listTrackedDomains: listing("example.com") } });
    const res = await trackSite({ domain: "example.com", enabled: false }, d);
    expect(res.ok).toBe(true);
    if (res.ok) expect("dashboard" in res.data).toBe(false);
  });

  it("track_site: an enrollment that is not active gets no link", async () => {
    const d = makeDeps({
      tier: "pro",
      client: { trackSite: vi.fn(async ({ domain }: { domain: string }) => ({ domain, cadence: "weekly", active: false, created: true, already_tracked: false })) },
    });
    const res = await trackSite({ domain: "example.com" }, d);
    expect(res.ok).toBe(true);
    if (res.ok) expect("dashboard" in res.data).toBe(false);
  });

  it("track_site: the newly tracked site is linked by name without a read", async () => {
    const list = listing();
    const d = makeDeps({ tier: "pro", client: { listTrackedDomains: list } });
    const res = await trackSite({ domain: "https://www.Example.com/" }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.dashboard?.url).toBe("https://website-auditor.io/dashboard?site=example.com&src=mcp-track_site");
    expect(res.data.message).toContain(res.data.dashboard!.note);
    expect(list).not.toHaveBeenCalled();
  });

  it("get_monitoring_status: links the dashboard, from the list it already holds", async () => {
    const list = listing();
    const d = makeDeps({
      tier: "pro",
      client: {
        listTrackedDomains: list,
        getMonitoringStatus: vi.fn(async () => ({
          limit: 5, used: 2, remaining: 3,
          sites: [{ ...SITE, domain: "first.com" }, { ...SITE, domain: "second.com", active: false }],
        })),
      },
    });
    const res = await getMonitoringStatus({}, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.dashboard?.url).toBe("https://website-auditor.io/dashboard?src=mcp-get_monitoring_status");
    expect(res.data.summary).toContain(res.data.dashboard!.note);
    expect(list).not.toHaveBeenCalled();
  });

  it("get_monitoring_status with nothing tracked: the plain dashboard and the track-it note", async () => {
    const d = makeDeps({
      tier: "pro",
      client: { getMonitoringStatus: vi.fn(async () => ({ limit: 5, used: 0, remaining: 5, sites: [] })) },
    });
    const res = await getMonitoringStatus({}, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.dashboard?.url).toBe("https://website-auditor.io/dashboard?src=mcp-get_monitoring_status");
    expect(res.data.dashboard?.note).toMatch(/^Track a site first/);
    // The summary already says to start tracking; it is not repeated.
    expect(res.data.summary).not.toContain("Track a site first");
  });

  it("get_monitoring_status: sites that are all inactive count as nothing tracked", async () => {
    const d = makeDeps({
      tier: "pro",
      client: { getMonitoringStatus: vi.fn(async () => ({ limit: 5, used: 1, remaining: 4, sites: [{ ...SITE, active: false }] })) },
    });
    const res = await getMonitoringStatus({}, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.dashboard?.note).toMatch(/^Track a site first/);
    expect(res.data.summary).not.toContain("Track a site first");
  });

  it("get_ai_visibility: the cached audit object is not mutated", async () => {
    const d = makeDeps({ tier: "pro", client: { listTrackedDomains: listing("example.com") } });
    const first = await getAiVisibility({ domain: "example.com" }, d);
    const second = await getAiVisibility({ domain: "example.com" }, d);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.data.summary.split("Your dashboard").length).toBe(2);
    }
  });
});
