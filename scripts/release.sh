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
# an expired one is what caused the 1.0.11 release to go out to npm and stop:
# the file was there, the precondition passed, npm published irreversibly, and
# only then did the registry reject the stale credential.
#
# THE 5-MINUTE FLOOR THAT USED TO LIVE HERE WAS UNSATISFIABLE. Measured against
# a real token: exp - iat = 300 seconds. The issued lifetime IS five minutes, so
# a gate demanding 300s remaining could only pass in the zeroth second after
# login. Every run aborted, and "refresh it first" could not help — a brand-new
# token is already only 300s. Do not reintroduce a floor at or near 300.
#
# The deeper problem is that NO token can survive this script. Typecheck, the
# full suite, the build, npm publish and an OTP prompt take well over five
# minutes, so freshness at the top says nothing about validity at the bottom.
# Checking earlier cannot fix that; only checking LATER can.
#
# So the expiry test moved to just before the registry publish (see the
# just-in-time refresh below), where a fresh 300s token has one command to
# survive instead of an entire release. What stays here is the check that
# actually belongs in preconditions: has this machine ever authenticated, and
# can it re-authenticate when the time comes.
#
# NB: no top-level `return` in the node snippet — node -e does not wrap the
# script in a function, so `return` is a parse error and the whole check
# silently degrades to "opaque". It did exactly that on the first attempt.
#
# REGISTRY_PUBLISH_FLOOR is the margin the registry publish itself needs: one
# HTTPS request, seconds not minutes. It is deliberately far below the 300s
# issued lifetime so that a token minted moments ago reads as usable.
REGISTRY_PUBLISH_FLOOR=90

# Self-check, because getting this wrong is silent and total: a floor at or
# above the 300s issued lifetime makes every run abort with "refresh it first",
# and refreshing cannot help. That shipped once and blocked releases outright.
TOKEN_ISSUED_LIFETIME=300
[ "$REGISTRY_PUBLISH_FLOOR" -lt "$TOKEN_ISSUED_LIFETIME" ] \
  || die "release.sh bug: REGISTRY_PUBLISH_FLOOR (${REGISTRY_PUBLISH_FLOOR}s) is >= the ${TOKEN_ISSUED_LIFETIME}s a registry token is issued with, so no token can ever satisfy it and every release will abort. Lower the floor."

token_state() {
  node -e '
    const fs = require("fs");
    let out = "opaque";
    try {
      const t = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const parts = (t.token || "").split(".");
      if (parts.length === 3) {
        const c = JSON.parse(Buffer.from(parts[1], "base64url").toString());
        if (c.exp) {
          const left = Math.floor((c.exp * 1000 - Date.now()) / 1000);
          const floor = Number(process.argv[2]);
          out = left <= 0 ? "expired" : (left < floor ? "expiring:" + left : "valid:" + left);
        }
      }
    } catch (e) { /* opaque */ }
    console.log(out);
  ' "$MCP_TOKEN" "$REGISTRY_PUBLISH_FLOOR" 2>/dev/null || echo "opaque"
}

TOKEN_STATE=$(token_state)

# Expiry here is INFORMATIONAL ONLY. The token will be re-minted just before it
# is used; all that matters now is that re-minting is possible at all, which
# needs a terminal for the GitHub device flow. Catching a headless shell here —
# before npm — is what keeps a missing registry step from becoming a
# half-published release.
if [ -t 0 ]; then
  case "$TOKEN_STATE" in
    expired|expiring:*)
      ok "mcp-publisher token is stale — it will be refreshed just before the registry publish" ;;
    valid:*)
      ok "mcp-publisher token has $(( ${TOKEN_STATE#valid:} ))s left — refreshed later if it runs down" ;;
    *)
      ok "mcp-publisher token present (expiry not readable)" ;;
  esac
else
  # No TTY: `mcp-publisher login github` cannot run, so the token on disk is the
  # only one this release will ever have. Now the old strict floor is the RIGHT
  # test — and it will essentially always fail, which is the honest answer:
  # a five-minute credential cannot survive a ten-minute release unattended.
  case "$TOKEN_STATE" in
    valid:*)
      ok "mcp-publisher token has $(( ${TOKEN_STATE#valid:} ))s left (non-interactive; cannot refresh)" ;;
    *)
      die "the mcp-publisher token is stale and this shell has no TTY, so the GitHub device flow cannot run. Registry tokens live only 300s, so an unattended release effectively cannot hold one. Run 'npm run release' from a terminal you can type into. Nothing has been published." ;;
  esac
fi

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

  # JUST-IN-TIME CREDENTIAL. This is the only place freshness can honestly be
  # asserted. Registry tokens live 300s from issue, and everything above —
  # typecheck, suite, build, npm publish, OTP — reliably outlasts that, so the
  # token checked in preconditions is routinely dead by the time we arrive here.
  # That is precisely how 1.0.11 went out to npm and stopped.
  #
  # Re-minting costs one device-flow prompt and buys a full 300s for a single
  # HTTPS request. npm has already published at this point, so refusing to
  # refresh would strand the release half-done — the exact failure being
  # prevented. Anything short of the floor gets a new token.
  case "$(token_state)" in
    valid:*)
      : ;;  # comfortably alive; publish straight away
    *)
      printf '   registry token is short-lived (300s) and has run down — re-authenticating\n'
      if [ -t 0 ]; then
        mcp-publisher login github \
          || die "mcp-publisher login failed. npm ALREADY HAS ${VERSION}; finish with 'mcp-publisher login github && mcp-publisher publish'. Do NOT re-run this script."
        case "$(token_state)" in
          valid:*) ok "registry token refreshed" ;;
          *) printf '   ! token still reads stale after login; attempting the publish anyway\n' ;;
        esac
      else
        die "the registry token needs refreshing and this shell has no TTY. npm ALREADY HAS ${VERSION}; finish from a terminal with 'mcp-publisher login github && mcp-publisher publish'. Do NOT re-run this script."
      fi ;;
  esac

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
