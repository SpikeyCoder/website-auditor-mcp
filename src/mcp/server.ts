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
import { getGtmPlan } from "../tools/getGtmPlan.js";
import { generateSchema } from "../tools/generateSchema.js";
import { getReport } from "../tools/getReport.js";
import { checkUpgradeStatus } from "../tools/checkUpgradeStatus.js";
import { getSampleAudit } from "../tools/sampleAudit.js";
import { upgradeLink } from "../tools/upgrade.js";
import { buildInstructions } from "./instructions.js";
import { PROMPT_SPECS } from "./prompts.js";
import { classifyAgentOrigin, type ClientInfo, type EventSink, type McpEvent } from "../telemetry/events.js";

export const SERVER_NAME = "website-auditor";
// Imported AND re-exported: line ~99 needs a local binding for the server's
// own `initialize` response, and every existing
// `import { SERVER_VERSION } from "../mcp/server.js"` must keep resolving.
// The constant itself lives in src/version.ts so api/client.ts can stamp it on
// requests without importing this module and closing a cycle.
import { SERVER_VERSION } from "../version.js";
export { SERVER_VERSION };

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
  get_gtm_plan: (a, d) => getGtmPlan(a as { domain: string; focus?: string; constraints?: string; prior_plan?: string }, d),
  generate_schema: (a, d) =>
    generateSchema(a as { domain: string; type?: "Organization" | "LocalBusiness" | "Product" | "FAQPage" | "auto" }, d),
  get_report: (a, d) => getReport(a as { domain: string }, d),
  check_upgrade_status: (_a, d) => checkUpgradeStatus({}, d),
  get_sample_audit: (_a, d) => getSampleAudit({}, d),
};

// get_sample_audit answers entirely from a bundled fixture — no key, no network,
// no external world. Every other tool reaches the Website Auditor API.
const LOCAL_ONLY_TOOLS = new Set(["get_sample_audit"]);

/**
 * Per-tool annotations, accurate against BOTH the MCP spec and the OpenAI
 * plugin-review definitions — each is a listed rejection reason when wrong, and
 * "conservatively true" is as wrong there as false:
 *
 *   readOnlyHint    — true unless the tool mutates server-side state. Only
 *                     track_site / untrack_site do.
 *   destructiveHint — "can delete, overwrite, revoke access, or act
 *                     irreversibly". track_site only ENROLLS (or pauses)
 *                     monitoring — reversible, nothing deleted — so it is NOT
 *                     destructive. untrack_site removes the tracking and frees
 *                     the slot, ending the history get_changes reads → true.
 *   openWorldHint   — read tools query the external Website Auditor API about
 *                     arbitrary internet domains (an open world) → true, except
 *                     the bundled sample. track/untrack change only the
 *                     caller's own account state, nothing publicly visible →
 *                     false.
 *
 * Pinned tool-by-tool in tests/mcp/server.test.ts.
 */
function annotationsFor(spec: { name: string; title: string }): {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
} {
  if (spec.name === "track_site") {
    return { title: spec.title, readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  }
  if (spec.name === "untrack_site") {
    return { title: spec.title, readOnlyHint: false, destructiveHint: true, openWorldHint: false };
  }
  return {
    title: spec.title,
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: !LOCAL_ONLY_TOOLS.has(spec.name),
  };
}

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
      // the highest-leverage copy in the package — and twice now the reason the
      // funnel leaked. The full history, and why the string is shaped the way it
      // is, lives in ./instructions.ts; the ordering and proportion it must keep
      // are pinned by tests/mcp/instructionTriggers.test.ts.
      instructions: buildInstructions(signupUrl, deps.config.upsellStyle, deps.transport),
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
      transport: deps.transport,
    });
  };

  for (const spec of SERVED_TOOLS) {
    const handler = HANDLERS[spec.name];
    if (!handler) continue;
    // Every tool carries a human `title` plus all three hint annotations —
    // required by the Claude connector directory and the OpenAI plugin review
    // alike. The values are per-tool; see annotationsFor above.
    const annotations = annotationsFor(spec);
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
          transport: deps.transport,
        });
        return toCallResult(result);
      },
    );
  }

  // Prompts are the only discovery surface in this package that a HUMAN drives:
  // hosts render them as clickable affordances, so unlike the tool list they do
  // not depend on the model first connecting the conversation to the capability.
  // See ./prompts.ts for why that distinction is the whole point.
  for (const spec of PROMPT_SPECS) {
    const message = (args: Record<string, string>) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: spec.render(args) } }],
    });
    // Two arities: with an argsSchema the SDK hands the callback the parsed
    // args, without one it hands it only the request extra. Registering the
    // argument-free prompt through the first form would make hosts render an
    // empty form for the one prompt whose whole value is being a single click.
    if (spec.argsSchema) {
      server.registerPrompt(
        spec.name,
        { title: spec.title, description: spec.description, argsSchema: spec.argsSchema },
        (args) => message(args as Record<string, string>),
      );
    } else {
      server.registerPrompt(spec.name, { title: spec.title, description: spec.description }, () => message({}));
    }
  }

  return server;
}
