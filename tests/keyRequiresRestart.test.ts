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
async function gateMessage(tier: "none" | "invalid", transport?: "stdio" | "http"): Promise<string> {
  const res = await gateProTool({ ...makeDeps({ tier }), transport });
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

/**
 * The same rule, for the transport where the stdio answer is not merely
 * incomplete but impossible.
 *
 * A hosted caller cannot "set WA_API_KEY in this server's config": that config
 * is on a box they have no access to, and restarting their client changes
 * nothing, because src/http.ts reads the key from a header on every request.
 * Telling them to do it reopens the same dead end this file exists to close —
 * pointed at a machine they cannot log into.
 */
describe("the hosted transport gets an instruction it can actually follow", () => {
  const httpDeps = (over: Parameters<typeof makeDeps>[0] = {}) => ({
    ...makeDeps(over),
    transport: "http" as const,
  });

  const surfaces: Array<[string, () => Promise<string>]> = [
    ["no-key AUTH_REQUIRED", () => gateMessage("none", "http")],
    ["revoked-key INVALID_KEY", () => gateMessage("invalid", "http")],
    [
      "check_upgrade_status",
      async () => {
        const res = await checkUpgradeStatus({}, httpDeps({ config: { apiKey: undefined } }));
        if (!res.ok) throw new Error("expected the no-key branch to be guidance, not an error");
        return res.data.message;
      },
    ],
  ];

  for (const [name, message] of surfaces) {
    it(`${name} names the header, not the env var`, async () => {
      const m = await message();
      expect(m).toMatch(/Authorization: Bearer|X-API-Key/);
      expect(m).not.toContain("WA_API_KEY");
    });

    it(`${name} does not tell a hosted caller to restart`, async () => {
      expect(await message()).not.toContain(RESTART_NOTE);
    });
  }

  it("still says where the key goes — silence would be its own dead end", async () => {
    // The failure this guards is over-correction: stripping the stdio sentence
    // and leaving nothing is the same incomplete procedure with fewer words.
    for (const [name, message] of surfaces) {
      expect(await message(), name).toMatch(/header|connector/i);
    }
  });

  it("keeps the stdio answer for stdio, so the fix is a branch and not a swap", async () => {
    expect(await gateMessage("none", "stdio")).toContain(RESTART_NOTE);
    expect(await gateMessage("none", "stdio")).toContain("WA_API_KEY");
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
