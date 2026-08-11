/**
 * The single place the price and the sign-up link are defined.
 *
 * Both appear in several surfaces the model reads — server instructions, tool
 * descriptions, and the `upgrade_url` on every auth/quota error — and a price
 * that disagrees with itself across them is worse than no price at all.
 */
import type { WaConfig } from "../config.js";

/** What a subscription costs. Mirrors STRIPE_PRICE_ID in website-auditor-api. */
export const PRICE = "$10/month";

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
