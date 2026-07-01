#!/usr/bin/env node
/**
 * Entry point: wires config + dependencies and serves the MCP over stdio.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { WaApiClient } from "./api/client.js";
import { DefaultSubscriptionProvider } from "./auth/entitlements.js";
import { InMemoryMeter } from "./auth/meter.js";
import { createServer } from "./mcp/server.js";
import type { ToolDeps } from "./tools/context.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const deps: ToolDeps = {
    config,
    client: new WaApiClient(config),
    subscriptions: new DefaultSubscriptionProvider(config),
    meter: new InMemoryMeter({
      dailyLimit: config.freeDailyAuditLimit,
      maxDomains: config.freeMaxDomains,
    }),
  };

  const server = createServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdio transport keeps the process alive; log to stderr (stdout is the
  // JSON-RPC channel and must not be polluted).
  console.error(`[website-auditor-mcp] ready — API ${config.apiBaseUrl}, key ${config.apiKey ? "set" : "not set"}`);
}

main().catch((err) => {
  console.error("[website-auditor-mcp] fatal:", err);
  process.exit(1);
});
