/**
 * Free audits in ChatGPT (owner decision 2026-11-05), WA_FREE_AUDITS=chatgpt.
 *
 * What a connected account without a plan gets on the hosted ChatGPT service:
 * run_audit and get_ai_visibility on its own site, and get_report for the
 * audit it ran, with `next_steps` that are plain facts and tool names. Every
 * other tool is gated as before, with the same neutral reply and the same
 * plans link (the ChatGPT page OpenAI already reviewed). Anything but that
 * service is unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import { runAudit } from "../../src/tools/runAudit.js";
import { getAiVisibility } from "../../src/tools/getAiVisibility.js";
import { getReport } from "../../src/tools/getReport.js";
import { checkUpgradeStatus } from "../../src/tools/checkUpgradeStatus.js";
import { trackSite } from "../../src/tools/trackSite.js";
import { untrackSite } from "../../src/tools/untrackSite.js";
import { getChanges } from "../../src/tools/getChanges.js";
import { getGtmPlan } from "../../src/tools/getGtmPlan.js";
import { getBenchmark } from "../../src/tools/getBenchmark.js";
import { compareCompetitors } from "../../src/tools/compareCompetitors.js";
import { generateSchema } from "../../src/tools/generateSchema.js";
import { listFixes } from "../../src/tools/listFixes.js";
import { getFixFacts } from "../../src/tools/getFixFacts.js";
import { getFix } from "../../src/tools/getFix.js";
import { confirmFacts } from "../../src/tools/confirmFacts.js";
import { checkFix } from "../../src/tools/checkFix.js";
import { getMonitoringStatus } from "../../src/tools/getMonitoringStatus.js";
import { listTrackedSites } from "../../src/tools/listTrackedSites.js";
import { getRecommendations } from "../../src/tools/getRecommendations.js";
import { fromApiError, type ToolDeps, type ToolResult } from "../../src/tools/context.js";
import { freeNextSteps, nextStepsSentence } from "../../src/tools/nextSteps.js";
import { SERVED_TOOLS, descriptionFor } from "../../src/tools/registry.js";
import { buildInstructions } from "../../src/mcp/instructions.js";
import { loadConfig } from "../../src/config.js";
import { WaApiClient } from "../../src/api/client.js";
import { WaApiError, FREE_AUDIT_LIMIT_REASON } from "../../src/api/errors.js";
import { DefaultSubscriptionProvider } from "../../src/auth/entitlements.js";
import { makeDeps, fixedResolution } from "../helpers.js";
import { reachableReport } from "../fixtures/reports.js";
import type { AuditReport } from "../../src/api/types.js";

const CHATGPT_INFO = "https://api.website-auditor.io/admin_portal/?source=chatgpt";
/** Words a free result may never carry (OpenAI: no pricing, subscriptions, free trials, promotions, upgrades). */
const BANNED = /\$\s?\d|\/month|\btrial|upgrade|subscri|\bpro\b|premium|discount|promo|\bfree\b|\bpay|\bbuy|\bprice|\bcost|checkout/i;

function freeReport(): AuditReport {
  const base = reachableReport();
  return {
    ...base,
    results: [
      ...base.results,
      { test_id: "a", module: "security", name: "Missing HSTS", description: "", status: "failed", severity: "high", url: "https://acme.com", details: "", recommendation: "", has_fix: true, impact_estimate: 400 },
      { test_id: "b", module: "links", name: "Broken links", description: "", status: "failed", severity: "medium", url: "https://acme.com", details: "", recommendation: "", has_fix: true, impact_estimate: 150 },
      { test_id: "c", module: "base", name: "AI Visibility Score", description: "", status: "failed", severity: "high", url: "https://acme.com", details: "", recommendation: "", has_fix: true, impact_estimate: 900 },
      { test_id: "d", module: "seo", name: "No fix row", description: "", status: "failed", severity: "low", url: "https://acme.com", details: "", recommendation: "", has_fix: false, impact_estimate: 50 },
    ],
    ai_visibility: { ...base.ai_visibility, locked_engines: ["Google AI Overviews", "Microsoft Copilot"] },
  } as AuditReport;
}

/** The hosted ChatGPT service: info style, flag on, http, reached by OAuth, API says eligible. */
function chatgptDeps(over: { freeAudit?: boolean; flag?: boolean; transport?: "stdio" | "http"; authVia?: ToolDeps["authVia"]; client?: Record<string, unknown>; verified?: boolean } = {}): ToolDeps {
  const deps = makeDeps({
    subscriptions: fixedResolution({ tier: "free", verified: over.verified ?? true, ...(over.freeAudit === false ? {} : { freeAudit: true }) }),
    config: { upsellStyle: "info", upsellInfoUrl: CHATGPT_INFO, freeAudits: over.flag ?? true },
    client: { runAudit: vi.fn(async () => ({ runId: "run1", report: freeReport(), raw: {} })), ...(over.client ?? {}) } as never,
  });
  return { ...deps, transport: over.transport ?? "http", authVia: "authVia" in over ? over.authVia : "oauth" };
}

describe("the flag", () => {
  it("is on only for WA_FREE_AUDITS=chatgpt on an info-style server", () => {
    expect(loadConfig({ WA_FREE_AUDITS: "chatgpt", WA_UPSELL_STYLE: "info" }).freeAudits).toBe(true);
    expect(loadConfig({ WA_FREE_AUDITS: " ChatGPT ", WA_UPSELL_STYLE: "info" }).freeAudits).toBe(true);
  });
  it("is off by default, for anything else, and on the Claude connector and local installs", () => {
    expect(loadConfig({}).freeAudits).toBe(false);
    for (const v of ["1", "true", "on", "claude", "", "${WA_FREE_AUDITS}"]) {
      expect(loadConfig({ WA_FREE_AUDITS: v, WA_UPSELL_STYLE: "info" }).freeAudits).toBe(false);
    }
    // The Claude box (link style, neutral copy, http challenge) and npm/stdio installs.
    expect(loadConfig({ WA_FREE_AUDITS: "chatgpt", WA_AUTH_CHALLENGE: "http", WA_TOOL_COPY: "neutral", WA_LINK_CHANNEL: "claude" }).freeAudits).toBe(false);
    expect(loadConfig({ WA_FREE_AUDITS: "chatgpt" }).freeAudits).toBe(false);
  });
});

describe("a free ChatGPT account", () => {
  it("run_audit runs the audit and returns next_steps, a summary sentence and no dashboard link", async () => {
    const deps = chatgptDeps();
    const res = await runAudit({ domain: "acme.com" }, deps);
    expect(deps.client.runAudit).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.scores.ai_visibility).toBe(62);
    expect(res.data.dashboard).toBeUndefined();
    expect(res.data.next_steps).toEqual([
      { tool: "get_fix", what: "2 fixes available for acme.com" },
      { tool: "track_site", what: "2 of 6 AI engines not checked on this plan (Google AI Overviews, Microsoft Copilot); weekly monitoring of acme.com checks all 6" },
      { tool: "get_gtm_plan", what: "A growth plan written from this audit" },
      { tool: "compare_competitors", what: "Side-by-side AI visibility against named competitors of acme.com" },
    ]);
    expect(res.data.summary).toBe(
      "Next steps: 2 fixes available for acme.com (get_fix); 2 of 6 AI engines not checked on this plan (Google AI Overviews, Microsoft Copilot); weekly monitoring of acme.com checks all 6 (track_site); A growth plan written from this audit (get_gtm_plan); Side-by-side AI visibility against named competitors of acme.com (compare_competitors).",
    );
  });

  it("get_ai_visibility works, skips the history call, and folds the next steps into summary", async () => {
    const deps = chatgptDeps();
    const res = await getAiVisibility({ domain: "acme.com" }, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(deps.client.getAiVisibilityHistory).not.toHaveBeenCalled();
    expect(res.data.trend).toBeNull();
    expect(res.data.dashboard).toBeUndefined();
    expect(res.data.next_steps!.map((s) => s.tool)).toContain("get_fix");
    expect(res.data.summary).toContain("Next steps:");
  });

  it("with no audit on record, get_report and get_recommendations tell a free account to run run_audit, not that it is not included", async () => {
    const noAudit = () => { throw new WaApiError("NOT_FOUND", "No audit on record for acme.com. Run an audit first.", { status: 404 }); };
    const deps = chatgptDeps({ client: { getReport: vi.fn(async () => noAudit()), getRecommendations: vi.fn(async () => noAudit()) } });
    for (const res of [await getReport({ domain: "acme.com" }, deps), await getRecommendations({ domain: "acme.com" }, deps)]) {
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.error.code).toBe("NOT_FOUND");
      expect(res.error.message).toContain("Run run_audit for acme.com first");
      expect(res.error.message).not.toMatch(/not included/);
    }
    // With the flag off, the same account is told running one is not included.
    const off = chatgptDeps({ flag: false, client: { getReport: vi.fn(async () => noAudit()) } });
    const res = await getReport({ domain: "acme.com" }, off);
    expect(!res.ok && res.error.message).toMatch(/not included/);
  });

  it("get_report works on the audit it ran", async () => {
    const deps = chatgptDeps({ client: { getReport: vi.fn(async () => ({ report_url: "https://website-auditor.io/report/x", badge_html: "<a>b</a>" })) } });
    const res = await getReport({ domain: "acme.com" }, deps);
    expect(res.ok).toBe(true);
  });

  it("next_steps never carry a price, trial, upgrade, subscribe, plan name or promotion", () => {
    expect(JSON.stringify(freeNextSteps(freeReport(), "acme.com"))).not.toMatch(BANNED);
    expect(nextStepsSentence(freeNextSteps(freeReport(), "acme.com"))).not.toMatch(BANNED);
    // A test that fails on them: the guard itself catches each word.
    for (const bad of ["Upgrade to Pro", "$49/month", "start a free trial", "Subscribe", "20% discount"]) expect(bad).toMatch(BANNED);
  });

  it("says only what is true: no fixes row, no locked engines -> neither is listed", () => {
    const steps = freeNextSteps(reachableReport(), "acme.com");
    expect(steps.map((s) => s.tool)).toEqual(["track_site", "get_gtm_plan", "compare_competitors"]);
    expect(steps[0]!.what).toBe("Weekly monitoring of acme.com");
  });
});

describe("what stays gated, with the reused neutral reply and plans page", () => {
  const stillPro: Array<[string, (d: string, deps: ToolDeps) => Promise<ToolResult<unknown>>]> = [
    ["track_site", (domain, deps) => trackSite({ domain }, deps)],
    ["untrack_site", (domain, deps) => untrackSite({ domain }, deps)],
    ["get_changes", (domain, deps) => getChanges({ domain }, deps)],
    ["get_gtm_plan", (domain, deps) => getGtmPlan({ domain }, deps)],
    ["get_benchmark", (domain, deps) => getBenchmark({ domain }, deps)],
    ["compare_competitors", (domain, deps) => compareCompetitors({ domain, competitors: ["rival.com"] }, deps)],
    ["generate_schema", (domain, deps) => generateSchema({ domain }, deps)],
    ["list_fixes", (domain, deps) => listFixes({ domain }, deps)],
    ["get_fix_facts", (domain, deps) => getFixFacts({ domain }, deps)],
    ["get_fix", (domain, deps) => getFix({ domain }, deps)],
    ["confirm_facts", (domain, deps) => confirmFacts({ domain, facts: { name: "Acme" }, seen: { kind: "premises", facts: {} } }, deps)],
    ["check_fix", (domain, deps) => checkFix({ domain, id: "0b6c1f5e-8a4d-4c39-9f1e-2a7d3c5b9e10" }, deps)],
    ["get_monitoring_status", (domain, deps) => getMonitoringStatus({ domain }, deps)],
    ["list_tracked_sites", (_d, deps) => listTrackedSites({}, deps)],
  ];
  for (const [name, call] of stillPro) {
    it(`${name} -> PRO_REQUIRED, the neutral sentence, the ChatGPT plans page named for the site`, async () => {
      const deps = chatgptDeps();
      const res = await call("acme.com", deps);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("PRO_REQUIRED");
      expect(res.error.message).toContain("is not included in this account's current Website Auditor plan.");
      expect(res.error.message).toContain(`Plans are described at ${CHATGPT_INFO}`);
      expect(res.error.upgrade_url).toContain("source=chatgpt");
      expect(res.error.message).not.toMatch(/\$\s?\d|trial|upgrade|subscri/i);
    });
  }
});

describe("who is not offered the free audit", () => {
  const cases: Array<[string, () => ToolDeps]> = [
    ["flag off", () => chatgptDeps({ flag: false })],
    ["the API did not say eligible", () => chatgptDeps({ freeAudit: false })],
    ["a pasted key, not an OAuth connection", () => chatgptDeps({ authVia: "key" })],
    ["stdio", () => chatgptDeps({ transport: "stdio" })],
    ["no authVia", () => chatgptDeps({ authVia: undefined })],
  ];
  for (const [label, make] of cases) {
    it(`${label}: run_audit, get_ai_visibility and get_report are PRO_REQUIRED and nothing is dispatched`, async () => {
      const deps = make();
      for (const call of [runAudit, getAiVisibility, getReport]) {
        const res = await call({ domain: "acme.com" }, deps);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("PRO_REQUIRED");
      }
      expect(deps.client.runAudit).not.toHaveBeenCalled();
    });
  }
  it("an unverified tier is a retryable signal, not a free audit", async () => {
    const res = await runAudit({ domain: "acme.com" }, chatgptDeps({ verified: false }));
    expect(!res.ok && res.error.code).toBe("SUBSCRIPTION_UNVERIFIED");
  });
  it("a subscriber is unaffected: a normal Pro result, with no next_steps", async () => {
    const deps = { ...chatgptDeps(), subscriptions: fixedResolution({ tier: "pro", verified: true }) };
    const res = await runAudit({ domain: "acme.com" }, deps);
    expect(res.ok && res.data.next_steps).toBeFalsy();
  });
});

describe("the account's limit", () => {
  const limited = (): WaApiError => new WaApiError("PRO_REQUIRED", "x", {
    status: 429, details: { reason: FREE_AUDIT_LIMIT_REASON, limit: "daily_cap" }, upgradeUrl: "https://api.website-auditor.io/admin_portal/",
  });
  it("is answered with the neutral plan reply and the same plans page, not an upsell", async () => {
    const deps = chatgptDeps({ client: { runAudit: vi.fn(async () => { throw limited(); }) } });
    const res = await runAudit({ domain: "acme.com" }, deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(res.error.message).toContain("The audits included in this account's current Website Auditor plan are used for now.");
    expect(res.error.message).toContain(`Plans are described at ${CHATGPT_INFO}&site=acme.com`);
    expect(res.error.upgrade_url).toBe(`${CHATGPT_INFO}&site=acme.com`);
    expect(res.error.message).not.toMatch(/\$\s?\d|trial|upgrade|subscri/i);
  });
  it("a rhythm refusal says to wait a minute, not that the audits are used", async () => {
    const e = new WaApiError("PRO_REQUIRED", "x", { status: 429, details: { reason: FREE_AUDIT_LIMIT_REASON, limit: "cadence" } });
    const deps = chatgptDeps({ client: { runAudit: vi.fn(async () => { throw e; }) } });
    const res = await runAudit({ domain: "acme.com" }, deps);
    expect(!res.ok && res.error.message).toContain("try again in a minute");
    expect(!res.ok && res.error.message).not.toMatch(/\$\s?\d|trial|upgrade|subscri/i);
  });
  it("the client maps the API's 429 FREE_AUDIT_LIMIT to it, and a plain 429 stays OVER_QUOTA", async () => {
    const mk = (body: unknown) => new WaApiClient(
      { ...loadConfig({}), apiKey: "wa_k" },
      { fetch: (async () => new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json" } })) as unknown as typeof fetch },
    );
    const a = await mk({ success: false, code: "FREE_AUDIT_LIMIT", reason: "cadence", error: "e" }).runAudit({ domain: "acme.com" }).catch((e) => e);
    expect(a).toBeInstanceOf(WaApiError);
    expect(a.code).toBe("PRO_REQUIRED");
    expect(a.details).toEqual({ reason: FREE_AUDIT_LIMIT_REASON, limit: "cadence" });
    const b = await mk({ success: false, error: "Rate limit exceeded." }).runAudit({ domain: "acme.com" }).catch((e) => e);
    expect(b.code).toBe("OVER_QUOTA");
    expect(fromApiError(b, loadConfig({}), "http", "oauth", "acme.com").ok).toBe(false);
  });
});

describe("the tier resolver", () => {
  it("passes the API's free_audits through, caches it, and never for Pro", async () => {
    const getSubscription = vi.fn(async () => ({ tier: "free" as const, status: "none", freeAudits: true }));
    const p = new DefaultSubscriptionProvider(loadConfig({ WA_API_KEY: "wa_k" }), { getSubscription });
    expect(await p.resolve("wa_k")).toEqual({ tier: "free", verified: true, freeAudit: true });
    expect(await p.resolve("wa_k")).toEqual({ tier: "free", verified: true, freeAudit: true });
    expect(getSubscription).toHaveBeenCalledOnce();
    const pro = new DefaultSubscriptionProvider(loadConfig({ WA_API_KEY: "wa_k" }), { getSubscription: async () => ({ tier: "pro" as const, status: "active", freeAudits: true }) });
    expect((await pro.resolve("wa_k")).freeAudit).toBeUndefined();
  });
  it("the client reads free_audits only for a free tier", async () => {
    const mk = (body: unknown) => new WaApiClient({ ...loadConfig({}), apiKey: "wa_k" }, { fetch: (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch });
    expect((await mk({ tier: "free", status: "none", free_audits: { eligible: true } }).getSubscription()).freeAudits).toBe(true);
    expect((await mk({ tier: "free", status: "none" }).getSubscription()).freeAudits).toBeUndefined();
    expect((await mk({ status: "active", free_audits: { eligible: true } }).getSubscription()).freeAudits).toBeUndefined();
  });
});

describe("the Claude connector and link-style servers are unchanged", () => {
  it("descriptions and instructions are byte-identical with the flag off", () => {
    for (const spec of SERVED_TOOLS) {
      for (const [style, copy] of [["link", "full"], ["info", "full"], ["link", "neutral"]] as const) {
        expect(descriptionFor(spec, style, copy, false)).toBe(descriptionFor(spec, style, copy));
      }
    }
    const args = ["https://x/", "info", "http", true, "full"] as const;
    expect(buildInstructions(...args, false)).toBe(buildInstructions(...args));
  });
  it("the flag changes exactly the three tools' descriptions and adds one paragraph", () => {
    const changed = SERVED_TOOLS.filter((s) => descriptionFor(s, "info", "full", true) !== descriptionFor(s, "info", "full"));
    expect(changed.map((s) => s.name).sort()).toEqual(["get_ai_visibility", "get_report", "run_audit"]);
    for (const s of changed) expect(descriptionFor(s, "info", "full", true)).not.toMatch(/\$\s?\d|trial|upgrade|subscri|\bpro\b/i);
    const args = ["https://x/", "info", "http", true, "full"] as const;
    const on = buildInstructions(...args, true);
    expect(on.startsWith(buildInstructions(...args))).toBe(true);
    expect(on.slice(buildInstructions(...args).length)).not.toMatch(/\$\s?\d|trial|upgrade|subscri|\bpro\b/i);
  });
  it("a server without the flag gates the three tools exactly as before", async () => {
    const deps = chatgptDeps({ flag: false });
    const res = await runAudit({ domain: "acme.com" }, deps);
    expect(!res.ok && res.error.message).toContain("is not included in this account's current Website Auditor plan.");
  });
});


describe("check_upgrade_status for a free ChatGPT account", () => {
  const sub = (freeAudits: boolean) => ({ getSubscription: vi.fn(async () => ({ tier: "free" as const, status: "none", freeAudits })) });

  it("says the account can run the free audit tools, instead of \"audits are locked\"", async () => {
    const res = await checkUpgradeStatus({}, chatgptDeps({ client: sub(true) }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.message).toContain("can run run_audit and get_ai_visibility");
    expect(res.data.message).toContain("get_recommendations");
    expect(res.data.message).not.toMatch(/locked/);
    expect(res.data.message).toContain(CHATGPT_INFO);
    expect(res.data.message).not.toMatch(BANNED);
  });

  it("keeps the locked wording when the API does not mark the account, the flag is off, or the key was pasted", async () => {
    for (const deps of [
      chatgptDeps({ client: sub(false) }),
      chatgptDeps({ flag: false, client: sub(true) }),
      chatgptDeps({ authVia: "key", client: sub(true) }),
    ]) {
      const res = await checkUpgradeStatus({}, deps);
      expect(res.ok && res.data.message).toMatch(/locked/);
    }
  });
});


describe("the server instructions with the flag on", () => {
  it("tell the model to call run_audit rather than decline from the plan sentence", () => {
    const args = ["https://x/", "info", "http", true, "full"] as const;
    const added = buildInstructions(...args, true).slice(buildInstructions(...args).length);
    expect(added).toContain("call run_audit rather than declining in advance");
    expect(added).not.toMatch(/\$\s?\d|trial|upgrade|subscri|\bpro\b/i);
  });
});
