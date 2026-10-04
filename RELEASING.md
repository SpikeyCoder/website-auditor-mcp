# Releasing

**Five channels ship this server, and they are separate publishes.** Feeding
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
| **ChatGPT/Codex plugin directory** | **tools: the portal's daily scan of the hosted server (deploy it); skills and listing text: `npm run pack:codex` + portal upload + review** | **ChatGPT and Codex users who added the listed plugin** |

**Codex has no directory of its own for MCP servers — don't go looking for
one.** MCP servers have no Codex submission process (verified 2026-08-10): Codex users
install straight from npm via `codex mcp add` / `~/.codex/config.toml` — the
README has the config — so `npm publish` already reaches them, and their
`npx -y` installs self-update like everyone else's.

The adjacent surface that DOES take submissions is the **plugin catalog shared
by ChatGPT and Codex** (the in-product directory users browse, search and
`@`-invoke; plugins can bundle MCP servers). **Published**: 1.0.16 was live on
2026-10-04, so it is the fifth row above. Its tools follow the hosted server
by daily scan, so deploying that server is the release step for them; skills
and listing text need a new ZIP and a review (docs/CODEX-PLUGIN.md,
"Updating the published listing").

**Cursor is the same shape.** `npm publish` already reaches Cursor users
(`~/.cursor/mcp.json`; the README carries the config and a one-click install
link). The **Cursor Marketplace** is a reviewed plugin channel on top:
`cursor-plugin/` (pinned by `tests/cursorPlugin.test.ts`), **submitted for
review 2026-08-13** — docs/CURSOR-PLUGIN.md has the full submission record.
Do not assume it landed; the listing exists only when Cursor says so.

Two things make this channel unlike the Claude directory, and both cut in your
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

> **The hosted server is NOT in this list, and `npm run release` does not touch
> it.** `src/http.ts` runs on Cloud Run as `website-auditor-mcp`, mapped to
> mcp.website-auditor.io, and it is deployed by hand:
>
> ```
> gcloud run deploy website-auditor-mcp --source . --region us-central1
> ```
>
> Measured 2026-09-07, after PR #76 merged to main: `curl
> https://mcp.website-auditor.io/health` returned `{"ok":true,"version":"1.0.22"}`
> and its `tools/list` carried no `engine_status` — i.e. the live build predated
> the fix while reporting a version string main had moved past. Publishing to
> npm leaves every HTTP, OAuth and Codex-plugin client on the old build.
>
> A version number cannot tell a stale revision from a current one (see
> docs/SUBMISSION-TESTS.md). Check the endpoint, not the number.

1. Bump the version. SEVEN strings must agree — package.json, package-lock.json
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
   # mcpb names its output after the directory unless given a path
   npx --yes @anthropic-ai/mcpb pack . website-auditor-mcp-<x.y.z>.mcpb
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

   `scripts/release.sh` does this for you. With the `gh` CLI logged in, it
   mints each registry token from that login (handing the GitHub token to
   `mcp-publisher login github` through `MCP_GITHUB_TOKEN`, not the command
   line), with no prompt, right before every publish attempt. Before npm, it
   also checks that the `gh` account owns the registry namespace (the registry
   issues a token to any account, and only refuses the wrong one at publish,
   after npm), and mints once so an outage stops the release while nothing has
   shipped. Without `gh`, it needs a terminal for the GitHub device flow; with
   neither, it stops before npm. An earlier version demanded 300s of remaining life up front, which no
   token can ever have, and every release aborted on a message telling you to
   refresh a token that was already as fresh as tokens get.

   **npm must serve the version before the registry is asked.** The registry
   validates a publish against npm, and right after `npm publish` npm may not
   serve the new version yet. 1.0.25 was refused with "version '1.0.25' was not
   found", published once, and stopped. The script now waits for
   `https://registry.npmjs.org/<pkg>/<version>` to answer, then tries the
   registry up to five times with backoff. A token mint that fails counts as
   a failed attempt too, and its error is shown with the token masked.

   **If it still ends half-published, run it again** as it says:
   `npm run release`, or `npm run release -- --yes` from a shell with no
   terminal (there is nothing to answer the confirm prompt there). It skips
   npm, which already has the version and so needs no npm login or one-time
   password, and finishes the bundle and the registry. Once both channels have
   the version, a run packs the `.mcpb` for the GitHub release, publishes
   nothing, and needs no credentials at all. It packs only if the files that
   decide what the bundle runs and shows (`src`, the manifests, the lockfile,
   `tsconfig.json`, `README.md`, `LICENSE`, `icon.png`, `.mcpbignore`) match
   the commit npm published that version from
   (`npm view <pkg>@<version> gitHead`), and not at all if npm cannot say
   which commit that was; changes since then need a version bump, not a
   bundle under the old name. The `.mcpb` is packed before anything is published, so a later
   failure can't lose it.

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

### Requirements, audited 2026-08-04, re-audited 2026-08-13 and 2026-09-02

Local connectors are held to a stricter bar than remote ones, and the docs
warn that *"Missing or incomplete privacy policies result in immediate
rejection."* `get_sample_audit` makes this a local connector, so all of it
applies:

| Requirement | State |
|---|---|
| `privacy_policies` array in manifest.json (needs manifest_version ≥ 0.2) | PASS — `["https://website-auditor.io/privacy"]`, manifest_version 0.3 |
| "Privacy Policy" section in README.md | PASS — README.md line ~240 |
| HTTPS privacy URL that resolves | PASS — 200 |
| Policy covers collection, use/storage, third-party sharing, retention, contact | PASS — all five present on the live page |
| Every tool carries a `title` | PASS — 15/15 |
| Every tool carries `readOnlyHint` or `destructiveHint` | PASS — 15/15, set in src/mcp/server.ts |

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
