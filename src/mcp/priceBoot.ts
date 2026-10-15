/**
 * The stdio server, built once the price is known (tools/upgrade.ts): its
 * instructions and tool descriptions state the price at the handshake, so
 * they must state the one the API charges today, and every tool call after
 * re-asks at most hourly (refreshPriceIfStale). An info-style server states
 * no price, so it never asks.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "../tools/context.js";
import { refreshPrice, refreshPriceIfStale } from "../tools/upgrade.js";
import { createServer } from "./server.js";

export async function createServerWithPrice(deps: ToolDeps, fetchImpl: typeof fetch = fetch): Promise<McpServer> {
  if (deps.config.upsellStyle !== "info") await refreshPrice(deps.config, fetchImpl);
  return createServer({ ...deps, refreshPrice: () => refreshPriceIfStale(deps.config, fetchImpl) });
}
