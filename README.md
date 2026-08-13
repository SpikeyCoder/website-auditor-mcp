# Website Auditor MCP

An [MCP](https://modelcontextprotocol.io) server for **[website-auditor.io](https://website-auditor.io)** —
AI-visibility (GEO) and site-audit tools you can call from any MCP client
(Claude Desktop, Claude Code, Cursor, Codex, and other agents).

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
| `get_sample_audit` | **Free — no key** | A complete sample report for `example.com` in the exact shape a real audit returns. Needs no API key, no subscription and no network. Try this first to see what you'd be buying. |
| `get_ai_visibility` | **Pro** | Current AI-visibility score (0–100) + per-engine breakdown (ChatGPT, Perplexity, Claude, Gemini) + the top competitor appearing in your place. Pro subscribers also get `trend`: 7- and 30-day score movement from stored snapshot history. |
| `run_audit` | **Pro**, rate-limited | Full one-time audit → category scores (AI visibility, SEO, security, performance) + top issues + a shareable report URL. |
| `get_changes` | **Pro** | What changed since the last check — score movement, engines gained/lost, competitor moves, new/resolved issues. Requires the domain to be tracked. |
| `compare_competitors` | **Pro** | Head-to-head AI-visibility ranking against named competitor domains + where each appears that you don't. Quota-aware: caps the audit fan-out to your remaining daily quota, reuses recent cached audits, and reports any competitors it had to skip rather than dropping them silently. |
| `track_site` | **Pro** | Start (or stop) weekly monitoring of a site's AI visibility. Establishes the history `get_changes` reads from. |
| `untrack_site` | **Pro** | Stop monitoring a site and free up a monitoring slot. Idempotent. |
| `list_tracked_sites` | **Pro** | List the sites you're monitoring, with cadence, active state, and slots used/remaining. |
| `get_monitoring_status` | **Pro** | A glanceable dashboard across all tracked sites — latest score, when each was last checked and next runs, and the most recent change. |
| `check_upgrade_status` | Any valid key | Your own subscription standing — tier, status, period end, and what upgrading unlocks (starting Pro requires a payment method and accepting the Terms). Consumes no audit quota. |

## Prompts

Clients that support MCP prompts (Claude Desktop, claude.ai) render these as
something you can pick from a menu, so you don't have to phrase the request
yourself or know which tool to ask for. In clients that don't surface prompts
(Codex, currently), nothing is lost but the menu — ask in words and the same
tools run.

| Prompt | Needs a key? | What it does |
|---|---|---|
| **See a sample report** | **No** | Walks through a complete report for `example.com`. No arguments, no setup — one click from any install. |
| **Check my AI visibility** | Pro | Runs `get_ai_visibility` for a domain you name, then explains the score, which assistants name the business, and who is named instead. |
| **Run a full site audit** | Pro | Runs `run_audit` for a domain and summarises it by category, with the three fixes that matter most. |
| **Compare me to a competitor** | Pro | Runs `compare_competitors` for your domain against a named rival, and explains where they get named and you don't. |

Each Pro prompt falls back to `get_sample_audit` when no API key is configured,
so you always get output rather than an error.

### Naming the business (optional)

`get_ai_visibility` and `run_audit` both accept two optional arguments that
decide *what question* the AI-visibility check actually asks:

| Argument | Omitted | Supplied |
|---|---|---|
| `business_name` | Detected from the site, and flagged with `name_warning` when it could not be verified | Taken as fact and recorded as caller-supplied — which suppresses the warning |
| `business_location` | Detected from the site; if nothing is found the questions widen to the country, or drop the place entirely | Scopes the questions to that place |

**Supply a name only when you actually know it.** A supplied name overrides
detection and is treated as confirmed, so a guess is scored exactly as if a
human had verified it — and silences the warning that would have told you
otherwise. Leaving it out is the safer default: detection is transparent about
its own uncertainty.

The same applies to location, in the other direction. Omitting it is correct
for a national or global business and wrong for a local one, since a local
business measured without a place is measured against the wrong queries.

```text
"Check AI visibility for hawaiibackroad.com,
 the business is Big Island Backroad Adventures in Hilo, HI"
```

---

## Install & configure

The server runs directly via `npx` — no clone or build required.

**Try it before you buy it.** Install with no API key at all and ask your agent
for a *sample audit* — `get_sample_audit` returns a full report for `example.com`
in the exact format a real run produces, so you can check the shape fits your
needs first.

**Pricing.** Auditing real domains needs a Website Auditor subscription at
**$10/month** — eligible new customers get a **7-day free trial** (payment
method required to start; no charge until the trial ends; customers who used
a trial in the last 12 months are billed immediately). Sign up and create an
API key at
**[api.website-auditor.io/admin_portal](https://api.website-auditor.io/admin_portal/?source=mcp)**,
then set it as `WA_API_KEY` below. There is no free API tier — a key only
functions with an active subscription.

**Claude Desktop** (`claude_desktop_config.json`), **Cursor**
(`~/.cursor/mcp.json`), and most other clients use the same `mcpServers` shape:

```jsonc
{
  "mcpServers": {
    "website-auditor": {
      "command": "npx",
      "args": ["-y", "website-auditor-mcp"],
      "env": {
        "WA_API_KEY": "wa_your_key_here"
      }
    }
  }
}
```

**Claude Code** — add it from the CLI:

```bash
claude mcp add website-auditor -e WA_API_KEY=wa_your_key_here -- npx -y website-auditor-mcp
```

**Codex** — the CLI, IDE extension and ChatGPT desktop app all read the same
`~/.codex/config.toml`, so one of these covers all three:

```bash
codex mcp add website-auditor --env WA_API_KEY=wa_your_key_here -- npx -y website-auditor-mcp
```

```toml
[mcp_servers.website-auditor]
command = "npx"
args = ["-y", "website-auditor-mcp"]

[mcp_servers.website-auditor.env]
WA_API_KEY = "wa_your_key_here"
```

Codex doesn't render MCP prompts, so the [Prompts](#prompts) above won't appear
as menu entries there — ask in words instead (*"show me a sample audit"*).

Or install the packaged **Codex plugin**, which bundles the same server and
restores the prompts as skills (which Codex does render):

```bash
codex plugin marketplace add SpikeyCoder/website-auditor-mcp
codex plugin add website-auditor@spikeycoder
```

**Cursor** — one-click install, or put the same `mcpServers` JSON as above in
`~/.cursor/mcp.json`:

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=website-auditor&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIndlYnNpdGUtYXVkaXRvci1tY3AiXSwiZW52Ijp7IldBX0FQSV9LRVkiOiIifX0%3D)

The one-click config arrives with an empty `WA_API_KEY` — the sample report
works as-is; fill the key in under **Settings → MCP** to audit real domains.
There is also a packaged **Cursor plugin** (this server plus the prompts as
skills) in [`cursor-plugin/`](cursor-plugin/); its Cursor Marketplace listing
is pending — status in [docs/CURSOR-PLUGIN.md](docs/CURSOR-PLUGIN.md).

Restart the client and the tools appear.

### Getting an API key

`WA_API_KEY` is a per-user key (it starts with `wa_`) minted from a Website
Auditor account at
**[api.website-auditor.io/admin_portal](https://api.website-auditor.io/admin_portal/?source=mcp)**
— the admin portal, where you subscribe and manage keys.

Minting a key requires an active subscription ($10/month; eligible new
customers get a 7-day free trial — payment method required, no charge until
the trial ends): there is no free API tier, so every tool except
`get_sample_audit` and `check_upgrade_status` needs one. `get_sample_audit`
needs no key at all.

Treat the key like a password — set it only in your MCP client's `env` and never
commit it.

**Restart after setting or changing the key.** `WA_API_KEY` is read once, when
the server starts, so a key added while the client is running is invisible to
it — in Claude Desktop, quit and reopen the app. Without the restart the tools
keep returning the same `AUTH_REQUIRED` you just acted on, which looks
identical to the key not working.

### Configuration (environment variables)

| Var | Default | Purpose |
|---|---|---|
| `WA_API_KEY` | _(required)_ | Per-user API key (starts with `wa_`). |
| `WA_API_BASE_URL` | `https://api.website-auditor.io` | The Website Auditor API this server wraps. |
| `WA_SITE_URL` | `https://website-auditor.io` | Used to build shareable report links. |
| `WA_UPGRADE_URL` | `https://api.website-auditor.io/admin_portal/` | Where auth and subscription errors point you. `?source=mcp` is appended so a signup that started here is attributable; set your own `source` to override. Not surfaced on quota errors — the daily cap is not an upsell. |
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

- **No key** → `get_sample_audit` still works (that's the point of it); every
  other tool returns `AUTH_REQUIRED` with the price and a sign-up link.
- **Revoked or unrecognized key** → `INVALID_KEY`, carrying the API's own
  remediation ("generate a new key"). Distinct from `PRO_REQUIRED`: the fix is a
  new key, not a purchase.
- **No active subscription** (valid key, lapsed/canceled/never subscribed) →
  `PRO_REQUIRED` with the price and an upgrade link — there is no free API tier;
  `check_upgrade_status` still answers so the caller can learn why.
- **Subscribed** (status `active` or a trial in progress) → all tools.

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

**Anonymous install id.** When telemetry is enabled, the server generates a
random UUID on first run and stores it at
`~/.config/website-auditor-mcp/install-id` (or `$XDG_CONFIG_HOME`), sending it
with each event. It exists solely to tell one install restarting many times
apart from many separate installs — without it, install counts are just restart
counts. It is randomly generated, never derived from your machine, username or
network, and is not a fingerprint. Setting `WA_METRICS_DISABLED` stops
telemetry entirely: no id is generated and nothing is written to disk.

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
can be disabled entirely by setting `WA_METRICS_DISABLED=1`. Installed as a
desktop extension, the same opt-out is a **"Disable anonymous usage telemetry"**
checkbox in the extension's settings.

Full privacy policy: **https://website-auditor.io/privacy**

---

## License

[MIT](LICENSE) — © 2026 Kevin Armstrong / SpikeyCoder.

This covers the MCP server in this repo: the client that talks to the Website
Auditor API. The audit engine and the API behind it are separate products, not
covered here, and running real audits still needs a Website Auditor account.

Learn more at **[website-auditor.io](https://website-auditor.io)**.
