/**
 * Shared tool plumbing: dependency bundle, the normalized ToolResult union, and
 * the gating helpers that enforce auth / Pro / metering uniformly across tools.
 */
import type { WaConfig } from "../config.js";
import type { WaApiClientLike } from "../api/client.js";
import type { SubscriptionProvider } from "../auth/entitlements.js";
import type { Meter } from "../auth/meter.js";
import type { AuditCache } from "../auth/auditCache.js";
import type { ErrorCode } from "../api/errors.js";
import { WaApiError } from "../api/errors.js";
import { isPro } from "../auth/entitlements.js";
import type { EventSink } from "../telemetry/events.js";

export interface ToolDeps {
  client: WaApiClientLike;
  subscriptions: SubscriptionProvider;
  meter: Meter;
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
 * Gate a FREE tool: requires a resolvable key (backend needs one) and applies
 * free-tier metering. Returns a ToolError result to short-circuit, or null to
 * proceed. `domain` is the metered resource.
 */
export async function gateFreeTool(deps: ToolDeps, domain: string): Promise<ToolResult<never> | null> {
  // Free tools default to free access, so `verified` is irrelevant here: an
  // outage that defaults an unknown key to free must NOT lock a user out of the
  // free tools (their own API call will surface any real auth problem).
  const { tier } = await deps.subscriptions.resolve(deps.config.apiKey);
  if (tier === "none") {
    return err(
      "AUTH_REQUIRED",
      "This tool requires a Website Auditor API key. Set WA_API_KEY in your MCP server config (a free key works for the free tools).",
      { upgrade_url: deps.config.upgradeUrl },
    );
  }
  if (tier === "free") {
    const metered = deps.meter.recordQuery(deps.config.apiKey ?? "anon", domain);
    if (!metered.ok) {
      const message =
        metered.reason === "domains"
          ? `The free tier covers ${deps.config.freeMaxDomains} domain(s). Upgrade to Pro to audit more domains.`
          : `You've reached the free tier's daily audit limit (${deps.config.freeDailyAuditLimit}/day). Upgrade to Pro for higher quotas.`;
      return err("OVER_QUOTA", message, { upgrade_url: deps.config.upgradeUrl });
    }
  }
  return null;
}

/**
 * Gate a PRO tool: requires an active subscription. Returns a ToolError result
 * to short-circuit, or null to proceed.
 *
 * Distinguishes a *verified* non-Pro tier (definitive "not subscribed" →
 * PRO_REQUIRED with the upgrade path) from an *unverified* one (the subscription
 * service was unreachable and we defaulted to free → SUBSCRIPTION_UNVERIFIED, a
 * retryable signal) so a genuine Pro user isn't wrongly told to upgrade during
 * an outage.
 */
export async function gateProTool(deps: ToolDeps): Promise<ToolResult<never> | null> {
  const { tier, verified } = await deps.subscriptions.resolve(deps.config.apiKey);
  if (isPro(tier)) return null;

  if (!verified) {
    return err(
      "SUBSCRIPTION_UNVERIFIED",
      "Couldn't verify your Website Auditor subscription right now — the subscription service was unreachable. This is a temporary issue, not a downgrade: please try again in a moment. (If you're on the free tier, this tool requires Pro.)",
      { upgrade_url: deps.config.upgradeUrl },
    );
  }

  return err(
    "PRO_REQUIRED",
    "This tool requires a Website Auditor Pro subscription. Add your Pro API key to unlock monitoring, deltas, benchmarks and competitor comparison.",
    { upgrade_url: deps.config.upgradeUrl },
  );
}
