/**
 * generate_schema [Pro]
 *
 * Pro-gated, read-only. Generates ready-to-paste JSON-LD structured data tailored
 * to a domain, to improve how AI assistants and search engines understand it.
 * Wired to `client.generateSchema` (GET /api/schema). The client strips the API's
 * `success` envelope, so this tool returns the documented
 * `{ jsonld, placement_notes }` shape.
 */
import type { SchemaResult } from "../api/types.js";
import { gateProTool, fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";

export interface GenerateSchemaArgs {
  domain: string;
  type?: "Organization" | "LocalBusiness" | "Product" | "FAQPage" | "auto";
}

export async function generateSchema(args: GenerateSchemaArgs, deps: ToolDeps): Promise<ToolResult<SchemaResult>> {
  const gate = await gateProTool(deps);
  if (gate) return gate;

  try {
    const schema = await deps.client.generateSchema({ domain: args.domain, type: args.type });
    return ok(schema);
  } catch (e) {
    return fromApiError(e, deps.config.upgradeUrl);
  }
}
