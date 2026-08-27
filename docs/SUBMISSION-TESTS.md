# OpenAI plugin submission — test protocol

> **These cases require Mixed Auth. Do not resubmit them under No Auth.**
>
> The 2026-08-24 rejection came from exactly that: this document named the
> reviewer demo API key as the fixture for five cases, on a listing configured
> **No Auth**, where no credential can reach the server. P2, P3, P5 and N2 all
> answered `AUTH_REQUIRED`, and P4 answered `tier: "none"` where P4 below
> promises `tier: "pro"`. Nothing in the repo compared the promise to the
> behaviour.
>
> `tests/http/server.test.ts` now pins what the keyless surface actually
> returns, case by case, so the two cannot drift apart silently again. The auth
> work is in **docs/OAUTH-MIXED-AUTH.md**.

This is a **fill-in protocol**, not prose. Run it top to bottom on web, then
again on mobile, and record what you saw. Every case names the ONE observation
that decides it, so a run is mechanical rather than a judgement call.

**Assert shapes, not snapshots.** Every value that can legitimately change
between the day it is written and the day a reviewer runs it — subscription
status, seeded monitoring rows, wall-clock timings — is stated as a shape or a
permitted set. Pinning a literal that later drifts reproduces the rejection with
a different symptom.

Fixture identity throughout: the reviewer demo account, connected through the
listing's OAuth flow, unless a case says keyless.

---

## 0. Pre-flight — do not start the cases until all five pass

A case that fails because the server was half-configured tells you nothing, and
a portal rescan against a half-configured server bakes the wrong metadata into
the submission snapshot.

| # | Check | Command / action | Pass condition | ✅ |
|---|---|---|---|---|
| 0.1 | OIDC key set | `gcloud run services update website-auditor-api --region us-central1 --update-env-vars "OIDC_PRIVATE_KEY=$(cat ~/.wa-oidc-key)"` | command succeeds, new revision serving | ☐ |
| 0.2 | OIDC live | `curl -s https://api.website-auditor.io/.well-known/openid-configuration \| jq '{issuer,scopes_supported,userinfo_endpoint,jwks_uri}'` | `scopes_supported` is `["audit","openid","email"]` | ☐ |
| 0.3 | MCP deployed | from a clean `main`: `git rev-parse --short HEAD` then `gcloud run deploy website-auditor-mcp --source . --region us-central1` | HEAD contains `8c14a48`; deploy succeeds | ☐ |
| 0.4 | Mixed Auth on | `gcloud run services logs read website-auditor-mcp --region us-central1 --limit 20 \| grep "Mixed Auth"` | reads `Mixed Auth ON`, with the issuer and a secret length of 44 | ☐ |
| 0.5 | End to end | `OAUTH_INTROSPECTION_SECRET="$(cat ~/.wa-oauth-secret)" node verify-oauth.mjs` | `ALL CHECKS PASSED` (24 checks) | ☐ |

Then, and only then, rescan in the portal:

| # | Check | Pass condition | ✅ |
|---|---|---|---|
| 0.6 | Scan Tools | 15 tools listed | ☐ |
| 0.7 | outputSchema warning | gone from all 15 | ☐ |
| 0.8 | Enterprise domain warning | gone | ☐ |
| 0.9 | Auth mode | **Mixed Auth** on the draft version | ☐ |

`curl -s -X POST https://mcp.website-auditor.io/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq '[.result.tools[] | select(.outputSchema == null) | .name]'` → expect `[]`.

---

## 1. Connect the account — the step no test can cover

Nothing in the repo can prove the account-linking UI renders; both halves of
Mixed Auth have to be live and a real ChatGPT client has to draw it.

| # | Step | Pass condition | Web | Mobile |
|---|---|---|---|---|
| 1.1 | Open the connector with no account linked | a **Connect** / sign-in affordance appears | ☐ | ☐ |
| 1.2 | Click it | lands on the Website Auditor consent screen | ☐ | ☐ |
| 1.3 | Read the consent screen | it lists running audits **and** managing monitored sites; it names the email address only if `email` scope was requested | ☐ | ☐ |
| 1.4 | Approve | returns to ChatGPT, connected, no error | ☐ | ☐ |

**If 1.1 does not appear**, stop: the declarative half or the runtime half is
missing, and no case below will behave. Re-run 0.4 and 0.5.

> **Record the client identity ChatGPT sends** (visible in Cloud Run logs as the
> `client_name` on the consent screen). Our authorization server issues public
> clients via Dynamic Client Registration with
> `token_endpoint_auth_method: "none"`. If the portal instead demanded a
> pre-registered client ID and secret, note that here — it needs a code change,
> not a form entry.
>
> Observed client_name: `________________`

---

## 2. Positive cases

Run each prompt **verbatim**. Record the tool the model actually called, not the
one you expected.

### P1 — Sample report, no credentials

> Show me what a Website Auditor report looks like.

- **Fixture:** none — a fresh connection with no login. Declared `noauth`.
- **Expected call:** `get_sample_audit`, no arguments.
- **Decides it:** the response says plainly that this is **sample data for
  example.com**, and is not presented as a result for any site the user asked
  about.
- **Shape:** `is_sample: true`, `domain: "example.com"`, an `audit` object with
  `availability`, `security`, `links`, `performance` and an AI-visibility score
  0–100 with a per-assistant breakdown.

| Web ☐ | Mobile ☐ | Tool actually called: `______________` | Notes: |
|---|---|---|---|

### P2 — AI-visibility check

> Check the AI visibility of website-auditor.io.

- **Fixture:** connected demo account, active subscription.
- **Expected call:** `get_ai_visibility`, `domain: "website-auditor.io"`.
- **Decides it:** a numeric score **and** a per-engine breakdown both appear.
- **Shape:** `score` 0–100, `by_engine` with `chatgpt`, `perplexity`, `claude`,
  `gemini`, and a top-competitor field.
- **Watch for:** if `name_warning` is present, the model must relay that caveat
  rather than presenting the score as settled.

| Web ☐ | Mobile ☐ | Score seen: `____` | Notes: |
|---|---|---|---|

### P3 — Full audit  ← the timed one

> Run a full audit of website-auditor.io.

- **Fixture:** connected demo account.
- **Expected call:** `run_audit`.
- **Decides it:** category scores, top issues, and a shareable report URL all
  appear, and the call does not time out.
- **Shape:** AI visibility / SEO / security / performance scores, `top_issues`,
  `report_url`.

**Timing — measure it, do not estimate it.** The prior claim ("well inside the
300s tool budget, typical 15–30s") was never a measurement. A live audit queries
four assistants in sequence, so this is the slowest tool in the set, and two
ceilings sit above it:

- the MCP client's own request timeout — **120 s** (`WA_REQUEST_TIMEOUT_MS`
  default, `src/config.ts:240`); exceeding it surfaces as `TIMEOUT`
- the host's tool budget — **300 s**

Run it **five times** and record each wall-clock duration, start of the tool call
to the answer. Mobile separately: the rejection named mobile.

| Run | Web (s) | Mobile (s) |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |
| 5 | | |
| **max** | | |

**Decision rule:**

- max < 60 s → quote the observed range in the listing; no change needed.
- 60–110 s → quote it, but say so plainly; it is close enough to the 120 s
  client timeout that a slow day will trip it.
- ≥ 110 s, or any `TIMEOUT` → **do not quote a more optimistic sentence.** Move
  this case to a smaller domain, or raise `WA_REQUEST_TIMEOUT_MS`. A number that
  is wrong under load is the same class of error as the No Auth mismatch.

Observed range to put in the listing: `________________`

### P4 — Subscription standing

> What's my Website Auditor subscription status?

- **Fixture:** connected demo account.
- **Expected call:** `check_upgrade_status`, no arguments. **Consumes no audit
  quota.**
- **Decides it:** `tier: "pro"`.
- **Shape:** `status` is `"active"` **or** `"trialing"` — both are correct, and
  the tool has distinct copy for each; a demo account inside its 7-day trial
  reports `trialing`. An earlier version of this case pinned `"active"` alone.
  Plus a `current_period_end` timestamp and a human-readable `message`.
- **Watch for:** `tier: "none"` here means the OAuth token did not resolve to
  the account — that is the rejection's failure mode returning, not a
  subscription problem.

| Web ☐ | Mobile ☐ | tier: `____` status: `____` | Notes: |
|---|---|---|---|

### P5 — Monitoring dashboard

> Which sites am I monitoring, and when do they next run?

- **Fixture:** connected demo account with at least one tracked site.
- **Expected call:** `get_monitoring_status`, no arguments.
- **Decides it:** slot counts and a per-site list both appear.
- **Shape:** numeric `limit`/`used`/`remaining`; a `sites` array whose entries
  carry `domain`, `cadence`, `latest_score`, `last_audited_at`, `next_run_at`.
  **Assert the shape, not the contents** — the weekly Cloud Scheduler job moves
  `next_run_at` and `latest_score` on its own, so any literal recorded here is
  wrong by the time it is read.
- **Watch for:** the string `undefined` anywhere in the summary (e.g. "AI
  visibility undefined/100"). That was a real defect, fixed in `8c14a48`; seeing
  it again means the MCP deploy did not take.

| Web ☐ | Mobile ☐ | Sites listed: `____` | Notes: |
|---|---|---|---|

---

## 3. Negative cases

### N1 — Not connected: explain, don't dead-end

**Scenario:** with **no** connected account: "Check the AI visibility of example.com."

- **Decides it:** the model offers the **sample** instead of dead-ending, and
  ChatGPT offers to connect an account.
- **Expected:** `get_ai_visibility` returns `AUTH_REQUIRED` whose message names
  the price and trial terms, points at the informational plans page (**never a
  checkout**), and recommends `get_sample_audit`. Under Mixed Auth the same
  error also carries `_meta["mcp/www_authenticate"]`, which is what makes
  ChatGPT surface the connect affordance.
- **Rationale:** capability discovery must not require payment, and the keyless
  path is the designed first-run experience.

| Web ☐ | Mobile ☐ | Connect offered? ☐ | Sample offered? ☐ |
|---|---|---|---|

### N2 — Unreachable domain: no fabricated score

> Audit this-domain-does-not-exist-9483749.com.

- **Fixture:** **connected demo account — this case cannot pass otherwise.**
  `gateProTool` runs before the domain is ever fetched, so an unauthenticated
  caller gets `AUTH_REQUIRED` and the dead domain is never looked up. This was
  the clearest of the five failures in the rejected submission.
- **Decides it:** no score and no partial report is invented.
- **Expected:** `run_audit` returns `UNREACHABLE_DOMAIN` with the API's own
  explanation.
- **Rationale:** a made-up number about an unreachable site would be worse than
  an error; accuracy of results is a review criterion.

| Web ☐ | Mobile ☐ | Error code seen: `______________` | Any number invented? ☐ |
|---|---|---|---|

### N3 — Someone else's business as a consumer query

> What's the best pizza place in Chicago? Check their AI visibility too.

- **Decides it:** the model does **not** volunteer an audit of a business the
  user does not own.
- **Expected:** the server's instructions scope offers to the user's own site
  and forbid consumer-recommendation contexts.
- **Rationale:** the person asking is not the business's owner — running
  visibility checks there turns the tool into ad injection, which the
  instructions explicitly rule out.

| Web ☐ | Mobile ☐ | Did it offer an audit anyway? ☐ | Notes: |
|---|---|---|---|

---

## 4. Sign-off

Resubmit only when every box above is ticked on **both** surfaces.

| Item | Value |
|---|---|
| Date run | |
| ChatGPT web build | |
| Mobile OS + app version | |
| MCP revision (`gcloud run services describe website-auditor-mcp --format='value(status.latestReadyRevisionName)'`) | |
| API revision | |
| P3 range quoted in the listing | |
| Anything that failed and what changed | |

**If any case fails, fix it and re-run the whole protocol.** A partial re-run is
how the No Auth mismatch survived: the promise was checked once and the
behaviour changed underneath it.
