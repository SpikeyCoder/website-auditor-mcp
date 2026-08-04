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

command -v mcp-publisher >/dev/null 2>&1 \
  || die "mcp-publisher is not installed. Without it the registry step cannot run, and publishing to npm alone is exactly the failure this script exists to prevent."
ok "mcp-publisher present"

# Already published? Publishing is irreversible, so refuse rather than error out
# halfway. Each channel is reported separately: one may legitimately be ahead if
# a previous run failed partway.
if npm view "${PKG_NAME}@${VERSION}" version >/dev/null 2>&1; then
  NPM_HAS=1; ok "npm already has ${VERSION}"
else
  NPM_HAS=0; ok "npm does not have ${VERSION} yet"
fi

REG_URL="https://registry.modelcontextprotocol.io/v0/servers?search=${PKG_NAME}&limit=100"
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
    printf '\n\033[31mHALF-PUBLISHED.\033[0m npm has %s; the registry does NOT.\n' "$VERSION" >&2
    printf 'Claude Desktop and directory users will not see this release until you finish:\n\n' >&2
    printf '    mcp-publisher login github\n    mcp-publisher publish\n\n' >&2
    printf 'Do NOT re-run this script — it will abort on "already on npm".\n\n' >&2
    exit 1
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
sleep 3
NPM_LIVE=$(npm view "${PKG_NAME}" version 2>/dev/null || echo "?")
[ "$NPM_LIVE" = "$VERSION" ] && ok "npm latest = ${NPM_LIVE}" || echo "   ! npm latest is ${NPM_LIVE}, expected ${VERSION}"

REG_LIVE=$(curl -fsS --max-time 25 "$REG_URL" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const l=(j.servers||[]).find(x=>((x._meta||{})["io.modelcontextprotocol.registry/official"]||{}).isLatest);console.log(l?((l.server&&l.server.version)||l.version):"?")})' 2>/dev/null || echo "?")
[ "$REG_LIVE" = "$VERSION" ] && ok "registry isLatest = ${REG_LIVE}" || echo "   ! registry isLatest is ${REG_LIVE}, expected ${VERSION}"

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
