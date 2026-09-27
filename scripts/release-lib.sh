# The steps of scripts/release.sh that talk to the outside world, kept apart
# so tests/releaseFinishesWhatItStarts.test.ts can drive them against stubs.
# Sourced, never run. Each returns non-zero rather than exiting, so the caller
# decides what a failure means.
#
# Why they exist (1.0.25, 2026-09-26): npm published, and the MCP registry,
# asked in the same breath, answered 400 "NPM package exists, but version
# '1.0.25' was not found". npm had not served it yet. One attempt, then a
# HALF-PUBLISHED exit, and no .mcpb.

# Seconds are multiplied by this; tests set it to 0.
RELEASE_BACKOFF_SCALE="${RELEASE_BACKOFF_SCALE:-1}"

release_sleep() { sleep $(( $1 * RELEASE_BACKOFF_SCALE )); }

# How to run the release again, as this run was run: <yes> is 1 for --yes. A
# terminal without --yes keeps the confirm prompt; a shell with no terminal
# cannot answer it, so it needs --yes.
release_rerun_hint() {
  if [ "$1" = 1 ] || [ ! -t 0 ]; then echo "npm run release -- --yes"; else echo "npm run release"; fi
}

# Mint a registry token. The registry issues tokens that live 300s, so one
# minted at the start of a release is dead by the end of it. Minting from the
# gh CLI's stored GitHub login needs no prompt, so it can happen right before
# every publish attempt. Without gh, the device flow needs a terminal.
# The GitHub token reaches mcp-publisher through MCP_GITHUB_TOKEN, which it
# reads when --token is not given, so it never sits in the process list; it is
# never printed, and is masked out of any error shown.
# Returns 2 when minting is impossible here (no gh, no terminal), which no
# retry can fix; 1 when an attempt failed.
release_mint_token() {
  local gh_token out xtrace=0
  # Never under xtrace: bash -x would print the token three times over.
  case $- in *x*) xtrace=1; set +x ;; esac
  release_mint_token_inner; local rc=$?
  [ "$xtrace" = 1 ] && set -x
  return "$rc"
}

release_mint_token_inner() {
  local gh_token out
  if command -v gh >/dev/null 2>&1 && gh_token=$(gh auth token 2>/dev/null) && [ -n "$gh_token" ]; then
    if out=$(MCP_GITHUB_TOKEN="$gh_token" mcp-publisher login github 2>&1); then
      return 0
    fi
    printf '   ! could not mint a registry token: %s\n' "${out//"$gh_token"/***}" >&2
    return 1
  fi
  if [ -t 0 ]; then
    mcp-publisher login github
    return
  fi
  printf '   ! no gh login to mint a registry token from, and no terminal for the GitHub device flow\n' >&2
  return 2
}

# Wait until npm serves <pkg>@<version>: the registry checks npm when it
# validates a publish, and npm takes a moment to serve a new version.
# Backs off 2, 4, 8, 16, 30, 30... seconds.
release_await_npm() {
  local pkg="$1" version="$2" tries="${3:-10}" delay=2 i=1
  while [ "$i" -le "$tries" ]; do
    if curl -fsS --max-time 20 -o /dev/null "https://registry.npmjs.org/${pkg}/${version}" 2>/dev/null; then
      return 0
    fi
    if [ "$i" -lt "$tries" ]; then
      printf '   … npm does not serve %s@%s yet, retrying in %ss (%d/%d)\n' "$pkg" "$version" "$delay" "$i" "$tries"
      release_sleep "$delay"
      delay=$(( delay * 2 )); [ "$delay" -gt 30 ] && delay=30
    else
      printf '   … npm does not serve %s@%s yet (%d/%d)\n' "$pkg" "$version" "$i" "$tries"
    fi
    i=$(( i + 1 ))
  done
  return 1
}

# Publish server.json to the MCP registry, minting a fresh token before each
# attempt and backing off between them (5, 10, 20, 30... seconds). A failed
# mint is a failed attempt like a refused publish; only "cannot mint here at
# all" stops at once.
release_publish_registry() {
  local tries="${1:-5}" delay=5 i=1 minted what
  while [ "$i" -le "$tries" ]; do
    minted=0; release_mint_token || minted=$?
    [ "$minted" = 2 ] && return 1
    if [ "$minted" = 0 ]; then
      mcp-publisher publish && return 0
      what="the registry refused the publish"
    else
      what="could not mint a registry token"
    fi
    if [ "$i" -lt "$tries" ]; then
      printf '   … %s, retrying in %ss (%d/%d)\n' "$what" "$delay" "$i" "$tries"
      release_sleep "$delay"
      delay=$(( delay * 2 )); [ "$delay" -gt 30 ] && delay=30
    else
      printf '   … %s (%d/%d)\n' "$what" "$i" "$tries"
    fi
    i=$(( i + 1 ))
  done
  return 1
}
