/**
 * get_sample_audit [Free — no API key required]
 *
 * The only tool a developer with no key can actually run, and the reason it
 * exists: `POST /api/keys` requires an active subscription, so there is no way
 * to obtain even a free key without paying $10/mo first. Without this, the
 * product is bought entirely sight-unseen.
 *
 * Deliberately does no work. No `gateProTool`, no subscription lookup, no
 * network call, no quota — so it answers with no key, with a revoked key, and
 * while the API is down. The whole value is that it cannot fail at the moment
 * someone is deciding whether this is worth paying for.
 *
 * Takes no domain argument, and always reports example.com. Accepting a domain
 * would return canned numbers that read as a real audit of the caller's own
 * site — the one outcome worse than showing nothing.
 */
import { keySetupNote, ok, type ToolDeps, type ToolResult } from "./context.js";
import { upgradeLink, PRICE } from "./upgrade.js";
import { sampleAuditReport } from "./sampleData.js";
import type { AuditReport } from "../api/types.js";

export interface SampleAudit {
  /** Always true. The caller must never mistake this for a live result. */
  is_sample: true;
  /** The fixed domain this sample describes. Never the caller's own. */
  domain: string;
  /** Plain-language framing for the model to relay. */
  note: string;
  /** The real `GET /api/audit` payload shape, populated with example.com data. */
  audit: AuditReport;
  /** What a real run costs. */
  price: string;
  /** Where to subscribe and mint a key. */
  upgrade_url: string;
}

const SAMPLE_DOMAIN = "example.com";

export async function getSampleAudit(
  _args: Record<string, never>,
  deps: ToolDeps,
): Promise<ToolResult<SampleAudit>> {
  return ok({
    is_sample: true,
    domain: SAMPLE_DOMAIN,
    note:
      `This is fixed sample data for ${SAMPLE_DOMAIN}, not a live audit, and not a result ` +
      `for any site you asked about. It shows the exact response shape a real run returns — ` +
      `scored summary, per-test results, and the AI-visibility breakdown across ChatGPT, ` +
      `Perplexity, Claude and Gemini. To audit a real domain you need a Website Auditor ` +
      `subscription (${PRICE}) and an API key.` +
      // Only for a caller who has no key. This tool does no gating and no key
      // check, so the note was appended unconditionally — which turned a
      // statement of what a real audit requires into a setup procedure served
      // to people who are already set up. A paying subscriber running the demo
      // was told to set a key and restart their client, which reads as "your
      // key isn't working", on the highest-traffic string in the package: the
      // keyless surface a marketplace reviewer sees first.
      (deps.config.apiKey ? "" : ` ${keySetupNote(deps.transport)}`),
    audit: sampleAuditReport(),
    price: PRICE,
    upgrade_url: upgradeLink(deps.config),
  });
}
