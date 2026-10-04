#!/usr/bin/env bash
#
# Build the ZIP the ChatGPT/Codex plugin portal takes for a published listing
# ("Upload plugin to make changes"). Usage:
#
#   npm run pack:codex              # writes website-auditor-codex-plugin-<version>.zip here
#   npm run pack:codex -- <dir>     # ...or into <dir>
#
# WHAT GOES THROUGH A ZIP AND WHAT DOES NOT (developers.openai.com/plugins/
# deploy/submission, read 2026-10-04). The portal scans the hosted MCP server
# daily and takes tool changes on its own (MCPs -> the server -> Issues ->
# Rescan to hurry it). Listing metadata, skills and assets change only through
# a new ZIP, which is a new package version with its own review — and only one
# review can be active per plugin.
#
# HOW IT DIFFERS FROM codex-plugin/. Its .mcp.json runs the stdio npm
# package, which is right for repo-marketplace installs. The portal accepts a
# hosted server only, and a connected server's URL cannot be changed except
# through OpenAI support, so the ZIP declares the hosted URL instead — as
# "streamable-http", the type OpenAI's plugin docs and the agent-plugins
# schema the file declares allow (stdio | sse | streamable-http). Codex's own
# config, as in github.com/openai/plugins, spells it "http" and omits the
# $schema; the portal ZIP follows the schema. No oauth block: the server
# publishes its OAuth protected-resource metadata, which is how a client finds
# the login (Canva's and Vercel's packages carry none either). The README is
# left out: it describes the stdio setup and this repo's bookkeeping.
#
# Packs what is COMMITTED (git archive HEAD), so a Finder .DS_Store or an
# unsaved edit cannot reach the portal; it warns when codex-plugin/ differs,
# and the file name carries the committed version. The portal reads the
# version from .codex-plugin/plugin.json: commit a bump above whatever the
# portal holds before packing.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
# Relative to where it was run (npm sets INIT_CWD to that directory).
OUT_DIR="${1:-$ROOT}"
case "$OUT_DIR" in /*) ;; *) OUT_DIR="${INIT_CWD:-$PWD}/$OUT_DIR" ;; esac
URL="https://mcp.website-auditor.io/mcp"

cd "$ROOT"
VERSION="$(git show HEAD:codex-plugin/.codex-plugin/plugin.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
if ! git diff --quiet HEAD -- codex-plugin || [ -n "$(git ls-files --others --exclude-standard -- codex-plugin)" ]; then
  echo "warning: codex-plugin/ has uncommitted changes; packing HEAD without them" >&2
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git archive HEAD codex-plugin | tar -x -C "$STAGE"
rm -f "$STAGE/codex-plugin/README.md"

URL="$URL" node -e '
  const out = { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
                mcpServers: { "website-auditor": { type: "streamable-http", url: process.env.URL } } };
  require("fs").writeFileSync(process.argv[1], JSON.stringify(out, null, 2) + "\n");
' "$STAGE/codex-plugin/.mcp.json"

mkdir -p "$OUT_DIR"
ZIP="$(cd "$OUT_DIR" && pwd)/website-auditor-codex-plugin-${VERSION}.zip"
rm -f "$ZIP"
(cd "$STAGE/codex-plugin" && zip -qrX "$ZIP" .)
echo "$ZIP"
