/**
 * Shared tool plumbing: dependency bundle, the normalized ToolResult union, and
 * the gating helpers that enforce auth / Pro / metering uniformly across tools.
 */
import type { WaConfig } from "../config.js";
import type { WaApiClientLike } from "../api/client.js";
import type { SubscriptionProvider } from "../auth/entitlements.js";
import type { AuditCache } from "../auth/auditCache.js";
import type { ErrorCode } from "../api/errors.js";
import { WaApiError } from "../api/errors.js";
import { isPro } from "../auth/entitlements.js";
import { upgradeLink, tagSource, PRICE } from "./upgrade.js";
import type { EventSink } from "../telemetry/events.js";

export interface ToolDeps {
  client: WaApiClientLike;
  subscriptions: SubscriptionProvider;
  cache: AuditCache;
  config: WaConfig;
  /** Telemetry sink for P0 success-metric events (fire-and-forget). */
  events: EventSink;
}

export interface ToolError {
  code: ErrorCode;
  message: string;
  upgrade_url?: string;
  details?: unknown;
}

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: ToolError };

export function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

/**
 * The step after "set WA_API_KEY", without which nothing changes.
 *
 * `loadConfig(process.env)` runs once, at startup (src/index.ts), so a key set
 * while this server is running is invisible to it. Every message that tells
 * someone to set the key must carry this, or it describes a procedure that
 * ends with the identical error it began with — see tests/keyRequiresRestart.
 */
export const RESTART_NOTE =
  "The key is read once at startup, so restart your MCP client after setting it " +
  "(in Claude Desktop: quit and reopen the app) — until then this server keeps using the old value.";

export function err(code: ErrorCode, message: string, extra: { upgrade_url?: string; details?: unknown } = {}): ToolResult<never> {
  return { ok: false, error: { code, message, ...extra } };
}

/** Map a thrown WaApiError (or unknown error) to a ToolError result. */
export function fromApiError(e: unknown, upgradeUrl: string): ToolResult<never> {
  if (e instanceof WaApiError) {
    // OVER_QUOTA is deliberately NOT in this list. It is the shared daily audit
    // cap, which only a subscriber can reach (there is no free API tier), so an
    // upgrade link there sells someone their own plan. See the 429 branch in
    // api/client.ts. These two ARE plan boundaries: no key, or no subscription.
    const attachUpgrade = e.code === "INVALID_KEY" || e.code === "PRO_REQUIRED";
    // Tagged HERE rather than by the 13 call sites that pass a raw
    // config.upgradeUrl, so no tool can emit an unattributed signup link — see
    // tagSource in upgrade.js. The API's own upgrade_url is tagged too: a 401
    // followed to the portal is an MCP-driven signup however the link was made.
    const target = e.upgradeUrl ?? (attachUpgrade ? upgradeUrl : undefined);
    return err(e.code, e.message, {
      upgrade_url: target === undefined ? undefined : tagSource(target),
      details: e.details,
    });
  }
  return err("UPSTREAM_ERROR", e instanceof Error ? e.message : "Unexpected error.");
}

/**
 * Gate a subscription-required tool. Returns a ToolError result to
 * short-circuit, or null to proceed.
 *
 * Since website-auditor-api PR #17 there is no free API tier: every key-authed
 * capability requires an active/trialing subscription, so this pre-flight
 * applies to ALL tools except check_upgrade_status (which reports standing
 * with any valid key). Blocking client-side saves the wasted round-trip the
 * server would 403 anyway.
 *
 * Distinguishes a *verified* non-Pro tier (definitive "not subscribed" →
 * PRO_REQUIRED with the upgrade path) from an *unverified* one (the subscription
 * service was unreachable and we defaulted to free → SUBSCRIPTION_UNVERIFIED, a
 * retryable signal) so a genuine subscriber isn't wrongly told to upgrade
 * during an outage. No key at all is AUTH_REQUIRED, not an upsell.
 */
export async function gateProTool(deps: ToolDeps): Promise<ToolResult<never> | null> {
  const { tier, verified, message, rejection } = await deps.subscriptions.resolve(
    deps.config.apiKey,
  );
  if (isPro(tier)) return null;

  const upgradeUrl = upgradeLink(deps.config);

  if (tier === "none") {
    return err(
      "AUTH_REQUIRED",
      `This tool requires a Website Auditor API key, but none is configured. ` +
        `Try get_sample_audit instead — it needs no key and shows exactly what a real audit returns. ` +
        `To audit real domains, subscribe (${PRICE}; eligible new customers get a 7-day free trial — payment method required to start, no charge until the trial ends) and create a key at ${upgradeUrl} , then set WA_API_KEY in this server's config. ${RESTART_NOTE}`,
      { upgrade_url: upgradeUrl },
    );
  }

  // The KEY was rejected, which is not the same as having no subscription and
  // must not be answered with an upsell — most revoked keys belong to people who
  // are currently paying and revoked their own key (rotated it, or killed a
  // leaked one). Telling them to subscribe cannot fix their problem.
  //
  // A lapsed subscriber never reaches here: cancelling does not revoke keys, so
  // their key stays valid and the Pro gate below answers with PRO_REQUIRED.
  //
  // The exception is someone whose key is revoked AND whose subscription has
  // lapsed. Minting a key requires an active subscription (requireProSession on
  // POST /api/keys), so "create a new key" alone would send them to a paywall
  // they weren't warned about — hence stating both, in the order they must
  // happen. The API's own remediation text is passed through, not replaced.
  if (tier === "invalid") {
    // The upstream message already carries the "generate a new key" instruction,
    // so only the portal URL and the subscription caveat are added — restating
    // it produced "Generate a new key from the admin portal. Create a
    // replacement at …", which reads like two different steps.
    const base =
      message ?? "This Website Auditor API key is not valid — it may have been revoked.";
    // Same sentence either way; only the CODE splits. A key with no `wa_`
    // prefix was never one of ours, so it is an onboarding slip rather than
    // access being withdrawn — and in the event stream those were one number.
    // Reading a paste error as "a customer is locked out" costs a support
    // panic; reading the reverse costs a customer.
    return err(
      rejection === "malformed" ? "MALFORMED_KEY" : "INVALID_KEY",
      `${base} Portal: ${upgradeUrl} — creating a key needs an active subscription (${PRICE}), ` +
        `so if yours has lapsed, resubscribe there first. Then set the new key as WA_API_KEY. ${RESTART_NOTE}`,
      { upgrade_url: upgradeUrl },
    );
  }

  if (!verified) {
    return err(
      "SUBSCRIPTION_UNVERIFIED",
      "Couldn't verify your Website Auditor subscription right now — the subscription service was unreachable. This is a temporary issue, not a downgrade: please try again in a moment.",
      { upgrade_url: upgradeUrl },
    );
  }

  return err(
    "PRO_REQUIRED",
    `This tool requires an active Website Auditor subscription (${PRICE}; eligible new customers get a 7-day free trial — payment method required to start, no charge until the trial ends). ` +
      `Subscribe at ${upgradeUrl} to unlock audits, AI-visibility checks, monitoring, deltas, benchmarks and competitor comparison. ` +
      `In the meantime get_sample_audit works with no subscription and shows the exact output format.`,
    { upgrade_url: upgradeUrl },
  );
}
