# API gaps — what the MCP needs from `website-auditor-api`

Findings from reading `SpikeyCoder/website-auditor-api` (the Node/Express API
portal) and `SpikeyCoder/chaos_tester` (the Flask audit engine it proxies).
This closes the PRD's "open questions" with specifics and lists what each
Phase-0/1 tool needs.

## What exists today (and the MCP uses)

- **`GET /api/audit?businessUrl=&businessName=&businessCity=`** — the only live,
  API-key-authed endpoint. Auth via `X-API-Key` (`wa_` prefix, SHA-256 hashed in
  Supabase `api_keys`). Hard rate limit of **10 requests/key/day** (`increment_rate_limit`
  RPC) → `429` with a `rate_limit` object. Triggers the Flask engine's `POST /run`,
  polls `/api/status`, returns `/report/<run_id>/json`.
  Response envelope: `{ success, request_id, run_id, timestamp, duration_ms, audit }`
  where `audit` is `TestRun.to_dict()`:
  ```
  { run_id, base_url, environment, started_at, finished_at, duration_s, status,
    summary: { total, passed, failed, warnings, errors, pass_rate },
    results: [ { test_id, module, name, status, severity, url, details, recommendation, ... } ],
    performance_metrics: {},
    ai_visibility: { overall_score, platform_scores: { ChatGPT|Perplexity|Claude|Gemini: { score, appearances, total, results[] } },
                     business_info, queries, site_signals, is_simulated, has_api_key, ... } }
  ```
  `modules/ai_visibility.py` confirms the four engines and the 0–100 scoring;
  scores are Perplexity-backed with per-engine variance, and fall back to
  `is_simulated: true` when `PERPLEXITY_API_KEY` is absent.

## Gaps (blocking / needed)

### 1. API-key-authed subscription check — **RESOLVED (PRD open question #1)**
Shipped in website-auditor-api **PR #7**: `GET /api/subscription` (X-API-Key
authed via `apiKeyAuth`, mounted at `/api`). It reads the same Supabase
`subscriptions` table as the web session (`resolveSubscription` in
`services/subscriptions.js`, statuses `active`/`trialing` ⇒ Pro) and returns
`{ success, tier, status, current_period_end, cancel_at_period_end }`. `401` on a
missing/invalid/revoked key; `500` on a lookup failure. It surfaces the real
`status` so "never subscribed" (`none`) is distinguishable from "lapsed"
(`canceled`/`past_due`).
**MCP wiring (live):** `client.getSubscription()` calls it and maps
`status ∈ {active,trialing}` ⇒ `pro`. `DefaultSubscriptionProvider` caches the
tier per key (`WA_SUBSCRIPTION_CACHE_TTL_MS`, default 60s) and, on an endpoint
outage, honors the last-known cached tier or defaults to `free` **flagged
unverified** (Pro tools then return `SUBSCRIPTION_UNVERIFIED`, not a false
`PRO_REQUIRED`). `WA_DEV_TIER` remains only as an explicit local override.

### 2. No AI-visibility deltas / history by API key — **PRD open question #2 (blocking for P1)**
`get_changes` needs "what changed since last check." The Flask app has
`GET /api/domain-history/<domain>` returning history rows
`[{ id, domain, base_url, started_at, finished_at, duration_s, status, overall_score,
total_tests, passed, failed, warnings, errors }]`, **but**:
- it's on website-auditor.io (Flask), not the API portal, and is **not API-key-authed**;
- it returns audit-level scores, not the per-engine AI-visibility scores the tool
  compares.

**RESOLVED:** the portal shipped API-key-authed (Pro-gated)
`GET /api/ai-visibility-history?domain=&since=&limit=` returning oldest-first
snapshots `{ captured_at, run_id, score, by_engine: {chatgpt, perplexity,
claude, gemini}, is_simulated, source, question }` — one row per interactive
audit plus one per weekly scheduled run for tracked domains and one per
extension scan. `source` (the writer) and `question` (what the run asked: the
business name looked for and the queries, with `question.key` saying when two
snapshots asked the same one) were added in 2026-09 (website-auditor-api
migration 034); rows stored before then carry `question: null`.
**MCP wiring (live):** `client.getChanges()` reads it and collapses to a delta
via `computeChanges`, only between measured snapshots whose `question.key`s
match (`sameQuestion` in `src/api/mappers.ts`) and whose answering engine sets
match (`sameEngines` there, the weekly digest's own rule in
website-auditor-api `src/services/digest.js`: an overall is averaged over the
engines that answered, so a different answering set is a different quantity —
the API's pull surfaces hand raw snapshots and pairs without deciding this,
only the digest does, server-side, so the MCP re-checks from `by_engine`,
nulls and missing keys both reading as silence, and returns `score_delta:
null` with an `overall_note` naming which engines answered each snapshot,
the per-engine changes still reported), over the domain's series as
`/api/monitoring-status` reads it (`seriesOf`: the measured weekly re-audits and
whatever asked the same question as the newest recorded one, while the series has no gap longer than four weeks
and a day from the newest weekly re-audit that recorded its question, through each
later snapshot of the series, weekly re-audits included, to the newest measured
snapshot), skipping simulated snapshots and weekly
re-audits that measured nothing of the business. It reads the whole history and
applies `since` itself, because which snapshots form the series depends on weekly
re-audits older than any window. It throws `NOT_YET_AVAILABLE` below two
measured snapshots, when the series is one measured re-audit with nothing
measured before it, and when the series has nothing since `since` (no `details`
on those three); when the series' latest records no question (`details.reason:
"question_not_recorded"`); and when no earlier snapshot asked its question
(`"question_changed"`, or `"earlier_not_recorded"` when no earlier snapshot
records its question, with `rebaselined_at` unless `since` narrowed the window;
`"not_in_window"` when one did, but only before the window). Those with a
`reason` carry `previous_change` when there is one: the weekly series' most
recent like-for-like change before the latest, or, when the series has none,
the most recent among all earlier measured snapshots. A refusal that leaves
newer snapshots out of the series names them, and the most recent like-for-like
change among them. The result's `note` and every refusal also name the weekly
re-audits newer than the series' latest that measured nothing of the business
(`source: "scheduled_unmeasured"`), read from the same response whether or not
they stored a score (a declined page, an invented name scoring 0 and a run no
engine answered carry `score: null`): no comparison uses them, and unnamed, an
older change reads as current. Below two measured snapshots, the refusal names
those newer than the newest measured snapshot, or every one when there is none.
A `since` that does not parse is `INVALID_INPUT`.
`client.getAiVisibilityHistory()` (1.0.4) returns the raw series, which
`get_ai_visibility` folds into 7/30-day `trend` windows for Pro callers: for the
question the audit just run asked, ending at its snapshot (matched by `run_id`),
between measured snapshots that asked it (`computeTrend`); null, with a
`trend_note`, when that audit stored no measured snapshot.

### 2b. Trial eligibility — live again (trial restored 2026-08-04)
The 7-day trial returned on 2026-08-04 (removed 2026-07-27), and the
session-authed `GET /stripe/subscription-status` reports `eligible_for_trial`
truthfully again (12-month re-use window on `api_users.trial_used_at`). The
once-proposed `eligible_for_trial` addition to the key-authed
`GET /api/subscription` is a REAL gap now: `check_upgrade_status` cannot see
eligibility, so its upsell says "eligible new customers **may** receive a
trial" rather than promising one — checkout tells the caller the truth.
Worth building if trial-aware MCP upsell copy ever needs to be exact.
`trialing` keeps resolving to tier `pro`, and `check_upgrade_status` keeps its
`trialing` message branch.

### 3. No dedicated competitor-comparison endpoint
Nothing computes head-to-head scores across domains. The audit's
`ai_visibility.platform_scores[].results[].competitors` lists competitor *names*
but there's no multi-domain comparison.
**MCP behavior today:** `compare_competitors` **fans out one `runAudit` per
domain** and builds the ranking + per-engine gaps from live data — a genuine
implementation, but each domain consumes an audit against the 10/day quota. To
avoid exhausting the day in one call, the tool is quota-aware: it reads the
remaining quota (pre-flight where possible, otherwise from each audit's
`X-RateLimit-Remaining` header), reuses recent cached audits, caps the fan-out
to what's available, and returns a `quota` block + `skipped` list naming any
competitors it couldn't audit — never silently dropping them or fabricating
scores. Zero remaining quota is an actionable `OVER_QUOTA` error.
**Nice to have:** a batch/compare endpoint to audit N domains for one quota unit,
and a no-audit-cost way to read remaining quota up-front. (The now-live
`GET /api/subscription` reports tier/status only — no quota block — so
`getRemainingQuota()` returns `null` and the fan-out still learns the remaining
quota from each audit's `X-RateLimit-Remaining` header. Adding a quota field to
that endpoint, or a dedicated quota endpoint, would let the tool pre-flight.)

## Smaller mismatches (worked around, worth fixing)

- **`/api/audit` required `businessName` and `businessCity`** (a naive
  `if (!businessCity)` check), so the client once derived a name from the domain
  and sent a one-space city. **Resolved, and that workaround was harmful:** a
  sent name replaces the one the engine detects and is trusted as confirmed. API
  PR #42 made both optional, the client now sends each only when its caller
  supplies one (`setIfProvided` in `src/api/client.ts`), and
  website-auditor-api#100 ignores the name that builds before 1.0.14 made up.
- **No dedicated SEO / security / performance 0–100 scores** in the report.
  `run_audit` derives them: `security`/`performance` from each module's pass-rate,
  and `seo` as an explicit **proxy** from `ai_visibility.site_signals` (structured
  data, meta description, sitemap, robots access). AI-visibility is the real
  `overall_score`. Documented as a proxy in `toAuditSummary`.
- **No AI-visibility-only endpoint.** `get_ai_visibility` runs the full audit and
  extracts the `ai_visibility` block. A lighter endpoint would make the free tool
  cheaper and faster.
- **"Free without a key" is not possible today.** The PRD/listing says a free
  check needs no account, but `/api/audit` returns `401` without a valid `wa_`
  key. The MCP therefore returns `AUTH_REQUIRED` (not a silent failure) when no
  key is set. Either mint anonymous/free keys or add an unauthenticated,
  tightly-rate-limited teaser endpoint to honor the "no account" promise.
- **Unreachable domains** are not signaled as a distinct error by `/api/audit`.
  A domain that does not resolve is refused by the engine before any audit
  runs (a `400`, relayed; the MCP reports `INVALID_INPUT` with the engine's
  "We couldn't find that domain" in `details`). A domain that resolves but
  whose pages never load gets `200` with availability failures in `results`. The MCP detects this
  (`detectUnreachable`) from the availability module's "Page load:" rows: when
  there are some and none passed or warned, no page loaded, and it returns
  `UNREACHABLE_DOMAIN` instead of a fabricated score (and compare_competitors
  stops before auditing any competitor). It used to also require a failed row
  whose remedy said "connectivity or DNS"; the engine stopped writing that in
  chaos_tester #429, so from then until this change nothing was ever detected.
  It is the API's own rule for a site that never loaded
  (website-auditor-api `trialSeeding.siteLoaded`).

### 4. No free API tier (2026-07-26, api PR #17)
Every key-authed capability upstream — including `GET /api/audit` — now
requires an active/trialing subscription; key minting/rotation is
subscription-gated in the portal too. The MCP retiered `get_ai_visibility` and
`run_audit` to Pro in 1.0.5, gates all tools client-side pre-flight (saving
the round-trip the server would 403), and retired the vestigial client-side
free meter. `GET /api/subscription` remains open to any valid key so
`check_upgrade_status` and the tier resolver can report a lapsed caller's
standing.
