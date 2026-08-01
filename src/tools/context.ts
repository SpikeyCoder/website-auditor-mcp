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
import { upgradeLink, PRICE } from "./upgrade.js";
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

export function err(code: ErrorCode, message: string, extra: { upgrade_url?: string; details?: unknown } = {}): ToolResult<never> {
  return { ok: false, error: { code, message, ...extra } };
}

/** Map a thrown WaApiError (or unknown error) to a ToolError result. */
export function fromApiError(e: unknown, upgradeUrl: string): ToolResult<never> {
  if (e instanceof WaApiError) {
    const attachUpgrade = e.code === "OVER_QUOTA" || e.code === "INVALID_KEY" || e.code === "PRO_REQUIRED";
    return err(e.code, e.message, {
      upgrade_url: e.upgradeUrl ?? (attachUpgrade ? upgradeUrl : undefined),
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
  const { tier, verified, message } = await deps.subscriptions.resolve(deps.config.apiKey);
  if (isPro(tier)) return null;

  const upgradeUrl = upgradeLink(deps.config);

  if (tier === "none") {
    return err(
      "AUTH_REQUIRED",
      `This tool requires a Website Auditor API key, but none is configured. ` +
        `Try get_sample_audit instead — it needs no key and shows exactly what a real audit returns. ` +
        `To audit real domains, subscribe (${PRICE}) and create a key at ${upgradeUrl} , then set WA_API_KEY in this server's config.`,
      { upgrade_url: upgradeUrl },
    );
  }

  // The key itself was rejected — a new key fixes this, buying a subscription
  // does not. Pass the API's own remediation text through rather than replacing
  // it with an upsell, which is what this path used to do.
  if (tier === "invalid") {
    return err(
      "INVALID_KEY",
      message ??
        "This Website Auditor API key is not valid — it may have been revoked. Create a new key in the admin portal and update WA_API_KEY.",
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
    `This tool requires an active Website Auditor subscription (${PRICE}). ` +
      `Subscribe at ${upgradeUrl} to unlock audits, AI-visibility checks, monitoring, deltas, benchmarks and competitor comparison. ` +
      `In the meantime get_sample_audit works with no subscription and shows the exact output format.`,
    { upgrade_url: upgradeUrl },
  );
}
