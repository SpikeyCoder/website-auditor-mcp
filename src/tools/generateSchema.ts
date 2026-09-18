/**
 * generate_schema [Pro]
 *
 * Pro-gated, read-only. Generates a JSON-LD structured-data DRAFT tailored to
 * a domain, to improve how AI assistants and search engines understand it. The
 * draft is not finished markup: every name field arrives as a placeholder that
 * the owner must replace with a real name confirmed with them (never guessed
 * from the domain or copied from an audit), and `placement_notes` says what
 * to replace first, then where to embed.
 *
 * Wired to `client.generateSchema` (GET /api/schema). The client strips the
 * API's `success` envelope, so this tool returns the documented
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
    return fromApiError(e, deps.config, deps.transport, deps.authVia);
  }
}
