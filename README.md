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
| `compare_competitors` | **Pro** | Head-to-head AI-visibility ranking against named competitor domains + per-engine gaps. |

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
| `WA_DEV_TIER` | _(none)_ | Local/testing override (`free`/`pro`) — see auth model. |

See `.env.example`. **Never commit `.env` or any `wa_` key** (`.gitignore` excludes them).

---

## Auth & gating model

The key is supplied via MCP server config (`WA_API_KEY`) and validated on every
call against the real API. Tiers:

- **`none`** (no key): free tools return `AUTH_REQUIRED` (the backend requires a
  key), Pro tools return `PRO_REQUIRED`. Both include the upgrade URL.
- **`free`** (valid key, no confirmed subscription): free tools work, subject to
  MCP-side metering (`WA_FREE_DAILY_AUDIT_LIMIT` audits/day, `WA_FREE_MAX_DOMAINS`
  domains) on top of the API's own per-key daily rate limit. Pro tools return
  `PRO_REQUIRED` + upgrade URL.
- **`pro`** (active subscription): all tools, metering bypassed.

Errors are normalized to stable codes so agents can branch on them:
`AUTH_REQUIRED`, `INVALID_KEY`, `PRO_REQUIRED`, `OVER_QUOTA`,
`UNREACHABLE_DOMAIN`, `INVALID_INPUT`, `UPSTREAM_ERROR`, `TIMEOUT`,
`NOT_YET_AVAILABLE`. Failures come back as MCP error results (`isError: true`)
with a JSON body carrying the `code`, `message`, and `upgrade_url` where relevant.

> **How is the tier resolved?** `SubscriptionProvider` (`src/auth/entitlements.ts`)
> is the seam. website-auditor-api does **not yet expose an API-key-authed way to
> read subscription state** (PRD open question #1), so the default provider is
> conservative: a valid key is `free` unless `WA_DEV_TIER=pro` is set for local
> testing. When the endpoint ships, swap in a provider that calls
> `client.getSubscription()` — no tool changes needed.

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
  mcp/server.ts          McpServer wiring + result formatting
  index.ts               stdio entrypoint
```

Tools are pure `(args, deps) => ToolResult` functions — the client, subscription
provider and meter are all injected, which is what makes the suite hermetic (no
network; HTTP is mocked at the `fetch` boundary).

## Test

```bash
npm test            # vitest run (62 tests)
npm run typecheck
```

The P0 acceptance criteria from the PRD are encoded as tests: auth-required
errors with the upgrade URL, over-quota errors + upgrade path, unreachable-domain
specific errors (never a fabricated score), and valid-key happy paths.

---

## Mapping to the real API (and what's missing)

This server wraps `SpikeyCoder/website-auditor-api`. Only one endpoint is live
today: `GET /api/audit` (`X-API-Key` auth, per-key daily rate limit → 429). Both
free tools map onto it; `compare_competitors` fans out one audit per domain.

The following are **declared on the client interface but not yet available
upstream** — they throw `NOT_YET_AVAILABLE` rather than fabricating data, and the
tools are wired to light up the moment the endpoints ship:

- **Subscription check by API key** (blocks true Pro gating) — PRD open question #1.
- **AI-visibility deltas / history by API key** (`get_changes`) — PRD open question #2.
- **A dedicated competitor-comparison endpoint** (`compare_competitors` uses
  fan-out audits in the meantime, which consumes audit quota).

See `docs/API-GAPS.md` for the full list, including the smaller mismatches
(`/api/audit` requiring `businessName`/`businessCity`; no dedicated SEO score).

## Guardrails

Keep the wrapper thin — the MCP distributes the moat (data + monitoring +
outcomes), it isn't the moat. Every Pro tool should return something an agent can
act on or re-call over time.
