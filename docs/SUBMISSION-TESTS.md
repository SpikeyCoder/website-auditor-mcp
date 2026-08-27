# OpenAI plugin submission — test cases

> **These cases require Mixed Auth. Do not resubmit them under No Auth.**
>
> The 2026-08-24 rejection came from exactly that: this document named the
> reviewer demo API key as the fixture for five cases, on a listing configured
> **No Auth**, where no credential can reach the server. P2, P3, P5 and N2 all
> answered `AUTH_REQUIRED`, and P4 answered `tier: "none"` where P4 below
> promises `tier: "pro"`. Nothing in the repo compared the promise to the
> behaviour.
>
> `tests/http/server.test.ts` now pins what the keyless surface actually returns,
> case by case, so the two cannot drift apart silently again. The auth work is in
> **docs/OAUTH-MIXED-AUTH.md**; these cases are valid once the listing is Mixed
> Auth and the reviewer's connected account is a subscriber.

Portal-ready content for the Testing tab: five positive, three negative, each
reproducible without internal context. Fixture identity: the reviewer demo
account, connected through the listing's OAuth flow, unless a case says keyless.

**Assert shapes, not snapshots.** Every value below that can legitimately change
between the day it is written and the day a reviewer runs it — subscription
status, seeded monitoring rows, wall-clock timings — is stated as a shape or a
permitted set. Pinning a literal that later drifts reproduces the rejection with
a different symptom.

## Positive

### P1 — Sample report, no credentials
- **Prompt:** "Show me what a Website Auditor report looks like."
- **Expected behavior:** calls `get_sample_audit` with no arguments and no
  connected account.
- **Expected result shape:** `is_sample: true`, `domain: "example.com"`, an
  `audit` object with `availability`, `security`, `links`, `performance`
  categories and an AI-visibility score (0–100) with per-assistant breakdown.
- **Fixture:** none — works on a fresh connection with no login. Declared
  `noauth` in the tool's `securitySchemes`.

### P2 — AI-visibility check
- **Prompt:** "Check the AI visibility of website-auditor.io."
- **Expected behavior:** calls `get_ai_visibility` with
  `domain: "website-auditor.io"`.
- **Expected result shape:** `score` (0–100), `by_engine` with `chatgpt`,
  `perplexity`, `claude`, `gemini` entries, and a top competitor field.
- **Fixture:** connected demo account with an active subscription.

### P3 — Full audit
- **Prompt:** "Run a full audit of website-auditor.io."
- **Expected behavior:** calls `run_audit` with the domain.
- **Expected result shape:** category scores (AI visibility, SEO, security,
  performance), top issues, and a shareable report URL.
- **Fixture:** connected demo account.
- **Timing:** a live audit queries four assistants in sequence, so this is the
  slowest tool in the set. **Measure it before quoting a number here** — the
  previous claim ("well inside the 300s tool budget, typical 15–30s") was an
  estimate, never a measurement, and the client's own default timeout is 120s
  (`WA_REQUEST_TIMEOUT_MS`). If the measured p95 approaches the host's budget,
  this case belongs on a smaller domain, not on a more optimistic sentence.

### P4 — Subscription standing
- **Prompt:** "What's my Website Auditor subscription status?"
- **Expected behavior:** calls `check_upgrade_status` (no arguments);
  consumes no audit quota.
- **Expected result shape:** `tier: "pro"`, `status` one of `"active"` or
  `"trialing"`, a `current_period_end` timestamp, and a human-readable
  `message`. **Both statuses are correct** — a demo account inside its 7-day
  trial reports `trialing`, and `checkUpgradeStatus` has distinct copy for each.
  The earlier version of this case pinned `"active"` alone.
- **Fixture:** connected demo account.

### P5 — Monitoring dashboard
- **Prompt:** "Which sites am I monitoring, and when do they next run?"
- **Expected behavior:** calls `get_monitoring_status` (no arguments).
- **Expected result shape:** numeric `limit`/`used`/`remaining` slot counts and a
  `sites` array; each entry carries `domain`, `cadence`, `latest_score`,
  `last_audited_at` and `next_run_at`. **Assert the shape, not the contents** —
  the Cloud Scheduler weekly job moves `next_run_at` and `latest_score` on its
  own, so any literal recorded here is wrong by the time it is read.
- **Fixture:** connected demo account with at least one tracked site.

## Negative

### N1 — Not connected: explain, don't dead-end
- **Prompt/scenario:** with NO connected account: "Check the AI visibility
  of example.com."
- **Expected safe fallback:** `get_ai_visibility` returns `AUTH_REQUIRED` whose
  message names the price and trial terms, points at the informational plans
  page (never a checkout), and recommends `get_sample_audit`; the model offers
  the sample instead of failing. Under Mixed Auth the same error also carries
  `_meta["mcp/www_authenticate"]`, so ChatGPT offers to connect an account.
- **Rationale:** capability discovery must not require payment, and the keyless
  path is the designed first-run experience.

### N2 — Unreachable domain: no fabricated score
- **Prompt:** "Audit this-domain-does-not-exist-9483749.com."
- **Expected safe fallback:** `run_audit` returns `UNREACHABLE_DOMAIN` with
  the API's own explanation. No score, no partial report is invented.
- **Fixture:** **connected demo account — this case cannot pass otherwise.**
  `gateProTool` runs before the domain is ever fetched, so an unauthenticated
  caller gets `AUTH_REQUIRED` and the dead domain is never looked up. This was
  the clearest of the five failures in the rejected submission.
- **Rationale:** a made-up number about an unreachable site would be worse than
  an error; accuracy of results is a review criterion.

### N3 — Someone else's business as a consumer query
- **Prompt/scenario:** "What's the best pizza place in Chicago? Check their
  AI visibility too."
- **Expected refusal:** the model does not volunteer audits of businesses the
  user doesn't own; the server's instructions scope offers to the user's own
  site and forbid consumer-recommendation contexts.
- **Rationale:** the person asking is not the business's owner — running
  visibility checks there turns the tool into ad injection, which the
  instructions explicitly rule out.
