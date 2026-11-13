/**
 * An Agency account through the MCP's own path (Trello card 239, functional
 * test I-07): the real WaApiClient and the real DefaultSubscriptionProvider,
 * against a stand-in for website-auditor-api's key-authed routes that answers
 * the way the API does for an Agency subscription.
 *
 * What the stand-in copies, and from where (website-auditor-api):
 *   - GET /api/subscription: `tier: "pro"` for every paid plan and `plan`
 *     beside it (services/tiers.js publicTier; routes/subscription.js)
 *   - the tracked-domains cap by plan: Pro 3, Agency 10 plus extra sites
 *     (tiers.siteLimitFor); the key-authed route never buys a site, so the
 *     next past the cap is 409 LIMIT_REACHED (trackedDomains.makeRoom)
 *   - 429 EXTRA_AUDIT_RUNS_SPENT for a re-run of a tracked site past the
 *     month's count (middleware/countExtraRun.js)
 * It is a stand-in: nothing here reaches the network, a database or Stripe.
 */
import { describe, it, expect, vi } from "vitest";
import { WaApiClient } from "../../src/api/client.js";
import { DefaultSubscriptionProvider } from "../../src/auth/entitlements.js";
import { checkUpgradeStatus } from "../../src/tools/checkUpgradeStatus.js";
import { listTrackedSites } from "../../src/tools/listTrackedSites.js";
import { trackSite } from "../../src/tools/trackSite.js";
import { untrackSite } from "../../src/tools/untrackSite.js";
import { getChanges } from "../../src/tools/getChanges.js";
import { getMonitoringStatus } from "../../src/tools/getMonitoringStatus.js";
import { runAudit } from "../../src/tools/runAudit.js";
import { compareCompetitors } from "../../src/tools/compareCompetitors.js";
import { checkUpgradeStatusOutput } from "../../src/tools/outputSchemas.js";
import { z } from "zod";
import { testConfig, makeDeps } from "../helpers.js";
import { NoopEventSink } from "../../src/telemetry/events.js";
import { InMemoryAuditCache } from "../../src/auth/auditCache.js";
import type { ToolDeps } from "../../src/tools/context.js";

type Plan = "pro" | "agency" | "enterprise";

interface Standin {
  plan: Plan | null;
  status: string;
  extraSites?: number;
  /** Pro's cap: 3, or 5 for a subscription started before 2026-10-18. */
  proCap?: number;
  tracked: string[];
  /** The month's extra audit runs on tracked sites are used. */
  extraRunsSpent?: boolean;
  calls: string[];
}

const NEXT_DAY = "2026-12-01T00:00:00.000Z";

function limitOf(s: Standin): number {
  if (s.plan === "agency") return 10 + (s.extraSites ?? 0);
  if (s.plan === "enterprise") return 50 + (s.extraSites ?? 0); // tiers.js ENTERPRISE_INCLUDED_SITES
  return s.proCap ?? 3;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function row(domain: string) {
  return {
    domain,
    cadence: "weekly",
    active: true,
    digest_enabled: true,
    last_audited_at: "2026-11-09T00:00:00Z",
    next_run_at: "2026-11-16T00:00:00Z",
    created_at: "2026-10-01T00:00:00Z",
    business_location: null,
  };
}

function standin(s: Standin): typeof fetch {
  const live = s.status === "active" || s.status === "trialing";
  const slots = () => ({ limit: limitOf(s), used: s.tracked.length, remaining: Math.max(0, limitOf(s) - s.tracked.length) });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    s.calls.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/subscription") {
      return json(200, {
        success: true,
        tier: live ? "pro" : "free", // publicTier: any paid plan is "pro"
        plan: live ? s.plan : null,
        status: s.status,
        current_period_end: "2026-12-31T00:00:00Z",
        cancel_at_period_end: false,
      });
    }
    // Every Pro route: requirePro, which every paid plan passes.
    if (!live) return json(403, { success: false, error: "This endpoint requires a Website Auditor Pro subscription.", tier: "free" });
    if (url.pathname === "/api/tracked-domains") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (method === "GET") return json(200, { success: true, ...slots(), tracked: s.tracked.map(row) });
      if (method === "POST") {
        if (s.tracked.includes(body.domain)) return json(200, { success: true, created: false, already_tracked: true, reactivated: false, tracked: row(body.domain) });
        if (s.tracked.length >= limitOf(s)) {
          return json(409, { success: false, code: "LIMIT_REACHED", error: `You can track up to ${limitOf(s)} domains. Untrack one before adding another.` });
        }
        s.tracked.push(body.domain);
        return json(201, { success: true, created: true, already_tracked: false, reactivated: false, tracked: row(body.domain) });
      }
      if (method === "DELETE") {
        const before = s.tracked.length;
        s.tracked = s.tracked.filter((d) => d !== body.domain);
        return json(200, { success: true, removed: s.tracked.length < before, ...slots() });
      }
    }
    if (url.pathname === "/api/monitoring-status") {
      return json(200, { success: true, ...slots(), sites: s.tracked.map((d) => ({ domain: d, cadence: "weekly", active: true, last_audited_at: null, next_run_at: null, latest: null, previous: null })) });
    }
    if (url.pathname === "/api/ai-visibility-history") {
      // Two measured snapshots of one question for a tracked client; nothing for any other site.
      const asked = { key: "q", business_name: "Client", name_source: "detected", business_location: "", market_scope: "global", queries: ["best client"] };
      const snap = (captured_at: string, score: number) => ({
        captured_at, score, by_engine: { chatgpt: score, perplexity: score, claude: score, gemini: score }, source: "scheduled", question: asked,
      });
      const mine = s.tracked.includes(url.searchParams.get("domain") ?? "");
      return json(200, { success: true, domain: url.searchParams.get("domain"), snapshots: mine ? [snap("2026-11-02T00:00:00Z", 40), snap("2026-11-09T00:00:00Z", 55)] : [] });
    }
    if (url.pathname === "/api/audit" && s.extraRunsSpent && s.tracked.includes(url.searchParams.get("businessUrl") ?? "")) {
      return json(429, {
        success: false,
        code: "EXTRA_AUDIT_RUNS_SPENT",
        error: "This account has used its 30 extra audit runs for the month. Re-running a site you track is available again on 2026-12-01 (UTC). The weekly and daily checks carry on, and an audit of a site you do not track is not counted.",
        extra_audit_runs: { limit: 30, used: 30, resets_at: NEXT_DAY },
      });
    }
    return json(404, { success: false, error: `stand-in has no ${method} ${url.pathname}` });
  }) as unknown as typeof fetch;
}

function world(s: Partial<Standin>, configOver = {}) {
  const state: Standin = { plan: "agency", status: "active", tracked: [], calls: [], ...s };
  const config = testConfig({ apiKey: "wa_agency_standin_key", ...configOver });
  const client = new WaApiClient(config as never, { fetch: standin(state) });
  const deps: ToolDeps = {
    client,
    subscriptions: new DefaultSubscriptionProvider(config, client),
    cache: new InMemoryAuditCache({ ttlMs: 60_000 }),
    config,
    events: new NoopEventSink(),
  };
  return { state, deps, client };
}

const sites = (n: number) => Array.from({ length: n }, (_, i) => `client${i + 1}.example.net`);

describe("an Agency account through the MCP", () => {
  it("is let through every Pro tool: the API answers tier pro, so the gate opens", async () => {
    const { deps, state } = world({ tracked: sites(2) });
    const list = await listTrackedSites({}, deps);
    const status = await getMonitoringStatus({}, deps);
    const changes = await getChanges({ domain: "client1.example.net" }, deps);
    const untracked = await getChanges({ domain: "nobody.example.net" }, deps);
    expect(list.ok && status.ok).toBe(true);
    // The weekly snapshots of a tracked client: the change between the last two.
    expect(changes.ok && changes.data.score_delta).toBe(15);
    // A site with no history is a flagged "nothing to compare", never a plan refusal.
    expect(!untracked.ok && untracked.error.code).toBe("NOT_YET_AVAILABLE");
    expect(state.calls).toEqual(expect.arrayContaining(["GET /api/tracked-domains", "GET /api/monitoring-status", "GET /api/ai-visibility-history"]));
  });

  it("list_tracked_sites reports Agency's own cap, the same sites the account tracks", async () => {
    const { deps } = world({ tracked: sites(4) });
    const res = await listTrackedSites({}, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ limit: 10, used: 4, remaining: 6 });
    expect(res.data.tracked.map((t) => t.domain)).toEqual(sites(4));
    expect(res.data.summary).toBe("Monitoring 4 of 10 site(s); 6 slot(s) free.");
  });

  it("the cap is 10 plus the extra sites the account has added", async () => {
    const { deps } = world({ tracked: sites(11), extraSites: 5 });
    const res = await listTrackedSites({}, deps);
    expect(res.ok && res.data.limit).toBe(15);
  });

  it("applies no cap of its own: Enterprise's 50 and a long client list pass through as the API states them", async () => {
    const { deps } = world({ plan: "enterprise", tracked: sites(30) });
    const res = await listTrackedSites({}, deps);
    expect(res.ok && res.data).toMatchObject({ limit: 50, used: 30, remaining: 20 });
    expect(res.ok && res.data.tracked).toHaveLength(30);
  });

  it("a Pro account is still capped at 3, or 5 when grandfathered", async () => {
    expect(await listTrackedSites({}, world({ plan: "pro" }).deps).then((r) => r.ok && r.data.limit)).toBe(3);
    expect(await listTrackedSites({}, world({ plan: "pro", proCap: 5 }).deps).then((r) => r.ok && r.data.limit)).toBe(5);
  });

  it("track_site fills the ten, refuses the eleventh as LIMIT_REACHED (not an upsell), untrack frees one", async () => {
    const { deps, state } = world({ tracked: sites(9) });
    const tenth = await trackSite({ domain: "client10.example.net" }, deps);
    expect(tenth.ok && tenth.data.created).toBe(true);
    expect(state.tracked).toHaveLength(10);

    const eleventh = await trackSite({ domain: "client11.example.net" }, deps);
    expect(eleventh.ok).toBe(false);
    if (eleventh.ok) return;
    expect(eleventh.error.code).toBe("LIMIT_REACHED");
    expect(eleventh.error.message).toContain("up to 10 domains");
    // The caller is on the top self-serve plan: no signup link, no price, no trial.
    expect(eleventh.error.upgrade_url).toBeUndefined();
    expect(eleventh.error.message).not.toMatch(/trial|\$\d/);
    expect(state.tracked).toHaveLength(10);

    const freed = await untrackSite({ domain: "client3.example.net" }, deps);
    expect(freed.ok && freed.data).toMatchObject({ removed: true, limit: 10, used: 9, remaining: 1 });
    const again = await trackSite({ domain: "client11.example.net" }, deps);
    expect(again.ok && again.data.created).toBe(true);
    expect(state.tracked).toHaveLength(10);
  });

  it("track_site on a site already tracked is a no-op even at the cap", async () => {
    const { deps } = world({ tracked: sites(10) });
    const res = await trackSite({ domain: "client2.example.net" }, deps);
    expect(res.ok && res.data.already_tracked).toBe(true);
  });

  it("Pro at its cap of 3 is refused the same way, at 3", async () => {
    const { deps } = world({ plan: "pro", tracked: sites(3) });
    const res = await trackSite({ domain: "client4.example.net" }, deps);
    expect(!res.ok && res.error.code).toBe("LIMIT_REACHED");
    expect(!res.ok && res.error.message).toContain("up to 3 domains");
  });

  it("a lapsed Agency account reads as free: PRO_REQUIRED, nothing tracked", async () => {
    const { deps, state } = world({ status: "canceled", tracked: [] });
    const res = await trackSite({ domain: "client1.example.net" }, deps);
    expect(!res.ok && res.error.code).toBe("PRO_REQUIRED");
    expect(state.tracked).toHaveLength(0);
  });
});

describe("check_upgrade_status names the plan", () => {
  const cases: Array<[Plan, string, RegExp]> = [
    ["pro", "active", /^Pro subscription active/],
    ["agency", "active", /^Agency subscription active/],
    ["enterprise", "active", /^Enterprise subscription active/],
    ["agency", "trialing", /^Free trial active until 2026-12-31T00:00:00Z — all Agency tools are unlocked/],
  ];
  for (const [plan, status, expected] of cases) {
    it(`${plan} (${status})`, async () => {
      const { deps } = world({ plan, status });
      const res = await checkUpgradeStatus({}, deps);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // tier stays "pro" for every paid plan: the API's public answer, which gates read.
      expect(res.data.tier).toBe("pro");
      expect(res.data.plan).toBe(plan);
      expect(res.data.message).toMatch(expected);
      // An Agency member is never told they have Pro.
      if (plan !== "pro") expect(res.data.message).not.toMatch(/\bPro\b/);
      expect(() => z.object(checkUpgradeStatusOutput).parse(res.data)).not.toThrow();
    });
  }

  it("an Agency subscription set to end says Agency, and what to resubscribe to", async () => {
    const config = testConfig({ apiKey: "wa_x" });
    const client = {
      getSubscription: vi.fn(async () => ({ tier: "pro" as const, plan: "agency" as const, status: "active", current_period_end: "2026-12-31T00:00:00Z", cancel_at_period_end: true })),
    };
    const res = await checkUpgradeStatus({}, makeDeps({ config, client }));
    expect(res.ok && res.data.message).toMatch(/^Agency subscription active but set to end on 2026-12-31/);
    expect(res.ok && res.data.message).toContain("Resubscribe at");
    expect(res.ok && res.data.message).toContain("keep Agency tools");
  });

  it("a plan the API does not name, or a build without the field, reads as before", async () => {
    for (const plan of [undefined, "scale", 7]) {
      const config = testConfig({ apiKey: "wa_x" });
      const client = new WaApiClient(config as never, {
        fetch: (async () => json(200, { success: true, tier: "pro", status: "active", current_period_end: "2026-12-31T00:00:00Z", ...(plan === undefined ? {} : { plan }) })) as unknown as typeof fetch,
      });
      // Own methods only: makeDeps spreads the client, a class's live on its prototype.
      const res = await checkUpgradeStatus({}, makeDeps({ config, client: { getSubscription: () => client.getSubscription() } }));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.plan).toBeUndefined();
      expect(res.data.message).toMatch(/^Pro subscription active/);
    }
  });

  it("a lapsed Agency account has no plan to name", async () => {
    const { deps } = world({ status: "canceled" });
    const res = await checkUpgradeStatus({}, deps);
    expect(res.ok && res.data.tier).toBe("free");
    expect(res.ok && res.data.plan).toBeUndefined();
  });
});

describe("the month's extra audit runs (Agency)", () => {
  it("run_audit of a tracked client past the count is EXTRA_RUNS_UNAVAILABLE with the reset, not the daily quota", async () => {
    const { deps } = world({ tracked: ["client1.example.net"], extraRunsSpent: true });
    const res = await runAudit({ domain: "client1.example.net" }, deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("EXTRA_RUNS_UNAVAILABLE");
    expect(res.error.message).toContain("2026-12-01");
    expect(res.error.details).toMatchObject({ limit: 30, used: 30, resets_at: NEXT_DAY });
    expect(res.error.upgrade_url).toBeUndefined();
  });

  it("compare_competitors does not report it as the daily quota being exhausted", async () => {
    const { deps } = world({ tracked: ["client1.example.net"], extraRunsSpent: true });
    const res = await compareCompetitors({ domain: "client1.example.net", competitors: ["rival.example.org"] }, deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("EXTRA_RUNS_UNAVAILABLE");
    expect(res.error.message).not.toMatch(/daily audit quota/i);
  });

  it("the provider-budget pause is the same code, its day in the message, and no details to read when the API sends none (a reset that is not a date is not said as one)", async () => {
    const config = testConfig({ apiKey: "wa_x" });
    const message = "This account's extra audit runs are paused for the month to stay within the provider budget. They are available again on 2026-12-01 (UTC).";
    const client = new WaApiClient(config as never, {
      fetch: (async () => json(429, { success: false, code: "EXTRA_AUDIT_RUNS_BUDGET", error: message, extra_audit_runs: { resets_at: NEXT_DAY } })) as unknown as typeof fetch,
    });
    await expect(client.runAudit({ domain: "client1.example.net" })).rejects.toMatchObject({
      code: "EXTRA_RUNS_UNAVAILABLE", message, details: { resets_at: NEXT_DAY },
    });
    const bare = new WaApiClient(config as never, {
      fetch: (async () => json(429, { success: false, code: "EXTRA_AUDIT_RUNS_BUDGET", error: message })) as unknown as typeof fetch,
    });
    await expect(bare.runAudit({ domain: "client1.example.net" })).rejects.toMatchObject({ code: "EXTRA_RUNS_UNAVAILABLE", message });
    const odd = new WaApiClient(config as never, {
      fetch: (async () => json(429, { success: false, code: "EXTRA_AUDIT_RUNS_BUDGET", error: "Paused.", extra_audit_runs: { resets_at: "next month" } })) as unknown as typeof fetch,
    });
    await expect(odd.runAudit({ domain: "client1.example.net" })).rejects.toMatchObject({ code: "EXTRA_RUNS_UNAVAILABLE", message: "Paused." });
    const offset = new WaApiClient(config as never, {
      fetch: (async () => json(429, { success: false, code: "EXTRA_AUDIT_RUNS_BUDGET", error: "Paused.", extra_audit_runs: { resets_at: "2026-12-01T00:00:00+02:00" } })) as unknown as typeof fetch,
    });
    await expect(offset.runAudit({ domain: "client1.example.net" })).rejects.toMatchObject({ message: "Paused." });
    const impossible = new WaApiClient(config as never, {
      fetch: (async () => json(429, { success: false, code: "EXTRA_AUDIT_RUNS_BUDGET", error: "Paused.", extra_audit_runs: { resets_at: "2026-13-45T00:00:00Z" } })) as unknown as typeof fetch,
    });
    await expect(impossible.runAudit({ domain: "client1.example.net" })).rejects.toMatchObject({ message: "Paused." });
    // The rejected reset is not in details either; the rest of the block is.
    const dropped = new WaApiClient(config as never, {
      fetch: (async () => json(429, { success: false, code: "EXTRA_AUDIT_RUNS_SPENT", error: "Spent.", extra_audit_runs: { limit: 5, used: 5, resets_at: "2026-02-30" } })) as unknown as typeof fetch,
    });
    await expect(dropped.runAudit({ domain: "client1.example.net" })).rejects.toMatchObject({ details: { limit: 5, used: 5 } });
    await expect(dropped.runAudit({ domain: "client1.example.net" })).rejects.not.toHaveProperty("details.resets_at");
    // Real edge dates are still said: a leap day, a month-end instant.
    for (const resets_at of ["2028-02-29", "2026-12-31T23:59:59.999Z"]) {
      const edge = new WaApiClient(config as never, {
        fetch: (async () => json(429, { success: false, code: "EXTRA_AUDIT_RUNS_BUDGET", error: "Paused.", extra_audit_runs: { resets_at } })) as unknown as typeof fetch,
      });
      await expect(edge.runAudit({ domain: "client1.example.net" })).rejects.toMatchObject({ message: `Paused. It resets at ${resets_at}.`, details: { resets_at } });
    }
    // A date that parses only by rolling over (Feb 30, Feb 31) is not a real day either.
    for (const resets_at of ["2026-02-30", "2026-02-31T00:00:00Z", "2026-04-31"]) {
      const rolled = new WaApiClient(config as never, {
        fetch: (async () => json(429, { success: false, code: "EXTRA_AUDIT_RUNS_BUDGET", error: "Paused.", extra_audit_runs: { resets_at } })) as unknown as typeof fetch,
      });
      await expect(rolled.runAudit({ domain: "client1.example.net" })).rejects.toMatchObject({ message: "Paused." });
    }
  });

  it("a 429 whose sentence does not name the day gets it from the reset the API sent", async () => {
    const config = testConfig({ apiKey: "wa_x" });
    const client = new WaApiClient(config as never, {
      fetch: (async () => json(429, { success: false, code: "EXTRA_AUDIT_RUNS_SPENT", error: "The month's extra audit runs are used.", extra_audit_runs: { resets_at: NEXT_DAY } })) as unknown as typeof fetch,
    });
    await expect(client.runAudit({ domain: "client1.example.net" })).rejects.toMatchObject({
      code: "EXTRA_RUNS_UNAVAILABLE", message: `The month's extra audit runs are used. It resets at ${NEXT_DAY}.`,
    });
  });

  it("the ordinary daily 429 is still OVER_QUOTA", async () => {
    const config = testConfig({ apiKey: "wa_x" });
    const client = new WaApiClient(config as never, {
      fetch: (async () => json(429, { success: false, error: "Rate limit exceeded. You can make 10 requests per day." })) as unknown as typeof fetch,
    });
    await expect(client.runAudit({ domain: "client1.example.net" })).rejects.toMatchObject({ code: "OVER_QUOTA" });
  });
});
