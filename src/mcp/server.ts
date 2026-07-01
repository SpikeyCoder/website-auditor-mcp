/**
 * MCP server wiring. Registers the Phase-0 tools with their verbatim metadata
 * and dispatches each call through the tool functions, formatting the normalized
 * ToolResult as an MCP CallToolResult (with `isError` on failures so agents can
 * react). Adding P1 tools is a matter of extending the dispatch map.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { P0_TOOLS } from "../tools/registry.js";
import type { ToolResult } from "../tools/context.js";
import type { ToolDeps } from "../tools/context.js";
import { getAiVisibility } from "../tools/getAiVisibility.js";
import { runAudit } from "../tools/runAudit.js";
import { getChanges } from "../tools/getChanges.js";
import { compareCompetitors } from "../tools/compareCompetitors.js";

export const SERVER_NAME = "website-auditor";
export const SERVER_VERSION = "0.1.0";

// Dispatch by tool name. Each handler receives the validated args + deps.
const HANDLERS: Record<string, (args: Record<string, unknown>, deps: ToolDeps) => Promise<ToolResult<unknown>>> = {
  get_ai_visibility: (a, d) => getAiVisibility(a as { domain: string }, d),
  run_audit: (a, d) => runAudit(a as { domain: string }, d),
  get_changes: (a, d) => getChanges(a as { domain: string; since?: string }, d),
  compare_competitors: (a, d) => compareCompetitors(a as { domain: string; competitors: string[] }, d),
};

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

export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Website Auditor — AI Visibility & Site Audit. Check and monitor how a website shows up in AI assistants (ChatGPT, Perplexity, Claude, Gemini) plus SEO, security and performance. Free tools: get_ai_visibility, run_audit. Pro tools: get_changes, compare_competitors. Set WA_API_KEY to a Website Auditor Pro key.",
    },
  );

  for (const spec of P0_TOOLS) {
    const handler = HANDLERS[spec.name];
    if (!handler) continue;
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args: Record<string, unknown>) => toCallResult(await handler(args ?? {}, deps)),
    );
  }

  return server;
}
