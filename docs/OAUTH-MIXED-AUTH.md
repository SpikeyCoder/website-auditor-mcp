# Mixed Auth — how the two repos fit together

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
   or `noauth`), plus an RFC 9728 protected-resource metadata document. Its
   location follows the resource identifier: §3.1 inserts
   `/.well-known/oauth-protected-resource` between the host and the resource's
   path, so a resource at `/mcp` publishes at
   `/.well-known/oauth-protected-resource/mcp`. The origin-root form is served
   too, for clients that already discovered it there — which is how ChatGPT
   reached it while the spec URL still 404'd, before that was fixed.
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
| Access token → derived API key, with bounded TTL cache | `src/auth/tokenExchange.ts` |
| Both protected-resource metadata routes (`resourceMetadataPaths`); `credentialFor()` | `src/http.ts` |
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

## What website-auditor-api provides

Shipped in that repo on the same branch — the MCP side was inert until it landed.

### 1. OAuth 2.1 authorization server

`src/routes/oauth.js` + `src/services/oauth.js`, root-mounted so the RFC 8414
discovery document sits where clients look:

| Endpoint | Spec |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 |
| `POST /oauth/register` | RFC 7591 — DCR, open, since ChatGPT self-registers |
| `GET /oauth/authorize` | Authorization Code + PKCE **S256 only** |
| `POST /oauth/token` | code exchange + refresh, with rotation |
| `POST /oauth/revoke` | RFC 7009 |
| `POST /api/oauth/introspect` | RFC 7662, resource-server authenticated |

Consent reuses the portal's existing Google sign-in. Both login paths carry an
explicit carve-out so an in-flight authorization finishes regardless of
subscription: `resolvePostAuthDestination` otherwise diverts a non-subscriber to
the paywall, which is right for a report link and wrong here — a connection has
to be completable by someone who has not paid yet, or the two-gate behaviour
below cannot happen.

### 2. The derived key — corrected from what this doc first specified

The original version of this document had introspection return the user's
**personal** API key. That was the weakest part of the design: the MCP holds
keys only for people who deliberately pasted one, and that version would have
given it a permanent credential for every ChatGPT user who connects.

What shipped instead: a token mints its **own** `wa_` key, expiring with it and
revoked when it is revoked. Same shape and same hashed storage, so `apiKeyAuth`'s
lookup is unchanged; `api_keys` gained `expires_at` and `oauth_token_id`
(migration 030), and `apiKeyAuth` answers `revoked_key` past the expiry.

The key is **recomputed, never stored**:

```
derived key = 'wa_' + base64url(HMAC-SHA256(introspection secret, access token))
```

Deterministic, so introspection reproduces it on every call and the MCP's
per-tenant bundle stays coherent for the session; unguessable without the server
secret; and safe even if that secret leaks, because a computed key only works if
its hash was written to `api_keys` at issuance.

`{ "active": true, "api_key": "wa_…", "scope": "audit", "sub": "…", "exp": … }`

**Minted for any authenticated account, subscribed or not** — the contract this
repo depends on. `requireProSession` on `POST /api/keys` did **not** need
relaxing: personal keys keep their existing rules and derived keys are a
separate path.

### 3. Deployment

Set `OAUTH_INTROSPECTION_SECRET` (the single switch — see that repo's
`.env.example`) and `OAUTH_ISSUER`, then apply migration 030 and redeploy. On
this side set `WA_OAUTH_ISSUER`, `WA_OAUTH_RESOURCE_URL` and
`WA_OAUTH_INTROSPECTION_SECRET` to match.

**Redeploy and rescan together.** The live box is still the 2026-08-11 build
serving 14 tools; `main` now has 15 (`get_gtm_plan`).

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
# The SPEC url — the one a conforming client builds, and the one that 404'd
# until it was fixed. Checking only the root form confirms the fallback and
# says nothing about the primary.
curl -s https://mcp.website-auditor.io/.well-known/oauth-protected-resource/mcp | jq
# expect: resource, authorization_servers, scopes_supported, bearer_methods_supported

# And the root form, which must answer the same document.
diff <(curl -s https://mcp.website-auditor.io/.well-known/oauth-protected-resource/mcp) \
     <(curl -s https://mcp.website-auditor.io/.well-known/oauth-protected-resource) && echo IDENTICAL

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
