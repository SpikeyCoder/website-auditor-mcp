# Mixed Auth — what this repo ships, and what website-auditor-api still owes

## Why this exists

OpenAI rejected the ChatGPT listing on 2026-08-24: *"One or more of your test
cases did not produce correct results."*

The cause was structural, not a bug. The listing was configured **No Auth**, but
five of the eight cases in `SUBMISSION-TESTS.md` required a Pro API key. Under No
Auth ChatGPT sends no credential, so `apiKeyFrom()` returns undefined, the keyless
tenant bundle is used, and `gateProTool` answers `AUTH_REQUIRED` — for `run_audit`,
`get_ai_visibility`, `get_monitoring_status` and the unreachable-domain negative
case alike, while `check_upgrade_status` reported `tier: "none"` where the document
promised `tier: "pro"`. The demo API key those cases named as their fixture had no
way to reach the server.

Confirmed from both ends: the deployed Cloud Run revision
(`website-auditor-mcp-00004-crf`, 2026-08-11 — the submission-day build, never
redeployed since) carries only `WA_UPSELL_STYLE`, `WA_INSTALL_ID` and
`WA_APPS_CHALLENGE_TOKEN`. No `WA_HTTP_DEFAULT_KEY`, no `WA_API_KEY`. The box
lends no identity, exactly as designed.

The portal's auth selector offers **No Auth / Mixed Auth / OAuth** and no api-key
mode. Mixed Auth is this product's shape: `get_sample_audit` and
`check_upgrade_status` open to everyone, the other thirteen tools behind a login.

## How Mixed Auth works

Two halves, and ChatGPT shows **no** account-linking UI unless both are present.
Each is silent when missing — the tool just answers "not authenticated" forever,
which is exactly the failure this document exists to prevent recurring:

1. **Declarative** — `_meta.securitySchemes` on every tool (`oauth2` with a scope,
   or `noauth`), plus an RFC 9728 protected-resource metadata document at
   `/.well-known/oauth-protected-resource`.
2. **Runtime** — the error a protected tool returns without a usable token must
   carry `_meta["mcp/www_authenticate"]`, a challenge pointing back at that
   document.

Plus OAuth 2.1 (Authorization Code + PKCE) and Dynamic Client Registration
(RFC 7591), because ChatGPT is an unknown client that self-registers. On
completion ChatGPT sends the access token as `Authorization: Bearer …`.

## What this repo ships

All of it is **off unless configured**. `oauthEnabled()` requires both
`WA_OAUTH_ISSUER` and `WA_OAUTH_RESOURCE_URL`; absent either, no metadata route
is served, no scheme is published, no challenge is attached, and every stdio
install and existing `Bearer wa_…` caller is byte-identical to before.

| Piece | Where |
|---|---|
| `oauthEnabled`, metadata document, challenge builder, scheme derivation, `looksLikeApiKey` | `src/auth/oauth.ts` |
| Access token → API key, with TTL cache | `src/auth/tokenExchange.ts` |
| `/.well-known/oauth-protected-resource` route; `credentialFor()` | `src/http.ts` |
| `_meta.securitySchemes` on registration; `_meta["mcp/www_authenticate"]` lifting | `src/mcp/server.ts` |
| The challenge on `AUTH_REQUIRED`, and the two-gate copy | `src/tools/context.ts` |
| Config + env | `src/config.ts`, `.env.example` |
| Tests | `tests/auth/mixedAuth.test.ts`, `tests/http/server.test.ts` |

Three decisions worth knowing before changing any of it:

- **`securitySchemes` is derived from the registry's existing `tier`**, not a
  parallel list. A second source of truth for "which tools need OAuth" would
  drift from the one that actually gates at runtime, and the drift would be
  invisible until a reviewer found a tool advertising itself as open.
- **A `wa_`-prefixed bearer never reaches introspection.** Every existing caller
  — curl, Codex's `bearer_token_env_var`, the README examples — is on that path.
- **With OAuth ON, a non-`wa_` bearer that fails introspection resolves to "not
  authenticated"**, not to the malformed-key message. An expired token and a
  typo'd key are indistinguishable at that point; "connect an account" is at
  worst imprecise for a curl user, while "Invalid API key format" is actively
  wrong for an OAuth one. With OAuth OFF the old verbatim passthrough is
  preserved exactly, so the typo can still be named.

## What website-auditor-api still owes

The MCP side is inert until these exist.

### 1. OAuth 2.1 authorization server

- Authorization Code + PKCE. No implicit flow.
- Dynamic Client Registration (RFC 7591) — ChatGPT self-registers; there is no
  dashboard step where someone pastes a client ID.
- Authorization-server metadata at `/.well-known/oauth-authorization-server`.
- A consent screen naming the scope in the user's terms.
- Token issuance and refresh.

The admin portal already has accounts and already mints `wa_` keys, so this is an
OAuth layer over existing identity — not a new user system.

### 2. Introspection endpoint

`POST /api/oauth/introspect`, RFC 7662, form-encoded `token` +
`token_type_hint=access_token`. The resource server authenticates with a bearer
secret (`WA_OAUTH_INTROSPECTION_SECRET`); an open introspection endpoint is a
token oracle.

```json
{ "active": true, "api_key": "wa_...", "scope": "audit" }
```

**The contract that matters: an active token must resolve to a key for ANY
authenticated account, subscribed or not.** Withholding the key from a
non-subscriber looks safer and strands them — with no key they resolve to tier
`none`, which answers `AUTH_REQUIRED` and asks them to connect an account they
just connected. Returning the key lets the normal subscription path answer
`PRO_REQUIRED` instead: true, and with a way forward. Two gates, two answers.

*Alternative considered:* teach every API endpoint to accept OAuth tokens
directly and forward the token instead of exchanging it. Cleaner in isolation,
but far larger — every tool here reaches the API through a key, `TenantDeps` is
keyed by one, and the 24h audit cache and 60s subscription cache both hang off
that bundle. Exchanging once at the edge leaves all of it untouched.

### 3. Deployment

Set `WA_OAUTH_ISSUER`, `WA_OAUTH_RESOURCE_URL`, `WA_OAUTH_INTROSPECTION_SECRET`
on the Cloud Run service, then redeploy.

**Redeploy and rescan together.** The deployed box is still the 2026-08-11 build
serving 14 tools; `main` now has 15 (`get_gtm_plan`). The moment it ships it
serves a tool the portal's snapshot has never seen.

## Portal steps, once deployed

1. Draft version → Authentication → **Mixed Auth**; configure the OAuth client.
2. **Scan Tools** — picks up `securitySchemes` and the 15th tool.
3. Restore the authenticated test cases in `SUBMISSION-TESTS.md` (see the note at
   the top of that file), keeping the drift fixes.
4. Re-run all eight in ChatGPT **web and mobile** — the rejection named both.
5. Resubmit.

## Verifying end to end

`npm test` covers both halves in isolation and over a real socket. What tests
cannot cover is whether ChatGPT actually renders the linking UI, because that
depends on it reading both halves. Check explicitly after deploying:

```bash
curl -s https://mcp.website-auditor.io/.well-known/oauth-protected-resource | jq
# expect: resource, authorization_servers, scopes_supported, bearer_methods_supported

curl -s -X POST https://mcp.website-auditor.io/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | jq '.result.tools[] | {name, schemes: ._meta.securitySchemes}'
# expect: noauth on get_sample_audit + check_upgrade_status, oauth2 on the other 13
```

A protected tool called with no token must come back with
`_meta["mcp/www_authenticate"]` present. If the metadata document is right and
the challenge is missing (or vice versa), ChatGPT stays silent and the app looks
exactly as broken as it did before this work.
