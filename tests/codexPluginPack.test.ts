import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPT_SPECS } from "../src/mcp/prompts.js";

/**
 * `npm run pack:codex` builds the ZIP the ChatGPT/Codex plugin portal takes
 * ("Upload plugin to make changes"): metadata, skills and assets reach a
 * published listing only through a new ZIP, while tool changes arrive by the
 * portal's daily scan of the hosted server
 * (developers.openai.com/plugins/deploy/submission, read 2026-10-04).
 *
 * How it differs from codex-plugin/ as committed: the portal accepts only a
 * hosted server (developers.openai.com/plugins/build/plugins), and the repo's
 * .mcp.json runs the stdio npm package for repo-marketplace installs; and the
 * README, which describes that stdio setup, is left out.
 * The first portal ZIP was built by hand on 2026-10-04 with the swap made
 * by hand, at a version (0.2.0) below what the portal already held (1.0.16
 * published, 2.0.0 in review) — this pins both.
 */
const root = join(__dirname, "..");
const HOSTED = "https://mcp.website-auditor.io/mcp";
// What is packed is what is committed: compare with HEAD, not the working tree.
const manifest = JSON.parse(execFileSync("git", ["show", "HEAD:codex-plugin/.codex-plugin/plugin.json"],
  { cwd: root, encoding: "utf8" }));
// The highest version the portal held when this was last checked (2026-10-04:
// 1.0.16 published, 2.0.0 in review). Raise it when the portal moves.
const PORTAL_HOLDS = "2.0.0";

let out: string;
let zip: string;
const entries = () => execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean);
const read = (entry: string) => execFileSync("unzip", ["-p", zip, entry], { encoding: "utf8" });

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "codex-pack-"));
  execFileSync("bash", [join(root, "scripts/pack-codex-plugin.sh"), out], { cwd: root, stdio: "pipe", timeout: 30_000 });
  zip = join(out, `website-auditor-codex-plugin-${manifest.version}.zip`);
});
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("pack:codex — the portal ZIP", () => {
  it("is named for the manifest's version and carries that manifest at the root", () => {
    expect(JSON.parse(read(".codex-plugin/plugin.json"))).toEqual(manifest);
  });

  it("declares the hosted server, not the stdio package", () => {
    // "streamable-http", not Codex's "http": the file declares the
    // agent-plugins schema, whose type enum is stdio | sse | streamable-http,
    // and OpenAI's plugin docs use it (/plugins/build/plugins, read 2026-10-04).
    const mcp = JSON.parse(read(".mcp.json"));
    const servers = Object.values(mcp.mcpServers) as Array<Record<string, unknown>>;
    expect(servers).toEqual([{ type: "streamable-http", url: HOSTED }]);
    expect(read(".mcp.json")).not.toMatch(/npx|"command"/);
  });

  it("holds every skill, the icon and nothing outside the plugin (not the stdio README)", () => {
    const files = entries().filter((e) => !e.endsWith("/"));
    for (const p of PROMPT_SPECS) expect(files).toContain(`skills/${p.name.replace(/_/g, "-")}/SKILL.md`);
    expect(files).toContain("assets/icon.png");
    for (const f of files) expect(f, f).toMatch(/^(\.codex-plugin\/|\.mcp\.json$|skills\/|assets\/)/);
  });

  it("is versioned above what the portal already holds", () => {
    // The portal reads the version from this manifest.
    const parts = (v: string) => {
      expect(v, v).toMatch(/^\d+\.\d+\.\d+$/);
      return v.split(".").map(Number);
    };
    const [a = 0, b = 0, c = 0] = parts(String(manifest.version));
    const [x = 0, y = 0, z = 0] = parts(PORTAL_HOLDS);
    expect(a - x || b - y || c - z, `${manifest.version} must be above ${PORTAL_HOLDS}`).toBeGreaterThan(0);
  });
});
