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
| `.mcpb` bundle | see below | direct/manual installs, GitHub release |
| **Claude Desktop directory** | **a submission form + human review** | **Claude Desktop users who installed from the in-app directory** |

**Codex is not a fifth channel — don't go looking for one.** MCP servers have
no Codex directory or submission process (verified 2026-08-10): Codex users
install straight from npm via `codex mcp add` / `~/.codex/config.toml` — the
README has the config — so `npm publish` already reaches them, and their
`npx -y` installs self-update like everyone else's.

The adjacent surface that DOES take submissions is the **plugin catalog shared
by ChatGPT and Codex** (the in-product directory users browse, search and
`@`-invoke; plugins can bundle MCP servers). Getting listed means packaging
this server as a Codex *plugin* and going through the OpenAI Platform
submission flow and review — a separate, deliberate project, not part of this
release train. If that ever ships, it becomes a genuine fifth channel with its
own review queue, exactly like the Claude Desktop directory.

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

   **Registry tokens live 300 seconds from issue.** That is the whole lifetime,
   not the remainder — so logging in at the start of a release and publishing at
   the end never works: typecheck, the suite, the build, `npm publish` and the
   OTP prompt together take far longer than five minutes. Log in *immediately
   before* this step, not before step 1.

   `scripts/release.sh` does this for you: preconditions only check that the
   machine has credentials at all and that there is a TTY to re-authenticate
   with, then it re-mints the token just before publishing. An earlier version
   demanded 300s of remaining life up front, which no token can ever have, and
   every release aborted on a message telling you to refresh a token that was
   already as fresh as tokens get.

6. `gh release create v<x.y.z> website-auditor-mcp-<x.y.z>.mcpb` so `.mcpb`
   users have a canonical download.

6b. **Submit the `.mcpb` to the Claude Desktop directory** — see the section
   below. This one is asynchronous and human-reviewed, so it will not be done
   when the rest of the release is. Do it, then carry on; just never assume it
   happened.

7. Confirm it actually landed, rather than assuming:

   ```
   npm view website-auditor-mcp version
   curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=website-auditor&limit=100" \
     | python3 -c "import json,sys;[print(s.get('version'),(s.get('_meta') or {}).get('io.modelcontextprotocol.registry/official',{}).get('isLatest')) for s in json.load(sys.stdin)['servers']]"
   ```

   Then watch `mcp_events.server_version` and `api_request_logs.mcp_version`
   for the new string. Until one real client reports it, the release has not
   reached anybody — that is the check that would have caught this.

## The Claude Desktop directory — the fourth channel

**Nothing in steps 1–7 touches it.** It is a curated catalogue with its own
submission form and a human review queue, separate from npm and from
registry.modelcontextprotocol.io. Anthropic's docs are explicit: *"Desktop
extensions (MCPB) use a separate submission form and don't require the
portal."*

This is why the listing sat at 1.0.6 while npm and the registry reached
1.0.11: `mcp-publisher publish` does nothing for it, and no amount of waiting
would have changed that. There is no propagation delay to ride out — there is a
submission nobody had made.

    https://clau.de/desktop-extention-submission

Increment `version` in manifest.json and leave `name` unchanged; that is what
marks it an update rather than a new listing. Attach the packed
`.mcpb` from step 3.

**There is no published SLA.** Anthropic states only *"Review times vary with
queue volume."* Once a version is approved, directory-installed extensions
update automatically — also with no stated interval. Privately distributed
`.mcpb` files never auto-update at all.

So: treat this channel as asynchronous and unbounded. Submit it, then keep
shipping; do not block a release on it, and do not assume it followed.

### Requirements, audited 2026-08-04 (all currently PASS)

Local connectors are held to a stricter bar than remote ones, and the docs
warn that *"Missing or incomplete privacy policies result in immediate
rejection."* `get_sample_audit` makes this a local connector, so all of it
applies:

| Requirement | State |
|---|---|
| `privacy_policies` array in manifest.json (needs manifest_version ≥ 0.2) | PASS — `["https://website-auditor.io/privacy"]`, manifest_version 0.3 |
| "Privacy Policy" section in README.md | PASS — README.md line ~148 |
| HTTPS privacy URL that resolves | PASS — 200 |
| Policy covers collection, use/storage, third-party sharing, retention, contact | PASS — all five present on the live page |
| Every tool carries a `title` | PASS — 14/14 |
| Every tool carries `readOnlyHint` or `destructiveHint` | PASS — set for all in src/mcp/server.ts |

Re-check these before each submission rather than assuming: the privacy page
is served by a different repo (chaos_tester), so it can regress without any
change landing here.

## Verifying a build without the directory

Installing the packed `.mcpb` from Settings → Extensions bypasses the review
queue entirely and is the fastest way to prove a build end to end. That is how
1.0.10 was confirmed to report `server_version` and `install_id` at all.
