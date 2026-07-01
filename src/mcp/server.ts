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
import { classifyAgentOrigin, type ClientInfo, type EventSink, type McpEvent } from "../telemetry/events.js";

export const SERVER_NAME = "website-auditor";
export const SERVER_VERSION = "1.0.0";

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
};

// Tools that MUTATE server state (not read-only). Everything else only reads.
const MUTATING_TOOLS = new Set(["track_site", "untrack_site"]);

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
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Website Auditor — AI Visibility & Site Audit. Check and monitor how a website shows up in AI assistants (ChatGPT, Perplexity, Claude, Gemini) plus SEO, security and performance. Free tools: get_ai_visibility, run_audit. Pro tools: get_changes, compare_competitors. Set WA_API_KEY to a Website Auditor Pro key.",
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
    // so they are NOT read-only. Every other served tool only reads.
    const readOnlyHint = !MUTATING_TOOLS.has(spec.name);
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: { readOnlyHint, openWorldHint: true },
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
