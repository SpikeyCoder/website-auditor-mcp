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

Status: **REJECTED 2026-08-24. Mixed Auth in progress** — see
docs/OAUTH-MIXED-AUTH.md for the root cause, what has shipped, and what
website-auditor-api still owes.

| Phase | State |
|---|---|
| 1. Package the plugin | **DONE** — `codex-plugin/`, installable from this repo |
| 2. Hosted HTTP MCP server | **LIVE** — https://mcp.website-auditor.io/mcp (Cloud Run `website-auditor-mcp`, us-central1, `WA_UPSELL_STYLE=info`, pinned `WA_INSTALL_ID`, `WA_APPS_CHALLENGE_TOKEN` serving the domain-verification token) |
| 3. Compliance pass | **DONE** — accurate annotations (42 justifications filed in the portal), info upsell live, minimization tests, terms/privacy/contact URLs live, reviewer demo account seeded with real monitoring history |
| 4. Portal submission | **SUBMITTED** — "We'll notify you when a decision is made." No published SLA; submit-and-keep-shipping applies |

Submission facts a future update needs:

- **Listing auth was No Auth, and that is what got it rejected.** Every ChatGPT
  user got the keyless surface, so the five submitted test cases needing a Pro
  key could not pass — no credential can reach the server under No Auth. Pro
  flows were demonstrated only via the recorded demo (hosted at
  storage.googleapis.com/website-auditor-public-assets/) running against the
  single-tenant demo instance (`website-auditor-mcp-demo`, PR #41), which the
  reviewer never exercised.
- **The portal offers No Auth / Mixed Auth / OAuth — and no api-key mode.** It
  is editable only on a DRAFT version; on a submitted one the field is frozen,
  which reads at a glance like No Auth being the only option. **Mixed Auth** is
  the target: `get_sample_audit` and `check_upgrade_status` open, the other 13
  behind a login. It requires OAuth 2.1 either way — there is no header-key
  shortcut.
- **Updates are snapshot-versioned**: change the server → Scan Tools again →
  bump the portal version → resubmit → publish on approval. Tool metadata and
  skills do NOT track the live server.
- **Reviewer-suggested for next version**: `outputSchema` on every tool.
- The Cloud Scheduler weekly-trackings job, the demo account, and the
  `mcp_transports` view all exist because of this work — see the api repo and
  chaos-tester project history from 2026-08-11.

## Phase 5 — the rejection, and Mixed Auth

**Rejected 2026-08-24**: *"One or more of your test cases did not produce correct
results… Ensure the same test cases pass consistently on both ChatGPT web and
mobile."*

Not a policy finding. Five of the eight submitted cases named the reviewer demo
API key as their fixture, and a No Auth listing has no mechanism to deliver one —
so `run_audit`, `get_ai_visibility`, `get_monitoring_status` and the
unreachable-domain negative all answered `AUTH_REQUIRED`, and
`check_upgrade_status` reported `tier: "none"` where the document promised
`tier: "pro"`.

Snapshot drift was suspected and ruled out: the active Cloud Run revision
(`website-auditor-mcp-00004-crf`) dates from 2026-08-11 and has never been
redeployed, so the reviewer tested exactly the build that was scanned. 1.0.17
through 1.0.20 — and `get_gtm_plan` — exist only in git.

**Consequence for the next deploy:** that box serves 14 tools and `main` has 15.
Redeploy and rescan together, or neither.

The remedy and its work split are in **docs/OAUTH-MIXED-AUTH.md**.

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

## Phase 2 — the hosted server

**The code exists**: `src/http.ts` serves the same 15 tools over stateless
Streamable HTTP (`npm run start:http`, port from `WA_HTTP_PORT`/`PORT`).
Multi-tenant by construction — the key arrives per request
(`Authorization: Bearer wa_…`, or `X-API-Key`), deps are per-key bundles with
idle eviction so the audit + subscription caches keep doing their job, a
stray `WA_API_KEY` in the host env is discarded rather than becoming the
anonymous identity, keyless requests get the sample-audit surface, and
telemetry events carry `transport: "http"` (**the API's mcp_events ingest
needs that column before real traffic**). It also serves
`/.well-known/openai-apps-challenge` (token from `WA_APPS_CHALLENGE_TOKEN`,
verbatim and alone) and `/healthz`. Pinned by `tests/http/server.test.ts`
over a real socket with the SDK's own HTTP client.

Known stateless trade-off: clientInfo arrives only in `initialize` POSTs, so
`tool_call` telemetry from this entry point usually lacks `client_name`
(`session_init` still records it).

What remains is deployment, not code:

- Stand it up at `https://mcp.website-auditor.io` (DNS + TLS + process next to
  the API), with `WA_UPSELL_STYLE=info` — see Phase 3.
- **Auth decision**: bearer keys work today; the portal's allowed auth modes
  decide whether OAuth against admin-portal accounts is required for listing.
  Build that against the portal's actual auth-config screen, not guesses.
  Reviewer demo credentials must work "without MFA, SMS, email confirmation,
  or private-network access."

## Phase 3 — compliance

1. **DONE — checkout links are a config switch now.** `WA_UPSELL_STYLE=info`
   (see config.ts) keeps every price/trial disclosure but points every link —
   including `upgrade_url`s the API itself returns on 401/403 — at the
   informational `WA_UPSELL_INFO_URL` (default: the site homepage) instead of
   the portal. The hosted deployment sets it; stdio installs keep `link`, the
   byte-identical historical behavior. Pinned by
   `tests/tools/upsellStyle.test.ts`. Residual: gate/status message VERBS
   still say "subscribe at" — the target is informational, which is the
   load-bearing part; revisit wording against actual review feedback.
2. **DONE — annotations are accurate, not just present.** All three hints were
   already on every tool; the VALUES were the risk ("incorrect annotations"
   is a listed rejection reason): track_site claimed destructive for
   enrolling monitoring, and track/untrack claimed open-world for touching
   only the caller's own account. Corrected and pinned tool-by-tool in
   `tests/mcp/server.test.ts`. Rides the next npm release.

Still required, currently missing: a **terms-of-service URL** (the portal
wants website, support, privacy AND terms URLs; we have no public terms page —
the subscription flow's terms live inside the portal).

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
