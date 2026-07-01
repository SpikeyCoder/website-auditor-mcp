# Website Auditor MCP

An MCP (Model Context Protocol) server for [website-auditor.io](https://website-auditor.io) —
**AI-visibility & site-audit tools, callable from any MCP client** (Claude, Cursor, ChatGPT connectors).

It is a **thin, authenticated wrapper** over the existing Website Auditor Pro API
(`SpikeyCoder/website-auditor-api`). The moat — the audit data, AI-visibility
scoring, and monitoring — lives in that service; this server just distributes it
to agents. Built test-first with [vitest](https://vitest.dev).

> **Scope: Phase 0 (MVP).** Four read tools + per-key auth + free/Pro gating +
> metering. Phase-1 tools are declared and ready to wire (see below).

---

## Tools

| Tool | Gate | What it does |
|---|---|---|
| `get_ai_visibility` | **Free** | Current AI-visibility score (0–100) + per-engine breakdown (ChatGPT, Perplexity, Claude, Gemini) + top competitor. |
| `run_audit` | **Free**, rate-limited | Full audit → category scores (AI visibility, SEO, security, performance) + top issues + shareable report URL. |
| `get_changes` | **Pro** | Deltas since the last check (score movement, engines gained/lost, competitor moves, new/resolved issues). |
| `compare_competitors` | **Pro** | Head-to-head AI-visibility ranking against named competitor domains + per-engine gaps. Quota-aware: caps the audit fan-out to the remaining daily quota, reuses recent cached audits, and reports any competitors skipped for quota rather than dropping them. |

Tool **names and descriptions are verbatim** from the agent-discovery listing doc
and must stay stable — agents bind to them (`src/tools/registry.ts`).

Phase-1 tools (`track_site`, `get_benchmark`, `get_recommendations`,
`generate_schema`, `get_report`) are already declared with full metadata and
input schemas in `P1_TOOLS`; adding them is a wiring change, not a rewrite.

---

## Run it

```bash
npm install
npm run build       # compile TypeScript → dist/
npm start           # serve over stdio
# or, without building:
npm run dev
```

### Configure in an MCP client

```jsonc
{
  "mcpServers": {
    "website-auditor": {
      "command": "node",
      "args": ["/absolute/path/to/website-auditor-mcp/dist/index.js"],
      "env": {
        "WA_API_KEY": "wa_your_key_here",
        "WA_API_BASE_URL": "https://api.website-auditor.io"
      }
    }
  }
}
```

### Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `WA_API_KEY` | _(none)_ | Per-user API key (starts with `wa_`), minted from a Website Auditor Pro account. |
| `WA_API_BASE_URL` | `https://api.website-auditor.io` | The website-auditor-api portal this server wraps. |
| `WA_SITE_URL` | `https://website-auditor.io` | Used to build shareable report links. |
| `WA_UPGRADE_URL` | `https://website-auditor.io/admin_portal` | Surfaced in auth/quota errors. |
| `WA_FREE_DAILY_AUDIT_LIMIT` | `3` | Free-tier audits per key per UTC day (MCP-side guard). |
| `WA_FREE_MAX_DOMAINS` | `1` | Free-tier distinct-domain cap per key. |
| `WA_REQUEST_TIMEOUT_MS` | `120000` | Timeout for API calls. |
| `WA_AUDIT_CACHE_TTL_MS` | `86400000` | Reuse a domain's audit within this window instead of spending quota (used by `compare_competitors`). Defaults to 24h. |
| `WA_SUBSCRIPTION_CACHE_TTL_MS` | `60000` | How long a resolved Pro/free tier is cached per key before re-checking the live subscription endpoint. Short (60s) so upgrades/downgrades reflect quickly. |
| `WA_DEV_TIER` | _(none)_ | **Explicit** local/testing tier override (`free`/`pro`) — **not** the default path; tier is normally read live. See auth model. |
| `WA_METRICS_DISABLED` | _(unset → metrics on)_ | Set to `1`/`true` to disable P0 telemetry emission. See [Telemetry & success metrics](#telemetry--success-metrics). |

See `.env.example`. **Never commit `.env` or any `wa_` key** (`.gitignore` excludes them).

---

## Auth & gating model

The key is supplied via MCP server config (`WA_API_KEY`) and validated on every
call against the real API. The Pro/free tier is resolved from the **live,
API-key-authed subscription endpoint** — `GET /api/subscription` in
website-auditor-api (shipped in PR #7) — which reads the same `subscriptions`
table as the web session, so the MCP and the portal always agree on who is Pro.
Tiers:

- **`none`** (no key): free tools return `AUTH_REQUIRED` (the backend requires a
  key), Pro tools return `PRO_REQUIRED`. Both include the upgrade URL.
- **`free`** (valid key, no active subscription — never-subscribed *or* lapsed):
  free tools work, subject to MCP-side metering (`WA_FREE_DAILY_AUDIT_LIMIT`
  audits/day, `WA_FREE_MAX_DOMAINS` domains) on top of the API's own per-key
  daily rate limit. Pro tools return `PRO_REQUIRED` + upgrade URL.
- **`pro`** (subscription `status` = `active` or `trialing`): all tools, metering
  bypassed.

**How the tier is resolved** (`DefaultSubscriptionProvider`, `src/auth/entitlements.ts`):

1. No key → `none`. A key with `WA_DEV_TIER` set → that tier (explicit local
   override only, **never the default path**).
2. Otherwise the tier is read from `GET /api/subscription` and **cached per key**
   for `WA_SUBSCRIPTION_CACHE_TTL_MS` (default 60s), so tier resolution isn't a
   round-trip on every tool call but still reflects upgrades/downgrades within a
   minute. `active`/`trialing` ⇒ `pro`, everything else ⇒ `free`.

**Failure handling (deliberate — a Pro user must never be wrongly told they're
not subscribed during an outage):**

- Subscription endpoint errors but a **prior tier is cached** → the **last-known
  tier is honored** (a Pro user keeps Pro through a blip).
- Endpoint errors with **no cached tier** (cold) → default to **`free`, but
  flagged _unverified_**. We never fail-open to Pro, but Pro tools return a
  distinct **`SUBSCRIPTION_UNVERIFIED`** ("couldn't verify — temporary, try
  again") instead of the flat `PRO_REQUIRED`, so a genuine Pro user isn't told
  they aren't subscribed. Free tools still work (free is the safe default).
- A **definitive** key rejection (`401` → `INVALID_KEY`) is treated as a verified
  `free`, not a retryable outage — retrying won't change a revoked key.

Errors are normalized to stable codes so agents can branch on them:
`AUTH_REQUIRED`, `INVALID_KEY`, `PRO_REQUIRED`, `SUBSCRIPTION_UNVERIFIED`,
`OVER_QUOTA`, `LIMIT_REACHED`, `UNREACHABLE_DOMAIN`, `INVALID_INPUT`,
`UPSTREAM_ERROR`, `TIMEOUT`, `NOT_YET_AVAILABLE`. Failures come back as MCP error
results (`isError: true`) with a JSON body carrying the `code`, `message`, and
`upgrade_url` where relevant.

---

## Architecture

```
src/
  config.ts              env → WaConfig
  api/
    client.ts            WaApiClient — thin adapter over the REAL endpoints (injectable fetch)
    mappers.ts           pure report → tool-shape mappers (+ unreachable detection, delta logic)
    domain.ts            domain normalization/validation
    errors.ts            WaApiError + normalized ErrorCode
    types.ts             upstream report shapes + tool return shapes
  auth/
    entitlements.ts      tier resolution (SubscriptionProvider seam)
    meter.ts             free-tier metering (Meter seam; in-memory default)
  tools/
    context.ts           ToolDeps, ToolResult, gating helpers
    getAiVisibility.ts   run_audit.ts  getChanges.ts  compareCompetitors.ts
    registry.ts          verbatim P0 + P1 tool metadata
  telemetry/
    events.ts            event model + agent-origin classification heuristic (EventSink seam)
    httpSink.ts          fire-and-forget POST of events to /api/mcp-events
  mcp/server.ts          McpServer wiring + result formatting + event emission
  index.ts               stdio entrypoint
```

Tools are pure `(args, deps) => ToolResult` functions — the client, subscription
provider and meter are all injected, which is what makes the suite hermetic (no
network; HTTP is mocked at the `fetch` boundary).

## Test

```bash
npm test            # vitest run
npm run typecheck
```

The P0 acceptance criteria from the PRD are encoded as tests: auth-required
errors with the upgrade URL, over-quota errors + upgrade path, unreachable-domain
specific errors (never a fabricated score), and valid-key happy paths.

---

## Mapping to the real API (and what's missing)

This server wraps `SpikeyCoder/website-auditor-api`. Live endpoints it uses:
`GET /api/audit` (`X-API-Key` auth, per-key daily rate limit → 429), `GET
/api/subscription` (Pro/free gating — see the auth model), `GET
/api/ai-visibility-history` (`get_changes`), and `/api/tracked-domains`
(`track_site` enrollment). Both free tools map onto `/api/audit`;
`compare_competitors` fans out one audit per domain, capped to the remaining
daily quota (learned from the `X-RateLimit-*` headers) and served from a
short-lived audit cache where possible.

The following remains **declared on the client interface but not yet available
upstream** — it throws `NOT_YET_AVAILABLE` rather than fabricating data, and the
tool is wired to light up the moment the endpoint ships:

- **A dedicated competitor-comparison endpoint** (`compare_competitors` uses
  fan-out audits in the meantime, which consumes audit quota).

See `docs/API-GAPS.md` for the full list, including the smaller mismatches
(`/api/audit` requiring `businessName`/`businessCity`; no dedicated SEO score).

## Telemetry & success metrics

The server emits **P0 success-metric telemetry** so the PRD's "leading" metrics
have data (installs, active keys, tool-call volume, % agent-originated,
time-to-first-successful-call, MCP-attributed conversion).

**What is emitted, and where** (`src/mcp/server.ts`):

- **`session_init`** — once, from the MCP `initialize` handshake's
  `oninitialized` hook. Carries the client's `clientInfo` (`name` + `version`).
  Installs, agent-origin and first-call latency are all derived from this.
- **`tool_call`** — after every tool invocation, with `tool_name`, `success`,
  `error_code` (the normalized code on failure), `duration_ms`, and the session's
  `clientInfo`.

**Transport.** Events are POSTed to the API portal's `POST /api/mcp-events`
ingest endpoint, authenticated with `WA_API_KEY`, which resolves
`api_key_id` / `user_id` / `acquisition_channel` **server-side** and inserts into
the `mcp_events` Supabase table. The MCP holds only a `wa_` key — never Supabase
credentials — so the API owns the write (the thinner, safer option than shipping
DB creds to every client).

**Fire-and-forget / non-blocking.** `EventSink.emit` returns immediately and
never throws; the HTTP send is not awaited by the tool path and swallows every
failure (network, non-2xx, timeout). A `safeEmit` guard in the server wraps every
emission as well, so **a metrics failure can never break a tool call** (there's a
test that asserts exactly this with a sink that throws). Set
`WA_METRICS_DISABLED=1` to swap in a no-op sink entirely.

**Metric definitions (honest heuristics — not ground truth).** MCP does not give
perfect signals, so each metric is a documented approximation. Defined once in
`src/telemetry/events.ts` (classification) and, on the API side, in
`src/services/mcpMetrics.js` + the SQL views (`db/migrations/004_mcp_metrics_views.sql`):

- **installs** — first `session_init` per identity, where identity is
  `api_key_id` when a valid key is present, else `client_name` (so no-key/free
  sessions still count, deduped per client). A reinstall by the same key/client
  is not a new install.
- **active keys** — distinct `api_key_id` with any event in the window.
- **tool-call volume** — count of `tool_call` events.
- **% agent-originated** — share of `tool_call`s where `is_agent_originated`.
  **Heuristic:** classified from `clientInfo.name` — known human-facing clients
  (`claude-ai`, `claude-code`, `cursor`, `windsurf`, `vscode`, `zed`, JetBrains;
  see `HUMAN_FACING_CLIENTS`) are **not** agent-originated; every other
  client — headless runners, SDK-built, custom, or unknown — **is**. Unknown
  clients therefore count as agent-originated, biasing this **upward**; read it as
  a signal of agent adoption, not a fact. Extend `HUMAN_FACING_CLIENTS` to tune.
- **time-to-first-successful-call** — first successful `tool_call` timestamp
  minus `session_init` timestamp, per key.
- **MCP-attributed free→Pro conversion** — of users whose API key
  `acquisition_channel='mcp'`, the share now holding an active/trialing
  subscription. `acquisition_channel` is stamped at **key creation**
  (`POST /api/keys` with `source: "mcp"`); **pre-existing keys are `unknown` and
  excluded — never guessed**, so they don't dilute the rate.

**What Kevin must run:** the Supabase migrations in `website-auditor-api`
(`db/migrations/002_mcp_events.sql`, `003_api_keys_acquisition_channel.sql`,
`004_mcp_metrics_views.sql`) before this telemetry has anywhere to write. Until
then, emission simply fails silently (by design) and no metrics accrue.

## Guardrails

Keep the wrapper thin — the MCP distributes the moat (data + monitoring +
outcomes), it isn't the moat. Every Pro tool should return something an agent can
act on or re-call over time.
