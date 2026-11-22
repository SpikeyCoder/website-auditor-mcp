/**
 * A free account's monthly cap (website-auditor-api's FREE_AUDIT_LIMIT, reason monthly_cap),
 * worded per channel: the two directory-listed hosts (hosted ChatGPT, `upsellStyle: info`; the
 * Claude connector, `toolCopy: neutral`) say only what is true and where plans are described, as
 * both directories forbid in-app promotion; every other channel (npm/stdio, link style) gets the
 * Pro offer and its link.
 *
 * Today only the two hosted services run free audits, and both are directory hosts, so the offer
 * branch is a defensive one: its tests hand-build a link-style config that loadConfig does not
 * produce for a free-audit service. The directory cases are pinned to the configs loadConfig does
 * produce for the hosted services, so a change to how they are derived fails here.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { runAudit } from "../../src/tools/runAudit.js";
import type { ToolDeps } from "../../src/tools/context.js";
import { loadConfig, isDirectoryChannel } from "../../src/config.js";
import { WaApiError, FREE_AUDIT_LIMIT_REASON } from "../../src/api/errors.js";
import { WaApiClient } from "../../src/api/client.js";
import { PRICE } from "../../src/tools/upgrade.js";
import { makeDeps, fixedResolution } from "../helpers.js";

// A fixed clock, so the expected text is a literal: a format or zone change fails here.
const RESETS = "2026-12-01T00:00:00.000Z";
const RESET_DATE = "December 1, 2026";
beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-22T12:00:00.000Z")); });
afterAll(() => { vi.useRealTimers(); });
const PORTAL = "https://api.website-auditor.io/admin_portal/";
const PRO_URL = `${PORTAL}?plan=pro&source=claude`; // as the API tags it, by ITS channel
const INFO = "https://website-auditor.io/?source=chatgpt";
const PROMO = /\$\s?\d|trial|upgrade|subscri|\bpro\b.*audits a day|per month/i;

function limited(limit: string, upgradeUrl = PORTAL, extra: Record<string, unknown> = { resets_at: RESETS }): WaApiError {
  return new WaApiError("PRO_REQUIRED", "x", { status: 429, upgradeUrl, details: { reason: FREE_AUDIT_LIMIT_REASON, limit, ...extra } });
}

function depsFor(config: Record<string, unknown>, error: WaApiError): ToolDeps {
  const deps = makeDeps({
    subscriptions: fixedResolution({ tier: "free", verified: true, freeAudit: true }),
    config: { freeAudits: true, ...config },
    client: { runAudit: vi.fn(async () => { throw error; }) } as never,
  });
  return { ...deps, transport: "http", authVia: "oauth" };
}

const CHATGPT = { upsellStyle: "info", upsellInfoUrl: INFO };
const CLAUDE = { upsellStyle: "link", toolCopy: "neutral", linkChannel: "claude" };
const NPM = { upsellStyle: "link" };

describe("the hosted services are the directory hosts", () => {
  it("loadConfig gives the hosted ChatGPT and Claude services a config isDirectoryChannel recognises", () => {
    expect(isDirectoryChannel(loadConfig({ WA_FREE_AUDITS: "chatgpt", WA_UPSELL_STYLE: "info" }))).toBe(true);
    expect(isDirectoryChannel(loadConfig({ WA_FREE_AUDITS: "claude", WA_AUTH_CHALLENGE: "http", WA_TOOL_COPY: "neutral", WA_LINK_CHANNEL: "claude" }))).toBe(true);
    expect(isDirectoryChannel(loadConfig({}))).toBe(false);
  });
  it("every config that turns free audits on is a directory host: the offer branch stays dormant", () => {
    let enabled = 0;
    for (const env of [
      { WA_FREE_AUDITS: "chatgpt", WA_UPSELL_STYLE: "info" },
      { WA_FREE_AUDITS: "claude", WA_AUTH_CHALLENGE: "http", WA_TOOL_COPY: "neutral", WA_LINK_CHANNEL: "claude" },
      { WA_FREE_AUDITS: "chatgpt" }, { WA_FREE_AUDITS: "claude" }, { WA_FREE_AUDITS: "claude", WA_LINK_CHANNEL: "claude" },
      { WA_FREE_AUDITS: "chatgpt", WA_UPSELL_STYLE: "link", WA_TOOL_COPY: "full" },
    ]) {
      const config = loadConfig(env);
      if (config.freeAudits) { enabled += 1; expect(isDirectoryChannel(config), JSON.stringify(env)).toBe(true); }
    }
    expect(enabled).toBeGreaterThanOrEqual(1); // the loop checked something
  });
  it("a hosted Claude service, built from its real config, words the cap as information", async () => {
    const config = loadConfig({ WA_FREE_AUDITS: "claude", WA_AUTH_CHALLENGE: "http", WA_TOOL_COPY: "neutral", WA_LINK_CHANNEL: "claude" });
    const res = await runAudit({ domain: "acme.com" }, depsFor({ upsellStyle: config.upsellStyle, toolCopy: config.toolCopy, linkChannel: config.linkChannel }, limited("monthly_cap")));
    expect(!res.ok && res.error.message).not.toMatch(PROMO);
  });
});

describe("the monthly cap on a directory-listed host: information only", () => {
  for (const [name, config] of [["hosted ChatGPT (info style)", CHATGPT], ["the Claude connector (neutral copy)", CLAUDE]] as const) {
    it(`${name}: the month's wording and where plans are described, with no price, trial or call to upgrade`, async () => {
      const res = await runAudit({ domain: "acme.com" }, depsFor(config, limited("monthly_cap", PORTAL)));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("PRO_REQUIRED");
      expect(res.error.message).toContain(`The 3 free audits included this month are used; they reset on ${RESET_DATE} (UTC).`);
      expect(res.error.message).toContain("Plans are described at ");
      expect(res.error.message).not.toMatch(PROMO);
      expect(res.error.message).not.toContain("plan=pro");
      expect(res.error.upgrade_url ?? "").not.toContain("plan=pro");
    });
  }
  it("ChatGPT's link is the informational page, as for any plan boundary", async () => {
    const res = await runAudit({ domain: "acme.com" }, depsFor(CHATGPT, limited("monthly_cap", PRO_URL)));
    expect(!res.ok && res.error.upgrade_url).toBe(INFO);
    expect(!res.ok && res.error.message).toContain(`Plans are described at ${INFO}`);
  });
  it("a reset already past is not said: next month is", async () => {
    const res = await runAudit({ domain: "acme.com" }, depsFor(CLAUDE, limited("monthly_cap", PORTAL, { resets_at: "2020-01-01T00:00:00.000Z" })));
    expect(!res.ok && res.error.message).toContain("they reset at the start of next month (UTC).");
    expect(!res.ok && res.error.message).not.toContain("2020");
  });
  it("keeps the API's allowance note beside the monthly wording", async () => {
    const e = new WaApiError("PRO_REQUIRED", "Your daily allowance was not consumed. The 3 free audits are used.", {
      status: 429, upgradeUrl: PORTAL, details: { reason: FREE_AUDIT_LIMIT_REASON, limit: "monthly_cap", resets_at: RESETS },
    });
    const res = await runAudit({ domain: "acme.com" }, depsFor(CLAUDE, e));
    expect(!res.ok && res.error.message).toContain("Your daily allowance was not consumed.");
    expect(!res.ok && res.error.message).toContain("they reset on");
  });
  it("a missing reset still reads true", async () => {
    const res = await runAudit({ domain: "acme.com" }, depsFor(CLAUDE, limited("monthly_cap", PORTAL, {})));
    expect(!res.ok && res.error.message).toContain("they reset at the start of next month (UTC).");
  });
});

describe("the monthly cap on every other channel: the Pro offer", () => {
  it("npm/stdio: states what Pro includes and the price, with the API's Pro link", async () => {
    const res = await runAudit({ domain: "acme.com" }, depsFor(NPM, limited("monthly_cap", `${PORTAL}?plan=pro`)));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toContain(`The 3 free audits included this month are used; they reset on ${RESET_DATE} (UTC).`);
    expect(res.error.message).toContain(`Website Auditor Pro includes 10 audits a day (${PRICE}).`);
    expect(res.error.message).toContain("plan=pro");
    expect(res.error.message).toContain("source=mcp");
    expect(res.error.message).not.toContain("source=claude");
    expect(res.error.message).toContain("site=acme.com");
    expect(res.error.upgrade_url).toContain("plan=pro");
  });
  it("falls back to the configured upgrade link when the API named none", async () => {
    const res = await runAudit({ domain: "acme.com" }, depsFor({ ...NPM, upgradeUrl: "https://portal.example/" }, limited("monthly_cap", "https://portal.example/")));
    expect(!res.ok && res.error.message).toContain("Upgrade to Pro: https://portal.example/?source=mcp .");
  });
  it("the other limits are unchanged on npm: the daily cap is still not an offer", async () => {
    const res = await runAudit({ domain: "acme.com" }, depsFor(NPM, limited("daily_cap")));
    expect(!res.ok && res.error.message).toContain("The audits included in this account's current Website Auditor plan are used for now.");
    expect(!res.ok && res.error.message).not.toContain("Pro includes");
    const wait = await runAudit({ domain: "acme.com" }, depsFor(NPM, limited("cadence")));
    expect(!wait.ok && wait.error.message).toContain("try again in a minute");
  });
});

describe("the client reads the API's 429", () => {
  const mk = (env: Record<string, string>, body: unknown) => new WaApiClient(
    { ...loadConfig(env), apiKey: "wa_k" },
    { fetch: (async () => new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json" } })) as unknown as typeof fetch },
  );
  const body = (over: Record<string, unknown> = {}) => ({
    success: false, code: "FREE_AUDIT_LIMIT", reason: "monthly_cap", error: "e", resets_at: RESETS,
    upgrade: { plan: "pro", url: PRO_URL }, ...over,
  });
  it("maps monthly_cap, keeps the reset, and takes the Pro link only where an offer may be made", async () => {
    const npm = await mk({}, body()).runAudit({ domain: "acme.com" }).catch((e) => e);
    expect(npm.code).toBe("PRO_REQUIRED");
    expect(npm.details).toEqual({ reason: FREE_AUDIT_LIMIT_REASON, limit: "monthly_cap", resets_at: RESETS });
    expect(npm.upgradeUrl).toBe(`${PORTAL}?plan=pro`);
    const gpt = await mk({ WA_UPSELL_STYLE: "info" }, body()).runAudit({ domain: "acme.com" }).catch((e) => e);
    expect(gpt.upgradeUrl).toBe(PORTAL);
    const claude = await mk({ WA_TOOL_COPY: "neutral", WA_LINK_CHANNEL: "claude" }, body()).runAudit({ domain: "acme.com" }).catch((e) => e);
    expect(claude.upgradeUrl).toBe(PORTAL);
    expect(JSON.stringify([gpt.details, claude.details])).not.toContain("plan=pro");
  });
  it("uses the API's link only on the configured portal host over https, and a reset that is an instant", async () => {
    for (const url of ["https://other.example/?plan=pro", "http://api.website-auditor.io/admin_portal/", "javascript:alert(1)", 5]) {
      const e = await mk({}, body({ upgrade: { plan: "pro", url }, resets_at: "tomorrow" })).runAudit({ domain: "acme.com" }).catch((x) => x);
      expect(e.upgradeUrl).toBe(PORTAL);
      expect(e.details).toEqual({ reason: FREE_AUDIT_LIMIT_REASON, limit: "monthly_cap" });
    }
  });
  it("carries only plan=pro onto the configured link", async () => {
    const e = await mk({}, body({ upgrade: { plan: "pro", url: "https://user:pw@api.website-auditor.io/other/path?x=1" } })).runAudit({ domain: "acme.com" }).catch((x) => x);
    expect(e.upgradeUrl).toBe(`${PORTAL}?plan=pro`);
    const notPro = await mk({}, body({ upgrade: { plan: "agency", url: PRO_URL } })).runAudit({ domain: "acme.com" }).catch((x) => x);
    expect(notPro.upgradeUrl).toBe(PORTAL);
  });
  it("an upgrade link that is not https is not used", async () => {
    const e = await mk({ WA_UPGRADE_URL: "http://api.website-auditor.io/admin_portal/" }, body({ upgrade: { plan: "pro", url: "http://api.website-auditor.io/admin_portal/?plan=pro" } })).runAudit({ domain: "acme.com" }).catch((x) => x);
    expect(e.upgradeUrl).toBe("http://api.website-auditor.io/admin_portal/");
  });
  it("a directory host's error carries no promotion in its own message; another channel keeps the API's sentence", async () => {
    const said = "The 3 free audits included this month are used. Website Auditor Pro includes 10 audits a day.";
    const gpt = await mk({ WA_UPSELL_STYLE: "info" }, body({ error: said })).runAudit({ domain: "acme.com" }).catch((e) => e);
    expect(gpt.message).toBe("The free audits included this month are used.");
    const noted = await mk({ WA_UPSELL_STYLE: "info" }, body({ error: `${said} Your daily allowance was not consumed.` })).runAudit({ domain: "acme.com" }).catch((e) => e);
    expect(noted.message).toBe("The free audits included this month are used. Your daily allowance was not consumed.");
    const npm = await mk({}, body({ error: said })).runAudit({ domain: "acme.com" }).catch((e) => e);
    expect(npm.message).toBe(said);
  });
  it("a WaApiError built without the client gets the same window in the wording", async () => {
    const far = new WaApiError("PRO_REQUIRED", "x", { status: 429, upgradeUrl: PORTAL, details: { reason: FREE_AUDIT_LIMIT_REASON, limit: "monthly_cap", resets_at: "2999-12-01T00:00:00.000Z" } });
    const res = await runAudit({ domain: "acme.com" }, depsFor(CLAUDE, far));
    expect(!res.ok && res.error.message).toContain("at the start of next month (UTC)");
    expect(!res.ok && res.error.details).toEqual({ reason: FREE_AUDIT_LIMIT_REASON, limit: "monthly_cap" });
  });
  it("a usable reset stays in details, beside the message that states it", async () => {
    const res = await runAudit({ domain: "acme.com" }, depsFor(CLAUDE, limited("monthly_cap")));
    expect(!res.ok && res.error.details).toEqual({ reason: FREE_AUDIT_LIMIT_REASON, limit: "monthly_cap", resets_at: RESETS });
  });
  it("a reset in the past, or more than a month off, is not said: the client passes it, the reply drops it", async () => {
    for (const resets_at of ["2020-01-01T00:00:00.000Z", "2999-12-01T00:00:00.000Z"]) {
      const e = await mk({}, body({ resets_at })).runAudit({ domain: "acme.com" }).catch((x) => x);
      const res = await runAudit({ domain: "acme.com" }, depsFor(CLAUDE, e));
      expect(!res.ok && res.error.message, resets_at).toContain("at the start of next month (UTC)");
      expect(!res.ok && res.error.details, resets_at).toEqual({ reason: FREE_AUDIT_LIMIT_REASON, limit: "monthly_cap" });
    }
  });
  it("an impossible calendar day is not a reset: the message says next month instead", async () => {
    for (const resets_at of ["2026-02-30T00:00:00.000Z", "2026-13-01T00:00:00.000Z"]) {
      const e = await mk({}, body({ resets_at })).runAudit({ domain: "acme.com" }).catch((x) => x);
      expect(e.details).toEqual({ reason: FREE_AUDIT_LIMIT_REASON, limit: "monthly_cap" });
    }
  });
  it("a hand-built error with the Pro link, on a directory host, keeps the plain link", async () => {
    for (const config of [CHATGPT, CLAUDE]) {
      const res = await runAudit({ domain: "acme.com" }, depsFor(config, limited("monthly_cap", PRO_URL)));
      expect(!res.ok && res.error.upgrade_url, JSON.stringify(config)).not.toMatch(/plan=pro/);
    }
  });
  it("a reset on a limit that has none is not kept, hand-built or not", async () => {
    for (const limit of ["cadence", "daily_cap"]) {
      const res = await runAudit({ domain: "acme.com" }, depsFor(CLAUDE, limited(limit)));
      expect(!res.ok && res.error.details, limit).toEqual({ reason: FREE_AUDIT_LIMIT_REASON, limit });
    }
  });
  it("a reset a few minutes past is still said, a long-past one is not; an operator's own plan=pro link is kept", async () => {
    const just = await runAudit({ domain: "acme.com" }, depsFor(CLAUDE, limited("monthly_cap", PORTAL, { resets_at: "2026-11-22T11:55:00.000Z" })));
    expect(!just.ok && just.error.message).toContain("November 22, 2026");
    const own = `${PORTAL}?plan=pro`;
    const res = await runAudit({ domain: "acme.com" }, depsFor({ ...CLAUDE, upgradeUrl: own }, limited("monthly_cap", own)));
    expect(!res.ok && res.error.upgrade_url).toMatch(/plan=pro/);
  });
  it("a date-only reset for today is still ahead until the day ends", async () => {
    const res = await runAudit({ domain: "acme.com" }, depsFor(CLAUDE, limited("monthly_cap", PORTAL, { resets_at: "2026-11-22" })));
    expect(!res.ok && res.error.message).toContain("November 22, 2026");
  });
  it("a date-only reset is accepted, as the Agency month's is", async () => {
    const res = await runAudit({ domain: "acme.com" }, depsFor(CLAUDE, limited("monthly_cap", PORTAL, { resets_at: "2026-12-01" })));
    expect(!res.ok && res.error.message).toContain(RESET_DATE);
    expect(!res.ok && res.error.details).toEqual({ reason: FREE_AUDIT_LIMIT_REASON, limit: "monthly_cap", resets_at: "2026-12-01" });
  });
  it("an operator's own source in the upgrade link still wins over the API's tag", async () => {
    const e = await mk({ WA_UPGRADE_URL: "https://api.website-auditor.io/admin_portal/?source=acme-bot" }, body()).runAudit({ domain: "acme.com" }).catch((x) => x);
    expect(e.upgradeUrl).toBe(`${PORTAL}?source=acme-bot&plan=pro`);
  });
  it("an API without monthly_cap, or an unknown reason, is the daily cap as before", async () => {
    const e = await mk({}, body({ reason: "something_new", upgrade: undefined, resets_at: undefined })).runAudit({ domain: "acme.com" }).catch((x) => x);
    expect(e.details).toEqual({ reason: FREE_AUDIT_LIMIT_REASON, limit: "daily_cap" });
  });
});
