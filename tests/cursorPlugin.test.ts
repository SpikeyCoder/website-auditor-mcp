import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PROMPT_SPECS } from "../src/mcp/prompts.js";

/**
 * Drift guards over the Cursor plugin package (cursor-plugin/), which nothing
 * imports or executes: like the manifests in manifests.test.ts it describes
 * this server to a storefront — here the Cursor Marketplace, which manually
 * reviews every listed version — so drift stays invisible until a reviewer or
 * a user hits it.
 *
 * The skills are the same four files as codex-plugin/'s: both re-express the
 * MCP prompts from src/mcp/prompts.ts as instructions. docs/CODEX-PLUGIN.md
 * states the rule — "if the prompts change, change the skills in the same
 * PR" — and admits nothing enforces it. Now something does, two ways: skills
 * must map 1:1 onto PROMPT_SPECS, and the two plugin copies must stay
 * byte-identical, so a fix to one copy cannot silently miss the other.
 */
const root = join(__dirname, "..");
const plugin = join(root, "cursor-plugin");
const readJson = (f: string) => JSON.parse(readFileSync(join(root, f), "utf8"));

const manifest = readJson("cursor-plugin/.cursor-plugin/plugin.json");
const mcp = readJson("cursor-plugin/mcp.json");
const marketplace = readJson(".cursor-plugin/marketplace.json");
const pkg = readJson("package.json");

const skillDirs = readdirSync(join(plugin, "skills"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

function frontmatter(path: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path, "utf8"));
  expect(match, `${path} carries YAML frontmatter`).toBeTruthy();
  const fields: Record<string, string> = {};
  for (const line of match![1].split("\n")) {
    const kv = /^([a-z-]+):\s*(.+)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2];
  }
  return fields;
}

describe("cursor-plugin manifest", () => {
  it("name satisfies the marketplace rule: lowercase kebab-case, alphanumeric at both ends", () => {
    expect(manifest.name).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
  });

  it("listing fields agree with package.json instead of drifting from it", () => {
    expect(manifest.license).toBe(pkg.license);
    expect(manifest.homepage).toBe(pkg.homepage);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("logo is committed and referenced by relative path (submission checklist item)", () => {
    expect(manifest.logo.startsWith("/")).toBe(false);
    expect(manifest.logo).not.toContain("..");
    expect(existsSync(join(plugin, manifest.logo))).toBe(true);
  });

  it("declares WA_API_KEY as the only variable, consumed as ${WA_API_KEY} in mcp.json", () => {
    expect(Object.keys(manifest.variables)).toEqual(["WA_API_KEY"]);
    expect(mcp.mcpServers["website-auditor"].env.WA_API_KEY).toBe("${WA_API_KEY}");
  });

  it("bundles the npm server unpinned, so releases reach plugin users without re-review", () => {
    const server = mcp.mcpServers["website-auditor"];
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "website-auditor-mcp"]);
  });

  it("the key's description points somewhere actionable and does not gate the sample", () => {
    // Same product rule the npm/registry listings are held to in
    // manifests.test.ts: a keyless visitor must be told what they CAN do.
    const desc = manifest.variables.WA_API_KEY.description;
    expect(desc).toContain("admin_portal");
    expect(desc.toLowerCase()).toMatch(/optional|without/);
  });
});

describe("cursor-plugin skills", () => {
  it("map 1:1 onto the served MCP prompts — a new prompt cannot silently miss the plugin", () => {
    const fromPrompts = PROMPT_SPECS.map((p) => p.name.replace(/_/g, "-")).sort();
    expect(skillDirs).toEqual(fromPrompts);
  });

  it("every SKILL.md carries frontmatter whose name matches its directory", () => {
    for (const dir of skillDirs) {
      const fields = frontmatter(join(plugin, "skills", dir, "SKILL.md"));
      expect(fields.name, dir).toBe(dir);
      expect(fields.description?.length ?? 0, dir).toBeGreaterThan(0);
    }
  });

  it("every keyed skill keeps the keyless get_sample_audit fallback", () => {
    // The storefront-into-paywall guard from manifests.test.ts, applied to
    // this channel's copy of the prompts.
    for (const dir of skillDirs) {
      if (dir === "see-sample-report") continue;
      const text = readFileSync(join(plugin, "skills", dir, "SKILL.md"), "utf8");
      expect(text, dir).toContain("get_sample_audit");
    }
  });

  it("stays byte-identical with the codex-plugin copy — one voice, changed together", () => {
    for (const dir of skillDirs) {
      const ours = readFileSync(join(plugin, "skills", dir, "SKILL.md"), "utf8");
      const codex = readFileSync(join(root, "codex-plugin", "skills", dir, "SKILL.md"), "utf8");
      expect(ours, dir).toBe(codex);
    }
  });
});

describe("repo-level packaging", () => {
  it("the root marketplace manifest points at the plugin it names", () => {
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].name).toBe(manifest.name);
    expect(marketplace.plugins[0].source).toBe("./cursor-plugin");
  });

  it("the Claude Desktop bundle excludes the Cursor packaging", () => {
    // codex-plugin/ earned this exclusion when a naive pack shipped dev
    // surfaces inside the .mcpb; the Cursor packaging must not regress it.
    const ignore = readFileSync(join(root, ".mcpbignore"), "utf8");
    expect(ignore).toMatch(/^cursor-plugin\/$/m);
    expect(ignore).toMatch(/^\.cursor-plugin\/$/m);
  });
});
