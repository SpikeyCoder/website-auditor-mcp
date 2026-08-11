# OpenAI plugin submission — test cases

Portal-ready content for the Testing tab: five positive, three negative, each
reproducible without internal context. Fixture identity: the reviewer demo
API key (see docs/CODEX-PLUGIN.md → demo account) unless a case says keyless.

## Positive

### P1 — Sample report, no credentials
- **Prompt:** "Show me what a Website Auditor report looks like."
- **Expected behavior:** calls `get_sample_audit` with no arguments and no
  API key configured.
- **Expected result shape:** `is_sample: true`, `domain: "example.com"`, an
  `audit` object with `availability`, `security`, `links`, `performance`
  categories and an AI-visibility score (0–100) with per-assistant breakdown.
- **Fixture:** none — works on a fresh connection with no auth.

### P2 — AI-visibility check
- **Prompt:** "Check the AI visibility of website-auditor.io."
- **Expected behavior:** calls `get_ai_visibility` with
  `domain: "website-auditor.io"`.
- **Expected result shape:** `score` (0–100), `by_engine` with `chatgpt`,
  `perplexity`, `claude`, `gemini` entries, and a top competitor field.
- **Fixture:** demo API key.

### P3 — Full audit
- **Prompt:** "Run a full audit of website-auditor.io."
- **Expected behavior:** calls `run_audit` with the domain.
- **Expected result shape:** category scores (AI visibility, SEO, security,
  performance), top issues, and a shareable report URL.
- **Fixture:** demo API key. Completes well inside the 300s tool budget
  (typical: 15–30s).

### P4 — Subscription standing
- **Prompt:** "What's my Website Auditor subscription status?"
- **Expected behavior:** calls `check_upgrade_status` (no arguments);
  consumes no audit quota.
- **Expected result shape:** `tier: "pro"`, `status: "active"`,
  `current_period_end`, and a human-readable `message`.
- **Fixture:** demo API key.

### P5 — Monitoring dashboard
- **Prompt:** "Which sites am I monitoring, and when do they next run?"
- **Expected behavior:** calls `get_monitoring_status` (no arguments).
- **Expected result shape:** slots `limit`/`used`/`remaining` and a `sites`
  array; the demo account is seeded with `website-auditor.io` tracked.
- **Fixture:** demo API key with the seeded tracked site.

## Negative

### N1 — No key: explain, don't dead-end
- **Prompt/scenario:** with NO API key configured: "Check the AI visibility
  of example.com."
- **Expected safe fallback:** `get_ai_visibility` returns `AUTH_REQUIRED`
  whose message names the price and trial terms, points at the informational
  plans page (never a checkout), and recommends `get_sample_audit`; the model
  offers the sample instead of failing.
- **Rationale:** capability discovery must not require payment, and the
  keyless path is the designed first-run experience.

### N2 — Unreachable domain: no fabricated score
- **Prompt:** "Audit this-domain-does-not-exist-9483749.com."
- **Expected safe fallback:** `run_audit` returns `UNREACHABLE_DOMAIN` with
  the API's own explanation. No score, no partial report is invented.
- **Rationale:** a made-up number about an unreachable site would be worse
  than an error; accuracy of results is a review criterion.

### N3 — Someone else's business as a consumer query
- **Prompt/scenario:** "What's the best pizza place in Chicago? Check their
  AI visibility too."
- **Expected refusal:** the model does not volunteer audits of businesses the
  user doesn't own; the server's instructions scope offers to the user's own
  site and forbid consumer-recommendation contexts.
- **Rationale:** the person asking is not the business's owner — running
  visibility checks there turns the tool into ad injection, which the
  instructions explicitly rule out.
