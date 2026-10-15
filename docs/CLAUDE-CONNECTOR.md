# The Claude connector (remote MCP in Anthropic's Connectors Directory)

**Status (2026-10-15): code ready in this branch. NOT deployed and NOT submitted.**
Each step below that touches production or Anthropic waits for the owner's go.

## Why a connector, and why its own deployment

The `.mcpb` desktop extension was this product's Claude listing, and it can no
longer be kept current. Anthropic's docs now say: *"Desktop extension listings in
the directory are deprecated, and the directory no longer accepts MCPB
submissions"* ([mcpb](https://claude.com/docs/connectors/building/mcpb)).

A remote connector fixes the lag that left Claude users on $10/month after Pro
moved to $49 on 2026-10-15:

- Tool changes reach every user on deploy. *"You don't resubmit to Anthropic to
  change a listed MCP server's tools"*
  ([after-publishing](https://claude.com/docs/connectors/building/after-publishing)).
- The connector works on claude.ai web, Desktop and mobile alike.

Claude gets **its own Cloud Run service**, built from the same image as the
ChatGPT one (owner decision, 2026-10-15). There are three reasons the ChatGPT
box can't simply be reused:

| | ChatGPT box (`website-auditor-mcp`) | Claude box (proposed `website-auditor-mcp-claude`) |
|---|---|---|
| URL / `resource` | `https://mcp.website-auditor.io/mcp` | `https://claude-mcp.website-auditor.io/mcp` (proposed) |
| Sign-in signal (`WA_AUTH_CHALLENGE`) | `result`: a 200 `AUTH_REQUIRED` carrying `_meta["mcp/www_authenticate"]` | `http`: a **401 + `WWW-Authenticate`** before the tool runs |
| Paywall answers (`WA_UPSELL_STYLE`) | `info`: no price or trial (OpenAI rules) | `link`: the $49/month price, the trial and its terms |
| Tool descriptions (`WA_TOOL_COPY`) | `full` (under `info`, already free of any price) | `neutral`: "Requires a Website Auditor subscription." |

1. **Claude only signs in from a 401.** *"Claude starts sign-in only when the
   HTTP request itself fails with `401 Unauthorized`"*, and it ignores
   `WWW-Authenticate` on a 200
   ([lazy-authentication](https://claude.com/docs/connectors/building/lazy-authentication),
   [authentication](https://claude.com/docs/connectors/building/authentication)).
   - On the ChatGPT box today, a protected tool returns a 200 tool error.
   - In Claude, that 200 reaches the model as text, and the user **never gets a
     Connect button**.
   - Turning the 401 on for the live ChatGPT listing would be an untested change
     to OpenAI's account linking.
2. **`resource` must equal the URL the user enters.** *"Make `resource` match
   your MCP server URL exactly"*. A second URL means a second resource identifier.
3. **The two listings need opposite copy.** OpenAI forbids any price or trial,
   and the owner wants Claude to state both at the paywall.

**Neutral descriptions.** Anthropic rejects tool descriptions that *"promote
products and services"* or *"instruct Claude to call external software or tools
the user didn't request"*
([review criteria](https://claude.com/docs/connectors/building/review-criteria)).
The full suffix does both: a price and trial pitch, then "call get_sample_audit
first". So on the Claude box:

- Descriptions say only what a tool needs.
- The PRO_REQUIRED answer itself still states the price and trial.
- The instructions still tell the model to relay that answer.

## What the code does (this branch)

- **`WA_AUTH_CHALLENGE=http`** (`src/http.ts`, `toolCalledBy`). These requests
  get a 401:
  - a `tools/call` to an account-only tool when nothing is presented;
  - **any** `tools/call` when the presented token is one the authorization
    server rejects (expired, revoked, or no audit scope). The 401 is what makes
    Claude refresh a dead token.
  - The 401 carries `WWW-Authenticate: Bearer resource_metadata="…", scope="…",
    error="invalid_token"`, exposed to browsers.
  - With nothing presented, `initialize`, `tools/list`, `get_sample_audit` and
    `check_upgrade_status` answer 200, so the connector works before sign-in.
    (`initialize` and `tools/list` answer 200 with a rejected token too.)
  - The account-only set is `requiresAccount`, the same rule that publishes
    `oauth2` in `securitySchemes`. A test asserts the two match tool by tool.
  - A presented `wa_` key is never gated. A signed-in account without the plan
    gets PRO_REQUIRED, not a 401.
  - A token that **could not be checked** is not gated: introspection down or
    unreachable, a non-2xx (for example a wrong
    `WA_OAUTH_INTROSPECTION_SECRET`), or an unreadable body
    (`TokenResolution` in `src/auth/tokenExchange.ts`). A 401 there would send
    every connected user round a reconnect loop that cannot succeed; they get
    the 200 "could not verify, try again" answer instead.
  - It needs Mixed Auth; without it the flag does nothing.
- **`WA_TOOL_COPY=neutral`** (`descriptionFor` in `src/tools/registry.ts`, and
  `buildInstructions`).
  - Descriptions: removes the price, the trial, "call get_sample_audit first",
    "before suggesting an upgrade", "worth subscribing to" and "use it INSTEAD of
    refusing". `check_upgrade_status` is titled "Check subscription status".
  - Instructions: the terms leave the billing paragraph. The three prescriptive
    blocks are replaced with descriptive ones:
    - "WHEN TO OFFER THIS without being asked" (raise it unasked) and "WHEN NOT
      TO" become "WHAT IT IS FOR", which keeps the consumer carve-out;
    - "NO API KEY? … Call it instead of declining" becomes "WITHOUT AN ACCOUNT";
    - get_gtm_plan's "Offer it…" list becomes when the tool applies.
  - Paywall guidance is unchanged: when a tool answers PRO_REQUIRED, the model is
    still told to relay the price and trial that the answer states.
- **Both default off.** The ChatGPT box, npm/stdio and `.mcpb` installs are
  unchanged; `tests/http/claudeConnector.test.ts` pins that.

## What already met Anthropic's requirements

Checked against the live servers on 2026-10-15:

- **Client registration:** open DCR on `api.website-auditor.io/oauth/register`,
  which accepts any https redirect, or loopback http (`127.0.0.1` or
  `localhost`). Claude's
  `https://claude.ai/api/mcp/auth_callback` and Claude Code's loopback ports
  therefore **need no allowlisting**.
- **Authorization server:** PKCE S256 only, RFC 8414 + OIDC discovery,
  `token_endpoint_auth_methods_supported: ["none"]`, refresh rotation, and a
  form-urlencoded `/oauth/token`.
- **This server:** RFC 9728 metadata on both paths, stateless Streamable HTTP.
- **Tools:** 15 of 15 have a `title` and all three hints.
- **Listing:** the privacy policy at https://website-auditor.io/privacy.

## Deploy runbook (NOT run — needs the owner's go)

1. **DNS and certificate.** Map `claude-mcp.website-auditor.io` to the new
   service. Use Cloud Run domain mapping, set DNS-only in Cloudflare, as for
   `mcp.`; Google issues the certificate.
   - The name is one level deep so that it would still fall under Cloudflare's
     free universal certificate if the record were ever proxied.
2. **Deploy (first creation only).** Same source, new service. `--set-env-vars`
   replaces a service's whole env, so later releases use plain `gcloud run
   deploy website-auditor-mcp-claude --source . --region us-central1`, which
   keeps it. The command below is the **complete** env. Compared with the
   ChatGPT box's eight variables (names checked 2026-10-15):
   - **The same:** `WA_OAUTH_ISSUER`, `WA_OAUTH_SCOPES` and
     `WA_OAUTH_INTROSPECTION_SECRET`.
   - **Different:**
     - `WA_OAUTH_RESOURCE_URL`, which is this URL;
     - `WA_INSTALL_ID`, a fresh UUID, so telemetry separates the boxes.
   - **Added:** `WA_AUTH_CHALLENGE=http` and `WA_TOOL_COPY=neutral`.
   - **Left out:**
     - `WA_UPSELL_STYLE`, so it defaults to link;
     - `WA_UPSELL_INFO_URL`;
     - `WA_APPS_CHALLENGE_TOKEN`, OpenAI's domain verification.

   ```bash
   gcloud run deploy website-auditor-mcp-claude --source . --region us-central1 \
     --allow-unauthenticated --max-instances 20 --cpu-boost \
     --set-env-vars "WA_AUTH_CHALLENGE=http,WA_TOOL_COPY=neutral,WA_INSTALL_ID=<new uuid>,WA_OAUTH_ISSUER=https://api.website-auditor.io,WA_OAUTH_RESOURCE_URL=https://claude-mcp.website-auditor.io/mcp,WA_OAUTH_SCOPES=audit openid email" \
     --set-secrets "WA_OAUTH_INTROSPECTION_SECRET=<secret>:latest"
   ```

   - **Introspection secret:** the ChatGPT box carries it as a plain env value.
     For the new service, put the same value in Secret Manager, as above, rather
     than typing it on a command line (gcloud writes command output to
     `~/.config/gcloud/logs`). The runtime service account needs
     `roles/secretmanager.secretAccessor` on that secret.
   - **Service settings:** match the ChatGPT service's memory, CPU, timeout,
     concurrency and service account. `describe` the ChatGPT service for
     settings only, never its env.
   - **Install id:** `WA_INSTALL_ID` must be a fresh UUID; reusing the ChatGPT
     box's merges the two boxes in telemetry.
   - **Optional, not decided:** set `WA_UPGRADE_URL=…/admin_portal/?source=claude`
     to attribute sign-ups to this channel. Check first that the API stores an
     unknown `source`.
3. **Firewall.** Anthropic calls from `160.79.104.0/21`, and so does discovery
   against `api.website-auditor.io`. Confirm no Cloudflare or WAF rule challenges
   that range on either host. Bot Fight Mode is already off.
4. **Verify.** Check the endpoint, not the version number:

   ```bash
   curl -s https://claude-mcp.website-auditor.io/.well-known/oauth-protected-resource/mcp
   # expect resource = https://claude-mcp.website-auditor.io/mcp
   curl -si -X POST https://claude-mcp.website-auditor.io/mcp \
     -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_audit","arguments":{"domain":"example.com"}}}' \
     | head -5
   # expect HTTP 401 and WWW-Authenticate: Bearer resource_metadata="…/oauth-protected-resource/mcp", …
   ```

   - The boot log must say `sign-in challenge: HTTP 401 (Claude)` and
     `tool copy neutral`.
   - Then add the URL in claude.ai under **Customize > Connectors > Add custom
     connector**:
     - Call `get_sample_audit` with no sign-in.
     - Call `run_audit` and check that a Connect card appears and the call
       completes after signing in.
     - Call every tool once. The portal's Test & launch step asks you to confirm
       this.
5. **Release process.** From then on, every hosted deploy is two commands; see
   RELEASING.md.

### API-side decisions (website-auditor-api, separate from this PR)

- **Trial at connect time.** The sign-in page offers the 7-day trial only to
  clients whose redirect host is in `OAUTH_TRIAL_OFFER_CLIENT_HOSTS`, which is
  empty today. Adding `claude.ai` makes the trial offer appear when Claude users
  connect. It is a repository variable plus an API deploy, so it is the owner's
  call.
- **Token audience.** Tokens aren't bound to a `resource` (RFC 8707), so a token
  issued through the ChatGPT box would also work on the Claude box. It is the
  same account through the same authorization server, so this is acceptable for
  now and noted only.
- **Client growth.** DCR registers a client per fresh connection
  ([authentication](https://claude.com/docs/connectors/building/authentication)).
  That is fine at current volume. CIMD is the upgrade if `oauth_clients` grows
  large.

## Listing draft (for the owner to review — nothing submitted)

Submit at https://claude.ai/directory/manage, then **Submit new**, then **MCP
connector**. This portal replaces the remote-server form (clau.de/mcp-directory-submission), which now redirects to
the docs. It needs an account on a paid Claude plan.

| Step | Field | Draft |
|---|---|---|
| Connection | URL | Universal URL: `https://claude-mcp.website-auditor.io/mcp` |
| Listing | Name (≤100) | Website Auditor |
| | One-liner (≤200) | See whether ChatGPT, Claude, Gemini and Perplexity recommend a business — plus security, performance, broken-link and crawlability checks for its website. |
| | Description (≤2,000) | Below |
| | Categories (1–5) | Pick from the portal's list: marketing first, then analytics/SEO if offered |
| | Documentation URL | https://github.com/SpikeyCoder/website-auditor-mcp#readme for now. *"A blog post or help-center article is sufficient"*; a website-auditor.io help page is better and is still to write |
| | Privacy policy URL | https://website-auditor.io/privacy |
| | Support contact | support@website-auditor.io (the address the site uses), to confirm |
| | Icon | `icon.png` is 256×256. The submission page states no size; the MCPB docs recommend 512×512 with 256 as the minimum, so export a 512×512 from `logo.svg` |
| | Slug (**permanent**) | `website-auditor` |
| Use cases | Primary | (1) Check whether AI assistants name a business for the questions its customers ask. (2) Audit a site's security, performance, links and crawlability. (3) Compare AI visibility against competitors. (4) Track a site weekly and see what changed. (5) Turn findings into prioritised fixes, JSON-LD schema and a go-to-market plan. |
| | Needed before connecting | A Website Auditor account, which signing in creates. Audits need a Pro subscription ($49/month, 7-day trial for eligible new customers). `get_sample_audit` works with no account. |
| | Reads / writes | Both. `track_site` and `untrack_site` write tracking state; audits spend daily quota. |
| Company | Name / website / contact | Owner to fill. Website: https://website-auditor.io |
| Authentication | Type | OAuth with dynamic client registration. **Flag that the server starts without authentication and individual tools prompt for it on demand** (lazy authentication). The portal offers this; its exact label is not in the docs. |
| Data handling | API ownership | Our own first-party API (`api.website-auditor.io`) |
| | Health data / sponsored content | No / No |
| Test & launch | Reviewer access | A **fully populated Pro test account** (owner to create): 2–3 tracked sites with at least two weekly audits, so `get_changes` has a series and `compare_competitors` has cached audits. Steps: add the connector, Connect, sign in with the test account, then run the prompts below. |
| Compliance | 7 acknowledgments | See the notes below |

**Description draft:**

> Website Auditor checks whether AI assistants actually recommend a business.
> It asks ChatGPT, Claude, Gemini and Perplexity the questions a real customer
> would ask, reports which businesses they name and which sources they read
> before answering, and runs security, broken-link, performance, and
> crawlability and markup checks on the site.
>
> Use it to audit your own site, compare your AI visibility with named
> competitors, track a site weekly and see what changed, and turn the findings
> into prioritised fixes, ready-to-paste JSON-LD schema, a shareable report, or
> a sequenced plan for getting recommended.
>
> Connect a Website Auditor account to audit real domains; audits need a Pro
> subscription. Without an account, ask for a sample audit to see a complete
> report for example.com.

**Reviewer prompts:**

1. "Show me a sample Website Auditor report." This works before Connect.
2. "Is example.com recommended by AI assistants?" This prompts Connect, then runs.
3. "Compare example.com with example.org."
4. "What should I fix first on example.com?"
5. "Track example.com weekly", then "which sites am I tracking?", then "stop
   tracking example.com".

**Compliance notes:**

- **Financial transactions:** none. No tool takes payment. Subscribing happens
  on the website.
- **AI media generation:** none.
- **Conversation data:** tools receive only their arguments, and those reach our
  API because running the audit needs them. Telemetry
  (`src/telemetry/events.ts`) records:
  - the tool name;
  - the client name and version;
  - transport and agent origin;
  - success, error code and duration;
  - install id and server version.

  It is sent with the account's key. It never contains the arguments or the
  conversation.
- **Prompt injection:** the neutral copy carries no unprompted offers and no
  "call X" instructions; see "What the code does". Only after a user's call
  meets a paywall do the instructions tell the model to state the terms the
  answer carries and to offer the sample.

**Tool names for the listing** (any later rename needs a reviewed listing edit):

- Sign-in required, read-only:
  - `get_changes`
  - `get_benchmark`
  - `get_recommendations`
  - `generate_schema`
  - `get_report`
  - `list_tracked_sites`
  - `get_monitoring_status`
- Sign-in required, write (spends quota):
  - `get_ai_visibility`
  - `run_audit`
  - `compare_competitors`
  - `get_gtm_plan`
- Sign-in required, destructive: `track_site`, `untrack_site`
- Open: `check_upgrade_status`, `get_sample_audit`

### Before submitting

1. **Result size.** Claude's limit is about 150,000 characters per tool result
   ([index](https://claude.com/docs/connectors/building/index)). Before
   submitting, measure the largest real `run_audit` / `get_report` results from
   the test account. For scale, the sample audit (the same shape as a real one)
   answers about 19,000 characters, measured 2026-10-15.
2. **`compare_competitors` and Claude's 240-second limit.**
   - It audits the site and then each competitor **one after another**, with no
     cap. Cold audits run at about 70 s p50.
   - Three or more uncached sites can pass *"240 seconds per tool call"*.
   - Fixing it (parallel audits, or a cap) is a follow-up. In the meantime the
     reviewer account's cached audits keep review runs fast.
3. **The support contact and the company name** for the listing.

## Plan for existing `.mcpb` users (plan only — nothing done)

**Facts:**

- The directory no longer accepts `.mcpb` submissions, so the existing listing
  is frozen at its last approved version. RELEASING.md step 6b can no longer be
  done.
- Directory-installed copies auto-update only when Anthropic approves a version,
  so they are stuck too.
- What still reaches them: the **API's responses**, which their tools relay, and
  telemetry (`api_request_logs.mcp_version`, `mcp_events.server_version`).

**Plan:**

1. **Keep the `.mcpb` listing up** while the connector is new. There is nothing
   to delist, and removing it would strand working installs. The GitHub release
   `.mcpb` stays for manual installs and private distribution.
2. **Once the connector is live, point users to it from places that update
   without the bundle:**
   - the README's Claude Desktop section;
   - the website's MCP or integrations page;
   - the `/admin_portal` API-key page;
   - the listing URL `https://claude.ai/directory/connectors/website-auditor`,
     which is permanent.
3. **Reach stale installs through the API (later, optional).** For requests whose
   `mcp_version` is an `.mcpb`-era build from Claude Desktop, the API could add
   one line to auth and plan answers: "Website Auditor is now a Claude connector,
   which updates itself: <listing URL>".
   - That is a change in website-auditor-api, measured against `mcp_events`
     before and after.
   - It never touches a successful audit's payload.
4. **Measure, then decide on delisting.** Watch the `.mcpb` share of
   `mcp_events.client_name` / `server_version` for Claude Desktop against the
   connector's sessions.
   - When `.mcpb` sessions fall to a level the owner sets, ask Anthropic to
     delist the extension. mcp-review@anthropic.com is documented for delisting
     *connectors*; using it for an MCPB listing is an assumption.
   - Keep the GitHub `.mcpb` for self-hosters.
5. **Update docs when the connector ships:** RELEASING.md's channel table already
   records that step 6b is closed. The README's Claude Desktop instructions should
   then lead with "Add the connector" and keep `.mcpb` and npx as alternatives.
