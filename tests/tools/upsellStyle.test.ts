/**
 * WA_UPSELL_STYLE — the switch that keeps checkout links out of responses.
 *
 * OpenAI's app rules forbid a plugin to display plans, advertise pricing or
 * free trials, or promote upgrades, while allowing it to say a feature is not
 * in the current plan and to link an informational plans page. The hosted
 * deployment therefore runs `info` style: no price and no trial anywhere, and
 * every link — including the ones the API itself returns on a 401/403 —
 * points at the informational page, never the portal.
 *
 * The other half of the contract matters just as much: `link` style (the
 * default) must stay byte-identical to the pre-style behavior, because every
 * existing install runs it.
 */
import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";
import { upgradeLink } from "../../src/tools/upgrade.js";
import { fromApiError, gateProTool } from "../../src/tools/context.js";
import { buildInstructions } from "../../src/mcp/instructions.js";
import { checkUpgradeStatus } from "../../src/tools/checkUpgradeStatus.js";
import { WaApiError } from "../../src/api/errors.js";
import { makeDeps, testConfig, fixedTier } from "../helpers.js";

const PORTAL = "admin_portal";
const INFO = "https://website-auditor.io/plans";

const infoConfig = (over = {}) => testConfig({ upsellStyle: "info", upsellInfoUrl: INFO, ...over });

describe("config parsing", () => {
  it("defaults to link style, and to the site homepage as the info page", () => {
    const cfg = loadConfig({});
    expect(cfg.upsellStyle).toBe("link");
    expect(cfg.upsellInfoUrl).toBe("https://website-auditor.io");
  });

  it("reads WA_UPSELL_STYLE=info and WA_UPSELL_INFO_URL", () => {
    const cfg = loadConfig({ WA_UPSELL_STYLE: "info", WA_UPSELL_INFO_URL: "https://example.com/plans/" });
    expect(cfg.upsellStyle).toBe("info");
    expect(cfg.upsellInfoUrl).toBe("https://example.com/plans");
  });

  it("treats an unrecognized style as link (never fail into a mode that was not asked for)", () => {
    expect(loadConfig({ WA_UPSELL_STYLE: "aggressive" }).upsellStyle).toBe("link");
  });

  it("the info page follows WA_SITE_URL, not WA_UPGRADE_URL — the checkout must never be the fallback", () => {
    const cfg = loadConfig({ WA_SITE_URL: "https://example.org", WA_UPGRADE_URL: "https://example.org/buy" });
    expect(cfg.upsellInfoUrl).toBe("https://example.org");
  });
});

describe("upgradeLink is the single style switch", () => {
  it("link style: the portal, tagged", () => {
    expect(upgradeLink(testConfig())).toBe("https://api.website-auditor.io/admin_portal/?source=mcp");
  });

  it("info style: the info page, tagged — the portal does not appear", () => {
    expect(upgradeLink(infoConfig())).toBe(`${INFO}?source=mcp`);
  });
});

describe("gateProTool under info style", () => {
  // Every gate message flows its link through upgradeLink, so the assertions
  // here are that NO surface leaks the portal — message text included.
  it.each([
    ["AUTH_REQUIRED (no key)", makeDeps({ tier: "none", config: infoConfig({ apiKey: undefined }) })],
    ["PRO_REQUIRED (free tier)", makeDeps({ tier: "free", config: infoConfig() })],
    ["INVALID_KEY (rejected key)", makeDeps({ tier: "invalid", config: infoConfig() })],
  ])("%s carries the info link and never the portal", async (_label, deps) => {
    const result = await gateProTool(deps);
    expect(result).not.toBeNull();
    if (result === null || result.ok) throw new Error("expected an error result");
    expect(result.error.upgrade_url).toContain(INFO);
    expect(result.error.upgrade_url).not.toContain(PORTAL);
    expect(result.error.message).not.toContain(PORTAL);
    // OpenAI's rules: never the price or the trial. Where a plan is the
    // blocker the message says where plans are described; a rejected key
    // usually belongs to a paying member, so it says where keys come from.
    if (result.error.code !== "INVALID_KEY") expect(result.error.message).toContain("Plans are described at");
    expect(result.error.message).not.toContain("$10/month");
    expect(result.error.message).not.toMatch(/free trial/i);
  });

  it("link style is untouched: the portal link, as every existing install expects", async () => {
    const result = await gateProTool(makeDeps({ tier: "free" }));
    if (result === null || result.ok) throw new Error("expected an error result");
    expect(result.error.upgrade_url).toBe("https://api.website-auditor.io/admin_portal/?source=mcp");
  });
});

describe("fromApiError under info style", () => {
  const apiError = new WaApiError("PRO_REQUIRED", "Subscription required.", {
    status: 403,
    upgradeUrl: "https://api.website-auditor.io/admin_portal/checkout",
  });

  it("replaces the API's own portal link with the info page", () => {
    const result = fromApiError(apiError, infoConfig());
    if (result.ok) throw new Error("expected an error result");
    expect(result.error.upgrade_url).toContain(INFO);
    expect(result.error.upgrade_url).not.toContain(PORTAL);
  });

  it("link style still passes the API's link through, tagged (attribution contract)", () => {
    const result = fromApiError(apiError, testConfig());
    if (result.ok) throw new Error("expected an error result");
    expect(result.error.upgrade_url).toBe("https://api.website-auditor.io/admin_portal/checkout?source=mcp");
  });

  it("info style does not ADD links where none would have appeared (OVER_QUOTA stays link-free)", () => {
    const result = fromApiError(new WaApiError("OVER_QUOTA", "Daily cap reached."), infoConfig());
    if (result.ok) throw new Error("expected an error result");
    expect(result.error.upgrade_url).toBeUndefined();
  });
});

describe("instructions under info style", () => {
  const infoText = buildInstructions(`${INFO}?source=mcp`, "info");

  it("says a plan is needed and links the info page — no price, no trial (OpenAI's app rules)", () => {
    expect(infoText).not.toContain("$10/month");
    expect(infoText).not.toMatch(/free trial/i);
    expect(infoText).toMatch(/Website Auditor plan/);
    expect(infoText).toContain(`${INFO}?source=mcp`);
  });

  it("never directs the model to a signup action", () => {
    expect(infoText).not.toMatch(/sign up/i);
    expect(infoText).not.toContain(PORTAL);
  });

  it("keeps the trigger block before any mention of plans or money, in both styles", () => {
    for (const [text, billing] of [
      [infoText, /Website Auditor plan/],
      [buildInstructions("https://x.example/?source=mcp", "link"), /\$10\/month/],
    ] as const) {
      const trigger = text.search(/when to offer/i);
      const money = text.search(billing);
      expect(trigger).toBeGreaterThanOrEqual(0);
      expect(money).toBeGreaterThan(trigger);
    }
  });

  it("default style is exactly the historical string (no drift for existing installs)", () => {
    const url = "https://api.website-auditor.io/admin_portal/?source=mcp";
    expect(buildInstructions(url)).toBe(buildInstructions(url, "link"));
    expect(buildInstructions(url)).toContain("Sign up ");
  });
});

describe("check_upgrade_status under info style", () => {
  it("keyless standing report points at the info page, portal nowhere", async () => {
    const deps = makeDeps({
      tier: "none",
      subscriptions: fixedTier("none"),
      config: infoConfig({ apiKey: undefined }),
    });
    const result = await checkUpgradeStatus({}, deps);
    if (!result.ok) throw new Error("expected success");
    expect(result.data.upgrade_url).toContain(INFO);
    expect(result.data.upgrade_url).not.toContain(PORTAL);
    expect(result.data.message).not.toContain(PORTAL);
  });
});

describe("info style says no price and no trial anywhere (OpenAI's app rules)", () => {
  // Any amount, any trial, any invitation to buy. Wider than the literal
  // "$10" / "free trial" so a rephrasing ("start your 7-day trial") is caught.
  const NO_MONEY = (text: string) => {
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toMatch(/\btrial\b/i);
    expect(text).not.toMatch(/\bsubscribe\b|\bupgrade\b|starting pro/i);
  };

  it("no published tool description advertises the price or the trial", async () => {
    const { SERVED_TOOLS, descriptionFor } = await import("../../src/tools/registry.js");
    for (const spec of SERVED_TOOLS) {
      const text = descriptionFor(spec, "info");
      // check_upgrade_status answers a member's own "is my trial still
      // active" — their account's state, which the rules allow.
      NO_MONEY(text.replace('"is my trial still active,"', ""));
    }
    // Link style keeps the terms on the Pro tools, as before.
    expect(SERVED_TOOLS.some((s) => descriptionFor(s, "link").includes("$10"))).toBe(true);
  });

  it.each([
    ["never subscribed", { tier: "free" as const, status: "none" }],
    ["lapsed", { tier: "free" as const, status: "canceled" }],
    ["trial set to end", { tier: "pro" as const, status: "trialing", cancel_at_period_end: true }],
    ["subscription set to end", { tier: "pro" as const, status: "active", cancel_at_period_end: true }],
  ])("check_upgrade_status (%s) points at plans, not at a purchase", async (_label, sub) => {
    const client = { getSubscription: async () => ({ current_period_end: null, ...sub }) };
    const res = await checkUpgradeStatus({}, makeDeps({ client, config: infoConfig() }));
    if (!res.ok) throw new Error("expected ok");
    // Reporting the member's OWN trial ("Free trial active") is their account's
    // state, which the rules allow; selling one is not. So: no price, no
    // purchase link, and no trial offered to someone without one.
    expect(res.data.message).not.toContain("$10");
    expect(res.data.message).not.toMatch(/subscribe at/i);
    if (sub.status !== "trialing") expect(res.data.message).not.toMatch(/free trial/i);
  });

  it("check_upgrade_status with no key points at plans, not at a purchase", async () => {
    const res = await checkUpgradeStatus({}, makeDeps({ config: infoConfig({ apiKey: undefined }) }));
    if (!res.ok) throw new Error("expected ok");
    NO_MONEY(res.data.message);
  });

  it("get_sample_audit's note and price field state no price", async () => {
    const { getSampleAudit } = await import("../../src/tools/sampleAudit.js");
    const res = await getSampleAudit({}, makeDeps({ config: infoConfig({ apiKey: undefined }) }));
    if (!res.ok) throw new Error("expected ok");
    NO_MONEY(res.data.note);
    expect(res.data.price).toBeUndefined();
  });
});

describe("info style: what the API relays, and what a connected reader is told", () => {
  it("a relayed API 403 that names the trial is replaced, not passed through", () => {
    const result = fromApiError(
      new WaApiError("PRO_REQUIRED", "An active subscription or free trial is required for the GTM plan.", { status: 403 }),
      infoConfig(),
    );
    if (result.ok) throw new Error("expected an error result");
    expect(result.error.message).not.toMatch(/trial/i);
    expect(result.error.message).toContain("Plans are described at");
  });

  it("link style still passes the API's own message through", () => {
    const msg = "An active subscription or free trial is required for the GTM plan.";
    const result = fromApiError(new WaApiError("PRO_REQUIRED", msg, { status: 403 }), testConfig());
    if (result.ok) throw new Error("expected an error result");
    expect(result.error.message).toBe(msg);
  });

  it("a connected Mixed Auth reader's sample note asks for no API key", async () => {
    const { getSampleAudit } = await import("../../src/tools/sampleAudit.js");
    const deps = {
      ...makeDeps({ config: infoConfig({
        apiKey: "wa_from_login",
        oauthIssuer: "https://api.website-auditor.io",
        oauthResourceUrl: "https://mcp.website-auditor.io/mcp",
        oauthScope: "audit",
      }) }),
      transport: "http" as const,
    };
    const res = await getSampleAudit({}, deps);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.note).toContain("on a connected account");
    expect(res.data.note).not.toContain("API key");
  });

  it("a trialing member is not sent to the plans page to cancel", async () => {
    const client = { getSubscription: async () => ({ tier: "pro" as const, status: "trialing", current_period_end: null }) };
    const res = await checkUpgradeStatus({}, makeDeps({ client, config: infoConfig() }));
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.message).not.toContain(INFO);
    expect(res.data.message).toContain("cancel it from your Website Auditor account");
  });
});

describe("info style: titles, quota copy, allowance notes", () => {
  it("publishes check_upgrade_status as a plan check, not an upgrade check", async () => {
    const { CHECK_UPGRADE_STATUS_TOOL, titleFor } = await import("../../src/tools/registry.js");
    expect(titleFor(CHECK_UPGRADE_STATUS_TOOL, "info")).not.toMatch(/upgrade/i);
    expect(titleFor(CHECK_UPGRADE_STATUS_TOOL, "link")).toBe(CHECK_UPGRADE_STATUS_TOOL.title);
  });

  it("keeps the API's allowance note when it replaces a relayed PRO_REQUIRED", () => {
    const msg = "The engine refused. Your daily allowance could not be refunded automatically, so this attempt still counts toward it.";
    const result = fromApiError(new WaApiError("PRO_REQUIRED", msg, { status: 403 }), infoConfig());
    if (result.ok) throw new Error("expected an error result");
    expect(result.error.message).toContain("Plans are described at");
    expect(result.error.message).toContain("Your daily allowance could not be refunded automatically, so this attempt still counts toward it.");
  });

  it("a pasted key on a Mixed Auth server is still told it needs a key, in link style", async () => {
    const { getSampleAudit } = await import("../../src/tools/sampleAudit.js");
    const deps = {
      ...makeDeps({ config: testConfig({
        apiKey: "wa_pasted",
        oauthIssuer: "https://api.website-auditor.io",
        oauthResourceUrl: "https://mcp.website-auditor.io/mcp",
        oauthScope: "audit",
      }) }),
      transport: "http" as const,
      authVia: "key" as const,
    };
    const res = await getSampleAudit({}, deps);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.note).toContain("and an API key");
  });
});
