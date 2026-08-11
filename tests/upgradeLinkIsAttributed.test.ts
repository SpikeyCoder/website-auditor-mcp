/**
 * Every signup link this server hands out must carry `?source=mcp`.
 *
 * website-auditor-api stamps `api_keys.acquisition_channel` from that
 * parameter at key mint (its src/services/acquisition.js). An untagged link
 * records NULL, and "MCP installs → subscriptions" stays uncomputable — the
 * exact state that prompted the tagging in the first place (see upgrade.ts).
 *
 * TWO LEAKS, both on the paths people actually take when they are stuck:
 *
 * 1. check_upgrade_status read `deps.config.upgradeUrl` raw. It is the tool
 *    someone runs BECAUSE they have no working key, so its link is among the
 *    likeliest to be followed and was the only one guaranteed not to attribute.
 *
 * 2. fromApiError was handed a raw URL by all 13 of its call sites. It emits
 *    `upgrade_url` on INVALID_KEY and PRO_REQUIRED — the two plan boundaries —
 *    so every tool's upgrade prompt was untagged too.
 *
 * Tagging inside fromApiError rather than at 13 call sites is deliberate: a
 * new tool cannot forget to do it, because there is nothing to remember.
 */
import { describe, it, expect } from "vitest";
import { fromApiError, ok } from "../src/tools/context.js";
import { checkUpgradeStatus } from "../src/tools/checkUpgradeStatus.js";
import { tagSource, upgradeLink } from "../src/tools/upgrade.js";
import { WaApiError } from "../src/api/errors.js";
import { makeDeps, testConfig } from "./helpers.js";

const PORTAL = "https://api.website-auditor.io/admin_portal/";

/** The one thing every link must be able to say about itself. */
function isAttributed(url: string | undefined): boolean {
  if (!url) return false;
  return new URL(url).searchParams.get("source") === "mcp";
}

describe("check_upgrade_status attributes its link", () => {
  it("tags the URL when no key is configured", async () => {
    const res = await checkUpgradeStatus({}, makeDeps({ config: { apiKey: undefined } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(isAttributed(res.data.upgrade_url)).toBe(true);
  });

  it("tags the URL for a keyed, never-subscribed caller", async () => {
    // The upsell branch — the single likeliest link to be clicked by someone
    // who is about to become a customer.
    const res = await checkUpgradeStatus({}, makeDeps({}));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(isAttributed(res.data.upgrade_url)).toBe(true);
  });

  it("tags the URL inside the message text, not just the field", async () => {
    // The model relays the prose; a tagged field beside an untagged sentence
    // still loses the attribution the moment someone clicks what they read.
    const res = await checkUpgradeStatus({}, makeDeps({ config: { apiKey: undefined } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.message).toContain("source=mcp");
  });
});

describe("fromApiError attributes the links it emits", () => {
  it("tags a PRO_REQUIRED upgrade_url built from the raw config URL", () => {
    const res = fromApiError(new WaApiError("PRO_REQUIRED", "Subscription required."), testConfig({ upgradeUrl: PORTAL }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(isAttributed(res.error.upgrade_url)).toBe(true);
  });

  it("tags an INVALID_KEY upgrade_url", () => {
    const res = fromApiError(new WaApiError("INVALID_KEY", "Key revoked."), testConfig({ upgradeUrl: PORTAL }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(isAttributed(res.error.upgrade_url)).toBe(true);
  });

  it("tags a URL the API supplied, not just the configured one", () => {
    const e = new WaApiError("PRO_REQUIRED", "Subscription required.", {
      upgradeUrl: "https://api.website-auditor.io/admin_portal/?plan=pro",
    });
    const res = fromApiError(e, testConfig({ upgradeUrl: PORTAL }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(isAttributed(res.error.upgrade_url)).toBe(true);
    // and without discarding what the server put there
    expect(res.error.upgrade_url).toContain("plan=pro");
  });

  it("still emits no upgrade_url for codes that are not plan boundaries", () => {
    // Guards the rule quotaIsNotAnUpsell.test.ts exists to protect: OVER_QUOTA
    // belongs to someone already paying, so selling them their own plan is the
    // bug. Tagging must not accidentally introduce a link here.
    const res = fromApiError(new WaApiError("OVER_QUOTA", "Rate limit exceeded."), testConfig({ upgradeUrl: PORTAL }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.upgrade_url).toBeUndefined();
  });
});

describe("tagSource is safe to apply anywhere", () => {
  it("does not override a source the caller already chose", () => {
    expect(tagSource(`${PORTAL}?source=web`)).toContain("source=web");
    expect(tagSource(`${PORTAL}?source=web`)).not.toContain("source=mcp");
  });

  it("is idempotent, so double-tagging cannot happen", () => {
    const once = tagSource(PORTAL);
    expect(tagSource(once)).toBe(once);
  });

  it("returns an unparseable value untouched rather than throwing", () => {
    // WA_UPGRADE_URL is operator-supplied; a typo must not take the tool down.
    expect(tagSource("not a url")).toBe("not a url");
  });

  it("keeps upgradeLink and tagSource in agreement", () => {
    expect(upgradeLink(testConfig())).toBe(tagSource(testConfig().upgradeUrl));
  });
});

describe("ok() is untouched by any of this", () => {
  it("still returns a success result", () => {
    // Sanity anchor: this file imports several modules for their side-effect-free
    // exports; if a circular import were introduced, this is what breaks first.
    expect(ok({ a: 1 })).toEqual({ ok: true, data: { a: 1 } });
  });
});
