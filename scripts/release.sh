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
# nothing has shipped. If the registry step still fails after its retries,
# running the script again resumes: it skips npm when npm already has the
# version, and finishes the bundle and the registry.
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

# shellcheck source=scripts/release-lib.sh
. scripts/release-lib.sh   # the cd above made the repo root the working directory

RERUN=$(release_rerun_hint "$YES")   # how to run this again, as it was run

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

# Seven strings have to agree; tests/manifests.test.ts is the authority. A bump
# once left the manifests behind at 1.0.7 while the code said otherwise.
npx vitest run tests/manifests.test.ts >/dev/null 2>&1 \
  || die "version strings disagree across package.json / package-lock / manifest.json / server.json / src/version.ts. Run: npx vitest run tests/manifests.test.ts"
ok "all seven version strings agree on ${VERSION}"

# ── What is already published ─────────────────────────────────────────
#
# Known before the credential checks, because only the steps still to do
# need credentials: a resume (npm has it) needs no npm login or OTP, and a
# run that only packs the bundle (both have it) needs none at all. npm's
# own login lapses (about two hours), so demanding it anyway stopped the
# very re-run the HALF-PUBLISHED message asks for.

# Publishing is irreversible, so npm is never published twice.
if npm view "${PKG_NAME}@${VERSION}" version >/dev/null 2>&1; then
  NPM_HAS=1
else
  NPM_HAS=0
fi

# Each channel is reported separately: one may legitimately be ahead if a
# previous run failed partway.
if [ "$NPM_HAS" = 1 ]; then
  ok "npm already has ${VERSION}"
else
  ok "npm does not have ${VERSION} yet"
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

# Auth for BOTH channels, checked before either publish.
if [ "$NPM_HAS" = 0 ]; then
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
else
  ok "npm already has ${VERSION}: npm is skipped, so no npm login is needed"
fi   # NPM_HAS = 0

if [ "$REG_HAS" = 0 ]; then
command -v mcp-publisher >/dev/null 2>&1 \
  || die "mcp-publisher is not installed. Without it the registry step cannot run, and publishing to npm alone is exactly the failure this script exists to prevent."
ok "mcp-publisher present"

# REGISTRY CREDENTIALS COME FROM THE gh LOGIN when there is one (1.0.25,
# 2026-09-26). The registry issues tokens that live 300s, so a token minted at
# the start is dead by the end, and every retry used to mean another GitHub
# device-flow prompt. With gh logged in, release_mint_token mints a fresh one
# from it, with no prompt, right before each publish attempt.
GH_MINT=0
if command -v gh >/dev/null 2>&1 && gh auth token >/dev/null 2>&1; then
  GH_MINT=1
  # The registry issues a token to ANY GitHub account, for io.github.<login>/*;
  # whether that covers this server's namespace is only checked by the publish,
  # after npm. So check the account here, against mcpName.
  NS_OWNER=$(node -p "(require('./package.json').mcpName || '').split('/')[0].replace(/^io\.github\./, '')")
  GH_LOGIN=$(gh api user --jq .login 2>/dev/null || true)
  [ -n "$GH_LOGIN" ] \
    || die "could not read which GitHub account gh is logged in as ('gh api user'). Check 'gh auth status'. Nothing was published by this run."
  [ "$(printf '%s' "$GH_LOGIN" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$NS_OWNER" | tr '[:upper:]' '[:lower:]')" ] \
    || die "gh is logged in as ${GH_LOGIN}, but the registry namespace io.github.${NS_OWNER} belongs to ${NS_OWNER}, so the registry would refuse the publish after npm had shipped. Run 'gh auth switch' (or unset GH_TOKEN / GITHUB_TOKEN). Nothing was published by this run."
  # And mint once, which needs no prompt now: an outage or a token the
  # registry will not exchange fails here, while nothing has shipped.
  release_mint_token \
    || die "the MCP registry would not issue a token for the gh login (${GH_LOGIN}). Nothing was published by this run."
  ok "registry tokens are minted from the gh login (${GH_LOGIN}, owner of io.github.${NS_OWNER})"
fi

if [ "$GH_MINT" = 0 ]; then
# Without gh, each registry attempt mints its token by the GitHub device flow
# (release_mint_token), which needs a terminal and nothing on disk. The saved
# token is only read to word the line below; it used to be required, though
# nothing used it, which blocked runs that would have succeeded.
MCP_TOKEN="${XDG_CONFIG_HOME:-$HOME/.config}/mcp-publisher/token.json"

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
# So the registry step mints a fresh token before every attempt
# (release_publish_registry in release-lib.sh) and never reads the one on
# disk. What stays here is the check that belongs in preconditions: can a
# token be minted when the time comes (a terminal for the device flow).
# The expiry below only words an informational line.
#
# NB: no top-level `return` in the node snippet — node -e does not wrap the
# script in a function, so `return` is a parse error and the whole check
# silently degrades to "opaque". It did exactly that on the first attempt.
#
# REGISTRY_PUBLISH_FLOOR only decides whether the informational line below
# calls the token on disk fresh or stale. It stays below the 300s issued
# lifetime so that a token minted moments ago reads as fresh.
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
      ok "mcp-publisher token is stale — a fresh one is minted before each registry attempt" ;;
    valid:*)
      ok "mcp-publisher token has $(( ${TOKEN_STATE#valid:} ))s left (a fresh one is minted before each registry attempt anyway)" ;;
    *)
      ok "no readable saved registry token — one is minted (GitHub device flow) before each registry attempt" ;;
  esac
else
  # No TTY: `mcp-publisher login github` cannot run, and there is no gh login
  # to mint from, so the registry step could never get a token: release-lib's
  # release_mint_token refuses this case. Stop while nothing has shipped,
  # whatever the token on disk says (it lives 300s; a release outlasts it).
  die "no gh login and no terminal, so no registry token can be minted for the registry step. Run 'gh auth login' so tokens are minted without a prompt, or run 'npm run release' from a terminal you can type into. Nothing was published by this run." 
fi
fi   # GH_MINT = 0
else
  ok "the registry already has ${VERSION}: no registry credentials are needed"
fi   # REG_HAS = 0



# The .mcpb must hold what npm has for this version. When npm already has it
# (a resume, or a run that only packs), compare the files that decide what the
# bundle runs and shows (the code, the manifests, the lockfile, tsconfig,
# README, LICENSE, the icon, and .mcpbignore, which decides what goes in) with
# the commit npm published from (npm view … gitHead). Other files the bundle
# happens to carry (scripts/, RELEASING.md, …) are never run and not compared.
# Without this,
# code merged since then (#81-#84 landed after 1.0.24) would be packed under
# the old version's name. Fails closed: if npm cannot say which
# commit it was, nothing is packed.
PACK=1
PUBLISHED_HEAD=""
if [ "$NPM_HAS" = 1 ]; then
  PUBLISHED_HEAD=$(npm view "${PKG_NAME}@${VERSION}" gitHead 2>/dev/null) || PUBLISHED_HEAD=""
  if [ -z "$PUBLISHED_HEAD" ]; then
    PACK=0
    PACK_WHY="npm does not say which commit ${VERSION} was published from"
  elif ! git cat-file -e "${PUBLISHED_HEAD}^{commit}" 2>/dev/null \
       || ! git diff --quiet "$PUBLISHED_HEAD" HEAD -- src manifest.json package.json package-lock.json tsconfig.json README.md LICENSE icon.png .mcpbignore; then
    PACK=0
    PACK_WHY="HEAD's code, manifests or bundle files differ from the commit npm published ${VERSION} from (${PUBLISHED_HEAD:0:7})"
  fi
fi

# Both channels have it: nothing to publish, but the .mcpb for the GitHub
# release may still be missing (1.0.25's run stopped before packing it), so
# pack that and stop. To release new code, bump the version first.
BUNDLE_ONLY=0
if [ "$NPM_HAS" = 1 ] && [ "$REG_HAS" = 1 ]; then
  [ "$PACK" = 1 ] \
    || die "${PACK_WHY}, so a bundle packed here might not be ${VERSION}. To release this code, bump the version first. Nothing was published by this run."
  BUNDLE_ONLY=1
  ok "${VERSION} is already on npm and the registry: packing the .mcpb for the GitHub release only (to release new code, bump the version first)"
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
  if [ "$PACK" = 1 ]; then
    echo "   would pack ${BUNDLE}"
  else
    echo "   would NOT pack the .mcpb: ${PACK_WHY}"
  fi
  [ "$BUNDLE_ONLY" = 1 ] || echo "   would publish ${VERSION} to:"
  [ "$NPM_HAS" = 0 ] && echo "     - npm"
  [ "$REG_HAS" = 0 ] && echo "     - MCP registry"
  exit 0
fi

if [ "$YES" != 1 ] && [ "$BUNDLE_ONLY" = 0 ]; then
  [ -t 0 ] || die "no terminal to confirm at. Run '${RERUN}' to publish without the prompt. Nothing was published by this run."
  if [ "$NPM_HAS" = 1 ]; then
    printf '\nnpm already has %s and is skipped; publishing it to the MCP registry is next.\n' "$VERSION"
  else
    printf '\n\033[33mPublishing %s is IRREVERSIBLE — an npm version can never be replaced.\033[0m\n' "$VERSION"
  fi
  printf 'Type the version to confirm: '
  read -r CONFIRM || die "no confirmation read. Nothing was published by this run."
  [ "$CONFIRM" = "$VERSION" ] || die "confirmation did not match; nothing was published."
fi

# ── 1. The .mcpb bundle, for the GitHub release ───────────────────────
#
# Packed FIRST: it is local and reversible, and packing it last meant a failed
# registry step lost it too (1.0.25).
#
# Packed from PRODUCTION dependencies only. A naive pack after a dev install
# produces a ~30MB / 2500-file bundle with vitest and typescript inside, versus
# ~2.6MB pruned. The pack step itself gives no warning.

# A pack that fails stops a fresh release here, before npm, with the dev
# dependencies put back; so does a restore that fails after a good pack,
# because npm publish's prepublishOnly (typecheck + tests) needs them. On a
# resume the registry needs neither, so the run goes on to finish it.
# mcpb names its output after the directory it packs unless told otherwise,
# so the output path is passed (a checkout under another name broke the old mv).
pack_bundle() {
  rm -f "$BUNDLE"
  npm ci --omit=dev >/dev/null \
    && npx --yes @anthropic-ai/mcpb pack . "$BUNDLE" >/dev/null \
    && [ -s "$BUNDLE" ]
}
restore_dev_deps() {
  npm ci >/dev/null && return 0
  [ "$NPM_HAS" = 1 ] \
    || die "could not restore dev dependencies (npm ci), which npm publish's checks need. Nothing was published by this run; run 'npm ci', then '${RERUN}'."
  echo "   ! could not restore dev dependencies (npm ci); run 'npm ci' after this. Going on to the registry, which does not need them"
}
if [ "$PACK" = 1 ]; then
  say "Packing the .mcpb bundle"
  if pack_bundle; then
    restore_dev_deps
    ok "$BUNDLE ($(du -h "$BUNDLE" | cut -f1))"
  else
    PACK=0
    PACK_WHY="could not pack the .mcpb (npm ci --omit=dev or mcpb pack failed; see above)"
    restore_dev_deps
    [ "$NPM_HAS" = 1 ] \
      || die "${PACK_WHY}. Nothing was published by this run; run '${RERUN}' again."
    echo "   ! ${PACK_WHY}; going on to the registry, which does not need it"
  fi
else
  echo "   ! not packing the .mcpb: ${PACK_WHY}. Pack it from the commit npm published ${VERSION} from (RELEASING.md step 3) for the GitHub release."
fi

# ── 2. npm — before the registry; the registry entry references it ────

if [ "$NPM_HAS" = 0 ]; then
  say "Publishing to npm"
  # prepublishOnly re-runs typecheck + tests; it is the last gate on the
  # irreversible action and is deliberately not bypassed.
  npm publish
  ok "npm now has ${VERSION}"
else
  say "Skipping npm (already published)"
fi

# ── 3. MCP registry — the step that was missed three releases running ─
#
# The registry validates a publish against npm, so npm must SERVE the version
# first; right after `npm publish` it may not (1.0.25 was refused with "version
# '1.0.25' was not found"). Then the publish is tried up to five times, each
# with a token freshly minted (release-lib.sh).

if [ "$REG_HAS" = 0 ]; then
  say "Publishing to the MCP registry"
  release_await_npm "$PKG_NAME" "$VERSION" 10 \
    || die "npm still does not serve ${PKG_NAME}@${VERSION}, so the registry would refuse it. npm HAS it published; when https://registry.npmjs.org/${PKG_NAME}/${VERSION} answers, run '${RERUN}' again: it skips npm and finishes the registry."
  ok "npm serves ${VERSION}"

  if ! release_publish_registry 5; then
    # A non-zero exit is NOT proof the publish failed. The registry indexes
    # asynchronously, and the CLI can report an error on a request that landed.
    # Confirm against the registry before calling it half-published (a
    # successful 1.0.11 was once republished on top of itself that way).
    printf '   the registry step failed — confirming against the registry\n'
    if await_registry "$VERSION" 5; then
      ok "registry has ${VERSION} after all — the error was not fatal"
    else
      printf '\n\033[31mHALF-PUBLISHED.\033[0m npm has %s; the registry does NOT.\n' "$VERSION" >&2
      printf 'Claude Desktop and directory users will not see this release until it is finished.\n' >&2
      printf 'Run it again — it skips npm, which already has %s, and finishes the registry:\n\n' "$VERSION" >&2
      printf '    %s\n\n' "$RERUN" >&2
      exit 1
    fi
  fi
  ok "registry now has ${VERSION}"
else
  say "Skipping registry (already published)"
fi

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

[ "$PACK" = 1 ] \
  || printf '\n   ! %s was not packed by this run (%s): pack it from the commit npm published %s from before the GitHub release.\n' "$BUNDLE" "$PACK_WHY" "$VERSION"

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
