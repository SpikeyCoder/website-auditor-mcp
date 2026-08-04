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
const lock = read("package-lock.json");
const server = read("server.json");
const manifest = read("manifest.json");

describe("published manifests stay in sync with the code", () => {
  it("every version string agrees", () => {
    expect(server.version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
    // The lockfile carries it twice and npm only rewrites it on install, so a
    // hand-edited version bump leaves it behind — it sat at 1.0.7 through the
    // 1.0.8 release and was only caught by an unrelated prune/install cycle.
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
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

  // ── Storefront copy ───────────────────────────────────────────────
  //
  // The test above checked the env-var descriptions and missed the storefront
  // text entirely: manifest.long_description went on saying "Every tool
  // requires an active Website Auditor subscription" through 1.0.8, 1.0.9 and
  // 1.0.10 — false since get_sample_audit shipped, and shown on the Claude
  // Desktop listing page to exactly the keyless visitors that tool exists to
  // convert. It slipped both because it is a different field AND because the
  // phrasing was "Every tool requires", not the "all tools require" that was
  // being grepped for. Hence: every user-facing blurb, any phrasing.

  const BLURBS = () => [
    ["manifest.description", manifest.description],
    ["manifest.long_description", manifest.long_description],
    ["server.description", server.description],
  ];

  it("no storefront blurb claims a subscription is needed for everything", () => {
    for (const [where, text] of BLURBS()) {
      expect(text, where).not.toMatch(/every tool requires/i);
      expect(text, where).not.toMatch(/all tools require/i);
      expect(text, where).not.toMatch(/requires? (an )?active .{0,30}subscription\b(?!.{0,80}sample)/i);
    }
  });

  it("the long description tells a keyless visitor what they CAN do", () => {
    // The listing is read before install, by someone deciding whether to
    // bother. If the only thing it says about access is "pay first", the free
    // path may as well not exist.
    expect(manifest.long_description).toContain("get_sample_audit");
    expect(manifest.long_description.toLowerCase()).toMatch(/no api key|without an api key|no key/);
  });

  // ── Claude Desktop directory submission requirements ──────────────
  //
  // The directory is a fourth channel with its own form and a human review
  // queue (see RELEASING.md). get_sample_audit makes this a LOCAL connector,
  // which is held to a stricter bar, and the docs are blunt about the cost of
  // getting it wrong: "Missing or incomplete privacy policies result in
  // immediate rejection." Audited by hand on 2026-08-04 and all passing;
  // pinned here so the next submission is not a coin flip.

  it("declares privacy policies, over HTTPS", () => {
    expect(Array.isArray(manifest.privacy_policies)).toBe(true);
    expect(manifest.privacy_policies.length).toBeGreaterThan(0);
    for (const url of manifest.privacy_policies) {
      expect(url, "privacy policy URLs must be HTTPS").toMatch(/^https:\/\//);
    }
  });

  it("manifest_version is new enough to carry privacy_policies", () => {
    // The field is only honoured from 0.2 onward; on an older manifest it
    // would be silently ignored and the submission rejected for its absence.
    const [major, minor] = String(manifest.manifest_version).split(".").map(Number);
    expect(major > 0 || minor >= 2).toBe(true);
  });

  it("README carries a Privacy Policy section", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toMatch(/^#+\s*Privacy Policy\s*$/m);
  });

  it("every served tool carries a title", () => {
    // Directory requirement: "All tools must include a title and the
    // applicable readOnlyHint or destructiveHint." The hints are applied in
    // src/mcp/server.ts for every tool; the titles live on the specs here.
    const untitled = SERVED_TOOLS.filter((t: { name: string; title?: string }) =>
      !t.title || !String(t.title).trim());
    expect(untitled.map((t: { name: string }) => t.name)).toEqual([]);
  });

  it("the free tool named in the blurb is actually served and actually free", () => {
    // Guards against advertising a tool that was renamed or re-tiered.
    const spec = SERVED_TOOLS.find((t: { name: string }) => t.name === "get_sample_audit");
    expect(spec, "get_sample_audit is advertised but not served").toBeTruthy();
    expect(spec.tier).toBe("free");
  });
});
