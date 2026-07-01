/**
 * get_benchmark [Pro]
 *
 * Pro-gated, read-only. Benchmarks a domain's AI visibility against its industry
 * and geography, returning percentile / peer-median context rather than an
 * absolute number. Wired to `client.getBenchmark` (GET /api/benchmark). The
 * client strips the API's `success` envelope, so this tool returns the
 * documented `{ percentile, peer_median, sample_size, position_summary }` shape.
 */
import type { Benchmark } from "../api/types.js";
import { gateProTool, fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";

export interface GetBenchmarkArgs {
  domain: string;
  industry?: string;
  geo?: string;
}

export async function getBenchmark(args: GetBenchmarkArgs, deps: ToolDeps): Promise<ToolResult<Benchmark>> {
  const gate = await gateProTool(deps);
  if (gate) return gate;

  try {
    const benchmark = await deps.client.getBenchmark({
      domain: args.domain,
      industry: args.industry,
      geo: args.geo,
    });
    return ok(benchmark);
  } catch (e) {
    return fromApiError(e, deps.config.upgradeUrl);
  }
}
