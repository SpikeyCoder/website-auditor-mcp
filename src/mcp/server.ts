/**
 * MCP server wiring. Registers the Phase-0 tools with their verbatim metadata
 * and dispatches each call through the tool functions, formatting the normalized
 * ToolResult as an MCP CallToolResult (with `isError` on failures so agents can
 * react). Adding P1 tools is a matter of extending the dispatch map.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SERVED_TOOLS } from "../tools/registry.js";
import type { ToolResult } from "../tools/context.js";
import type { ToolDeps } from "../tools/context.js";
import { getAiVisibility } from "../tools/getAiVisibility.js";
import { runAudit } from "../tools/runAudit.js";
import { getChanges } from "../tools/getChanges.js";
import { compareCompetitors } from "../tools/compareCompetitors.js";
import { trackSite } from "../tools/trackSite.js";
import { untrackSite } from "../tools/untrackSite.js";
import { listTrackedSites } from "../tools/listTrackedSites.js";
import { getMonitoringStatus } from "../tools/getMonitoringStatus.js";
import { getBenchmark } from "../tools/getBenchmark.js";
import { getRecommendations } from "../tools/getRecommendations.js";
import { generateSchema } from "../tools/generateSchema.js";
import { getReport } from "../tools/getReport.js";
import { checkUpgradeStatus } from "../tools/checkUpgradeStatus.js";
import { getSampleAudit } from "../tools/sampleAudit.js";
import { upgradeLink, PRICE } from "../tools/upgrade.js";
import { classifyAgentOrigin, type ClientInfo, type EventSink, type McpEvent } from "../telemetry/events.js";

export const SERVER_NAME = "website-auditor";
export const SERVER_VERSION = "1.0.9";

// Dispatch by tool name. Each handler receives the validated args + deps.
const HANDLERS: Record<string, (args: Record<string, unknown>, deps: ToolDeps) => Promise<ToolResult<unknown>>> = {
  get_ai_visibility: (a, d) => getAiVisibility(a as { domain: string }, d),
  run_audit: (a, d) => runAudit(a as { domain: string }, d),
  get_changes: (a, d) => getChanges(a as { domain: string; since?: string }, d),
  compare_competitors: (a, d) => compareCompetitors(a as { domain: string; competitors: string[] }, d),
  track_site: (a, d) => trackSite(a as { domain: string; cadence?: "weekly"; enabled?: boolean }, d),
  untrack_site: (a, d) => untrackSite(a as { domain: string }, d),
  list_tracked_sites: (_a, d) => listTrackedSites({}, d),
  get_monitoring_status: (_a, d) => getMonitoringStatus({}, d),
  get_benchmark: (a, d) => getBenchmark(a as { domain: string; industry?: string; geo?: string }, d),
  get_recommendations: (a, d) => getRecommendations(a as { domain: string }, d),
  generate_schema: (a, d) =>
    generateSchema(a as { domain: string; type?: "Organization" | "LocalBusiness" | "Product" | "FAQPage" | "auto" }, d),
  get_report: (a, d) => getReport(a as { domain: string }, d),
  check_upgrade_status: (_a, d) => checkUpgradeStatus({}, d),
  get_sample_audit: (_a, d) => getSampleAudit({}, d),
};

// Tools that MUTATE server state (not read-only). Everything else only reads.
const MUTATING_TOOLS = new Set(["track_site", "untrack_site"]);

// get_sample_audit answers entirely from a bundled fixture — no key, no network,
// no external world. Every other tool reaches the Website Auditor API.
const LOCAL_ONLY_TOOLS = new Set(["get_sample_audit"]);

/** Format a normalized ToolResult as an MCP tool result. */
export function toCallResult(result: ToolResult<unknown>): CallToolResult {
  if (result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      structuredContent: result.data as Record<string, unknown>,
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(result.error, null, 2) }],
    structuredContent: result.error as unknown as Record<string, unknown>,
  };
}

/** Pull the normalized error code off a failed ToolResult, for tool_call telemetry. */
function errorCodeOf(result: ToolResult<unknown>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

/**
 * Belt-and-braces guard around emission. EventSink.emit is fire-and-forget by
 * contract, but we also defend against a sink that throws synchronously so a
 * broken telemetry path can NEVER fail a tool call.
 */
function safeEmit(events: EventSink, event: McpEvent): void {
  try {
    events.emit(event);
  } catch {
    /* swallow: telemetry must not affect the tool path */
  }
}

export function createServer(deps: ToolDeps): McpServer {
  // Config-derived, and carries ?source=mcp so a key minted from this link is
  // attributable to the MCP (website-auditor-api stamps acquisition_channel).
  const signupUrl = upgradeLink(deps.config);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      // Injected into the model's system prompt at handshake, which makes this
      // the highest-leverage copy in the package — and previously the reason the
      // funnel leaked. It used to open with "Every tool requires an active
      // Website Auditor subscription — there is no free API tier." A model
      // reading that with no key configured simply told the user to subscribe
      // WITHOUT calling anything: no tool call, no error payload, no link in the
      // chat, and no telemetry row. Production agreed — 102 keyless sessions
      // produced exactly 1 tool call.
      //
      // So it now leads with what CAN be done and names the sign-up URL inline,
      // so a keyless user gets a runnable demo and a clickable link even if the
      // model never calls a tool at all.
      instructions:
        "Website Auditor — AI Visibility & Site Audit. Check and monitor how a website shows up in AI assistants (ChatGPT, Perplexity, Claude, Gemini) plus SEO, security and performance.\n\n" +
        "NO API KEY? You can still run get_sample_audit — it needs no key, no setup and no network, and returns a full report for example.com in the exact shape a real audit returns. Call it instead of declining, so the user can see what they would be buying.\n\n" +
        `Auditing real domains requires a Website Auditor subscription (${PRICE}). Sign up and create an API key at ${signupUrl} , then set WA_API_KEY in this server's config. check_upgrade_status reports the caller's own standing with any valid key.\n\n` +
        "When a tool returns AUTH_REQUIRED or PRO_REQUIRED, tell the user the price and give them that link — do not just report the error code.",
    },
  );

  // clientInfo is only known after the `initialize` handshake. Capture it once
  // and reuse it to stamp every tool_call, and to emit the session_init event
  // (installs / agent-origin / first-call latency are all derived from it).
  let clientInfo: ClientInfo | undefined;
  server.server.oninitialized = () => {
    clientInfo = server.server.getClientVersion();
    safeEmit(deps.events, {
      event_type: "session_init",
      client_name: clientInfo?.name,
      client_version: clientInfo?.version,
      is_agent_originated: classifyAgentOrigin(clientInfo?.name),
    });
  };

  for (const spec of SERVED_TOOLS) {
    const handler = HANDLERS[spec.name];
    if (!handler) continue;
    // track_site / untrack_site mutate server state (enroll/remove a tracking),
    // so they are NOT read-only — they carry destructiveHint. Every other served
    // tool only reads and carries readOnlyHint. Every tool also carries a human
    // `title` and openWorldHint (all tools reach the external Website Auditor API).
    // These annotations are required for the Claude connector directory.
    const isMutating = MUTATING_TOOLS.has(spec.name);
    const annotations = isMutating
      ? { title: spec.title, readOnlyHint: false, destructiveHint: true, openWorldHint: true }
      : { title: spec.title, readOnlyHint: true, openWorldHint: !LOCAL_ONLY_TOOLS.has(spec.name) };
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations,
      },
      async (args: Record<string, unknown>) => {
        const startedAt = Date.now();
        const result = await handler(args ?? {}, deps);
        // Fire-and-forget: emit() never throws, and telemetry is not awaited, so
        // a metrics failure cannot affect the tool response.
        safeEmit(deps.events, {
          event_type: "tool_call",
          tool_name: spec.name,
          client_name: clientInfo?.name,
          client_version: clientInfo?.version,
          is_agent_originated: classifyAgentOrigin(clientInfo?.name),
          success: result.ok,
          error_code: errorCodeOf(result),
          duration_ms: Date.now() - startedAt,
        });
        return toCallResult(result);
      },
    );
  }

  return server;
}
