/**
 * The free audit on the hosted Claude service (WA_FREE_AUDITS=claude, owner's
 * ask 2026-11-12): the ChatGPT free audit (freeAudits.test.ts) with the Claude
 * box's settings, link style and neutral copy. The API decides eligibility and
 * the engine applies the same per-account limits; this only lets the tools
 * offer it, in words Anthropic's directory review accepts.
 */
import { describe, it, expect, vi } from "vitest";
import { runAudit } from "../../src/tools/runAudit.js";
import { getAiVisibility } from "../../src/tools/getAiVisibility.js";
import { getReport } from "../../src/tools/getReport.js";
import { trackSite } from "../../src/tools/trackSite.js";
import { checkUpgradeStatus } from "../../src/tools/checkUpgradeStatus.js";
import type { ToolDeps } from "../../src/tools/context.js";
import { SERVED_TOOLS, descriptionFor } from "../../src/tools/registry.js";
import { buildInstructions } from "../../src/mcp/instructions.js";
import { loadConfig } from "../../src/config.js";
import { WaApiError, FREE_AUDIT_LIMIT_REASON } from "../../src/api/errors.js";
import { WaApiClient } from "../../src/api/client.js";
import { uncheckedEnginesNote } from "../../src/tools/nextSteps.js";
import { makeDeps, fixedResolution } from "../helpers.js";
import { reachableReport } from "../fixtures/reports.js";

const MONEY = /\$\s?\d|\/month|\btrial|upgrade|subscri|\bpro\b|premium|discount|promo|\bbuy|\bprice|checkout/i;
/** The hosted Claude service's own settings, as loadConfig reads them. */
const CLAUDE_ENV = { WA_FREE_AUDITS: "claude", WA_AUTH_CHALLENGE: "http", WA_TOOL_COPY: "neutral", WA_LINK_CHANNEL: "claude" };

function claudeDeps(over: { freeAudit?: boolean; flag?: boolean; authVia?: ToolDeps["authVia"]; client?: Record<string, unknown> } = {}): ToolDeps {
  const deps = makeDeps({
    subscriptions: fixedResolution({ tier: "free", verified: true, ...(over.freeAudit === false ? {} : { freeAudit: true }) }),
    config: { upsellStyle: "link", toolCopy: "neutral", linkChannel: "claude", freeAudits: over.flag ?? true },
    client: { runAudit: vi.fn(async () => ({ runId: "run1", report: reachableReport(), raw: {} })), ...(over.client ?? {}) } as never,
  });
  return { ...deps, transport: "http", authVia: "authVia" in over ? over.authVia : "oauth" };
}

describe("the flag on the Claude service", () => {
  it("is on for WA_FREE_AUDITS=claude on the hosted Claude service", () => {
    expect(loadConfig(CLAUDE_ENV).freeAudits).toBe(true);
    expect(loadConfig({ ...CLAUDE_ENV, WA_FREE_AUDITS: " Claude " }).freeAudits).toBe(true);
  });
  it("is off for claude anywhere else, and for chatgpt on the Claude service", () => {
    expect(loadConfig({ WA_FREE_AUDITS: "claude" }).freeAudits).toBe(false);
    expect(loadConfig({ WA_FREE_AUDITS: "claude", WA_UPSELL_STYLE: "info" }).freeAudits).toBe(false);
    expect(loadConfig({ WA_FREE_AUDITS: "claude", WA_UPSELL_STYLE: "info", WA_LINK_CHANNEL: "claude" }).freeAudits).toBe(false);
    expect(loadConfig({ WA_FREE_AUDITS: "claude", WA_LINK_CHANNEL: "chatgpt" }).freeAudits).toBe(false);
    expect(loadConfig({ ...CLAUDE_ENV, WA_FREE_AUDITS: "chatgpt" }).freeAudits).toBe(false);
    expect(loadConfig({ ...CLAUDE_ENV, WA_FREE_AUDITS: "" }).freeAudits).toBe(false);
    expect(loadConfig({ ...CLAUDE_ENV, WA_TOOL_COPY: "full" }).freeAudits).toBe(false);
    expect(loadConfig({ WA_FREE_AUDITS: "chatgpt", WA_UPSELL_STYLE: "info", WA_TOOL_COPY: "neutral" }).freeAudits).toBe(false);
    const { WA_TOOL_COPY: _copy, ...noCopy } = CLAUDE_ENV as Record<string, string>;
    expect(loadConfig(noCopy).freeAudits).toBe(false);
  });
});

describe("a free Claude connector account", () => {
  it("run_audit runs the audit, with no next_steps and no dashboard link", async () => {
    const deps = claudeDeps();
    const res = await runAudit({ domain: "acme.com" }, deps);
    expect(deps.client.runAudit).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.dashboard).toBeUndefined();
    expect(res.data.next_steps).toBeUndefined();
    expect(JSON.stringify(res.data)).not.toMatch(/track_site|get_gtm_plan|compare_competitors/);
    const vis = await getAiVisibility({ domain: "acme.com" }, deps);
    expect(vis.ok && (vis.data as { next_steps?: unknown }).next_steps).toBeUndefined();
  });
  it("still says which AI engines a free result left out, with no tool name", async () => {
    const report = { ...reachableReport(), ai_visibility: { ...reachableReport().ai_visibility, locked_engines: ["Google AI Overviews", "Microsoft Copilot"] } };
    const deps = claudeDeps({ client: { runAudit: vi.fn(async () => ({ runId: "run1", report, raw: {} })) } });
    const note = "4 of 6 AI engines were checked in this result; not checked: Google AI Overviews, Microsoft Copilot.";
    const res = await runAudit({ domain: "acme.com" }, deps);
    expect(res.ok && (res.data as { summary?: string }).summary).toBe(note);
    const vis = await getAiVisibility({ domain: "acme.com" }, deps);
    expect(vis.ok && (vis.data as { summary?: string }).summary).toContain(note);
    for (const r of [res, vis]) expect(JSON.stringify(r)).not.toMatch(MONEY);
    const withLocked = (locked_engines: unknown) => ({ ...reachableReport(), ai_visibility: { ...reachableReport().ai_visibility, locked_engines } }) as never;
    expect(uncheckedEnginesNote(withLocked(["Claude", "Claude"]))).toBe("5 of 6 AI engines were checked in this result; not checked: Claude.");
    expect(uncheckedEnginesNote(withLocked(["a", "b", "c", "d", "e", "f", "g"]))).toBe("Not checked in this result: a, b, c, d, e, f, g.");
    expect(uncheckedEnginesNote(withLocked(undefined))).toBeNull();
  });
  it("get_ai_visibility and get_report are open to it; other Pro tools stay gated", async () => {
    const deps = claudeDeps();
    expect((await getAiVisibility({ domain: "acme.com" }, deps)).ok).toBe(true);
    const report = await getReport({ domain: "acme.com" }, deps);
    expect(!report.ok && report.error.code).not.toBe("PRO_REQUIRED");
    const track = await trackSite({ domain: "acme.com" }, deps);
    expect(!track.ok && track.error.code).toBe("PRO_REQUIRED");
  });
  it("is not offered without the flag, without the API's word, or on a pasted key", async () => {
    for (const deps of [claudeDeps({ flag: false }), claudeDeps({ freeAudit: false }), claudeDeps({ authVia: "key" })]) {
      const res = await runAudit({ domain: "acme.com" }, deps);
      expect(!res.ok && res.error.code).toBe("PRO_REQUIRED");
      expect(deps.client.runAudit).not.toHaveBeenCalled();
    }
  });
  it("check_upgrade_status says it can run the free audit tools", async () => {
    const client = { getSubscription: vi.fn(async () => ({ tier: "free" as const, status: "none", freeAudits: true })) };
    const res = await checkUpgradeStatus({}, claudeDeps({ client }));
    expect(res.ok && res.data.message).toContain("can run run_audit and get_ai_visibility");
    expect(res.ok && res.data.message).not.toMatch(/locked/);
  });
});

describe("the account's limit on the Claude service", () => {
  const limited = (limit: "daily_cap" | "cadence") => new WaApiError("PRO_REQUIRED", "The audits included with this account are used for now.", {
    status: 429, details: { reason: FREE_AUDIT_LIMIT_REASON, limit }, upgradeUrl: "https://api.website-auditor.io/admin_portal/",
  });
  it("says the included audits are used for now, with where plans are described", async () => {
    const deps = claudeDeps({ client: { runAudit: vi.fn(async () => { throw limited("daily_cap"); }) } });
    const res = await runAudit({ domain: "acme.com" }, deps);
    expect(!res.ok && res.error.code).toBe("PRO_REQUIRED");
    expect(!res.ok && res.error.message).toContain("The audits included in this account's current Website Auditor plan are used for now.");
    expect(!res.ok && res.error.message).toContain("Plans are described at https://api.website-auditor.io/admin_portal/");
    expect(!res.ok && res.error.upgrade_url).toContain("admin_portal");
  });
  it("a rhythm refusal says to wait a minute", async () => {
    const deps = claudeDeps({ client: { runAudit: vi.fn(async () => { throw limited("cadence"); }) } });
    const res = await runAudit({ domain: "acme.com" }, deps);
    expect(!res.ok && res.error.message).toContain("try again in a minute");
  });
});

describe("what the Claude service publishes with the flag on", () => {
  it("changes no tool description: the reviewed neutral copy stands", () => {
    for (const s of SERVED_TOOLS) expect(descriptionFor(s, "link", "neutral", true)).toBe(descriptionFor(s, "link", "neutral"));
  });
  it("adds one descriptive paragraph to the instructions: no money words, no telling Claude to call a tool", () => {
    const args = ["https://x/", "link", "http", true, "neutral"] as const;
    const off = buildInstructions(...args);
    const on = buildInstructions(...args, true);
    expect(on.startsWith(off)).toBe(true);
    const added = on.slice(off.length);
    expect(added).toContain("FREE AUDITS.");
    expect(added).toContain("free_audit_limit, whatever its details.limit, is this account's own limit");
    expect(added).toContain("the plan terms above do not apply to it");
    expect(added).not.toMatch(MONEY);
    expect(added).not.toMatch(/\bcall\b/i);
  });
});

describe("each service takes only its own channel's grant", () => {
  const mk = (env: Record<string, string>, body: unknown) => new WaApiClient({ ...loadConfig(env), apiKey: "wa_k" }, { fetch: (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch });
  const CHATGPT_ENV = { WA_FREE_AUDITS: "chatgpt", WA_UPSELL_STYLE: "info" };
  const grant = (channel?: string) => ({ tier: "free", status: "none", free_audits: channel === undefined ? { eligible: true } : { eligible: true, channel } });
  it("the Claude service takes a claude grant and refuses a chatgpt or unnamed one", async () => {
    expect((await mk(CLAUDE_ENV, grant("claude")).getSubscription()).freeAudits).toBe(true);
    expect((await mk(CLAUDE_ENV, grant("chatgpt")).getSubscription()).freeAudits).toBeUndefined();
    expect((await mk(CLAUDE_ENV, grant()).getSubscription()).freeAudits).toBeUndefined();
  });
  it("the ChatGPT service takes a chatgpt or unnamed grant and refuses a claude one", async () => {
    expect((await mk(CHATGPT_ENV, grant("chatgpt")).getSubscription()).freeAudits).toBe(true);
    expect((await mk(CHATGPT_ENV, grant()).getSubscription()).freeAudits).toBe(true);
    expect((await mk(CHATGPT_ENV, grant("claude")).getSubscription()).freeAudits).toBeUndefined();
  });
  it("a service with no free audit takes no grant, and the channel comes from WA_FREE_AUDITS", async () => {
    expect((await mk({}, grant("chatgpt")).getSubscription()).freeAudits).toBeUndefined();
    expect((await mk({ ...CLAUDE_ENV, WA_FREE_AUDITS: "off" }, grant("claude")).getSubscription()).freeAudits).toBeUndefined();
    expect(loadConfig(CLAUDE_ENV).freeAuditsChannel).toBe("claude");
    expect(loadConfig(CHATGPT_ENV).freeAuditsChannel).toBe("chatgpt");
    expect(loadConfig({}).freeAuditsChannel).toBeUndefined();
  });
});
