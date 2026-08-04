#!/usr/bin/env bash
#
# Publish this server to BOTH channels that matter, in the only order that works.
#
# WHY THIS EXISTS. 1.0.8, 1.0.9 and 1.0.10 went to npm while the MCP registry
# stayed on 1.0.7 and Claude Desktop sat on 1.0.6. Nothing warned anybody: each
# `npm publish` succeeded, and the versions just quietly disagreed. The cost was
# that get_sample_audit (the free, no-key demo), the telemetry that would have
# revealed the gap, and the storefront copy were all invisible to real users for
# days — and the resulting "MCP doesn't convert" reading was an artifact of a
# release process, not of demand.
#
# ORDER IS NOT A PREFERENCE. server.json points the registry entry at a specific
# npm identifier + version, so that npm version must already exist. npm first,
# registry second — always.
#
# THE UNAVOIDABLE RISK, STATED PLAINLY. `npm publish` cannot be undone and a
# version can never be replaced. If the registry step fails after it, you are
# half-published. This script therefore does every check it can BEFORE the
# irreversible step — auth for both channels, version parity, "is this version
# already out", full test suite — so that the common failures happen while
# nothing has shipped. If the registry step still fails, it says exactly how to
# finish, because re-running the whole script would abort on "already on npm".
#
# Usage:
#   npm run release            # prompts before publishing
#   npm run release -- --yes   # no prompt (CI / you already know)
#   npm run release -- --dry-run
#
set -euo pipefail

cd "$(dirname "$0")/.."

YES=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)   YES=1 ;;
    --dry-run)  DRY=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

PKG_NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
BUNDLE="${PKG_NAME}-${VERSION}.mcpb"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mABORT:\033[0m %s\n\n' "$*" >&2; exit 1; }

say "Releasing ${PKG_NAME} ${VERSION}"

# ── Preconditions — everything that can fail cheaply, fails here ──────

say "Preconditions"

[ -z "$(git status --porcelain)" ] || die "working tree is dirty. Commit or stash first — the published artifact must match a commit."
ok "working tree clean"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || die "on '$BRANCH', not main. Release from main so the tag and the artifact agree."
ok "on main"

git fetch origin --quiet
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "local main differs from origin/main. Push or pull first."
ok "in sync with origin/main"

# Six strings have to agree; tests/manifests.test.ts is the authority. A bump
# once left the manifests behind at 1.0.7 while the code said otherwise.
npx vitest run tests/manifests.test.ts >/dev/null 2>&1 \
  || die "version strings disagree across package.json / package-lock / manifest.json / server.json / src/version.ts. Run: npx vitest run tests/manifests.test.ts"
ok "all six version strings agree on ${VERSION}"

# Auth for BOTH channels, checked before either publish.
npm whoami >/dev/null 2>&1 || die "not logged in to npm. Run: npm login"
ok "npm authenticated as $(npm whoami 2>/dev/null)"

# Being logged in is NOT the same as being able to publish. With 2FA set to
# "auth-and-writes", npm demands a one-time password at publish time via a
# browser flow — which cannot be satisfied from a non-interactive shell. The
# first run of this script sailed past a green "npm authenticated" check,
# rebuilt everything, and only failed at EOTP after the tarball was packed.
# Cheap to detect, so detect it.
TFA=$(npm profile get "two-factor auth" 2>/dev/null || echo "unknown")
case "$TFA" in
  *writes*)
    if [ -t 0 ]; then
      ok "npm 2FA is '${TFA}' — you will be prompted for a one-time password"
    else
      die "npm 2FA is '${TFA}', so publishing needs a one-time password, and this shell is not interactive (no TTY). Run 'npm run release' from a terminal you can type into. Nothing has been published."
    fi ;;
  unknown)
    # Network or auth hiccup reading the profile. Not worth blocking a release
    # over: npm itself will still demand the OTP if one is required.
    echo "   ! could not read npm 2FA setting; continuing" ;;
  *)
    ok "npm 2FA is '${TFA}' — no OTP prompt expected" ;;
esac

command -v mcp-publisher >/dev/null 2>&1 \
  || die "mcp-publisher is not installed. Without it the registry step cannot run, and publishing to npm alone is exactly the failure this script exists to prevent."
ok "mcp-publisher present"

# Installed is not the same as authenticated, either. mcp-publisher has no
# whoami, so the token file is the only signal available. Checked BEFORE the
# npm publish, because discovering it afterwards is precisely the
# half-published state this script exists to avoid.
MCP_TOKEN="${XDG_CONFIG_HOME:-$HOME/.config}/mcp-publisher/token.json"
[ -s "$MCP_TOKEN" ] \
  || die "mcp-publisher has no saved credentials at ${MCP_TOKEN}. Run: mcp-publisher login github  — checked here rather than after npm, because npm cannot be un-published."

# PRESENT IS NOT THE SAME AS VALID. Registry tokens are short-lived JWTs, and
# an expired one is what actually caused the 1.0.11 release to go out to npm
# and stop: the file was there, the precondition passed, npm published
# irreversibly, and only then did the registry reject the stale credential.
# The exp claim is right there in the token, so read it.
#
# A 5-minute floor, not zero: the steps between here and the registry publish
# (typecheck, full suite, build, npm publish, OTP) take minutes, so a token
# valid "right now" can still be dead by the time it is used.
# NB: no top-level `return` here — node -e does not wrap the script in a
# function, so `return` is a parse error and the whole check silently degrades
# to "opaque". It did exactly that on the first attempt.
TOKEN_STATE=$(node -e '
  const fs = require("fs");
  let out = "opaque";
  try {
    const t = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const parts = (t.token || "").split(".");
    if (parts.length === 3) {
      const c = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      if (c.exp) {
        const left = Math.floor((c.exp * 1000 - Date.now()) / 1000);
        out = left <= 0 ? "expired" : (left < 300 ? "expiring:" + left : "valid:" + left);
      }
    }
  } catch (e) { /* opaque */ }
  console.log(out);
' "$MCP_TOKEN" 2>/dev/null || echo "opaque")

case "$TOKEN_STATE" in
  expired)
    die "the mcp-publisher token has EXPIRED. Run: mcp-publisher login github — caught before npm, because an expired registry token is exactly what half-published 1.0.11." ;;
  expiring:*)
    die "the mcp-publisher token expires in ${TOKEN_STATE#expiring:}s, which will not survive the test run, build, npm publish and OTP prompt ahead of it. Refresh it first: mcp-publisher login github" ;;
  valid:*)
    ok "mcp-publisher token valid for $(( ${TOKEN_STATE#valid:} / 60 )) more minutes" ;;
  *)
    ok "mcp-publisher token present (expiry not readable)" ;;
esac

# Already published? Publishing is irreversible, so refuse rather than error out
# halfway. Each channel is reported separately: one may legitimately be ahead if
# a previous run failed partway.
if npm view "${PKG_NAME}@${VERSION}" version >/dev/null 2>&1; then
  NPM_HAS=1; ok "npm already has ${VERSION}"
else
  NPM_HAS=0; ok "npm does not have ${VERSION} yet"
fi

REG_URL="https://registry.modelcontextprotocol.io/v0/servers?search=${PKG_NAME}&limit=100"

# THE REGISTRY INDEXES ASYNCHRONOUSLY. A publish can succeed and still not be
# visible to a read a second later — which is exactly how a successful 1.0.11
# release was misreported as HALF-PUBLISHED, and then republished on the
# strength of that stale read. Every registry read therefore retries.
#
# registry_has <version>   -> 0 if that version exists at all
# registry_latest          -> prints the isLatest version, or "?"
registry_has() {
  curl -fsS --max-time 25 "$REG_URL" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1];let j;try{j=JSON.parse(s)}catch(e){process.exit(2)}const hit=(j.servers||[]).some(x=>(((x.server&&x.server.version)||x.version)===v));process.exit(hit?0:1)})' "$1"
}
registry_latest() {
  curl -fsS --max-time 25 "$REG_URL" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch(e){return console.log("?")}const l=(j.servers||[]).find(x=>((x._meta||{})["io.modelcontextprotocol.registry/official"]||{}).isLatest);console.log(l?((l.server&&l.server.version)||l.version):"?")})' \
    || echo "?"
}
# Poll until <version> appears, or give up. Backs off 2,4,8,16,30,30... seconds.
await_registry() {
  local want="$1" tries="${2:-6}" delay=2 i=1
  while [ "$i" -le "$tries" ]; do
    if registry_has "$want"; then return 0; fi
    printf '   … not indexed yet, retrying in %ss (%d/%d)\n' "$delay" "$i" "$tries"
    sleep "$delay"
    delay=$(( delay * 2 )); [ "$delay" -gt 30 ] && delay=30
    i=$(( i + 1 ))
  done
  return 1
}

if curl -fsS --max-time 25 "$REG_URL" 2>/dev/null \
     | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1];const j=JSON.parse(s);const hit=(j.servers||[]).some(x=>((x.server&&x.server.version)||x.version)===v);process.exit(hit?0:1)})' "$VERSION"; then
  REG_HAS=1; ok "registry already has ${VERSION}"
else
  REG_HAS=0; ok "registry does not have ${VERSION} yet"
fi

if [ "$NPM_HAS" = 1 ] && [ "$REG_HAS" = 1 ]; then
  die "${VERSION} is already published to both channels. Bump the version first."
fi

# ── Verify the build before anything irreversible ─────────────────────

say "Verifying"
npm run typecheck
npx vitest run
ok "typecheck + full suite green"

npm run build >/dev/null
ok "dist built"

if [ "$DRY" = 1 ]; then
  say "Dry run — stopping before publish"
  echo "   would publish ${VERSION} to:"
  [ "$NPM_HAS" = 0 ] && echo "     - npm"
  [ "$REG_HAS" = 0 ] && echo "     - MCP registry"
  exit 0
fi

if [ "$YES" != 1 ]; then
  printf '\n\033[33mPublishing %s is IRREVERSIBLE — an npm version can never be replaced.\033[0m\n' "$VERSION"
  printf 'Type the version to confirm: '
  read -r CONFIRM
  [ "$CONFIRM" = "$VERSION" ] || die "confirmation did not match; nothing was published."
fi

# ── 1. npm — must be first; the registry entry references it ──────────

if [ "$NPM_HAS" = 0 ]; then
  say "Publishing to npm"
  # prepublishOnly re-runs typecheck + tests; it is the last gate on the
  # irreversible action and is deliberately not bypassed.
  npm publish
  ok "npm now has ${VERSION}"
else
  say "Skipping npm (already published)"
fi

# ── 2. MCP registry — the step that was missed three releases running ─

if [ "$REG_HAS" = 0 ]; then
  say "Publishing to the MCP registry"
  if ! mcp-publisher publish; then
    # A non-zero exit is NOT proof the publish failed. The registry indexes
    # asynchronously, and the CLI can report an error on a request that landed
    # (or that raced a concurrent publish). Confirm against the registry before
    # accusing it of anything — the previous version of this branch declared a
    # SUCCESSFUL 1.0.11 release half-published, which is how it then got
    # republished on top of itself.
    printf '   publish reported an error — confirming against the registry\n'
    if await_registry "$VERSION" 5; then
      ok "registry has ${VERSION} after all — the error was not fatal"
    else
    printf '\n\033[31mHALF-PUBLISHED.\033[0m npm has %s; the registry does NOT.\n' "$VERSION" >&2
    printf 'Claude Desktop and directory users will not see this release until you finish:\n\n' >&2
    printf '    mcp-publisher login github\n    mcp-publisher publish\n\n' >&2
    printf 'Do NOT re-run this script — it will abort on "already on npm".\n\n' >&2
    exit 1
    fi
  fi
  ok "registry now has ${VERSION}"
else
  say "Skipping registry (already published)"
fi

# ── 3. The .mcpb bundle, for the GitHub release ───────────────────────
#
# Packed from PRODUCTION dependencies only. A naive pack after a dev install
# produces a ~30MB / 2500-file bundle with vitest and typescript inside, versus
# ~2.6MB pruned. The pack step itself gives no warning.

say "Packing the .mcpb bundle"
rm -f "$BUNDLE" "${PKG_NAME}.mcpb"
npm ci --omit=dev >/dev/null 2>&1
npx --yes @anthropic-ai/mcpb pack . >/dev/null
mv "${PKG_NAME}.mcpb" "$BUNDLE"
npm ci >/dev/null 2>&1   # restore dev deps so the tree is usable again
ok "$BUNDLE ($(du -h "$BUNDLE" | cut -f1))"

# ── 4. Confirm it actually landed ─────────────────────────────────────
#
# Checked rather than assumed: every failure in this thread looked like success
# from the publishing side.

say "Verifying both channels"

# Both registries are eventually consistent, so a single read proves nothing.
# The old code slept 3s and read once; that is what produced a false negative.
NPM_LIVE="?"
for i in 1 2 3 4 5; do
  NPM_LIVE=$(npm view "${PKG_NAME}" version 2>/dev/null || echo "?")
  [ "$NPM_LIVE" = "$VERSION" ] && break
  printf '   … npm still shows %s, retrying (%d/5)\n' "$NPM_LIVE" "$i"
  sleep $(( i * 2 ))
done
[ "$NPM_LIVE" = "$VERSION" ] && ok "npm latest = ${NPM_LIVE}" || echo "   ! npm latest is ${NPM_LIVE}, expected ${VERSION}"

# Presence first (that is what "did it publish" means), then isLatest, which
# the registry may flip a moment later.
if await_registry "$VERSION" 6; then
  ok "registry has ${VERSION}"
  REG_LIVE=$(registry_latest)
  [ "$REG_LIVE" = "$VERSION" ] \
    && ok "registry isLatest = ${REG_LIVE}" \
    || echo "   ! registry has ${VERSION} but isLatest is ${REG_LIVE} — usually just indexing lag; re-check before acting"
else
  echo "   ! registry does not show ${VERSION} yet after retries — re-check before republishing, it may still be indexing"
fi

cat <<NEXT

$(printf '\033[1m== Remaining, by hand\033[0m')

   gh release create v${VERSION} ${BUNDLE} --title "v${VERSION}"

   Then confirm the release REACHED someone, which is the check that would
   have caught the 1.0.6 situation — publishing is not the same as arriving:

     select server_version, count(*) from mcp_events
      where created_at > now() - interval '1 day' group by 1;

   Until a real client reports ${VERSION}, this release has reached nobody.
   The Claude Desktop directory has lagged the registry even after a
   successful publish; installing ${BUNDLE} from Settings -> Extensions
   bypasses it and verifies the build end to end.

NEXT
