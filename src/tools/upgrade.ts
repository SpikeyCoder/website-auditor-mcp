/**
 * The single place the price and the sign-up link are defined.
 *
 * Both appear in several surfaces the model reads — server instructions, tool
 * descriptions, and the `upgrade_url` on every auth/quota error — and a price
 * that disagrees with itself across them is worse than no price at all.
 */
import type { WaConfig } from "../config.js";

/**
 * The price stated when the API cannot be asked: the list price new signups
 * pay (from 2026-10-15, $49; earlier subscribers move later and are told by
 * email, never by this server). Overstating is the safer error: a signup is
 * never charged more than they were shown.
 */
export const FALLBACK_PRICE = "$49/month";

/**
 * What a subscription costs, as the API says it (GET /pricing.json, from its
 * PRO_PRICE_MONTHLY, which moves with STRIPE_PRICE_ID). Read at startup, and
 * every few minutes by the hosted server (refreshPrice), so a price change
 * reaches every surface without a release: installed servers lag releases by
 * weeks, and a price this server states must be the price a signup pays.
 *
 * A live binding: every importer reads the current value.
 */
export let PRICE = FALLBACK_PRICE;

const PRICE_SHAPE = /^\$[1-9]\d{0,3}\/month$/;
const PRICE_TIMEOUT_MS = 2000;

/**
 * Ask the API for the price, and use it if it answers in shape; otherwise
 * keep the last good one. Never throws: a server that cannot reach the API
 * at startup still starts, and says the fallback.
 */
export async function refreshPrice(
  config: Pick<WaConfig, "apiBaseUrl">,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  try {
    const res = await fetchImpl(`${config.apiBaseUrl}/pricing.json`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PRICE_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as { pro_price_label?: unknown };
      if (typeof body.pro_price_label === "string" && PRICE_SHAPE.test(body.pro_price_label)) {
        PRICE = body.pro_price_label;
      }
    }
  } catch {
    // Keep the last good price.
  }
  return PRICE;
}

/** Tests only: set the price as if the API had said it. */
export function __setPriceForTests(price: string): void {
  PRICE = price;
}

/**
 * The plan sentence an `upsellStyle: "info"` surface may say, and all it may
 * say. OpenAI's app rules: "Plugins must not display subscription plans,
 * initiate new subscriptions, or promote upgrades", and "Do not advertise
 * pricing, subscriptions, free trials, discounts, or promotions" — but they
 * allow "Explain that a certain feature is not available with the user's
 * current plan" and "Link to an informational page describing available
 * plans" (developers.openai.com/apps-sdk/app-submission-guidelines). So no
 * price and no trial under info style: the need for a plan, and where plans
 * are described.
 */
export function plansAreDescribedAt(config: WaConfig): string {
  return `Plans are described at ${upgradeLink(config)}`;
}

/**
 * The sign-up link, tagged so the resulting key is attributable to the MCP.
 *
 * `?source=mcp` is not decoration: website-auditor-api stamps
 * `api_keys.acquisition_channel` from this parameter at key mint (see its
 * `src/services/acquisition.js`), and the admin portal carries it across the
 * sign-in redirect. Without the tag every MCP-driven signup records NULL and
 * "MCP downloads → subscriptions" stays uncomputable — which is exactly the
 * state that prompted this work.
 *
 * The server validates against a fixed allowlist and stores null for anything
 * unrecognized, so this can only ever attribute honestly or not at all.
 *
 * Preserves any query string already on WA_UPGRADE_URL rather than clobbering
 * it, and degrades to the raw configured value if it isn't a parseable URL.
 *
 * Style-aware: under `upsellStyle: "info"` (see config.ts) this returns the
 * informational page instead of the portal — EVERY surface that links a reader
 * toward the paid plan flows through here, which is what makes the style a
 * config switch rather than a fork. Still tagged: on the info page the
 * parameter is inert, but a reader who continues to the portal carries it.
 */
export function upgradeLink(config: WaConfig): string {
  return tagSource(config.upsellStyle === "info" ? config.upsellInfoUrl : config.upgradeUrl);
}

/**
 * The same tagging, applied to a URL that did not come from config — chiefly
 * the `upgrade_url` the API itself returns on a 401/403, which is just as much
 * an MCP-driven signup as a link we composed.
 *
 * Split out of upgradeLink so fromApiError can attribute every error-path link
 * in one place. Doing it there rather than at its 13 call sites means a new
 * tool cannot forget: there is nothing left to remember.
 *
 * Idempotent, and never overrides a `source` that is already present, so it is
 * safe to apply more than once or to a link that was tagged elsewhere.
 */
export function tagSource(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has("source")) url.searchParams.set("source", "mcp");
    return url.toString();
  } catch {
    return rawUrl;
  }
}
