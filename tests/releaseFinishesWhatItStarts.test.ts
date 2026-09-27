/**
 * The release script finishes what it starts.
 *
 * 1.0.25 (2026-09-26): npm published, then the MCP registry was asked in the
 * same breath and answered 400 "NPM package exists, but version '1.0.25' was
 * not found": npm had not served it yet. The script tried once, re-read the
 * registry five times (as if the publish might have landed), called it
 * HALF-PUBLISHED and exited, so the .mcpb bundle, packed after the registry
 * step, was never made. The GitHub login was fine; the registry token only
 * lives 300s, so any retry meant another device-flow prompt.
 *
 * scripts/release-lib.sh now holds the steps that talk to the outside, so they
 * can be driven here against stubs: gh, mcp-publisher and curl on PATH log
 * what they were asked, and fail as many times as a test says.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const LIB = join(ROOT, "scripts", "release-lib.sh");
const SCRIPT = join(ROOT, "scripts", "release.sh");
const GH_TOKEN = "gho_stubbedTokenValue123";

let dir: string;
let log: string;

function stub(name: string, body: string) {
  const p = join(dir, "bin", name);
  writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
  chmodSync(p, 0o755);
}

/** Fail the first `n` calls of a stub, then succeed. */
function failsFirst(name: string, n: number, okBody = "exit 0", failBody = "exit 1") {
  const count = join(dir, `${name}.count`);
  stub(name, `c=$(cat "${count}" 2>/dev/null || echo 0); c=$((c+1)); echo $c > "${count}"
if [ "$c" -le ${n} ]; then ${failBody}; fi
${okBody}`);
}

function run(snippet: string, env: Record<string, string> = {}) {
  rmSync(log, { force: true });
  const r = spawnSync("bash", ["-c", `set -euo pipefail; source "${LIB}"; ${snippet}`], {
    env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, HOME: dir, RELEASE_BACKOFF_SCALE: "0", LOG_FILE: log, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], // no TTY, as under CI or an agent
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  return { status: r.status, out: r.stdout + r.stderr, calls };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "release-"));
  log = join(dir, "calls.log");
  spawnSync("mkdir", ["-p", join(dir, "bin")]);
  stub("gh", `[ "$1 $2" = "auth token" ] && echo "${GH_TOKEN}"`);
  stub("mcp-publisher", PUBLISHER_OK);
  stub("curl", "exit 0");
});

// Logs "env-token" when MCP_GITHUB_TOKEN carries the gh token, so a test can
// see how it arrived; argv is logged by stub() itself.
const PUBLISHER_OK = `[ "\${MCP_GITHUB_TOKEN:-}" = "${GH_TOKEN}" ] && echo "env-token" >> "\$LOG_FILE"; exit 0`;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the registry token comes from the gh login, every time it is needed", () => {
  it("mints it with no prompt from `gh auth token`, handing the token over by environment, not argv", () => {
    const r = run("release_mint_token");
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(["gh auth token", "mcp-publisher login github", "env-token"]);
    expect(r.calls.join("\n")).not.toContain(GH_TOKEN);
  });

  it("keeps the token out of a bash -x trace, and leaves tracing on after", () => {
    const r = run("set -x; release_mint_token; echo \"after:$-\"");
    expect(r.status).toBe(0);
    expect(r.out).not.toContain(GH_TOKEN);
    expect(r.out).toMatch(/after:\S*x/);
  });

  it("shows why a mint failed, with the token masked", () => {
    stub("mcp-publisher", `echo "token exchange failed with status 502 for ${GH_TOKEN}" >&2; exit 1`);
    const r = run("release_mint_token || echo mint-failed");
    expect(r.out).toContain("token exchange failed with status 502");
    expect(r.out).toContain("mint-failed");
    expect(r.out).not.toContain(GH_TOKEN);
  });

  it("never prints the token", () => {
    const r = run("release_mint_token; release_publish_registry 3");
    expect(r.out).not.toContain(GH_TOKEN);
  });

  it("without a gh login and without a terminal, says so rather than prompting", () => {
    stub("gh", "exit 1");
    const r = run("release_mint_token");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("no gh login");
    expect(r.calls.filter((c) => c.startsWith("mcp-publisher"))).toEqual([]);
  });
});

describe("npm must serve the version before the registry is asked", () => {
  it("waits until npm answers for that exact version", () => {
    failsFirst("curl", 2);
    const r = run("release_await_npm website-auditor-mcp 1.0.25 6");
    expect(r.status).toBe(0);
    const curls = r.calls.filter((c) => c.startsWith("curl"));
    expect(curls).toHaveLength(3);
    expect(curls[0]).toContain("https://registry.npmjs.org/website-auditor-mcp/1.0.25");
  });

  it("gives up after its tries, and says npm is the one missing", () => {
    failsFirst("curl", 99);
    const r = run("release_await_npm website-auditor-mcp 1.0.25 4");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("npm does not serve website-auditor-mcp@1.0.25");
    expect(r.calls.filter((c) => c.startsWith("curl"))).toHaveLength(4);
  });
});

describe("the advice to run it again matches how it was run", () => {
  // A terminal without --yes keeps the confirm prompt in front of the
  // registry publish; --yes, or no terminal to confirm at, needs --yes.
  function hint(yes: string, tty: boolean) {
    const cmd = `source "${LIB}"; release_rerun_hint ${yes}`;
    const [bin, argv] = !tty ? ["bash", ["-c", cmd]]
      : process.platform === "darwin" ? ["script", ["-q", "/dev/null", "bash", "-c", cmd]]
      : ["script", ["-qec", `bash -c '${cmd}'`, "/dev/null"]];
    const r = spawnSync(bin, argv as string[], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return (r.stdout + r.stderr).replace(/\^D\x08*|\r/g, "").trim();
  }
  it("a terminal without --yes: plain npm run release", () => expect(hint("0", true)).toBe("npm run release"));
  it("--yes: npm run release -- --yes", () => expect(hint("1", true)).toBe("npm run release -- --yes"));
  it("no terminal: npm run release -- --yes", () => expect(hint("0", false)).toBe("npm run release -- --yes"));
});

describe("the waits are real waits", () => {
  // RELEASE_BACKOFF_SCALE=1 and a sleep that only logs: the delays are read,
  // not slept. A wait with no sleep is the race that refused 1.0.25.
  const sleeps = (r: { calls: string[] }) => r.calls.filter((c) => c.startsWith("sleep ")).map((c) => c.slice(6));
  beforeEach(() => stub("sleep", "exit 0"));

  it("npm is polled at 2, 4, 8 … seconds, capped at 30", () => {
    failsFirst("curl", 3);
    expect(sleeps(run("release_await_npm website-auditor-mcp 1.0.25 10", { RELEASE_BACKOFF_SCALE: "1" }))).toEqual(["2", "4", "8"]);
    stub("curl", "exit 22");
    const r = run("release_await_npm website-auditor-mcp 1.0.25 7 || true", { RELEASE_BACKOFF_SCALE: "1" });
    // No wait after the last try, and no claim to be retrying.
    expect(sleeps(r)).toEqual(["2", "4", "8", "16", "30", "30"]);
    expect(r.out).not.toMatch(/retrying in \d+s \(7\/7\)/);
  });

  it("the registry retry does not wait, or claim to retry, after its last try", () => {
    stub("mcp-publisher", `[ "$1" = "publish" ] && exit 1; exit 0`);
    const r = run("release_publish_registry 3 || true", { RELEASE_BACKOFF_SCALE: "1" });
    expect(sleeps(r)).toEqual(["5", "10"]);
    expect(r.out).not.toMatch(/retrying in \d+s \(3\/3\)/);
  });

  it("registry attempts are 5, then 10 seconds apart", () => {
    const count = join(dir, "publish.count");
    stub("mcp-publisher", `if [ "$1" = "publish" ]; then c=$(cat "${count}" 2>/dev/null || echo 0); c=$((c+1)); echo $c > "${count}"; [ "$c" -ge 3 ] || exit 1; fi; exit 0`);
    expect(sleeps(run("release_publish_registry 5", { RELEASE_BACKOFF_SCALE: "1" }))).toEqual(["5", "10"]);
  });
});

describe("a registry publish that fails is tried again, with a fresh token each time", () => {
  it("retries until it lands", () => {
    const count = join(dir, "publish.count");
    stub("mcp-publisher", `if [ "$1" = "publish" ]; then c=$(cat "${count}" 2>/dev/null || echo 0); c=$((c+1)); echo $c > "${count}"; [ "$c" -ge 3 ] || exit 1; fi; exit 0`);
    const r = run("release_publish_registry 5");
    expect(r.status).toBe(0);
    const pub = r.calls.filter((c) => c.startsWith("mcp-publisher"));
    expect(pub).toEqual([
      "mcp-publisher login github", "mcp-publisher publish",
      "mcp-publisher login github", "mcp-publisher publish",
      "mcp-publisher login github", "mcp-publisher publish",
    ]);
  });

  it("a mint that fails is an attempt too: it is retried, and the publish still runs", () => {
    const count = join(dir, "login.count");
    stub("mcp-publisher", `if [ "$1" = "login" ]; then c=$(cat "${count}" 2>/dev/null || echo 0); c=$((c+1)); echo $c > "${count}"; if [ "$c" -le 2 ]; then echo "token exchange failed with status 502" >&2; exit 1; fi; fi; exit 0`);
    const r = run("release_publish_registry 5");
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("mcp-publisher"))).toEqual([
      "mcp-publisher login github", "mcp-publisher login github",
      "mcp-publisher login github", "mcp-publisher publish",
    ]);
    expect(r.out).toContain("could not mint a registry token");
  });

  it("stops after its tries and reports failure", () => {
    stub("mcp-publisher", `[ "$1" = "publish" ] && exit 1; exit 0`);
    const r = run("release_publish_registry 3");
    expect(r.status).not.toBe(0);
    expect(r.calls.filter((c) => c === "mcp-publisher publish")).toHaveLength(3);
  });

  it("does not publish without a token it could mint, and does not retry what no retry can fix", () => {
    stub("gh", "exit 1");
    const r = run("release_publish_registry 3");
    expect(r.status).not.toBe(0);
    expect(r.calls.filter((c) => c === "mcp-publisher publish")).toEqual([]);
    expect(r.calls.filter((c) => c === "gh auth token")).toHaveLength(1);
  });
});

/**
 * release.sh itself, run end to end in a scratch git repo (main, in sync with
 * a bare origin) with npm, npx, gh, mcp-publisher, curl and sleep stubbed on
 * PATH and no terminal. Every stub logs its call, so a test reads the order
 * things happened in and whether an irreversible step ran at all.
 */
// Each case runs the whole script (git, node, stubs): allow for a loaded machine.
describe("release.sh, run", { timeout: 30_000 }, () => {
  const VERSION: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const PKG = "website-auditor-mcp";

  type Opts = { ghLogin?: string | null; npmHas?: boolean; npmServes?: boolean; loginFails?: boolean;
                tfa?: string; savedToken?: boolean; publishFails?: boolean; regHas?: boolean; noYes?: boolean;
                whoamiFails?: boolean; noPublisher?: boolean; fromScripts?: boolean;
                codeSincePublished?: boolean; dry?: boolean; tty?: boolean;
                npmLate?: number; changedSincePublished?: string; gitHead?: "none" | "fails";
                packFails?: boolean; restoreFails?: boolean; emptyBundle?: boolean };

  function release(o: Opts = {}) {
    const ghLogin = o.ghLogin === undefined ? "SpikeyCoder" : o.ghLogin;
    const repo = join(dir, "repo"), origin = join(dir, "origin.git"), state = join(dir, "state");
    const sh = (cmd: string, cwd = dir) => {
      const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(cmd + "\n" + r.stderr);
    };
    for (const d of [repo, origin, state, log, join(dir, ".config")]) rmSync(d, { recursive: true, force: true });
    sh(`mkdir -p "${repo}/scripts" "${state}" && cp "${join(ROOT, "package.json")}" "${repo}/" && cp "${SCRIPT}" "${LIB}" "${repo}/scripts/"`);
    const g = "git -c user.email=t@t -c user.name=t";
    sh(`mkdir -p src && echo "export const a = 1;" > src/a.ts && echo '{}' > manifest.json && echo '{}' > package-lock.json && echo '{}' > tsconfig.json && echo readme > README.md && echo licence > LICENSE && echo png > icon.png && echo "tests/" > .mcpbignore && git init -q -b main . && ${g} add -A && ${g} commit -qm init && git init -q --bare "${origin}" && git remote add origin "${origin}" && git push -q origin main`, repo);
    // The commit npm published this version from (npm view … gitHead).
    const published = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    if (o.codeSincePublished) {
      sh(`echo "export const a = 2;" > src/a.ts && ${g} commit -qam "code after the release" && git push -q origin main`, repo);
    }
    if (o.changedSincePublished) {
      sh(`echo " " >> "${o.changedSincePublished}" && ${g} commit -qam "a shipped file changed after the release" && git push -q origin main`, repo);
    }
    if (o.savedToken) {
      const b64 = (x: object) => Buffer.from(JSON.stringify(x)).toString("base64url");
      const jwt = `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3000 })}.sig`;
      sh(`mkdir -p "${dir}/.config/mcp-publisher" && printf '%s' '{"token":"${jwt}"}' > "${dir}/.config/mcp-publisher/token.json"`);
    }
    stub("npm", `case "$1" in
  whoami) ${o.whoamiFails ? "exit 1" : "echo kevin"} ;;
  profile) echo "${o.tfa ?? "disabled"}" ;;
  view) if [ "$2" = "${PKG}@${VERSION}" ]; then
          ${o.npmHas ? `if [ "$3" = "gitHead" ]; then ${o.gitHead === "none" ? "exit 0" : o.gitHead === "fails" ? "exit 1" : `echo ${published}`}; else echo ${VERSION}; fi` : "exit 1"}
        else echo ${VERSION}; fi ;;
  publish) touch "${state}/npm" ;;
  ci) ${o.packFails ? '[ "$2" = "--omit=dev" ] && { echo "npm ERR! network" >&2; exit 1; }' : ""}
      ${o.restoreFails ? '[ -z "${2:-}" ] && { echo "npm ERR! restore" >&2; exit 1; }' : ""} ;;
esac; exit 0`);
    // As real mcpb: "pack <dir> [output]"; with no output it names the file
    // after the directory it packs (this scratch repo is "repo", not the package).
    stub("npx", `case "$*" in *mcpb*) out="\${5:-$(basename "$PWD").mcpb}"; ${o.emptyBundle ? ': > "$out"' : 'echo mcpb > "$out"'} ;; esac; exit 0`);
    // npm ci is logged by stub() like every call, so the prune/restore order shows.
    stub("gh", ghLogin === null ? "exit 1" : `case "$1 $2" in "auth token") echo "${GH_TOKEN}" ;; "api user") echo "${ghLogin}" ;; esac; exit 0`);
    stub("mcp-publisher", `case "$1" in
  login) ${o.loginFails ? 'echo "token exchange failed with status 502" >&2; exit 1' : "exit 0"} ;;
  publish) ${o.publishFails ? "exit 1" : `touch "${state}/registry"`} ;;
esac; exit 0`);
    stub("curl", `case "$*" in
  *registry.npmjs.org*)
    ${o.npmServes === false ? "exit 22" : o.npmLate ? `c=$(cat "${state}/npmjs" 2>/dev/null || echo 0); c=$((c+1)); echo $c > "${state}/npmjs"; [ "$c" -gt ${o.npmLate} ] || exit 22` : ""}
    exit 0 ;;
  *registry.modelcontextprotocol.io*)
    if [ -e "${state}/registry" ] || ${o.regHas ? "true" : "false"}; then echo '{"servers":[{"server":{"version":"${VERSION}"},"_meta":{"io.modelcontextprotocol.registry/official":{"isLatest":true}}}]}'; else echo '{"servers":[]}'; fi ;;
esac`);
    stub("sleep", "exit 0");
    if (o.noPublisher) rmSync(join(dir, "bin", "mcp-publisher"));
    const node = spawnSync("bash", ["-c", "dirname $(command -v node)"], { encoding: "utf8" }).stdout.trim();
    const args = [o.fromScripts ? "release.sh" : join(repo, "scripts", "release.sh"), ...(o.noYes ? [] : ["--yes"]), ...(o.dry ? ["--dry-run"] : [])];
    // tty: run under script(1), which gives the release a terminal (BSD and
    // util-linux spell it differently).
    const [cmd, argv] = !o.tty ? ["bash", args]
      : process.platform === "darwin" ? ["script", ["-q", "/dev/null", "bash", ...args]]
      : ["script", ["-qec", ["bash", ...args].map((a) => `'${a}'`).join(" "), "/dev/null"]];
    const r = spawnSync(cmd, argv as string[], {
      cwd: o.fromScripts ? join(repo, "scripts") : repo, encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: `${join(dir, "bin")}:${node}:/usr/bin:/bin`, HOME: dir, RELEASE_BACKOFF_SCALE: "0", LOG_FILE: log },
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
    const idx = (p: string) => calls.findIndex((c) => c.startsWith(p));
    return { status: r.status, out: r.stdout + r.stderr, calls, idx,
             npmPublished: existsSync(join(state, "npm")), registryPublished: existsSync(join(state, "registry")),
             bundle: existsSync(join(repo, `${PKG}-${VERSION}.mcpb`)) };
  }

  it("a fresh release packs, publishes to npm, waits for npm, then the registry", () => {
    const r = release();
    expect(r.status, r.out).toBe(0);
    expect(r.npmPublished && r.registryPublished && r.bundle).toBe(true);
    expect(r.idx("npx --yes @anthropic-ai/mcpb pack")).toBeLessThan(r.idx("npm publish"));
    expect(r.idx("npm publish")).toBeLessThan(r.idx("curl -fsS --max-time 20 -o /dev/null https://registry.npmjs.org/"));
    expect(r.idx("curl -fsS --max-time 20 -o /dev/null https://registry.npmjs.org/")).toBeLessThan(r.idx("mcp-publisher publish"));
    expect(r.out).not.toContain(GH_TOKEN);
  });

  it("with no gh and no terminal, stops before npm even with a saved token", () => {
    const r = release({ ghLogin: null, savedToken: true });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("no gh login and no terminal");
    expect(r.npmPublished).toBe(false);
  });

  it("stops before npm when gh is logged in as someone who does not own the namespace", () => {
    const r = release({ ghLogin: "someone-else" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("gh is logged in as someone-else");
    expect(r.npmPublished).toBe(false);
  });

  it("stops before npm when the registry will not issue a token", () => {
    const r = release({ loginFails: true });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("token exchange failed with status 502");
    expect(r.npmPublished).toBe(false);
  });

  it("resumes a half-published release with no terminal: skips npm, packs, and finishes the registry", () => {
    const r = release({ npmHas: true, tfa: "auth-and-writes" });
    expect(r.status, r.out).toBe(0);
    expect(r.npmPublished).toBe(false);
    expect(r.registryPublished && r.bundle).toBe(true);
    expect(r.out).not.toContain("Nothing has been published");
  });

  it("waits for an npm that serves late, as it did for 1.0.25, and then finishes", () => {
    // Nine refusals, served on the tenth poll: the release's own try count
    // (ten) is what carries it through.
    const r = release({ npmLate: 9 });
    expect(r.status, r.out).toBe(0);
    expect(r.registryPublished).toBe(true);
    expect(r.calls.filter((c) => c.includes("https://registry.npmjs.org/"))).toHaveLength(10);
  });

  it("stops, saying so, if npm never serves the version, and asks the registry nothing", () => {
    const r = release({ npmServes: false });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("npm still does not serve");
    expect(r.calls.filter((c) => c.includes("https://registry.npmjs.org/"))).toHaveLength(10);
    expect(r.idx("mcp-publisher publish")).toBe(-1);
    expect(r.bundle).toBe(true);
  });

  it("packs from production dependencies and restores dev ones before npm publish runs its checks", () => {
    const r = release();
    expect(r.status, r.out).toBe(0);
    const prune = r.calls.indexOf("npm ci --omit=dev"), pack = r.idx("npx --yes @anthropic-ai/mcpb pack");
    const restore = r.calls.findIndex((c, i) => i > pack && c === "npm ci");
    expect(prune).toBeGreaterThan(-1);
    expect(prune).toBeLessThan(pack);
    expect(pack).toBeLessThan(restore);
    expect(restore).toBeLessThan(r.idx("npm publish"));
  });

  it("a fresh release with 2FA on and no terminal stops before npm", () => {
    const r = release({ tfa: "auth-and-writes" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("needs a one-time password");
    expect(r.npmPublished).toBe(false);
  });

  it("with no terminal and no --yes, says to add --yes instead of stopping without a word", () => {
    const r = release({ npmHas: true, noYes: true });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("npm run release -- --yes");
    expect(r.out).toContain("ABORT");
  });

  it("when both channels already have the version, packs the bundle for the GitHub release and publishes nothing", () => {
    const r = release({ npmHas: true, regHas: true });
    expect(r.status, r.out).toBe(0);
    expect(r.bundle).toBe(true);
    expect(r.npmPublished || r.registryPublished).toBe(false);
    expect(r.idx("mcp-publisher publish")).toBe(-1);
    expect(r.out).toContain(`gh release create v${VERSION}`);
  });

  it("when both channels already have the version, packs without asking, even with no terminal and no --yes", () => {
    const r = release({ npmHas: true, regHas: true, noYes: true });
    expect(r.status, r.out).toBe(0);
    expect(r.bundle).toBe(true);
    expect(r.npmPublished || r.registryPublished).toBe(false);
    expect(r.out).not.toMatch(/no terminal to confirm at|Type the version to confirm/);
  });

  it("a resume needs no npm login: npm is skipped", () => {
    const r = release({ npmHas: true, whoamiFails: true });
    expect(r.status, r.out).toBe(0);
    expect(r.registryPublished && r.bundle).toBe(true);
  });

  it("packing the bundle alone needs no npm login and no registry credentials", () => {
    const r = release({ npmHas: true, regHas: true, whoamiFails: true, ghLogin: null, noYes: true });
    expect(r.status, r.out).toBe(0);
    expect(r.bundle).toBe(true);
  });

  it("packing the bundle alone asks the registry and gh nothing, even when gh is logged in", () => {
    for (const o of [{ ghLogin: "someone-else" }, { loginFails: true }, { noPublisher: true }] as Opts[]) {
      const r = release({ npmHas: true, regHas: true, noYes: true, ...o });
      expect(r.status, JSON.stringify(o) + r.out).toBe(0);
      expect(r.bundle).toBe(true);
      expect(r.calls.filter((c) => c.startsWith("gh ") || c.startsWith("mcp-publisher"))).toEqual([]);
    }
  });

  it("runs from any directory, by a relative path", () => {
    const r = release({ npmHas: true, regHas: true, fromScripts: true });
    expect(r.status, r.out).toBe(0);
    expect(r.bundle).toBe(true);
  });

  it("will not pack code newer than the version npm has as that version", () => {
    const r = release({ npmHas: true, regHas: true, codeSincePublished: true });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("bump the version");
    expect(r.bundle).toBe(false);
  });

  it("counts every shipped file, not only src, when deciding the bundle would not be npm's version", () => {
    for (const f of ["manifest.json", "package.json", "package-lock.json", "tsconfig.json", "README.md", "LICENSE", "icon.png", ".mcpbignore"]) {
      const r = release({ npmHas: true, regHas: true, changedSincePublished: f });
      expect(r.status, f).not.toBe(0);
      expect(r.out, f).toContain("bump the version");
      expect(r.bundle, f).toBe(false);
    }
  });

  it("will not pack when npm cannot say which commit it published from", () => {
    for (const gitHead of ["none", "fails"] as const) {
      const r = release({ npmHas: true, regHas: true, gitHead });
      expect(r.status, gitHead).not.toBe(0);
      expect(r.bundle, gitHead).toBe(false);
      expect(r.out, gitHead).toContain("does not say which commit");
    }
  });

  it("a resume whose npm cannot name its commit still finishes the registry, packing nothing", () => {
    for (const gitHead of ["none", "fails"] as const) {
      const r = release({ npmHas: true, gitHead });
      expect(r.status, gitHead + r.out).toBe(0);
      expect(r.registryPublished, gitHead).toBe(true);
      expect(r.bundle, gitHead).toBe(false);
      expect(r.out, gitHead).toContain("not packing");
    }
  });

  it("a pack that fails on a fresh release stops before npm, saying why, with dev dependencies restored", () => {
    const r = release({ packFails: true });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("could not pack");
    expect(r.npmPublished).toBe(false);
    expect(r.calls.filter((c) => c === "npm ci")).toHaveLength(1);
  });

  it("a failed restore after a good pack stops a fresh release before npm, saying why and what to run", () => {
    const r = release({ restoreFails: true });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("could not restore dev dependencies");
    expect(r.out).toContain("run 'npm ci', then 'npm run release -- --yes'");
    expect(r.npmPublished).toBe(false);
  });

  it("a failed restore after a good pack does not stop a resume from finishing the registry", () => {
    const r = release({ npmHas: true, restoreFails: true });
    expect(r.status, r.out).toBe(0);
    expect(r.registryPublished && r.bundle).toBe(true);
    expect(r.out).toContain("could not restore dev dependencies");
  });

  it("an empty bundle is a failed pack", () => {
    const r = release({ emptyBundle: true });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("could not pack");
    expect(r.npmPublished).toBe(false);
  });

  it("a pack that fails on a resume still finishes the registry, with dev dependencies restored", () => {
    const r = release({ npmHas: true, packFails: true });
    expect(r.status, r.out).toBe(0);
    expect(r.calls.filter((c) => c === "npm ci")).toHaveLength(1);
    expect(r.registryPublished).toBe(true);
    expect(r.bundle).toBe(false);
    expect(r.out).toContain("could not pack");
  });

  it("a resume with code newer than npm's still finishes the registry, but packs no mismatched bundle", () => {
    const r = release({ npmHas: true, codeSincePublished: true });
    expect(r.status, r.out).toBe(0);
    expect(r.registryPublished).toBe(true);
    expect(r.bundle).toBe(false);
    expect(r.out).toContain("not packing");
  });

  it("a dry run says it would not pack when the real run would not", () => {
    const r = release({ npmHas: true, codeSincePublished: true, dry: true });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("would NOT pack");
    expect(r.out).not.toMatch(/would pack /);
    expect(r.out).toContain("- MCP registry");
  });

  it("without gh, a terminal is enough: no saved registry token is needed", () => {
    const r = release({ npmHas: true, ghLogin: null, tty: true });
    expect(r.status, r.out).toBe(0);
    expect(r.registryPublished).toBe(true);
  });

  it("a fresh release still needs the npm login", () => {
    const r = release({ whoamiFails: true });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("not logged in to npm");
    expect(r.npmPublished).toBe(false);
  });

  it("half-published after every try, says to run it again, as it was run", () => {
    const r = release({ publishFails: true });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("HALF-PUBLISHED");
    expect(r.out).toContain("npm run release -- --yes");
    expect(r.out).not.toMatch(/Do NOT re-run/);
    expect(r.calls.filter((c) => c === "mcp-publisher publish")).toHaveLength(5);
  });
});
