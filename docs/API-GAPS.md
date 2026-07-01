# API gaps — what the MCP needs from `website-auditor-api`

Findings from reading `SpikeyCoder/website-auditor-api` (the Node/Express API
portal) and `SpikeyCoder/chaos_tester` (the Flask audit engine it proxies).
This closes the PRD's "open questions" with specifics and lists what each
Phase-0/1 tool needs.

## What exists today (and the MCP uses)

- **`GET /api/audit?businessUrl=&businessName=&businessCity=`** — the only live,
  API-key-authed endpoint. Auth via `X-API-Key` (`wa_` prefix, SHA-256 hashed in
  Supabase `api_keys`). Hard rate limit of **5 requests/key/day** (`increment_rate_limit`
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
- it returns audit-level scores, not the per-engine AI-visibility deltas the tool
  promises (engine gained/lost, competitor moves).

**Needed:** an API-key-authed `GET /api/changes?domain=&since=` (or expose
domain-history through the portal) returning at least two AI-visibility snapshots
so deltas can be computed. The delta computation itself is done and unit-tested
in the MCP (`computeChanges` in `src/api/mappers.ts`) — it only needs the data.
**MCP wiring:** `client.getChanges()` throws `NOT_YET_AVAILABLE`; `get_changes`
passes the Pro gate and returns that clearly-flagged error until the endpoint lands.

### 3. No dedicated competitor-comparison endpoint
Nothing computes head-to-head scores across domains. The audit's
`ai_visibility.platform_scores[].results[].competitors` lists competitor *names*
but there's no multi-domain comparison.
**MCP behavior today:** `compare_competitors` **fans out one `runAudit` per
domain** and builds the ranking + per-engine gaps from live data — a genuine
implementation, but each domain consumes an audit against the 5/day quota. To
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

- **`/api/audit` requires `businessName` and `businessCity`** (naive
  `if (!businessCity)` validation), but the MCP tools take only `domain` per the
  listing doc. The engine re-detects name/sector/location from the site
  (`BusinessIdentifier`), so these should be optional. **Workaround:** the client
  derives `businessName` from the domain and sends a whitespace `businessCity`
  sentinel (the engine `.strip()`s it, so detection still wins). See
  `CITY_SENTINEL` in `src/api/client.ts`.
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
- **Unreachable domains** are not signaled as a distinct error by `/api/audit` —
  it returns `200` with an availability failure in `results`. The MCP detects this
  (`detectUnreachable`) from the availability module's connection-level failure
  (recommendation "Investigate server connectivity or DNS resolution." with no
  page load succeeding) and returns `UNREACHABLE_DOMAIN` instead of a fabricated
  score.
