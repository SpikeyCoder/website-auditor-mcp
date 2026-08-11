# Codex plugin & the ChatGPT/Codex plugin directory

**Two different things share this document, and only one of them exists yet.**

1. **The plugin package** (`codex-plugin/` in this repo) — works today, installable
   by anyone from this repo as a marketplace. It bundles the stdio npm server
   plus four skills, and it doubles as the listing material for (2).
2. **A directory listing** — the in-product Plugins Directory shared by ChatGPT
   and Codex (browse, one-click install, `@website-auditor`). This is a
   submission-and-review channel like the Claude Desktop directory, and it has
   one hard prerequisite we do not meet yet: **a hosted Streamable HTTP MCP
   server**. The directory does not accept bundled stdio servers.

Status, audited 2026-08-11:

| Phase | State |
|---|---|
| 1. Package the plugin | **DONE** — `codex-plugin/`, installable from this repo |
| 2. Hosted HTTP MCP server | not started — gates everything below |
| 3. Compliance pass | not started — two known blockers, see below |
| 4. Portal submission | not started |

## The plugin package (Phase 1)

```
codex-plugin/
├── .codex-plugin/plugin.json   # manifest + all directory listing metadata
├── .mcp.json                   # bundles: npx -y website-auditor-mcp (stdio)
├── skills/                     # the four MCP prompts, ported
│   ├── see-sample-report/      #   ← no key, no arguments: the entry point
│   ├── check-ai-visibility/
│   ├── audit-my-site/
│   └── compare-to-competitor/
└── assets/icon.png
```

The repo root carries `.agents/plugins/marketplace.json`, which makes the repo
itself a Codex marketplace:

    codex plugin marketplace add SpikeyCoder/website-auditor-mcp   # or a local path
    codex plugin add website-auditor

**Why skills, when the server already ships MCP prompts:** Codex does not
render MCP prompts (openai/codex#8342, closed duplicate of a still-open ask).
Plugin skills DO surface there. The four skills are the prompts from
`src/mcp/prompts.ts` re-expressed as model instructions — same names, same
keyless fallback to `get_sample_audit`, same own-site-only guard. If the
prompts change, change the skills in the same PR; nothing enforces this.

**Versioning:** the plugin has its own version (`.codex-plugin/plugin.json`).
The bundled server is unpinned (`npx -y`), so npm releases reach plugin users
without a plugin update. Bump the plugin version only when the plugin itself
(manifest, skills) changes. It is NOT one of the six strings the release
process keeps in agreement, and `tests/manifests.test.ts` does not check it.

## Phase 2 — the hosted server (gates submission)

Submission requires "a public, production URL" — a Streamable HTTP endpoint,
e.g. `https://mcp.website-auditor.io/mcp`. The SDK in use (≥1.29) supports the
transport; this is an entry point + deployment next to the API, not a rewrite.

Also required on that host:

- **Domain verification**: serve the portal-generated token at
  `https://<host>/.well-known/openai-apps-challenge` — the token alone, no JSON.
- **Auth decision**: keyless `get_sample_audit` + authenticated Pro tools.
  Plan for OAuth against admin-portal accounts; confirm the portal's allowed
  auth modes when configuring. Reviewer demo credentials must work "without
  MFA, SMS, email confirmation, or private-network access."

## Phase 3 — compliance: the two known blockers

1. **Upsell links violate the monetization rules as-is.** OpenAI prohibits
   plugins selling "digital products, subscriptions" and says "no direct
   checkout links or transactional pages"; a plugin "may explain unavailable
   features under current plans but cannot initiate purchases." Our tool
   responses carry `upgrade_url` → the admin-portal checkout in ~53 places.
   Fix without forking behavior: the hosted deployment sets `WA_UPGRADE_URL`
   to a neutral pricing-information page and the response copy explains rather
   than links-to-buy. The Claude-directory behavior stays as shipped.
2. **`openWorldHint` is missing on most tools.** Every tool needs accurate
   `readOnlyHint`, `destructiveHint` AND `openWorldHint`; only 3 of 14 tools
   set the third. All our tools are `openWorldHint: false` (nothing posts
   publicly). One pass in `src/mcp/server.ts`, then rides the next npm release.

Also required, currently missing: a **terms-of-service URL** (the portal wants
website, support, privacy AND terms URLs; we have no public terms page — the
subscription flow's terms live inside the portal).

## Phase 4 — the portal

At **platform.openai.com/plugins**, with identity verification completed in
OpenAI Platform org settings and the submitter holding "Apps Management" =
Write:

- Type: **With MCP** + uploaded skills (upload `codex-plugin/skills/`; MCP
  import is also possible but snapshots whatever the server exposes at scan
  time).
- Info tab: listing fields — everything already in
  `codex-plugin/.codex-plugin/plugin.json`, plus support URL and terms URL.
- MCP tab: universal server URL, auth config, demo credentials, domain
  challenge, then **Scan Tools** (discovers tools, validates the three hint
  annotations, checks the domain token).
- Testing tab: **exactly 5 positive + 3 negative cases**, reproducible without
  internal context. Natural set: sample audit (keyless), visibility check,
  full audit, competitor comparison, upgrade-status check; negatives: audit a
  site the user does not own → refusal, Pro tool with no key → sample
  fallback not an error, unreachable domain → UNREACHABLE_DOMAIN not a score.
- Global tab: launch countries. Submit tab: release notes + attestations.

After approval you choose publication timing; the listing then appears in the
shared directory. **Reviews have no published SLA** ("review timelines may
vary") — same posture as the Claude directory: submit, keep shipping, never
assume it happened.

## Updates are snapshots — this becomes a fifth channel

Published plugins do NOT track the server live: tool metadata and imported
skills are frozen at scan time. Every meaningful change = rescan → new version
→ review → publish. When the listing exists, add it to the channel table in
RELEASING.md with exactly that warning.

## Sources

- Submission: https://developers.openai.com/plugins/deploy/submission
- Review guidelines: https://developers.openai.com/plugins/app-guidelines
- Packaging: https://developers.openai.com/codex/plugins/build
- Overview: https://learn.chatgpt.com/docs/plugins
- Production plugin examples: https://github.com/openai/plugins
