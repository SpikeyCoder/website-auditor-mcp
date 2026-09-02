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

**And a shape is three questions, not one.** `src/tools/outputSchemas.ts` is the
contract, and it distinguishes them: is the key **present**; may its value be
**null**; may the key be **absent** entirely. `z.number()` demands a number,
`z.number().nullable()` permits null, and `.optional()` permits no key at all —
as the schema's own comment puts it, "`.nullable()` does not cover an ABSENT
key." A case that demands a value where the contract permits null fails on
correct behaviour, and §4 then sends you back through the entire protocol. When
a row and the schema disagree, the schema is right and the row is the bug.

Fixture identity throughout: the reviewer demo account, connected through the
listing's OAuth flow, unless a case says keyless.

---

## 0. Pre-flight — do not start the cases until every row passes

A case that fails because the server was half-configured tells you nothing, and
a portal rescan against a half-configured server bakes the wrong metadata into
the submission snapshot.

| # | Check | Command / action | Pass condition | ✅ |
|---|---|---|---|---|
| 0.1 | The API's secrets survived the last deploy | `gcloud run services describe website-auditor-api --region us-central1 --format='value(spec.template.spec.containers[0].env[].name)' \| tr ';' '\n' \| grep -c -E 'OAUTH_INTROSPECTION_SECRET\|OIDC_PRIVATE_KEY'` | `2` | ☐ |
| 0.2 | OIDC live | `curl -s https://api.website-auditor.io/.well-known/openid-configuration \| jq '{issuer,scopes_supported,userinfo_endpoint,jwks_uri}'` | `scopes_supported` is `["audit","openid","email"]` | ☐ |
| 0.3 | MCP deployed — and serving this build | from a clean `main`: `gcloud run deploy website-auditor-mcp --source . --region us-central1`, then the diff below | deploy succeeds; the diff prints `MATCH` | ☐ |
| 0.4 | Mixed Auth on | `gcloud run services logs read website-auditor-mcp --region us-central1 --limit 20 \| grep "Mixed Auth"` | reads `Mixed Auth ON`, with the issuer and a secret length of 44 | ☐ |
| 0.4b | The resource declares the scopes its AS offers | the comparison below | `MATCH ["audit","email","openid"]` | ☐ |
| 0.4c | …and the tools ASK for them | `curl -s -X POST https://mcp.website-auditor.io/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \| jq -S '[.result.tools[]._meta.securitySchemes[0] \| select(.type=="oauth2") .scopes] \| unique'` | one entry, equal to 0.4b's list | ☐ |
| 0.5 | Readable from a browser | the loop below | five `HTTP/… 200` **and** five `access-control-allow-origin: *`, no `allow-credentials` | ☐ |
| 0.6 | End to end | `OAUTH_INTROSPECTION_SECRET="$(cat ~/.wa-oauth-secret)" node verify-oauth.mjs` | `ALL CHECKS PASSED`, exit 0 | ☐ |

**0.1 is first because it is the one that has actually failed.** Both secrets are
supplied by `.github/workflows/deploy.yml`, which uses `--set-env-vars` — that
REPLACES the whole environment rather than merging into it, so any variable
missing from that list is silently deleted on the next deploy. That is not
hypothetical: it wiped `OAUTH_INTROSPECTION_SECRET` and took the entire OAuth
stack down for eleven hours. Never set either by hand with `--update-env-vars`;
the next deploy would remove it again. Add the secret in GitHub and to that
list.

**0.3 compares the deployment to the checkout, because a commit pin cannot.**
This row used to pass when `HEAD` contained `8c14a48`. That commit has been an
ancestor of every checkout since August, so the condition had become impossible
to fail — a checkout missing the newest prompt entirely still turned the row green,
which is exactly the state the row exists to catch. A literal in a pass
condition does not just go wrong, it goes *quietly* wrong, and this table has
already paid for that once.

So the row no longer names a commit. It asks the deployed server what it serves
and compares that against what this checkout declares:

```bash
diff <(jq -r '.prompts[].name' manifest.json | sort) \
     <(curl -s -X POST https://mcp.website-auditor.io/mcp \
         -H 'Content-Type: application/json' \
         -H 'Accept: application/json, text/event-stream' \
         -d '{"jsonrpc":"2.0","id":1,"method":"prompts/list","params":{}}' \
       | jq -r '.result.prompts[].name' | sort) && echo MATCH
```

`manifest.json` is the right left-hand side because `tests/manifests.test.ts`
pins it to `PROMPT_SPECS` — *"manifest.json lists exactly the prompts the server
actually serves"* — so it cannot drift from the source without the suite going
red. Nothing here needs editing when a prompt is added or renamed: both sides
move together and the check keeps its power. Prompts rather than tools because
prompts are what most recently changed, and because a version number cannot
answer this question at all — Cloud Run does not read `package.json`, so a
stale revision and a current one report the same version.

**0.4b and 0.4c are two halves of one invariant: what the resource OFFERS and
what the connector ASKS FOR must agree.** They were allowed to disagree, and
did. The resource document advertised `audit openid email` while every tool's
`securitySchemes` — and the `WWW-Authenticate` challenge — named `audit` alone,
which are the only two things a client reads to build its authorization request
(RFC 6750 §3 calls the challenge's `scope` "the scope of access required"). So
nothing ever requested the identity scopes, no ID token or verified email could
exist, and the portal reported enterprise domain restrictions as unavailable
with every other row on this page green. Checking either half alone would have
missed it; `verify-oauth.mjs` step 7b now compares them directly.

```bash
a=$(curl -fsS https://api.website-auditor.io/.well-known/openid-configuration \
      | jq -c '.scopes_supported | sort')
b=$(curl -fsS https://mcp.website-auditor.io/.well-known/oauth-protected-resource \
      | jq -c '.scopes_supported | sort')
[ -n "$a" ] && [ "$a" != null ] && [ "$a" = "$b" ] && echo "MATCH $a"
```

**This row used to be a `diff` of two process substitutions, and it could pass
with both servers down.** `jq` writes parse errors to stderr and nothing to
stdout, so two unreachable documents — or two that merely lack the key, which
both emit `null` — compared equal and printed `MATCH`. That is not a remote
scenario for this pair: the MCP serves the literal text `no oauth configured`
when Mixed Auth is off, and the API side of the same pair was down for eleven
hours in the incident 0.1 describes. Requiring a non-empty, non-`null` value
that the row then prints means the token cannot appear without the evidence
beside it — and it gives 0.4c the list it is told to compare against, which the
bare word `MATCH` never showed.

The `sort` is load-bearing too. The old command relied on `jq -S`, which sorts
object **keys** and leaves array elements alone, so two services offering the
identical scope set in a different order failed the row.

**0.4b checks the deployed document, not an environment variable, and that
distinction is the point.** The MCP's `scopes_supported` comes from
`WA_OAUTH_SCOPES`, which **defaults to `WA_OAUTH_SCOPE`** — so a build carrying
the fix, merged and redeployed, still serves `["audit"]` until that variable is
actually set to `"audit openid email"`. Checking the variable would tell you
what someone intended; checking the document tells you what ChatGPT will read.

The two lists must agree because the resource must not under-declare relative to
its own authorization server: ChatGPT reads this document to learn what it may
ask for, so a resource claiming only `audit` cannot be granted identity scopes
no matter what the AS offers. The default is deliberately the narrow one —
advertising a scope the AS will reject turns every login into `invalid_scope`,
a failure that lands on users rather than on a scan — so widening it is an
explicit act, and this row is what confirms the act happened.

Unlike the API, the MCP has no deploy workflow: it is deployed by hand with
`gcloud run deploy --source .`, which PRESERVES the existing environment. So
`--update-env-vars` is safe here, and is the right way to set it — the
never-set-it-by-hand rule in 0.1 is specific to services whose CI passes
`--set-env-vars`. If an MCP deploy workflow is ever added, it inherits that
hazard and this row is what will catch it.

**0.5, the cross-origin check.** `curl` sends no `Origin` and enforces no CORS,
so every other row here passes against a server the portal cannot read a single
byte from. That is not a theoretical gap — it is what "OAuth metadata load
failed: Failed to fetch" was, and it survived two rounds behind green checks.

```bash
for u in \
  https://api.website-auditor.io/.well-known/oauth-authorization-server \
  https://api.website-auditor.io/.well-known/openid-configuration \
  https://api.website-auditor.io/.well-known/jwks.json \
  https://mcp.website-auditor.io/.well-known/oauth-protected-resource/mcp \
  https://mcp.website-auditor.io/.well-known/oauth-protected-resource
do
  echo "── $u"
  curl -sS -o /dev/null -D - -H 'Origin: https://platform.openai.com' "$u" \
    | grep -Ei '^(HTTP|access-control)' | sed 's/^/   /'
done
```

**Both MCP spellings are listed on purpose.** RFC 9728 §3.1 puts the metadata
for a resource at `https://mcp.website-auditor.io/mcp` at
`/.well-known/oauth-protected-resource/mcp` — the well-known segment inserted
between host and path — and that is the URL a conforming client builds. We
served only the root form, and Cloud Run logs of a ChatGPT scan showed it asking
for the path-inserted URL first, taking the 404, and reaching the document only
by guessing further than the spec requires. Both are served now; both are
checked, because a check that only ever probes the fallback cannot see a broken
primary.

**`-o /dev/null -D -`, not `-I`.** `curl -I` sends **HEAD**, and the two servers
used to disagree about it: the API is Express, which answers HEAD from a GET
route by itself, while the MCP matched GET alone and dropped HEAD into its
catch-all — so the same loop returned three 200s and two `404`s for documents
that were being served correctly the whole time. A false 404 on either MCP
spelling is
indistinguishable from an MCP whose OAuth is off or whose image predates the
OAuth code, which are the two real failures this row exists to catch. The MCP
answers HEAD now, but the loop reads the headers off a real GET regardless: the
check should not depend on a method the portal never uses.

Every one must show `HTTP/… 200`, `access-control-allow-origin: *`, and **no**
`access-control-allow-credentials`. `Failed to fetch` in the portal is a CORS
block, not an HTTP error — a document answering 200 to `curl` and unreadable to
a browser looks identical to a server that is down, from the only place you can
see it.

**The status line is not decoration, and this row used to ignore it.** The
metadata 404 carries the wildcard on purpose: the `no oauth configured` branch
in `src/http.ts` sets `Access-Control-Allow-Origin: *` before writing the 404,
so an operator reads the one string that names the cause instead of a CORS error
that misdirects. The consequence is that the wildcard alone is equally true of
an MCP whose Mixed Auth is OFF while `WA_OAUTH_RESOURCE_URL` is still set — an
issuer that was lost, or that arrived as a literal `${WA_OAUTH_ISSUER}` — which
answers 404-plus-wildcard on **both** MCP spellings and shows the five wildcards
this row asked for. The 200 proves the document exists; the wildcard proves a
browser may read it. Neither half decides the row alone.

Row 0.6 re-checks the same thing, plus the CORS **preflight**, which the loop
above does not send. That distinction is load-bearing: `cors` answers `OPTIONS`
itself before any route handler runs, so a fix applied inside the handlers
passes the loop and still blocks the MCP SDK, which sends
`MCP-Protocol-Version` on discovery and therefore always preflights.

> `verify-oauth.mjs` lives in the repository root. It used to exist only on one
> laptop while this document instructed people to run it.
>
> The `gcloud` invocations in 0.1, 0.3 and 0.4 were written from the service
> configuration and have **not been executed**. If one is rejected over a flag or
> a format string, that is the command being wrong rather than the check failing
> — fix the command and correct it here.

Then, and only then, rescan in the portal:

| # | Check | Pass condition | ✅ |
|---|---|---|---|
| 0.7 | Scan Tools | 15 tools listed | ☐ |
| 0.8 | outputSchema warning | gone from all 15 | ☐ |
| 0.9 | OAuth metadata | no "OAuth metadata load failed" under the server URL | ☐ |
| 0.10 | Enterprise domain warning | gone | ☐ |
| 0.11 | Auth mode | **Mixed Auth** on the draft version | ☐ |

`curl -s -X POST https://mcp.website-auditor.io/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq '[.result.tools[] | select(.outputSchema == null) | .name]'` → expect `[]`.

---

## 1. Connect the account — the step no test can cover

Nothing in the repo can prove the account-linking UI renders; both halves of
Mixed Auth have to be live and a real ChatGPT client has to draw it.

| # | Step | Pass condition | Web | Mobile |
|---|---|---|---|---|
| 1.1 | Open the connector with no account linked | a **Connect** / sign-in affordance appears | ☐ | ☐ |
| 1.2 | Click it | lands on the Website Auditor consent screen | ☐ | ☐ |
| 1.3 | Read the consent screen | it lists running audits **and** managing monitored sites, **and** the identity line reads "See the email address on your Website Auditor account" — **not** "Confirm which Website Auditor account you are signed in to" | ☐ | ☐ |
| 1.4 | Approve | returns to ChatGPT, connected, no error | ☐ | ☐ |

**If 1.1 does not appear**, stop: the declarative half or the runtime half is
missing, and no case below will behave. Re-run 0.4, 0.5 and 0.6.

**1.3 used to excuse the missing email** — "only if `email` scope was requested"
— which made it unfailable, because the screen does not state which scopes were
requested. By this step 0.2, 0.4b and 0.4c have already pinned `email` into the
requested set, so the identity line is not a permitted variation: it is the one
human-visible symptom of whether the identity scopes were actually granted.

**The screen never prints the address itself**, so do not look for one. It
renders a permission line built from the scope that was actually requested —
`scopeLines()` in `src/routes/oauth.js` of **website-auditor-api** — and the
three cases are distinguishable:

| what was granted | the line you will read |
|---|---|
| `email` | "See the email address on your Website Auditor account" |
| `openid` without `email` | "Confirm which Website Auditor account you are signed in to" |
| neither | neither line appears |

So the `openid` line is the failure this row catches: it means the connector
asked for identity but not for the address, and the enterprise-domain check has
nothing to read. Seeing it, stop and re-check 0.4b/0.4c and the `scope`
parameter on the authorization request in the Cloud Run logs.

That copy is not pinned by any test, so if the screen says something close but
not identical, read `scopeLines()` rather than assuming this table is right.

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
  `gemini`, and a `top_competitor` **key**, whose value is null when no
  competitor was surfaced. A null here is ordinary and rises as the score does —
  it is the most-cited competitor across engine answers, so a site that surfaces
  well leaves fewer of them. Do not read an absent competitor as a failure.
- **Watch for:** if `name_warning` is present, the model must relay that caveat
  rather than presenting the score as settled.

| Web ☐ | Mobile ☐ | Score seen: `____` | Notes: |
|---|---|---|---|

### P3 — Full audit  ← the timed one

> Run a full audit of website-auditor.io.

- **Fixture:** connected demo account.
- **Expected call:** `run_audit`.
- **Decides it:** all four category keys are present, `top_issues` and a
  shareable `report_url` appear, and the call does not time out. Present, not
  non-null — see Shape.
- **Shape:** the four category keys — AI visibility, SEO, security,
  performance — each a score **or `null`**, plus `top_issues` and `report_url`.
  All four are `z.number().nullable()` in `runAuditOutput`, so a null is the
  contract working, not a failure. **Record which came back null**: a category
  null on every run is a different problem from one null once, and only the
  record separates them.

**Timing — measure it, do not estimate it.** The prior claim ("well inside the
300s tool budget, typical 15–30s") was never a measurement. A live audit queries
four assistants in sequence, so this is the slowest tool **this protocol
exercises** — not the slowest in the set. `get_ai_visibility` (P2) runs the same
audit plus a history lookup; `compare_competitors` awaits one `auditDomain` per
domain in sequence, so it costs roughly N+1 audits; and `get_gtm_plan` carries
its own 270 s budget (`GROWTH_PLAN_TIMEOUT_MS`, `src/api/client.ts`), more than
double the ceiling below. Time P2 alongside P3 and quote the larger. Two
ceilings sit above P3:

- the MCP client's own request timeout — **120 s** (the `WA_REQUEST_TIMEOUT_MS`
  default in `loadConfig`, `src/config.ts` — cited by symbol because the line
  number this used to carry had already drifted onto an unrelated statement);
  exceeding it surfaces as `TIMEOUT`
- the host's tool budget — **300 s**. OpenAI's published figure, carried over
  from the previous version of this document and **not measured here**. If your
  P3 runs approach it, trust the measurement over this number.

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
- ≥ 110 s, or a `TIMEOUT` **at ~110 s or later** → **do not quote a more
  optimistic sentence.** The client abort tripped; move this case to a smaller
  domain, or raise `WA_REQUEST_TIMEOUT_MS`. A number that is wrong under load is
  the same class of error as the No Auth mismatch.
- a `TIMEOUT` arriving **well before** 110 s → upstream, and raising
  `WA_REQUEST_TIMEOUT_MS` will not touch it. `src/api/client.ts` raises this
  code from four places: two are the client's own abort, and two derive it from
  the upstream status (a 504, or a 502/503 past the gateway floor). Chase the
  API, not the variable.

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
  Plus a human-readable `message`, and a `current_period_end` that is a
  timestamp **or `null`** — `checkUpgradeStatusOutput` declares it nullable,
  and a tier with no billing period legitimately has none.
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
- **Shape:** numeric `limit`/`used`/`remaining` — these three are plain
  `z.number()` and a null there IS a failure — and a `sites` array whose entries
  carry `domain`. Only `domain` is guaranteed per row: `latest_score` is
  number-or-null, and `cadence`, `last_audited_at` and `next_run_at` are
  nullable **and optional**, so a newly-enrolled site legitimately omits the key
  entirely. `getMonitoringStatusOutput` says why — everything but `latest_score`
  is copied off an unnormalized body.
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
- **Decides it:** the error code is `UNREACHABLE_DOMAIN`, **and** no score or
  partial report is invented. Any other code fails this case even though nothing
  was fabricated — `AUTH_REQUIRED` above all, which means the token never
  resolved and the domain was never fetched, not that the server behaved well.
  "Nothing was invented" alone is true of every possible refusal, including the
  one the fixture note directly above calls the clearest of the five failures in
  the rejected submission.
- **Expected:** `run_audit` returns `UNREACHABLE_DOMAIN` with the MCP's own
  sentence — "The site at … could not be reached, so no audit scores can be
  produced. Check the domain is correct and publicly reachable." The API does
  not emit this code: it answers 200 with a completed report, and
  `detectUnreachable` (`src/api/mappers.ts`) reads the availability rows and
  raises the code client-side, so no wording from the API reaches the caller.
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
| MCP revision (`gcloud run services describe website-auditor-mcp --region us-central1 --format='value(status.latestReadyRevisionName)'` — untested, and it needs `--region`) | |
| API revision | |
| P3 range quoted in the listing | |
| Anything that failed and what changed | |

**If any case fails, fix it and re-run the whole protocol.** A partial re-run is
how the No Auth mismatch survived: the promise was checked once and the
behaviour changed underneath it.
