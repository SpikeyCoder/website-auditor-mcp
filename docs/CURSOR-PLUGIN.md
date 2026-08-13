# Cursor plugin & the Cursor Marketplace

The Cursor analogue of [CODEX-PLUGIN.md](CODEX-PLUGIN.md). Cursor 2.5
(2026-02-17) replaced the old curated MCP list
(github.com/cursor/mcp-servers — archived 2026-03-19) with an in-product
**Cursor Marketplace** of *plugins*: bundles of MCP server + skills + rules,
browsed from the Customize page and one-click installed. Every listing is
manually reviewed, and **every update is re-reviewed**.

Status: **PACKAGE BUILT (`cursor-plugin/`) — not yet submitted.** Submission
is gated on a publisher application (step 2 below), which is account-bound.

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

## Local test (required by the submission checklist)

```
ln -s "$(pwd)/cursor-plugin" ~/.cursor/plugins/local/website-auditor
```

Reload Cursor (`Developer: Reload Window`); remove the symlink to uninstall.
Verify: the 14 tools and 4 skills load; `get_sample_audit` answers with no
variable configured; setting `WA_API_KEY` unlocks real audits. **Also confirm
what an unset variable expands to**: expected is an empty string (⇒ keyless
surface). If Cursor instead leaves the literal `${WA_API_KEY}`, the server
sees a garbage key — handled gracefully (see
`tests/malformedKeyIsNotALockout.test.ts`) but a worse first-run, so it would
be worth dropping the `env` block from `mcp.json` before submitting.

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

## The license question — resolve before submitting

Cursor's stated requirement: "All plugins must be open source." This repo is
**Elastic-2.0** — source-available, not OSI-approved open source. Whether
review accepts that is unknown. If it objects, the least-invasive option is
licensing `cursor-plugin/` itself (manifest + skills — the actual plugin
content) under MIT while the server keeps Elastic-2.0. That is a business
decision: flag it, don't relicense casually.

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
