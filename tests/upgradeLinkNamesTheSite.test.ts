/**
 * The upgrade link names the site the tool was asked about: `site=<hostname>`.
 *
 * ChatGPT users hit PRO_REQUIRED before any audit runs — gateProTool is what
 * stops it — and the portal page they land on said nothing about their site.
 * The portal now reads `site=` and names it on its sign-in and paywall pages
 * ("ChatGPT sent you here to audit acme.com …"). This pins the MCP's half:
 *
 *   * every tool with a domain argument passes it, under BOTH upsell styles;
 *   * only the hostname travels — never a scheme, port, path or query, which
 *     could carry whatever the user pasted;
 *   * no site, or one that does not parse, means no param (not an empty one);
 *   * an existing `site` is never overridden or duplicated, and `source=mcp`
 *     tagging is unchanged;
 *   * the WORDS do not change. Under info style OpenAI's rules allow exactly
 *     "this is not in your plan" plus a link to an informational page
 *     (upgrade.ts plansAreDescribedAt) — the link may gain a param, the
 *     sentence may not gain a clause.
 */
import { describe, it, expect } from "vitest";
import { fromApiError, gateProTool, type ToolDeps, type ToolResult } from "../src/tools/context.js";
import { siteHostname, tagSite, tagSource, upgradeLink } from "../src/tools/upgrade.js";
import { WaApiError } from "../src/api/errors.js";
import { makeDeps, testConfig, makeClient } from "./helpers.js";
import type { WaApiClientLike } from "../src/api/client.js";
import { runAudit } from "../src/tools/runAudit.js";
import { getAiVisibility } from "../src/tools/getAiVisibility.js";
import { getReport } from "../src/tools/getReport.js";
import { trackSite } from "../src/tools/trackSite.js";
import { untrackSite } from "../src/tools/untrackSite.js";
import { getChanges } from "../src/tools/getChanges.js";
import { getGtmPlan } from "../src/tools/getGtmPlan.js";
import { getBenchmark } from "../src/tools/getBenchmark.js";
import { compareCompetitors } from "../src/tools/compareCompetitors.js";
import { generateSchema } from "../src/tools/generateSchema.js";
import { getRecommendations } from "../src/tools/getRecommendations.js";
import { listTrackedSites } from "../src/tools/listTrackedSites.js";
import { getMonitoringStatus } from "../src/tools/getMonitoringStatus.js";
import type { WaConfig } from "../src/config.js";

const ASKED = "https://www.Acme.com:8443/pricing?ref=secret#plans";
const HOST = "acme.com";
/** What the hosted ChatGPT deployment links under info style. */
const CHATGPT_INFO = "https://api.website-auditor.io/admin_portal/?source=chatgpt";

const STYLES: Array<[string, Partial<WaConfig>]> = [
  ["link", {}],
  ["info", { upsellStyle: "info", upsellInfoUrl: CHATGPT_INFO }],
];

type SiteTool = (domain: string, deps: ToolDeps) => Promise<ToolResult<unknown>>;

/** Every tool that gates on Pro and is about one site. */
const SITE_TOOLS: Array<[string, SiteTool]> = [
  ["run_audit", (domain, deps) => runAudit({ domain }, deps)],
  ["get_ai_visibility", (domain, deps) => getAiVisibility({ domain }, deps)],
  ["get_report", (domain, deps) => getReport({ domain }, deps)],
  ["track_site", (domain, deps) => trackSite({ domain }, deps)],
  ["untrack_site", (domain, deps) => untrackSite({ domain }, deps)],
  ["get_changes", (domain, deps) => getChanges({ domain }, deps)],
  ["get_gtm_plan", (domain, deps) => getGtmPlan({ domain }, deps)],
  ["get_benchmark", (domain, deps) => getBenchmark({ domain }, deps)],
  ["compare_competitors", (domain, deps) => compareCompetitors({ domain, competitors: ["rival.com"] }, deps)],
  ["generate_schema", (domain, deps) => generateSchema({ domain }, deps)],
];

function errorOf(res: ToolResult<unknown>) {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("expected an error");
  return res.error;
}

function siteParams(url: string | undefined): string[] {
  return new URL(url!).searchParams.getAll("site");
}

describe("siteHostname: the hostname, or nothing", () => {
  it.each([
    ["acme.com", "acme.com"],
    ["Acme.COM", "acme.com"],
    ["https://www.Acme.com/pricing", "acme.com"],
    ["WWW.acme.com", "acme.com"],
    ["www2.acme.com", "www2.acme.com"],
    ["shop.www.acme.com", "shop.www.acme.com"],
    ["http://acme.com:8080/a?b=c#d", "acme.com"],
    ["acme.com/some/path?token=x", "acme.com"],
    ["  shop.acme.co.uk  ", "shop.acme.co.uk"],
    ["https://user:pass@acme.com/", "acme.com"],
    ["acme.com.", "acme.com"],
    ["münchen.de", "xn--mnchen-3ya.de"],
    ["https://bücher.example/", "xn--bcher-kva.example"],
    ["shop.xn--p1ai", "shop.xn--p1ai"],
    ["www.co.acme.com", "co.acme.com"], // a listed label only matters as a bare two-label suffix
    // `www.` goes only where a registrable-looking name is left.
    ["www.acme.co.uk", "acme.co.uk"],
    ["www.co.uk", "www.co.uk"],
    ["www.com.au", "www.com.au"],
    ["www.com", "www.com"],
  ])("%s → %s", (raw, host) => {
    expect(siteHostname(raw)).toBe(host);
  });

  it.each([
    [undefined],
    [""],
    ["   "],
    ["not a domain"],
    ["localhost"],
    ["127.0.0.1"],
    ["http://[::1]/"],
    ["https://"],
    ["acme"],
    ["a.xn--abc-"], // the portal refuses a label ending in a hyphen
    [`${"a".repeat(64)}.com`],
    [`${"abcdefghi.".repeat(26)}com`], // 263 characters: past 253
  ])("%s → undefined", (raw) => {
    expect(siteHostname(raw)).toBeUndefined();
  });

  it("accepts a hostname of exactly 253 characters", () => {
    const host = `${"abcdefghi.".repeat(25)}com`;
    expect(host).toHaveLength(253);
    expect(siteHostname(host)).toBe(host);
  });
});

describe("tagSite", () => {
  const BASE = "https://api.website-auditor.io/admin_portal/?source=mcp";
  const PORTAL_CFG = testConfig();

  it("only on a link to our own portal: the configured API's origin", () => {
    expect(tagSite(BASE, ASKED, PORTAL_CFG)).toBe(`${BASE}&site=${HOST}`);
    // The marketing homepage (the default info page) logs its query string.
    expect(tagSite("https://website-auditor.io/?source=mcp", ASKED, PORTAL_CFG))
      .toBe("https://website-auditor.io/?source=mcp");
    // Whatever third party an operator configured.
    expect(tagSite("https://example.org/buy?source=mcp", ASKED, PORTAL_CFG))
      .toBe("https://example.org/buy?source=mcp");
    // Same host on another port is another origin.
    expect(tagSite("https://api.website-auditor.io:8443/admin_portal/", ASKED, PORTAL_CFG))
      .toBe("https://api.website-auditor.io:8443/admin_portal/");
    // Same host over plain http would carry the site in clear.
    expect(tagSite("http://api.website-auditor.io/admin_portal/", ASKED, PORTAL_CFG))
      .toBe("http://api.website-auditor.io/admin_portal/");
    // It follows WA_API_BASE_URL, not a hard-coded host.
    const staging = testConfig({ apiBaseUrl: "https://staging-api.example.net" });
    expect(siteParams(tagSite("https://staging-api.example.net/admin_portal/", ASKED, staging))).toEqual([HOST]);
    expect(tagSite(BASE, ASKED, staging)).toBe(BASE);
  });

  it("appends the hostname alone", () => {
    expect(tagSite(BASE, ASKED, PORTAL_CFG)).toBe(`${BASE}&site=${HOST}`);
  });

  it("leaves the link untouched with no site, or one that does not parse", () => {
    expect(tagSite(BASE, undefined, PORTAL_CFG)).toBe(BASE);
    expect(tagSite(BASE, "", PORTAL_CFG)).toBe(BASE);
    expect(tagSite(BASE, "not a domain", PORTAL_CFG)).toBe(BASE);
  });

  it("never overrides an existing site, so it cannot duplicate", () => {
    const already = `${BASE}&site=other.com`;
    expect(tagSite(already, ASKED, PORTAL_CFG)).toBe(already);
    const once = tagSite(BASE, ASKED, PORTAL_CFG);
    expect(tagSite(once, ASKED, PORTAL_CFG)).toBe(once);
    expect(siteParams(tagSite(once, "different.com", PORTAL_CFG))).toEqual([HOST]);
  });

  it("returns an unparseable link untouched rather than throwing", () => {
    expect(tagSite("not a url", ASKED, PORTAL_CFG)).toBe("not a url");
  });

  it("does not change what tagSource does: source=mcp when absent, never over an existing source", () => {
    const portal = "https://api.website-auditor.io/admin_portal/";
    expect(upgradeLink(testConfig({ upgradeUrl: portal }), ASKED)).toBe(`${portal}?source=mcp&site=${HOST}`);
    expect(upgradeLink(testConfig({ upgradeUrl: portal }))).toBe(tagSource(portal));
    expect(upgradeLink(testConfig({ upsellStyle: "info", upsellInfoUrl: CHATGPT_INFO }), ASKED))
      .toBe(`${CHATGPT_INFO}&site=${HOST}`);
  });
});

describe.each(STYLES)("%s style: PRO_REQUIRED names the site", (_style, config) => {
  it.each(SITE_TOOLS)("%s carries site=<hostname> in the link and the message", async (_name, tool) => {
    const deps = makeDeps({ tier: "free", config });
    const e = errorOf(await tool(ASKED, deps));
    expect(e.code).toBe("PRO_REQUIRED");
    const expected = upgradeLink(deps.config, ASKED);
    expect(e.upgrade_url).toBe(expected);
    expect(siteParams(e.upgrade_url)).toEqual([HOST]);
    expect(new URL(e.upgrade_url!).searchParams.get("source")).toBe(
      config.upsellStyle === "info" ? "chatgpt" : "mcp",
    );
    // Only the hostname: no path, port or query from what was asked.
    expect(e.upgrade_url).not.toMatch(/pricing|8443|secret/);

    // The words are exactly the site-less gate's; only the link differs.
    const plain = errorOf((await gateProTool(makeDeps({ tier: "free", config })))!);
    expect(plain.message.includes(upgradeLink(deps.config))).toBe(true);
    expect(e.message).toBe(plain.message.split(upgradeLink(deps.config)).join(expected));
  });

  it.each(SITE_TOOLS)("%s with a domain that does not parse: no site param at all", async (_name, tool) => {
    const deps = makeDeps({ tier: "free", config });
    const e = errorOf(await tool("not a domain", deps));
    expect(e.code).toBe("PRO_REQUIRED");
    expect(e.upgrade_url).toBe(upgradeLink(deps.config));
    expect(siteParams(e.upgrade_url)).toEqual([]);
  });

  it.each([
    ["list_tracked_sites", (deps: ToolDeps) => listTrackedSites({}, deps)],
    ["get_monitoring_status", (deps: ToolDeps) => getMonitoringStatus({}, deps)],
  ])("%s is about no one site, so its link has none", async (_name, tool) => {
    const deps = makeDeps({ tier: "free", config });
    const e = errorOf(await tool(deps));
    expect(e.code).toBe("PRO_REQUIRED");
    expect(e.upgrade_url).toBe(upgradeLink(deps.config));
    expect(siteParams(e.upgrade_url)).toEqual([]);
  });

  it("AUTH_REQUIRED (no key) carries it too, from both gates", async () => {
    const run = errorOf(await runAudit({ domain: ASKED }, makeDeps({ tier: "none", config: { ...config, apiKey: undefined } })));
    expect(run.code).toBe("AUTH_REQUIRED");
    expect(siteParams(run.upgrade_url)).toEqual([HOST]);
    const recs = errorOf(
      await getRecommendations({ domain: ASKED }, makeDeps({ tier: "none", config: { ...config, apiKey: undefined } })),
    );
    expect(recs.code).toBe("AUTH_REQUIRED");
    expect(siteParams(recs.upgrade_url)).toEqual([HOST]);
  });
});

describe("no site leaves for a host other than the portal", () => {
  it.each([
    ["the homepage as info page", { upsellStyle: "info" as const, upsellInfoUrl: "https://website-auditor.io" }],
    ["a third-party info page", { upsellStyle: "info" as const, upsellInfoUrl: "https://plans.example.org/" }],
    ["a third-party upgrade URL", { upgradeUrl: "https://example.org/buy" }],
  ])("%s: gate and fromApiError", async (_name, config) => {
    const gated = errorOf(await runAudit({ domain: ASKED }, makeDeps({ tier: "free", config })));
    expect(gated.code).toBe("PRO_REQUIRED");
    expect(siteParams(gated.upgrade_url)).toEqual([]);
    expect(gated.message).not.toContain("site=");
    const relayed = errorOf(fromApiError(new WaApiError("PRO_REQUIRED", "x"), testConfig(config), undefined, undefined, ASKED));
    expect(siteParams(relayed.upgrade_url)).toEqual([]);
  });

  it("an API-supplied link to another host is passed on without it", () => {
    const e = errorOf(fromApiError(
      new WaApiError("PRO_REQUIRED", "x", { upgradeUrl: "https://checkout.example.com/pay" }),
      testConfig(), undefined, undefined, ASKED,
    ));
    expect(e.upgrade_url).toBe("https://checkout.example.com/pay?source=mcp");
  });
});

/**
 * Each site tool's own catch → fromApiError path, by stubbing the one client
 * method it calls to answer PRO_REQUIRED. Pro tier, so the gate passes and
 * only the tool's pass-through of its domain can put the site on the link.
 */
const PRO_REQUIRED = () => { throw new WaApiError("PRO_REQUIRED", "Subscription required."); };
const CATCH_PATHS: Array<[string, Partial<WaApiClientLike>, SiteTool]> = [
  ["run_audit", { runAudit: PRO_REQUIRED }, (d, deps) => runAudit({ domain: d }, deps)],
  ["get_ai_visibility", { runAudit: PRO_REQUIRED }, (d, deps) => getAiVisibility({ domain: d }, deps)],
  ["get_report", { getReport: PRO_REQUIRED }, (d, deps) => getReport({ domain: d }, deps)],
  ["track_site (start)", { trackSite: PRO_REQUIRED }, (d, deps) => trackSite({ domain: d }, deps)],
  ["track_site (enabled: false)", { untrackSite: PRO_REQUIRED }, (d, deps) => trackSite({ domain: d, enabled: false }, deps)],
  ["untrack_site", { untrackSite: PRO_REQUIRED }, (d, deps) => untrackSite({ domain: d }, deps)],
  ["get_changes", { getChanges: PRO_REQUIRED }, (d, deps) => getChanges({ domain: d }, deps)],
  ["get_gtm_plan", { getGtmPlan: PRO_REQUIRED }, (d, deps) => getGtmPlan({ domain: d }, deps)],
  ["get_benchmark", { getBenchmark: PRO_REQUIRED }, (d, deps) => getBenchmark({ domain: d }, deps)],
  ["compare_competitors (primary audit)", { runAudit: PRO_REQUIRED },
    (d, deps) => compareCompetitors({ domain: d, competitors: ["rival.com"] }, deps)],
  ["generate_schema", { generateSchema: PRO_REQUIRED }, (d, deps) => generateSchema({ domain: d }, deps)],
  ["get_recommendations", { getRecommendations: PRO_REQUIRED }, (d, deps) => getRecommendations({ domain: d }, deps)],
];

describe.each(STYLES)("%s style: each tool's own fromApiError carries its site", (_style, config) => {
  it.each(CATCH_PATHS)("%s", async (_name, client, tool) => {
    const deps = makeDeps({ tier: "pro", config, client });
    const e = errorOf(await tool(ASKED, deps));
    expect(e.code).toBe("PRO_REQUIRED");
    expect(e.upgrade_url).toBe(upgradeLink(deps.config, ASKED));
    expect(siteParams(e.upgrade_url)).toEqual([HOST]);
  });

  it("compare_competitors: a competitor refused for a revoked key carries the PRIMARY site", async () => {
    const base = makeClient();
    const deps = makeDeps({
      tier: "pro",
      config,
      client: {
        runAudit: async (req) => {
          if (req.domain === "rival.com") throw new WaApiError("REVOKED_KEY", "This API key has been revoked.");
          return base.runAudit(req);
        },
      },
    });
    const e = errorOf(await compareCompetitors({ domain: ASKED, competitors: ["rival.com"] }, deps));
    expect(e.code).toBe("REVOKED_KEY");
    expect(siteParams(e.upgrade_url)).toEqual([HOST]);
  });

  it("an unparseable primary domain is INVALID_INPUT with no link at all, site or not", async () => {
    // The normalizeDomain catches in compare_competitors and get_gtm_plan pass
    // the site too, for uniformity; INVALID_INPUT carries no link, so there
    // is nothing for it to appear on.
    for (const tool of [
      (deps: ToolDeps) => compareCompetitors({ domain: "acme.com:8443", competitors: ["rival.com"] }, deps),
      (deps: ToolDeps) => getGtmPlan({ domain: "acme.com:8443" }, deps),
    ]) {
      const e = errorOf(await tool(makeDeps({ tier: "pro", config })));
      expect(e.code).toBe("INVALID_INPUT");
      expect(e.upgrade_url).toBeUndefined();
    }
  });
});

/** Mixed Auth, as the hosted ChatGPT server runs it. */
const OAUTH: Partial<WaConfig> = {
  oauthIssuer: "https://api.website-auditor.io",
  oauthResourceUrl: "https://mcp.website-auditor.io/mcp",
};
const INFO_OAUTH: Partial<WaConfig> = { upsellStyle: "info", upsellInfoUrl: CHATGPT_INFO, ...OAUTH };
const hosted = (deps: ToolDeps, authVia?: ToolDeps["authVia"]): ToolDeps => ({ ...deps, transport: "http", authVia });
const SITE_LINK = `${CHATGPT_INFO}&site=${HOST}`;

describe("info style under Mixed Auth: every gate branch carries the site", () => {
  it("not connected (AUTH_REQUIRED): message and upgrade_url", async () => {
    const deps = hosted(makeDeps({ tier: "none", config: { ...INFO_OAUTH, apiKey: undefined } }));
    const e = errorOf(await runAudit({ domain: ASKED }, deps));
    expect(e.code).toBe("AUTH_REQUIRED");
    expect((e.details as { connection: string }).connection).toBe("not_connected");
    expect(e.upgrade_url).toBe(SITE_LINK);
    expect(e.message).toContain(`Plans are described at ${SITE_LINK}.`);
  });

  it("connection unverified: upgrade_url", async () => {
    const deps = hosted(makeDeps({ tier: "none", config: { ...INFO_OAUTH, apiKey: undefined } }), "unresolved_token");
    const e = errorOf(await runAudit({ domain: ASKED }, deps));
    expect((e.details as { connection: string }).connection).toBe("unverified");
    expect(e.upgrade_url).toBe(SITE_LINK);
  });

  it("connection expired, from the gate (connectionExpired)", async () => {
    const deps = hosted(makeDeps({ tier: "invalid", config: INFO_OAUTH }), "oauth");
    const e = errorOf(await runAudit({ domain: ASKED }, deps));
    expect(e.code).toBe("AUTH_REQUIRED");
    expect((e.details as { connection: string }).connection).toBe("expired");
    expect(e.upgrade_url).toBe(SITE_LINK);
  });

  it("connection expired, from the tool's own call (fromApiError → connectionExpired)", async () => {
    const deps = hosted(makeDeps({
      tier: "pro",
      config: INFO_OAUTH,
      client: { runAudit: async () => { throw new WaApiError("REVOKED_KEY", "This API key has been revoked."); } },
    }), "oauth");
    const e = errorOf(await runAudit({ domain: ASKED }, deps));
    expect((e.details as { connection: string }).connection).toBe("expired");
    expect(e.upgrade_url).toBe(SITE_LINK);
  });

  it("a rejected pasted key (key-rejection branch): upgrade_url, message unchanged", async () => {
    const deps = makeDeps({ tier: "invalid", config: { upsellStyle: "info", upsellInfoUrl: CHATGPT_INFO } });
    const e = errorOf(await runAudit({ domain: ASKED }, deps));
    expect(e.code).toBe("INVALID_KEY");
    expect(e.upgrade_url).toBe(SITE_LINK);
    const plain = errorOf(await runAudit({ domain: "not a domain" }, makeDeps({
      tier: "invalid", config: { upsellStyle: "info", upsellInfoUrl: CHATGPT_INFO },
    })));
    expect(e.message).toBe(plain.message);
  });

  it("no key, no OAuth (AUTH_REQUIRED stdio): message and upgrade_url", async () => {
    const deps = makeDeps({ tier: "none", config: { upsellStyle: "info", upsellInfoUrl: CHATGPT_INFO, apiKey: undefined } });
    const e = errorOf(await runAudit({ domain: ASKED }, deps));
    expect(e.upgrade_url).toBe(SITE_LINK);
    expect(e.message).toContain(`Plans are described at ${SITE_LINK}.`);
  });
});

describe.each(STYLES)("%s style: fromApiError carries the calling tool's site", (_style, config) => {
  it("on a PRO_REQUIRED the API returned", () => {
    const cfg = testConfig(config);
    const e = errorOf(fromApiError(new WaApiError("PRO_REQUIRED", "Subscription required."), cfg, undefined, undefined, ASKED));
    expect(siteParams(e.upgrade_url)).toEqual([HOST]);
    expect(new URL(e.upgrade_url!).searchParams.has("source")).toBe(true);
    const plain = errorOf(fromApiError(new WaApiError("PRO_REQUIRED", "Subscription required."), cfg));
    expect(siteParams(plain.upgrade_url)).toEqual([]);
    expect(e.message).toBe(plain.message.split(plain.upgrade_url!).join(e.upgrade_url!));
  });

  it("on the API's own upgrade_url, without overriding a site it already set", () => {
    const cfg = testConfig(config);
    const fresh = errorOf(fromApiError(
      new WaApiError("PRO_REQUIRED", "x", { upgradeUrl: "https://api.website-auditor.io/admin_portal/?plan=pro" }),
      cfg, undefined, undefined, ASKED,
    ));
    expect(siteParams(fresh.upgrade_url)).toEqual([HOST]);
    if (config.upsellStyle !== "info") {
      expect(fresh.upgrade_url).toContain("plan=pro");
      const preset = errorOf(fromApiError(
        new WaApiError("PRO_REQUIRED", "x", { upgradeUrl: "https://api.website-auditor.io/admin_portal/?site=other.com" }),
        cfg, undefined, undefined, ASKED,
      ));
      expect(siteParams(preset.upgrade_url)).toEqual(["other.com"]);
    }
  });

  it("adds no link where there was none (OVER_QUOTA is not an upsell)", () => {
    const e = errorOf(fromApiError(new WaApiError("OVER_QUOTA", "Rate limit exceeded."), testConfig(config), undefined, undefined, ASKED));
    expect(e.upgrade_url).toBeUndefined();
  });

  it("from a tool's own call path, not just when called directly", async () => {
    const deps = makeDeps({
      tier: "pro",
      config,
      client: { getReport: async () => { throw new WaApiError("PRO_REQUIRED", "Subscription required."); } },
    });
    const e = errorOf(await getReport({ domain: ASKED }, deps));
    expect(siteParams(e.upgrade_url)).toEqual([HOST]);
  });
});
