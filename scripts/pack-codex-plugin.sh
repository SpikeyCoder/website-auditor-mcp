#!/usr/bin/env bash
#
# Build the update for the published ChatGPT/Codex plugin listing:
#
#   npm run pack:codex -- <release.zip | release-dir> [out-dir]
#
# <release.zip>: the portal's own package — open the plugin, select the
# published version, "…" -> Download release ZIP. To change the listing text
# too, unzip it, edit .codex-plugin/plugin.json, and pass the folder: every
# check below then runs on the edited text. Always start from the version
# that is published NOW — a package built on an older release undoes whatever
# came after it. Writes
# website-auditor-codex-plugin-<version>.zip, <version> being
# codex-plugin/.codex-plugin/plugin.json's: the repo's plugin version IS the
# portal version, so every portal version matches a commit. Bump it (above the
# release and above any version the portal has in review) and merge before
# packing.
#
# WHY START FROM THE PORTAL'S PACKAGE (developers.openai.com/plugins/deploy/
# submission, read 2026-10-04). This listing went through the previous
# submission form, and an update must be "a complete ZIP, including all
# components you intend to keep". The portal's package is not codex-plugin/:
# its manifest is named for the portal's app id and carries the portal's
# listing text, and it has no .mcp.json (the server is connected in the
# dashboard) and no assets. So this keeps that package and changes two
# things: skills/ becomes codex-plugin/skills, and the version.
#
# ONLY MERGED SKILLS SHIP. Skills come from HEAD (git archive, so a .DS_Store
# or an unsaved edit cannot ship), and HEAD's skills must equal origin/main's:
# a feature branch's skills never reach the public listing.
#
# WHAT ELSE GOES WHERE. Tool changes need no ZIP: the portal scans the hosted
# server daily (MCPs -> the server -> Issues -> Rescan to hurry). Listing text
# lives in the release's manifest, not in codex-plugin/.codex-plugin/
# plugin.json, and is not rewritten here: to change it, pack from an edited,
# unzipped release (above). Uploading starts a review, and only one review can
# be active.
set -euo pipefail

die() { echo "pack:codex: $*" >&2; exit 1; }
[ $# -ge 1 ] || die "usage: npm run pack:codex -- <release.zip | release-dir> [out-dir]"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${PACK_CODEX_BASE:-origin/main}"   # overridable for the test only
# Relative paths are the caller's: npm runs scripts from the repo root and
# records the caller's directory in INIT_CWD, trusted only when npm ran this.
CALLER="$PWD"
[ "${npm_lifecycle_event:-}" = "pack:codex" ] && CALLER="${INIT_CWD:-$PWD}"
here() { case "$1" in /*) echo "$1" ;; *) echo "$CALLER/$1" ;; esac; }
RELEASE="$(here "$1")"
OUT_DIR="$(here "${2:-.}")"
[ -e "$RELEASE" ] || die "no such file or folder: $RELEASE"

cd "$ROOT"
git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null \
  || die "$BASE is not available: run \`git fetch origin main\`"
git diff --quiet "$BASE" HEAD -- codex-plugin/skills \
  || die "codex-plugin/skills at HEAD differs from $BASE: merge first and pack from main"
if ! git diff --quiet HEAD -- codex-plugin/skills || [ -n "$(git ls-files --others --exclude-standard -- codex-plugin/skills)" ]; then
  echo "warning: codex-plugin/skills has uncommitted changes; packing HEAD without them" >&2
fi
version_at() { git show "$1:codex-plugin/.codex-plugin/plugin.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'; }
VERSION="$(version_at HEAD)"
[ "$VERSION" = "$(version_at "$BASE")" ] \
  || die "codex-plugin version at HEAD ($VERSION) is not $BASE's: merge the bump first and pack from main"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
if [ -d "$RELEASE" ]; then
  mkdir -p "$STAGE/pkg" && cp -R "$RELEASE/." "$STAGE/pkg/"
else
  # unzip exits 1 for warnings on a complete extract; 2 and up are errors.
  rc=0; unzip -q "$RELEASE" -d "$STAGE/pkg" || rc=$?
  [ "$rc" -le 1 ] || die "not a ZIP: $RELEASE"
fi
# Not part of a plugin: OS and editor litter, version control, and an earlier
# output of this script left in the release folder. Removed first, so it
# cannot stop the unwrap below.
find "$STAGE/pkg" \( -name .DS_Store -o -name __MACOSX -o -name '._*' -o -name .git \
  -o -name '*.swp' -o -name '*.swo' -o -name '*~' -o -name 'website-auditor-codex-plugin-*.zip' \) \
  -prune -exec rm -rf {} +
# Finder's Compress (and some unzippers) wrap the package in one folder.
if [ ! -e "$STAGE/pkg/.codex-plugin" ]; then
  inner="$(find "$STAGE/pkg" -mindepth 1 -maxdepth 1)"
  if [ "$(printf '%s\n' "$inner" | grep -c .)" = 1 ] && [ -d "$inner/.codex-plugin" ]; then
    mv "$STAGE/pkg" "$STAGE/wrapped" && mv "$STAGE/wrapped/$(basename "$inner")" "$STAGE/pkg"
  fi
fi
MANIFEST="$STAGE/pkg/.codex-plugin/plugin.json"
[ -f "$MANIFEST" ] || die "$RELEASE has no .codex-plugin/plugin.json: download the release ZIP from the portal"

# Version and listing limits, checked before anything is written.
VERSION="$VERSION" node -e '
  const fs = require("fs");
  const path = process.argv[1], next = process.env.VERSION;
  const m = JSON.parse(fs.readFileSync(path, "utf8"));
  const fail = (msg) => { console.error("pack:codex: " + msg); process.exit(1); };
  const semver = /^\d+\.\d+\.\d+$/;
  if (!semver.test(next)) fail(`codex-plugin version must be plain x.y.z, got ${next}`);
  if (!semver.test(String(m.version))) fail(`release version is not x.y.z: ${m.version}`);
  const [a, b] = [next, m.version].map((v) => v.split(".").map(Number));
  if (!((a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) > 0)) {
    fail(`codex-plugin is at ${next}, not above the release (${m.version}): bump codex-plugin/.codex-plugin/plugin.json and merge`);
  }
  const i = m.interface || {};
  // UTF-16 units, the stricter count (an emoji is 2): how the portal counts is
  // not documented, and a refusal here costs a shorter subtitle while one
  // there costs an upload and a review cycle.
  const chars = (s) => s.length;
  const limits = { displayName: 30, shortDescription: 30, longDescription: 4000, developerName: 80 };
  for (const [k, n] of Object.entries(limits)) {
    if (i[k] !== undefined && typeof i[k] !== "string") fail(`interface.${k} must be a string`);
    if (typeof i[k] === "string" && chars(i[k]) > n) fail(`interface.${k} is ${chars(i[k])} characters; the limit is ${n}`);
  }
  if (m.description !== undefined && typeof m.description !== "string") fail("description must be a string");
  if (typeof m.description === "string" && chars(m.description) > 4000) fail(`description is ${chars(m.description)} characters; the limit is 4000`);
  const caps = i.capabilities ?? [];
  if (!Array.isArray(caps) || caps.some((c) => typeof c !== "string")) fail("interface.capabilities must be a list of strings");
  if (caps.length > 20) fail(`interface.capabilities has ${caps.length} labels; the limit is 20`);
  for (const c of caps) if (chars(c) > 120) fail(`interface.capabilities has a ${chars(c)}-character label; the limit is 120`);
  if (m.skills !== undefined && !["./skills", "./skills/"].includes(m.skills)) {
    fail(`the release declares skills at ${m.skills}; this script writes ./skills`);
  }
  const prompts = i.defaultPrompt ?? [];
  if (!Array.isArray(prompts) || prompts.some((p) => typeof p !== "string")) fail("interface.defaultPrompt must be a list of strings");
  if (prompts.length > 3) fail(`interface.defaultPrompt has ${prompts.length} prompts; the limit is 3`);
  for (const p of prompts) if (chars(p) > 128) fail(`interface.defaultPrompt has a ${chars(p)}-character prompt; the limit is 128`);
  // Listing text belongs to the portal and is not rewritten here, so say when it
  // still names SEO (there is no SEO module; mcp#88). A disclaimer trips it too:
  // read the field before uploading.
  const named = new Set();
  const walk = (v, at) => {
    if (typeof v === "string") {
      if (/\bSEO\b|search[- ]engine[- ]optimi[sz]/i.test(v)) named.add(at.replace(/\[\d+\]$/, ""));
    } else if (Array.isArray(v)) v.forEach((x, n) => walk(x, `${at}[${n}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k);
  };
  walk(m, "");
  for (const k of named) {
    console.error(`warning: ${k} still names SEO: unzip the release, edit .codex-plugin/plugin.json, and run pack:codex on the folder`);
  }
  m.version = next;
  fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
' "$MANIFEST"

git archive HEAD codex-plugin/skills | tar -x -C "$STAGE"
# The release's skills are replaced, so say what published skill content this
# drops: a stale checkout of main, or a file the portal added, must not go
# quietly.
if [ -d "$STAGE/pkg/skills" ]; then
  for d in "$STAGE/pkg/skills"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    if [ ! -d "$STAGE/codex-plugin/skills/$name" ]; then
      echo "warning: the release has skill $name, which codex-plugin/skills does not; this update removes it" >&2
      continue
    fi
    (cd "$d" && find . -type f) | while read -r f; do
      [ -e "$STAGE/codex-plugin/skills/$name/$f" ] \
        || echo "warning: the release has skills/$name/${f#./}, which codex-plugin/skills does not; this update removes it" >&2
    done
  done
fi
rm -rf "$STAGE/pkg/skills"
mv "$STAGE/codex-plugin/skills" "$STAGE/pkg/skills"

mkdir -p "$OUT_DIR"
ZIP="$(cd "$OUT_DIR" && pwd)/website-auditor-codex-plugin-${VERSION}.zip"
rm -f "$ZIP"
(cd "$STAGE/pkg" && zip -qrX -D "$ZIP" .)
echo "$ZIP"
