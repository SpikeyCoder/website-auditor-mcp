# Cursor plugin & the Cursor Marketplace

The Cursor analogue of [CODEX-PLUGIN.md](CODEX-PLUGIN.md). Cursor 2.5
(2026-02-17) replaced the old curated MCP list
(github.com/cursor/mcp-servers — archived 2026-03-19) with an in-product
**Cursor Marketplace** of *plugins*: bundles of MCP server + skills + rules,
browsed from the Customize page and one-click installed. Every listing is
manually reviewed, and **every update is re-reviewed**.

Status: **READY TO SUBMIT (2026-08-13).** Package built, verified in Cursor
3.15.19, licensing resolved (below), and the 1.0.17 npm release is live — so a
reviewer's first run gets the corrected keyless onboarding. What remains is the
publisher application itself (step 2 below), which is account-bound.

## What already reaches Cursor users without any of this

- `npm publish` — Cursor reads `~/.cursor/mcp.json`; the README documents the
  config and carries a one-click install link
  (`https://cursor.com/install-mcp?name=…&config=<base64>`, spec:
  cursor.com/docs/mcp/install-links; the `cursor://` deeplink form exists too,
  but GitHub strips non-https hrefs, so READMEs must use the https wrapper).
- The hosted endpoint (`https://mcp.website-auditor.io/mcp`) works as a remote
  `{"url": …}` server config for Node-less installs.

As with Codex: the marketplace is a *discovery* channel, not the only path to
Cursor users. npm reaches them today.

## The package

`cursor-plugin/` mirrors `codex-plugin/` — manifest + the same four skills +
the npm server bundled unpinned via `npx -y`:

- `.cursor-plugin/plugin.json` uses Cursor's **flat** manifest schema (no
  `interface` block like Codex's): name / description / version / author /
  homepage / repository / license / keywords / logo, plus `skills`,
  `mcpServers`, and `variables` declaring `WA_API_KEY`. The variable is
  consumed as `${WA_API_KEY}` in `mcp.json`; users set the value in Cursor's
  plugin settings. Unset ⇒ empty string ⇒ `config.ts` trims it to undefined ⇒
  the keyless sample surface, same as every other channel.
- Repo root `.cursor-plugin/marketplace.json` makes this repo itself addable
  as a Cursor marketplace — the Cursor twin of `.agents/plugins/marketplace.json`.
- Skills are **byte-identical** with `codex-plugin/skills/` and map 1:1 onto
  the server's MCP prompts; `tests/cursorPlugin.test.ts` enforces both, so
  the "change the prompts ⇒ change the skills in the same PR" rule from
  CODEX-PLUGIN.md is now a failing test instead of a hope.

## Local test — DONE 2026-08-13 (Cursor 3.15.19)

**Copy the directory; do NOT symlink it.** The upstream docs suggest
`ln -s` for iterative development, but Cursor rejects any symlink escaping the
local plugins directory:

    loadUserLocalPlugin website-auditor rejected: symlink target
    /Users/…/website-auditor-mcp/cursor-plugin is outside /Users/…/.cursor/plugins/local

so the plugin silently never loads. What works:

```
cp -R cursor-plugin ~/.cursor/plugins/local/website-auditor
```

Cursor rescans on its own (no restart needed) — `Cursor Plugins.log` under
`~/Library/Application Support/Cursor/logs/<session>/window1_wb0/exthost/anysphere.cursor-agent-exec/`
is the ground truth for whether a load succeeded. Re-copy after every change;
nothing live-reloads from the repo.

Results: **Customize → Plugins** lists *Website Auditor* `Local` with
"website-auditor · 14 tools enabled" (green/Connected) and all 4 skills; the
configure dialog enumerates all 14 tools. The server reached telemetry as
`client_name: "cursor-vscode"`, `transport: "stdio"` — already classified
human-facing by `HUMAN_FACING_CLIENTS` (substring "cursor"), no change needed.

### The unset-variable question, answered: Cursor passes the placeholder VERBATIM

A first-run install spawns the server with the **literal**
`WA_API_KEY=${WA_API_KEY}` (confirmed via `ps eww` on the spawned process).
There is no key field in the plugin's configure dialog — per Cursor's docs
variable values come from the dashboard, which a *local* plugin has no entry
in, so the placeholder is never substituted.

Measured effect before the fix, over real stdio:

| | genuinely keyless | literal placeholder |
|---|---|---|
| `get_sample_audit` | sample report | sample report |
| `check_upgrade_status` | `tier: none` + "create one at …" | **error** `MALFORMED_KEY`, "Invalid API key format" |

So the user who configured nothing was told their key was invalid. **Fixed in
`src/config.ts`**: an unexpanded placeholder (`${X}`, `{X}`, `{{X}}`,
`${env:X}`, `$X`) is read as no key at all, restoring the keyless surface —
pinned by `tests/config.test.ts`, and re-verified end to end (the two columns
above are now byte-identical). The `env` block therefore STAYS in `mcp.json`:
it is what lets a subscriber's dashboard value reach the server.

**Sequencing:** the plugin bundles `npx -y website-auditor-mcp`, so it runs
the *published* npm version — the local Cursor test above ran 1.0.16, which
still has the wart. Ship the fix (1.0.17) to npm before submitting, so a
reviewer's first run gets the corrected onboarding; every existing plugin user
picks it up automatically with no re-review.

## Submission steps

1. **Checklist** (cursor.com/docs/reference/plugins): valid manifest; unique
   lowercase kebab-case name; valid frontmatter in every component; logo
   committed and referenced by relative path; README documents usage and
   configuration; relative paths only (no `..`, no absolute); tested locally.
   Everything but the local test is pinned by `tests/cursorPlugin.test.ts`.
2. **Publisher application** at **cursor.com/marketplace/publish** — requires
   signing in with a Cursor account first ("You need to be signed in to
   submit a plugin publisher application", verified live 2026-08-13).
3. Submit the plugin (public repo URL). Manual review, no published SLA —
   same posture as the other directories: submit, keep shipping, never assume
   it landed.

## The license question — RESOLVED 2026-08-13

Cursor's stated requirement: "All plugins must be open source." The server is
**Elastic-2.0** — source-available, but not OSI-approved, and GitHub reports
the repo as license `Other`, which is what a reviewer checking that box sees.

**`cursor-plugin/` is therefore MIT** (`cursor-plugin/LICENSE`, declared in the
manifest). This gives nothing away: the directory is eight files of glue —
manifest, four skills, icon, README — with no server source in it. The server
is fetched from npm at run time and keeps Elastic-2.0 unchanged, the same
shape as every commercial plugin already listed (Stripe, Linear, Figma all
point at paid services).

The LICENSE file opens with a scope note so it cannot be read as covering the
repo, and `tests/cursorPlugin.test.ts` pins the divergence as a deliberate
pair — declared license, license text, and the server's differing license —
so a later "consistency fix" to either side fails loudly instead of silently
relicensing something.

## Updates — a softer snapshot than the other directories

The bundled server is unpinned (`npx -y`), so npm releases reach plugin users
with **no marketplace re-review**. Only changes under `cursor-plugin/`
(manifest, skills) re-enter the review queue. If review ever objects to
checkout links in tool responses, `WA_UPSELL_STYLE=info` in `mcp.json`'s
`env` is the one-line fix — the same switch the hosted endpoint uses for
OpenAI's marketplace rules.

## Secondary channel

**cursor.directory** — the community site the archived official repo now
points to; submissions at cursor.directory/plugins/new. Worth the form for
search traffic once the marketplace submission is in.

## Sources

- Plugin format, local testing, marketplace: https://cursor.com/docs/plugins
- Manifest schema + submission checklist: https://cursor.com/docs/reference/plugins
- Publish / publisher application: https://cursor.com/marketplace/publish
- Install links: https://cursor.com/docs/mcp/install-links
- Archived official list: https://github.com/cursor/mcp-servers
