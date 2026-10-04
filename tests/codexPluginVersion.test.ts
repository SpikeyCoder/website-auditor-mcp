import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * The Codex plugin's version moves when the plugin does.
 *
 * The rule (docs/CODEX-PLUGIN.md, codex-plugin/README.md): bump
 * .codex-plugin/plugin.json `version` when anything in codex-plugin/ changes
 * other than its README. Nothing enforced it, and codex-plugin/ stayed at
 * 0.1.0 through a new skill (build-growth-plan), a relicence and the mcp#88
 * rewording. The version is NOT one of the seven strings the release keeps
 * in agreement, so this is the only thing that notices.
 *
 * Against origin/main (CI fetches it: test.yml, fetch-depth 0). What this
 * branch changed is measured from the merge-base with main, so main moving on
 * is not this branch's change. A branch that changed the plugin must carry a
 * version later than main's tip, so it cannot merge an equal or lower one; a
 * branch that did not change it only must not lower the version it started
 * from (a branch behind a plugin bump on main still passes).
 *
 * The plugin is everything under codex-plugin/ but its README: the
 * manifest, compared as parsed JSON with its `version` removed (key order is
 * formatting, not content), and every other file, edited, deleted, or new and
 * not ignored (a Finder .DS_Store is ignored). A component added later
 * (hooks, agents, an AGENTS.md) counts without a change here.
 */
const root = join(__dirname, "..");
const MANIFEST = "codex-plugin/.codex-plugin/plugin.json";
const PLUGIN = ["codex-plugin", `:(exclude)${MANIFEST}`, ":(exclude)codex-plugin/README.md"];
const BASE = "origin/main";

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function gitOrExplain(...args: string[]): string {
  try {
    return git(...args);
  } catch (e) {
    const why = String((e as { stderr?: string }).stderr || (e as Error).message).trim();
    const hint = /origin\/main|not a git repository|Not a valid object name/i.test(why)
      ? ` This test compares codex-plugin/ with ${BASE}: run \`git fetch origin main\` (CI: fetch-depth 0).`
      : "";
    throw new Error(`git ${args.join(" ")} failed: ${why}.${hint}`);
  }
}

const withoutVersion = ({ version: _v, ...rest }: Record<string, unknown>) => rest;

/** Positive when a is later than b; both must be plain x.y.z. */
function compareVersions(a: string, b: string): number {
  for (const v of [a, b]) if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`not x.y.z: ${v}`);
  const [x1 = 0, x2 = 0, x3 = 0] = a.split(".").map(Number);
  const [y1 = 0, y2 = 0, y3 = 0] = b.split(".").map(Number);
  return x1 - y1 || x2 - y2 || x3 - y3;
}

describe("codex-plugin version tracks its contents", () => {
  const forkPoint = gitOrExplain("merge-base", "HEAD", BASE).trim();
  const here = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  const atFork = JSON.parse(gitOrExplain("show", `${forkPoint}:${MANIFEST}`));
  const onMain = JSON.parse(gitOrExplain("show", `${BASE}:${MANIFEST}`));

  it("a changed plugin carries a later version than main", () => {
    const changed = [
      ...(isDeepStrictEqual(withoutVersion(atFork), withoutVersion(here)) ? [] : [`${MANIFEST} (beyond its version)`]),
      ...gitOrExplain("diff", "--name-only", forkPoint, "--", ...PLUGIN).split("\n").filter(Boolean),
      ...gitOrExplain("ls-files", "--others", "--exclude-standard", "--", ...PLUGIN).split("\n").filter(Boolean),
    ];
    if (changed.length === 0) return;
    expect(compareVersions(here.version, onMain.version),
      `codex-plugin changed (${changed.join(", ")}) but ${MANIFEST} is ${here.version}, not later than main's ${onMain.version}: bump it`)
      .toBeGreaterThan(0);
  });

  it("the version never goes below the one this branch started from", () => {
    expect(compareVersions(here.version, atFork.version), `${here.version} is older than ${atFork.version}, where this branch started`)
      .toBeGreaterThanOrEqual(0);
  });

  it("orders versions numerically and refuses anything but x.y.z", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.9", "0.2.0")).toBeLessThan(0);
    expect(() => compareVersions("0.3.0-beta.1", "0.2.0")).toThrow(/x\.y\.z/);
    expect(() => compareVersions("1.0", "0.2.0")).toThrow(/x\.y\.z/);
  });
});
