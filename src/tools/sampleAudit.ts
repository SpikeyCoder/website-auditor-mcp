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
import { upgradeLink, PRICE, plansAreDescribedAt } from "./upgrade.js";
import { oauthEnabled } from "../auth/oauth.js";
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
  /** What a real run costs. Absent under info style, which states no price. */
  price?: string;
  /** Where to subscribe and mint a key. */
  upgrade_url: string;
}

const SAMPLE_DOMAIN = "example.com";

export async function getSampleAudit(
  _args: Record<string, never>,
  deps: ToolDeps,
): Promise<ToolResult<SampleAudit>> {
  // What a real audit needs. Under Mixed Auth the login carries the key, so
  // the requirement is a plan on the connected account — for a connected
  // reader too, whose key came from the login. Under info style no price
  // (plansAreDescribedAt).
  const mixedAuth = deps.transport === "http" && oauthEnabled(deps.config);
  // A caller who pasted a key on a Mixed Auth server is a key user, not a login.
  const what = mixedAuth && deps.authVia !== "key" ? "on a connected account" : "and an API key";
  const requirement = deps.config.upsellStyle === "info"
    ? `plan ${what}. ${plansAreDescribedAt(deps.config)}.`
    : `subscription (${PRICE}) ${what}.`;
  return ok({
    is_sample: true,
    domain: SAMPLE_DOMAIN,
    note:
      `This is fixed sample data for ${SAMPLE_DOMAIN}, not a live audit, and not a result ` +
      `for any site you asked about. It shows the exact response shape a real run returns — ` +
      `scored summary, per-test results, and the AI-visibility breakdown across ChatGPT, ` +
      `Perplexity, Claude and Gemini. To audit a real domain you need a Website Auditor ` +
      requirement +
      // Only for a caller who has no key. This tool does no gating and no key
      // check, so the note was appended unconditionally — which turned a
      // statement of what a real audit requires into a setup procedure served
      // to people who are already set up. A paying subscriber running the demo
      // was told to set a key and restart their client, which reads as "your
      // key isn't working", on the highest-traffic string in the package: the
      // keyless surface a marketplace reviewer sees first.
      //
      // Under Mixed Auth there is no key to deliver at all — the host's login
      // carries it — and the unverified and not-connected errors send readers
      // here, so the header instruction would contradict what they just read.
      (deps.config.apiKey
        ? ""
        : mixedAuth
          ? " Connect (or reconnect) your account when your app offers to — there is no key to paste."
          : ` ${keySetupNote(deps.transport)}`),
    audit: sampleAuditReport(),
    // Omitted under info style: a price field is a price display, which
    // OpenAI's rules forbid a plugin to show (tools/upgrade.ts).
    ...(deps.config.upsellStyle === "info" ? {} : { price: PRICE }),
    upgrade_url: upgradeLink(deps.config),
  });
}
