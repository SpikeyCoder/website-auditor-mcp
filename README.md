# Website Auditor MCP

An [MCP](https://modelcontextprotocol.io) server for **[website-auditor.io](https://website-auditor.io)** —
AI-visibility (GEO) and site-audit tools you can call from any MCP client
(Claude Desktop, Claude Code, Cursor, and other agents).

Ask an agent *"does ChatGPT recommend my business?"*, *"what's my AI-visibility
score?"*, *"audit example.com"*, or *"how do I stack up against my competitors?"*
and it answers with real data — an overall AI-visibility score (0–100), a
per-engine breakdown across **ChatGPT, Perplexity, Claude and Gemini**, a full
site audit (SEO, security, performance), competitor comparisons, and ongoing
monitoring.

The server is a thin, authenticated wrapper over the Website Auditor API — the
audit engine, AI-visibility scoring and monitoring live in that service; this
server just makes them available to agents.

---

## Tools

| Tool | Tier | What it does |
|---|---|---|
| `get_ai_visibility` | **Free** | Current AI-visibility score (0–100) + per-engine breakdown (ChatGPT, Perplexity, Claude, Gemini) + the top competitor appearing in your place. |
| `run_audit` | **Free**, rate-limited | Full one-time audit → category scores (AI visibility, SEO, security, performance) + top issues + a shareable report URL. |
| `get_changes` | **Pro** | What changed since the last check — score movement, engines gained/lost, competitor moves, new/resolved issues. Requires the domain to be tracked. |
| `compare_competitors` | **Pro** | Head-to-head AI-visibility ranking against named competitor domains + where each appears that you don't. Quota-aware: caps the audit fan-out to your remaining daily quota, reuses recent cached audits, and reports any competitors it had to skip rather than dropping them silently. |
| `track_site` | **Pro** | Start (or stop) weekly monitoring of a site's AI visibility. Establishes the history `get_changes` reads from. |
| `untrack_site` | **Pro** | Stop monitoring a site and free up a monitoring slot. Idempotent. |
| `list_tracked_sites` | **Pro** | List the sites you're monitoring, with cadence, active state, and slots used/remaining. |
| `get_monitoring_status` | **Pro** | A glanceable dashboard across all tracked sites — latest score, when each was last checked and next runs, and the most recent change. |

---

## Install & configure

The server runs directly via `npx` — no clone or build required. Add it to your
MCP client's config with your API key.

**Claude Desktop** (`claude_desktop_config.json`), **Cursor**
(`~/.cursor/mcp.json`), and most other clients use the same `mcpServers` shape:

```jsonc
{
  "mcpServers": {
    "website-auditor": {
      "command": "npx",
      "args": ["-y", "@spikeycoder/website-auditor-mcp"],
      "env": {
        "WA_API_KEY": "wa_your_key_here"
      }
    }
  }
}
```

**Claude Code** — add it from the CLI:

```bash
claude mcp add website-auditor -e WA_API_KEY=wa_your_key_here -- npx -y @spikeycoder/website-auditor-mcp
```

Restart the client and the tools appear.

### Getting an API key

`WA_API_KEY` is a per-user key (it starts with `wa_`) minted from a Website
Auditor account at **[website-auditor.io](https://website-auditor.io)**. Free
tools work with any valid key; **Pro** tools require an account with an active
subscription. Treat the key like a password — set it only in your MCP client's
`env` and never commit it.

### Configuration (environment variables)

| Var | Default | Purpose |
|---|---|---|
| `WA_API_KEY` | _(required)_ | Per-user API key (starts with `wa_`). |
| `WA_API_BASE_URL` | `https://api.website-auditor.io` | The Website Auditor API this server wraps. |
| `WA_SITE_URL` | `https://website-auditor.io` | Used to build shareable report links. |
| `WA_UPGRADE_URL` | `https://website-auditor.io/admin_portal` | Surfaced in auth/quota errors. |
| `WA_FREE_DAILY_AUDIT_LIMIT` | `3` | Free-tier audits per key per UTC day. |
| `WA_FREE_MAX_DOMAINS` | `1` | Free-tier distinct-domain cap per key. |
| `WA_REQUEST_TIMEOUT_MS` | `120000` | Timeout for API calls. |
| `WA_AUDIT_CACHE_TTL_MS` | `86400000` | Reuse a domain's audit within this window instead of spending quota (used by `compare_competitors`). Defaults to 24h. |
| `WA_SUBSCRIPTION_CACHE_TTL_MS` | `60000` | How long a resolved Pro/free tier is cached per key before re-checking the subscription. |
| `WA_METRICS_DISABLED` | _(unset → metrics on)_ | Set to `1`/`true` to disable anonymous usage telemetry. |

Only `WA_API_KEY` is normally needed; the rest have sensible defaults. See
[`.env.example`](.env.example) for the full list.

---

## Auth & tiers

Your key is validated on every call. The Pro/free tier is resolved live from the
API and cached briefly, so upgrades and downgrades take effect within about a
minute:

- **No key** → free tools return `AUTH_REQUIRED`, Pro tools return
  `PRO_REQUIRED`. Both include an upgrade link.
- **Free** (valid key, no active subscription) → free tools work, subject to
  per-day metering; Pro tools return `PRO_REQUIRED`.
- **Pro** (active or trialing subscription) → all tools, metering bypassed.

Errors are normalized to stable codes agents can branch on — e.g.
`AUTH_REQUIRED`, `INVALID_KEY`, `PRO_REQUIRED`, `OVER_QUOTA`,
`UNREACHABLE_DOMAIN`, `INVALID_INPUT`, `TIMEOUT`. A domain that can't be reached
returns `UNREACHABLE_DOMAIN` — never a fabricated score.

---

## Develop

```bash
npm install
npm run build      # compile TypeScript → dist/
npm start          # serve over stdio
npm run dev        # run from source without building
npm test           # vitest
npm run typecheck
```

The suite is hermetic — the API client, subscription provider and meter are
injected, and HTTP is mocked at the `fetch` boundary, so no network is touched.

---

## Privacy Policy

This connector talks to a single external service: the **Website Auditor API**
at **[website-auditor.io](https://website-auditor.io)**. When you invoke a tool
it sends only two things to that API:

- the **target domain** you asked to audit or monitor, and
- your **API key** (`WA_API_KEY`), used to authenticate the request and resolve
  your plan tier.

That's the full extent of what leaves your machine. The connector does **not**
collect, store, or transmit your files, prompts, conversation content, or any
other personal data, and it does not send data to any third party beyond the
Website Auditor API. Your API key is held only in your MCP client's
configuration (in Claude Desktop it is stored in the OS keychain and injected as
an environment variable); it is never written to the bundle or logged.

Anonymous, aggregate usage telemetry (which tool ran, success/failure, latency —
no domains, no keys, no personal data) may be emitted to improve the service, and
can be disabled entirely by setting `WA_METRICS_DISABLED=1`.

Full privacy policy: **https://website-auditor.io/privacy**

---

## License

[Elastic License 2.0](LICENSE) — © 2026 Kevin Armstrong / SpikeyCoder.

Learn more at **[website-auditor.io](https://website-auditor.io)**.
