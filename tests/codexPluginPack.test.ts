import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `npm run pack:codex -- <release.zip>` builds the update for the published
 * ChatGPT/Codex listing, at codex-plugin/.codex-plugin/plugin.json's version.
 *
 * The listing went through the previous submission form, and OpenAI's guide
 * (developers.openai.com/plugins/deploy/submission, read 2026-10-04) says to
 * start such an update from the portal's own package: the published version →
 * "…" → Download release ZIP, then upload "a complete ZIP, including all
 * components you intend to keep". That package is not codex-plugin/: on
 * 2026-10-04 (1.0.16) it held only .codex-plugin/plugin.json — named for the
 * portal's app id, with the portal's listing text — and skills/. No .mcp.json
 * (the server is connected in the dashboard) and no assets. A ZIP built from
 * the repo, the first design, would have replaced the listing text with the
 * repo's (a 93-character subtitle where the limit is 30) and added a stdio
 * .mcp.json the portal does not take.
 *
 * So the script keeps the release package and changes two things: skills/
 * becomes codex-plugin/skills as committed (added, changed and removed skills
 * all follow), and the version becomes the repo plugin's, so every portal
 * version matches a commit. It refuses skills that differ from origin/main,
 * a version not above the release's, and listing fields over OpenAI's
 * submission limits, and warns when the listing text still names SEO.
 */
const root = join(__dirname, "..");
const script = join(root, "scripts/pack-codex-plugin.sh");

const RELEASE_MANIFEST = {
  author: { name: "Example Publisher" },
  description: "Portal description",
  interface: {
    category: "Business & Operations",
    defaultPrompt: ["Show me a sample report"],
    developerName: "Example Publisher",
    displayName: "Website Auditor",
    longDescription: "Portal long description",
    shortDescription: "Audit sites and AI visibility",
  },
  name: "app-0000000000000000000000000000000",
  skills: "./skills",
  version: "1.0.16",
};

let dir: string;
// HEAD is fixed for the run: read it once.
const SKILL_FILES = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "codex-plugin/skills"], { cwd: root, encoding: "utf8" })
  .split("\n").filter(Boolean).map((p) => p.replace(/^codex-plugin\//, "")).sort();
const committedSkills = () => SKILL_FILES;
const GIT_COMMON = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  { cwd: root, encoding: "utf8" }).trim();
const COMMITTED = new Map<string, string>();
const REPO_VERSION: string = JSON.parse(execFileSync("git", ["show", "HEAD:codex-plugin/.codex-plugin/plugin.json"],
  { cwd: root, encoding: "utf8" })).version;
const committed = (path: string) => {
  if (!COMMITTED.has(path)) {
    COMMITTED.set(path, execFileSync("git", ["show", `HEAD:codex-plugin/${path}`], { cwd: root, encoding: "utf8" }));
  }
  return COMMITTED.get(path)!;
};

function releaseDir(manifest: object = RELEASE_MANIFEST): string {
  const src = join(dir, "release");
  mkdirSync(join(src, ".codex-plugin"), { recursive: true });
  mkdirSync(join(src, "skills", "audit-my-site"), { recursive: true });
  mkdirSync(join(src, "skills", "retired-skill"), { recursive: true });
  writeFileSync(join(src, ".codex-plugin", "plugin.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(src, "skills", "audit-my-site", "SKILL.md"), "---\nname: audit-my-site\ndescription: stale SEO copy\n---\n");
  writeFileSync(join(src, "skills", "retired-skill", "SKILL.md"), "---\nname: retired-skill\ndescription: gone\n---\n");
  return src;
}
function release(manifest: object = RELEASE_MANIFEST): string {
  const src = releaseDir(manifest);
  const zip = join(dir, "app-1.0.16.zip");
  execFileSync("zip", ["-qrX", zip, "."], { cwd: src });
  rmSync(src, { recursive: true, force: true });
  return zip;
}
// The script refuses skills or a version that are not origin/main's. A PR
// that changes skills is meant to differ from main, so every case but the
// main-check ones compares HEAD with itself (review of #91: pinned to
// origin/main, any skill-editing PR failed CI here).
const pack = (args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) =>
  spawnSync("bash", [script, ...args], { cwd: opts.cwd ?? root, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, ...objects, PACK_CODEX_BASE: "HEAD", npm_lifecycle_event: "", ...opts.env } });
const REMOVES_RETIRED = "warning: the release has skill retired-skill, which codex-plugin/skills does not; this update removes it";
// Commits the main checks compare against, built in a throwaway object store
// that reads the repo's objects but never writes to it (review of #91: the
// first version wrote into .git, and needed a git identity CI does not have).
let objects: Record<string, string> = {};
function commitLikeHead(path: string, content: string): string {
  const store = join(dir, "objects");
  mkdirSync(store, { recursive: true });
  objects = { GIT_OBJECT_DIRECTORY: store, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(GIT_COMMON, "objects") };
  const identity = { GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
                     GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (args: string[], env: Record<string, string> = {}, input?: string) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", input,
      env: { ...process.env, ...objects, ...identity, ...env } }).trim();
  const blob = git(["hash-object", "-w", "--stdin"], {}, content);
  const index = { GIT_INDEX_FILE: join(dir, "index") };
  git(["read-tree", "HEAD"], index);
  git(["update-index", "--cacheinfo", `100644,${blob},${path}`], index);
  return git(["commit-tree", git(["write-tree"], index), "-p", "HEAD", "-m", "test commit"]);
}
const MANIFEST_PATH = "codex-plugin/.codex-plugin/plugin.json";
const headWithVersion = (version: string) => commitLikeHead(MANIFEST_PATH,
  JSON.stringify({ ...JSON.parse(committed(".codex-plugin/plugin.json")), version }, null, 2) + "\n");
const headWithEditedSkill = () => {
  const skill = committedSkills()[0]!;
  return commitLikeHead(`codex-plugin/${skill}`, committed(skill) + "\nedited on another branch\n");
};
const withInterface = (patch: Record<string, unknown>) =>
  ({ ...RELEASE_MANIFEST, interface: { ...RELEASE_MANIFEST.interface, ...patch } });
const entries = (zip: string) => execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
const read = (zip: string, entry: string) => execFileSync("unzip", ["-p", zip, entry], { encoding: "utf8" });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "codex-pack-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); objects = {}; });

// Each case spawns the script (git, node, zip, unzip) several times: give it
// room on a loaded CI runner rather than vitest's 5s default.
describe("pack:codex — the update for the published listing", { timeout: 30_000 }, () => {
  it("keeps the release manifest, sets the repo plugin's version, and carries the committed skills", () => {
    const r = pack([release(), join(dir, "out")]);
    expect(r.status, r.stderr).toBe(0);
    const zip = join(dir, "out", `website-auditor-codex-plugin-${REPO_VERSION}.zip`);
    expect(r.stdout.trim()).toBe(zip);
    expect(JSON.parse(read(zip, ".codex-plugin/plugin.json"))).toEqual({ ...RELEASE_MANIFEST, version: REPO_VERSION });
    // Changed, added and removed skills all follow the repo; nothing else is added.
    expect(entries(zip)).toEqual([".codex-plugin/plugin.json", ...committedSkills()].sort());
    for (const s of committedSkills()) expect(read(zip, s), s).toBe(committed(s));
    // The fixture's retired skill is named as removed; nothing else is said.
    expect(r.stderr).toContain(REMOVES_RETIRED);
    expect(r.stderr).not.toMatch(/pack:codex:|names SEO/);
  });

  it("runs from any directory, and trusts INIT_CWD only when npm ran it", () => {
    const r = pack([release(), "out"], { cwd: dir, env: { INIT_CWD: "/nonexistent-stale-npm-dir" } });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(join(dir, "out"))).toEqual([`website-auditor-codex-plugin-${REPO_VERSION}.zip`]);
  });

  it("resolves relative paths against the caller's directory when npm runs it", () => {
    // npm runs the script from the repo root and records the caller's
    // directory in INIT_CWD: `npm run pack:codex -- app.zip out` from
    // ~/Downloads must read and write there.
    const zip = release();
    const r = pack(["app-1.0.16.zip", "out"], { cwd: root, env: { npm_lifecycle_event: "pack:codex", INIT_CWD: dir } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(join(dir, "out", `website-auditor-codex-plugin-${REPO_VERSION}.zip`));
    expect(zip).toBe(join(dir, "app-1.0.16.zip"));
  });

  it("refuses skills that differ from origin/main", () => {
    const base = headWithEditedSkill();
    const r = pack([release(), join(dir, "out")], { env: { PACK_CODEX_BASE: base } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`differs from ${base}: merge first`);
  });

  it("refuses a version that is not origin/main's", () => {
    const base = headWithVersion("9.9.9");
    const r = pack([release(), join(dir, "out")], { env: { PACK_CODEX_BASE: base } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(new RegExp(`version at HEAD \\(${REPO_VERSION.replace(/\./g, "\\.")}\\) is not ${base}'s`));
  });

  it("refuses a repo version that is not above the release's", () => {
    for (const [v, why] of [[REPO_VERSION, /not above the release/], ["99.0.0", /not above the release/],
                            ["2.1", /release version is not x\.y\.z/], ["1.0.16-rc.1", /release version is not x\.y\.z/]] as const) {
      const r = pack([release({ ...RELEASE_MANIFEST, version: v }), join(dir, "out")]);
      expect(r.status, v).not.toBe(0);
      expect(r.stderr, v).toMatch(why);
    }
    expect(readdirSync(dir)).not.toContain("out");
  });

  it("refuses each listing field over OpenAI's submission limits", () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ displayName: "x".repeat(31) }, /displayName is 31/],
      [{ shortDescription: "x".repeat(31) }, /shortDescription is 31/],
      [{ longDescription: "x".repeat(4001) }, /longDescription is 4001/],
      [{ developerName: "x".repeat(81) }, /developerName is 81/],
      [{ defaultPrompt: ["a", "b", "c", "d"] }, /4 prompts; the limit is 3/],
      [{ defaultPrompt: ["x".repeat(129)] }, /129-character prompt/],
      [{ defaultPrompt: "Show me a sample" }, /list of strings/],
      [{ defaultPrompt: [{ text: "x" }] }, /list of strings/],
      [{ capabilities: Array.from({ length: 21 }, (_, k) => `cap ${k}`) }, /21 labels; the limit is 20/],
      [{ capabilities: ["x".repeat(121)] }, /121-character label/],
      [{ capabilities: "audits" }, /capabilities must be a list of strings/],
    ];
    const longDescription = pack([release({ ...RELEASE_MANIFEST, description: "x".repeat(4001) }), join(dir, "out")]);
    expect(longDescription.status).not.toBe(0);
    expect(longDescription.stderr).toMatch(/^pack:codex: description is 4001 characters/m);
    for (const [patch, why] of cases) {
      const r = pack([release(withInterface(patch)), join(dir, "out")]);
      expect(r.status, JSON.stringify(patch)).not.toBe(0);
      expect(r.stderr, JSON.stringify(patch)).toMatch(why);
    }
    expect(pack([release(withInterface({ shortDescription: "x".repeat(30), defaultPrompt: ["a", "b", "c"] })),
      join(dir, "out")]).status).toBe(0);
  });

  it("warns, per field, when the portal's listing text still names SEO", () => {
    const cases: Array<[object, string]> = [
      [{ ...RELEASE_MANIFEST, description: "Adds SEO checks" }, "description"],
      [withInterface({ longDescription: "Adds search engine optimization checks" }), "interface.longDescription"],
      [withInterface({ shortDescription: "SEO and AI audits" }), "interface.shortDescription"],
      [withInterface({ defaultPrompt: ["Check my SEO"] }), "interface.defaultPrompt"],
      [withInterface({ displayName: "Website Auditor SEO" }), "interface.displayName"],
    ];
    cases.push([{ ...RELEASE_MANIFEST, keywords: ["audit", "seo"] }, "keywords"]);
    for (const [manifest, field] of cases) {
      const r = pack([release(manifest), join(dir, "out")]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr, field).toContain(`warning: ${field} still names SEO`);
    }
  });

  it("packs an unzipped, edited release folder, with every check on the edited text", () => {
    // How the listing text gets changed: edit the manifest before packing, so
    // the limits still apply (review of #91).
    const edited = withInterface({ longDescription: "Edited listing text" });
    const src = releaseDir(edited);
    writeFileSync(join(src, ".DS_Store"), "junk");
    mkdirSync(join(src, "__MACOSX"));
    writeFileSync(join(src, "__MACOSX", "._plugin.json"), "junk");
    const r = pack([src, join(dir, "out")]);
    expect(r.status, r.stderr).toBe(0);
    const zip = join(dir, "out", `website-auditor-codex-plugin-${REPO_VERSION}.zip`);
    expect(JSON.parse(read(zip, ".codex-plugin/plugin.json"))).toEqual({ ...edited, version: REPO_VERSION });
    expect(entries(zip)).toEqual([".codex-plugin/plugin.json", ...committedSkills()].sort());
    const tooLong = releaseDir(withInterface({ shortDescription: "x".repeat(31) }));
    expect(pack([tooLong, join(dir, "out2")]).status).not.toBe(0);
  });

  it("refuses something that is not a release package", () => {
    const zip = join(dir, "not-a-plugin.zip");
    writeFileSync(join(dir, "x.txt"), "x");
    execFileSync("zip", ["-qX", zip, "x.txt"], { cwd: dir });
    const notPlugin = pack([zip, join(dir, "out")]);
    expect(notPlugin.status).not.toBe(0);
    expect(notPlugin.stderr).toMatch(/has no \.codex-plugin\/plugin\.json/);
    const missing = pack([join(dir, "missing.zip"), join(dir, "out")]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/no such file or folder/);
  });

  it("packs only the plugin from a release folder: no litter, no earlier output", () => {
    const src = releaseDir();
    for (const f of ["._plugin.json", ".plugin.json.swp", "plugin.json~", `website-auditor-codex-plugin-${REPO_VERSION}.zip`]) {
      writeFileSync(join(src, f), "junk");
    }
    mkdirSync(join(src, ".git"));
    writeFileSync(join(src, ".git", "HEAD"), "junk");
    const r = pack([src, src]);
    expect(r.status, r.stderr).toBe(0);
    expect(entries(join(src, `website-auditor-codex-plugin-${REPO_VERSION}.zip`)))
      .toEqual([".codex-plugin/plugin.json", ...committedSkills()].sort());
  });

  it("unwraps a release that Finder compressed into one folder, litter and all", () => {
    const src = releaseDir();
    writeFileSync(join(dir, "._release"), "appledouble");
    const zip = join(dir, "wrapped.zip");
    execFileSync("zip", ["-qrX", zip, "release", "._release"], { cwd: dir });
    const r = pack([zip, join(dir, "out")]);
    expect(r.status, r.stderr).toBe(0);
    expect(entries(join(dir, "out", `website-auditor-codex-plugin-${REPO_VERSION}.zip`))).toContain(".codex-plugin/plugin.json");
    expect(src).toBe(join(dir, "release"));
  });

  it("counts UTF-16 units, the stricter count, so an emoji is 2", () => {
    // 13 emoji + " audit": 19 characters, 32 UTF-16 units.
    const r = pack([release(withInterface({ shortDescription: "\u{1F50D}".repeat(13) + " audit" })), join(dir, "out")]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/shortDescription is 32 characters/);
    expect(pack([release(withInterface({ shortDescription: "\u{1F50D}".repeat(12) })), join(dir, "out2")]).status).toBe(0);
  });

  it("says nothing of an empty skills folder", () => {
    const src = releaseDir();
    rmSync(join(src, "skills"), { recursive: true, force: true });
    mkdirSync(join(src, "skills"));
    const r = pack([src, join(dir, "out")]);
    expect(r.status, r.stderr).toBe(0);
    // Only the empty-glob symptom: an uncommitted skill edit rightly warns too.
    expect(r.stderr).not.toMatch(/the release has|skill \*/);
  });

  it("names files inside a kept skill that the update drops", () => {
    const src = releaseDir();
    mkdirSync(join(src, "skills", "audit-my-site", "agents"));
    writeFileSync(join(src, "skills", "audit-my-site", "agents", "openai.yaml"), "portal: metadata");
    const r = pack([src, join(dir, "out")]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("warning: the release has skills/audit-my-site/agents/openai.yaml, which codex-plugin/skills does not");
  });

  it("refuses a release that declares its skills somewhere other than ./skills", () => {
    const r = pack([release({ ...RELEASE_MANIFEST, skills: "./plugin-skills" }), join(dir, "out")]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/declares skills at \.\/plugin-skills/);
  });

  it("strips Finder junk from a re-zipped release too", () => {
    const src = releaseDir();
    writeFileSync(join(src, ".DS_Store"), "junk");
    const zip = join(dir, "rezipped.zip");
    execFileSync("zip", ["-qrX", zip, "."], { cwd: src });
    const r = pack([zip, join(dir, "out")]);
    expect(r.status, r.stderr).toBe(0);
    expect(entries(join(dir, "out", `website-auditor-codex-plugin-${REPO_VERSION}.zip`))).not.toContain(".DS_Store");
  });
});
