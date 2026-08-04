# Releasing

**Three channels ship this server, and they are separate publishes.** Feeding
only one is how 1.0.8, 1.0.9 and 1.0.10 reached npm while every Claude Desktop
user stayed on 1.0.6 — which meant `get_sample_audit`, the telemetry that would
have revealed it, and the storefront copy were all invisible to real users for
days. Nothing warns you; the versions just quietly disagree.

| Channel | Command | Who it reaches |
|---|---|---|
| npm | `npm publish` | `npx -y website-auditor-mcp` configs (self-updating) |
| MCP registry | `mcp-publisher publish` | the MCP registry / directory consumers |
| `.mcpb` bundle | see below | Claude Desktop extension installs |

## Just run the script

```
npm run release              # prompts before publishing
npm run release -- --dry-run # check the preconditions, publish nothing
```

`scripts/release.sh` does everything below in the right order, refuses to start
if a precondition fails, and — critically — checks BOTH channels afterwards
rather than assuming. The manual steps are kept for when something goes wrong.

## Steps

1. Bump the version. SIX strings must agree — package.json, package-lock.json
   (x2), manifest.json, server.json (x2) and `src/version.ts`.
   `tests/manifests.test.ts` fails if any lags, after a bump once left the
   manifests behind at 1.0.7.

   ```
   npm version <x.y.z> --no-git-tag-version
   # then hand-edit manifest.json, server.json and src/version.ts
   npx vitest run tests/manifests.test.ts
   ```

2. Full suite + typecheck: `npm run typecheck && npx vitest run`

3. Build and pack the bundle. **Prune dev dependencies first** — a naive pack
   after a dev install produces a ~30MB / 2500-file bundle with vitest and
   typescript inside, versus 2.6MB / ~1926 files pruned. The pack step does not
   warn.

   ```
   npm run build
   npm ci --omit=dev
   npx @anthropic-ai/mcpb pack .
   mv website-auditor-mcp.mcpb website-auditor-mcp-<x.y.z>.mcpb
   npm ci            # restore dev deps
   ```

4. `npm publish` — `prepublishOnly` re-runs typecheck + tests, and a published
   version can never be replaced.

5. `mcp-publisher publish` — needs `mcp-publisher login github` first. **This is
   the step that was missed three releases running.**

6. `gh release create v<x.y.z> website-auditor-mcp-<x.y.z>.mcpb` so `.mcpb`
   users have a canonical download.

7. Confirm it actually landed, rather than assuming:

   ```
   npm view website-auditor-mcp version
   curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=website-auditor&limit=100" \
     | python3 -c "import json,sys;[print(s.get('version'),(s.get('_meta') or {}).get('io.modelcontextprotocol.registry/official',{}).get('isLatest')) for s in json.load(sys.stdin)['servers']]"
   ```

   Then watch `mcp_events.server_version` and `api_request_logs.mcp_version`
   for the new string. Until one real client reports it, the release has not
   reached anybody — that is the check that would have caught this.

## Note on the Claude Desktop directory

Its listing lagged the MCP registry even after a successful `mcp-publisher
publish` (1.0.6 shown against a registry `isLatest` of 1.0.10). Whether it
polls with a lag or needs its own submission was not established. Installing
the local `.mcpb` from Settings → Extensions bypasses it entirely and is the
fastest way to verify a build end to end.
