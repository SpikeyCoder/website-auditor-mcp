/**
 * Telemetry event model + the agent-origin classification heuristic.
 *
 * The MCP server emits two event types (see the API's mcp_events table):
 *   - session_init: once, when a client completes the `initialize` handshake.
 *   - tool_call:    after every tool invocation.
 *
 * Emission is fire-and-forget (see EventSink): a metrics failure must NEVER
 * break a tool call. The transport is an authenticated POST to the API portal's
 * /api/mcp-events ingest endpoint (HttpEventSink) — the MCP holds only the
 * user's `wa_` key, never Supabase credentials, so the API owns the write.
 */

/** clientInfo from the MCP `initialize` handshake (name + version). */
export interface ClientInfo {
  name?: string;
  version?: string;
}

export interface SessionInitEvent {
  event_type: "session_init";
  client_name?: string;
  client_version?: string;
  is_agent_originated: boolean;
}

export interface ToolCallEvent {
  event_type: "tool_call";
  tool_name: string;
  client_name?: string;
  client_version?: string;
  is_agent_originated: boolean;
  success: boolean;
  error_code?: string;
  duration_ms: number;
}

export type McpEvent = SessionInitEvent | ToolCallEvent;

/**
 * Sink for telemetry events. `emit` is FIRE-AND-FORGET by contract: it must
 * return immediately and never throw or reject into the caller — the tool path
 * does not await it and must not be affected by a metrics failure.
 */
export interface EventSink {
  emit(event: McpEvent): void;
}

/** A sink that drops everything — used when telemetry is disabled or in tests. */
export class NoopEventSink implements EventSink {
  emit(): void {
    /* no-op */
  }
}

/**
 * AGENT-ORIGIN HEURISTIC (documented, NOT ground truth).
 *
 * MCP gives us the client's self-reported clientInfo.name and nothing more, so
 * we cannot truly know whether a human or an autonomous agent drove a call. We
 * approximate: a call is "human-in-client" when the client is a KNOWN
 * human-facing desktop/IDE (the allowlist below); everything else — headless
 * runners, SDK-built clients, and custom/unknown agent clients — is treated as
 * agent-originated.
 *
 * Bias: unknown clients count as agent-originated, so this can OVER-count agent
 * share. That is the intended conservative direction for a metric whose job is
 * to detect agent adoption, but read it as a heuristic, not a fact. To adjust,
 * add clients to HUMAN_FACING_CLIENTS. Keep this rule in sync with the README
 * ("Metric definitions → % agent-originated").
 */
export const HUMAN_FACING_CLIENTS: readonly string[] = [
  "claude-ai", // Claude Desktop / claude.ai
  "claude-code", // Claude Code (human-in-terminal)
  "claude-desktop",
  "cursor", // Cursor IDE
  "windsurf", // Windsurf / Codeium IDE
  "vscode",
  "visual studio code",
  "zed", // Zed editor
  "jetbrains", // JetBrains IDEs
];

/** True when the call should be counted as agent-originated (see heuristic above). */
export function classifyAgentOrigin(clientName: string | undefined): boolean {
  if (!clientName) return true; // no client identity ⇒ assume non-human
  const name = clientName.toLowerCase();
  return !HUMAN_FACING_CLIENTS.some((human) => name.includes(human));
}
