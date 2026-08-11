/**
 * WA_UPSELL_STYLE — the switch that keeps checkout links out of responses.
 *
 * The OpenAI plugin directory prohibits "direct checkout links or transactional
 * pages" while allowing a plugin to "explain unavailable features under current
 * plans". The hosted deployment therefore runs `info` style: price and trial
 * terms still appear everywhere they do today, but every link — including the
 * ones the API itself returns on a 401/403 — points at the informational page,
 * never the portal.
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
    // Explaining the plan is still allowed — and still required.
    expect(result.error.message).toContain("$10/month");
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

  it("keeps the full disclosure — price, trial, prerequisites — and the info link", () => {
    expect(infoText).toContain("$10/month");
    expect(infoText).toMatch(/payment method/i);
    expect(infoText).toContain(`${INFO}?source=mcp`);
  });

  it("never directs the model to a signup action", () => {
    expect(infoText).not.toMatch(/sign up/i);
    expect(infoText).not.toContain(PORTAL);
  });

  it("keeps the trigger block before any mention of money, in both styles", () => {
    for (const text of [infoText, buildInstructions("https://x.example/?source=mcp", "link")]) {
      const trigger = text.search(/when to offer/i);
      const money = text.search(/\$10\/month/);
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
