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
`@`-invoke; plugins can bundle MCP servers). **Submitted for review
2026-08-11** (docs/CODEX-PLUGIN.md has the full submission record). Per this
file's own rule: do not assume it landed — the listing exists only when OpenAI
says so, and once it does, it becomes a genuine fifth channel here with its
own review queue and a rescan required per release, exactly like the Claude
Desktop directory.

**Cursor is the same shape.** `npm publish` already reaches Cursor users
(`~/.cursor/mcp.json`; the README carries the config and a one-click install
link). The **Cursor Marketplace** is a reviewed plugin channel on top:
`cursor-plugin/` (pinned by `tests/cursorPlugin.test.ts`), **submitted for
review 2026-08-13** — docs/CURSOR-PLUGIN.md has the full submission record.
Do not assume it landed; the listing exists only when Cursor says so.

Two things make this channel unlike the other two, and both cut in your
favour. The plugin bundles the server unpinned (`npx -y`), so npm releases
flow through **without re-review** — only changes to the plugin itself
(manifest, skills) re-enter the queue. But review reads the **repo at
`main`**, not an uploaded snapshot, so `cursor-plugin/` must stay
submission-ready on main rather than only at submission time.

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
     | python3 -c "import json,sys;[print(e['server']['version'],(e.get('_meta') or {}).get('io.modelcontextprotocol.registry/official',{}).get('isLatest')) for e in json.load(sys.stdin)['servers']]"
   ```

   Expect exactly one `True` — the version you just published. **The registry
   nests the record under a `server` key** (`{"server": {...}, "_meta": {...}}`).
   An earlier version of this snippet read `version` off the outer object, so it
   printed `None` for every entry no matter what was published, and answered
   "did it land?" with a column of nulls that looked like a registry outage
   rather than a broken query. Caught during the 1.0.17 release. If this ever
   prints `None` again, the response shape moved — fix the query before
   concluding anything about the release.

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

### Requirements, audited 2026-08-04, re-audited 2026-08-13

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

The **submission form itself** states four more, which this table missed
through the 1.0.16 submission because they live on the form rather than in the
docs. Added 2026-08-13:

| Form requirement | State |
|---|---|
| Publicly available on GitHub | PASS |
| Built with Node.js | PASS |
| `author` field in manifest.json points at your GitHub profile | PASS since 1.0.18 — `https://github.com/SpikeyCoder`. Was the site URL (homepage covers that) through 1.0.17 |
| **MIT licensed** | PASS since 2026-08-13 — the repo was relicensed from Elastic-2.0 |

The MIT row had no cheap workaround: unlike the Cursor Marketplace — where
only `cursor-plugin/` is distributed, so MIT-licensing that directory settled
it — the `.mcpb` **is** the server, so meeting it meant relicensing. Done
deliberately, on the understanding that this repo is the *client* for the
Website Auditor API: the audit engine (chaos_tester) and the API
(website-auditor-api) are separate products under their own terms, and a fork
still needs a `wa_` key against a real account to audit anything.

**The 1.0.17 bundle now in review was submitted under Elastic-2.0.** The
relicense reaches reviewers on the next release; it is not worth resubmitting
for on its own.

Re-check these before each submission rather than assuming: the privacy page
is served by a different repo (chaos_tester), so it can regress without any
change landing here.

## Verifying a build without the directory

Installing the packed `.mcpb` from Settings → Extensions bypasses the review
queue entirely and is the fastest way to prove a build end to end. That is how
1.0.10 was confirmed to report `server_version` and `install_id` at all.
