import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVED_TOOLS } from "../src/tools/registry.js";
import { SERVER_VERSION } from "../src/mcp/server.js";

/**
 * Drift guards over the three files that describe this server to the outside
 * world but are never exercised by running it:
 *
 *   package.json  — npm
 *   server.json   — the MCP registry listing
 *   manifest.json — the .mcpb installer and directory listing
 *
 * They drift silently because nothing imports them. Both failure modes have
 * already happened in production: SERVER_VERSION sat at 1.0.6 while the
 * manifests said 1.0.7, so clients were told the wrong version at `initialize`;
 * and after get_sample_audit shipped, both listings still advertised
 * "All tools require an active subscription" with the API key marked required —
 * the exact message 1.0.8 existed to remove, left standing on the two surfaces a
 * prospective user actually browses.
 */
const root = join(__dirname, "..");
const read = (f: string) => JSON.parse(readFileSync(join(root, f), "utf8"));

const pkg = read("package.json");
const server = read("server.json");
const manifest = read("manifest.json");

describe("published manifests stay in sync with the code", () => {
  it("all four version strings agree", () => {
    expect(server.version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
  });

  it("manifest.json lists exactly the tools the server actually serves", () => {
    const served = SERVED_TOOLS.map((t) => t.name).sort();
    const listed = manifest.tools.map((t: { name: string }) => t.name).sort();
    expect(listed).toEqual(served);
  });

  it("server.json's free/pro split matches the registry's tiers", () => {
    const meta = server._meta["io.website-auditor/tools"];
    const byTier = (tier: string) =>
      SERVED_TOOLS.filter((t) => t.tier === tier).map((t) => t.name).sort();
    expect([...meta.free].sort()).toEqual(byTier("free"));
    expect([...meta.pro].sort()).toEqual(byTier("pro"));
  });

  it("neither listing marks the API key as required", () => {
    // get_sample_audit runs without one, and the .mcpb installer blocking on a
    // key is precisely the barrier this release set out to remove.
    const env = server.packages[0].environmentVariables.find(
      (e: { name: string }) => e.name === "WA_API_KEY",
    );
    expect(env.isRequired).toBe(false);
    expect(manifest.user_config.wa_api_key.required).toBe(false);
  });

  it("neither listing still claims every tool needs a subscription", () => {
    const env = server.packages[0].environmentVariables.find(
      (e: { name: string }) => e.name === "WA_API_KEY",
    );
    for (const text of [env.description, manifest.user_config.wa_api_key.description]) {
      expect(text.toLowerCase()).not.toContain("all tools require");
      // and should point somewhere actionable instead
      expect(text).toContain("admin_portal");
    }
  });
});
