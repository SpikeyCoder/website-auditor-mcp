/**
 * "Set WA_API_KEY" is not the last step — the server must be restarted.
 *
 * THE DEAD END. `loadConfig(process.env)` runs exactly once, at startup
 * (src/index.ts). A key created after this process booted is invisible to it
 * until the host relaunches it. Every message that ends at "set WA_API_KEY"
 * therefore describes an incomplete procedure: the user creates a key, edits
 * their config, asks again, and gets the byte-identical error they just acted
 * on. The only available conclusion is that the product is broken.
 *
 * WHY IT MATTERS NOW. On 2026-08-05 two paying subscribers were found with
 * zero API keys ever created and zero API calls ever made — one of whom had
 * been billed since 2026-07-28. Whatever else stopped them, none of the three
 * messages they could have hit told them this step existed.
 *
 * Three surfaces, one rule, so they cannot drift apart:
 *   - gateProTool AUTH_REQUIRED  (no key configured)
 *   - gateProTool INVALID_KEY    (key revoked → mint a new one)
 *   - check_upgrade_status       (the tool people run when stuck)
 */
import { describe, it, expect } from "vitest";
import { gateProTool, RESTART_NOTE } from "../src/tools/context.js";
import { checkUpgradeStatus } from "../src/tools/checkUpgradeStatus.js";
import { PRICE } from "../src/tools/upgrade.js";
import { makeDeps } from "./helpers.js";

/** Pull the message off a gate result, failing loudly if the gate let it pass. */
async function gateMessage(tier: "none" | "invalid"): Promise<string> {
  const res = await gateProTool(makeDeps({ tier }));
  if (res === null) throw new Error(`gateProTool passed a "${tier}" tier — it must block`);
  if (res.ok) throw new Error("gate returned a success result");
  return res.error.message;
}

describe("the restart step is stated wherever a key is", () => {
  it("says it in the no-key AUTH_REQUIRED message", async () => {
    expect(await gateMessage("none")).toContain(RESTART_NOTE);
  });

  it("says it in the revoked-key INVALID_KEY message", async () => {
    // This path ends "Then set the new key as WA_API_KEY" — the same cliff,
    // reached by someone who already has a subscription and rotated a key.
    expect(await gateMessage("invalid")).toContain(RESTART_NOTE);
  });

  it("says it in check_upgrade_status when no key is configured", async () => {
    const res = await checkUpgradeStatus({}, makeDeps({ config: { apiKey: undefined } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.message).toContain(RESTART_NOTE);
  });

  it("actually tells the reader to restart", async () => {
    // Without this, emptying RESTART_NOTE would turn the three tests above
    // green while deleting the instruction they exist to guarantee.
    expect(RESTART_NOTE).toMatch(/restart/i);
  });
});

describe("check_upgrade_status does not imply a key is free", () => {
  it("names the subscription requirement instead of offering a free key", async () => {
    // The old copy read "Create a free account and API key" — the account is
    // free, the key is not: POST /api/keys is behind requireProSession. Read
    // as a whole it promises a working key for nothing, which is the same
    // dead end one step earlier.
    const res = await checkUpgradeStatus({}, makeDeps({ config: { apiKey: undefined } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.message).not.toMatch(/free account/i);
    expect(res.data.message).toMatch(/subscription/i);
    expect(res.data.message).toContain(PRICE);
  });
});
