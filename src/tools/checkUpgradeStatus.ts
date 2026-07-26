/**
 * check_upgrade_status [Free]
 *
 * Reports the caller's own subscription standing: tier, raw status, period
 * end, and what upgrading unlocks. Works with any valid key (the upstream
 * /api/subscription endpoint is deliberately not Pro-gated) and never spends
 * audit quota — it isn't an audit, so it bypasses the free-tier meter.
 *
 * Deliberately does NOT claim trial eligibility: no API-key-authed endpoint
 * exposes it (it's decided at checkout), so the message says what a trial
 * requires rather than promising one.
 */
import { fromApiError, ok, type ToolDeps, type ToolResult } from "./context.js";

export interface UpgradeStatus {
  tier: "none" | "free" | "pro";
  /** Raw subscription status ('active', 'trialing', 'canceled', 'none', …). */
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  /** Where to sign in / subscribe / manage the subscription. */
  upgrade_url: string;
  /** Human-readable summary of the standing and the next step, if any. */
  message: string;
}

export async function checkUpgradeStatus(_args: Record<string, never>, deps: ToolDeps): Promise<ToolResult<UpgradeStatus>> {
  const upgradeUrl = deps.config.upgradeUrl;

  if (!deps.config.apiKey) {
    return ok({
      tier: "none",
      status: "none",
      current_period_end: null,
      cancel_at_period_end: false,
      upgrade_url: upgradeUrl,
      message: `No API key is configured. Create a free account and API key at ${upgradeUrl}, then set WA_API_KEY.`,
    });
  }

  let sub;
  try {
    sub = await deps.client.getSubscription();
  } catch (e) {
    return fromApiError(e, upgradeUrl);
  }

  const periodEnd = sub.current_period_end ?? null;
  const canceling = sub.cancel_at_period_end === true;

  let message: string;
  if (sub.tier === "pro" && sub.status === "trialing") {
    // A canceled-mid-trial subscription stays `trialing` with
    // cancel_at_period_end=true — it will NOT convert or charge, so the
    // auto-conversion wording would be flatly wrong for that state.
    message = canceling
      ? `Free trial active${periodEnd ? ` until ${periodEnd}` : ""}, but set not to convert — Pro access simply ends then. ` +
        `Resubscribe at ${upgradeUrl} to keep Pro tools.`
      : `Free trial active${periodEnd ? ` until ${periodEnd}` : ""} — all Pro tools are unlocked. ` +
        `The subscription starts automatically when the trial ends unless canceled at ${upgradeUrl}.`;
  } else if (sub.tier === "pro") {
    message = canceling
      ? `Pro subscription active but set to end${periodEnd ? ` on ${periodEnd}` : ""}. Resubscribe at ${upgradeUrl} to keep Pro tools.`
      : `Pro subscription active${periodEnd ? ` (renews ${periodEnd})` : ""} — all tools are unlocked.`;
  } else if (sub.status === "none") {
    message =
      `No active subscription — there is no free API tier, so all Website Auditor tools are locked. ` +
      `Subscribe at ${upgradeUrl} — starting Pro requires adding a payment method and accepting the Terms; eligible new customers get a 7-day free trial.`;
  } else {
    message =
      `Subscription lapsed (status: ${sub.status}) — all Website Auditor tools are locked (there is no free API tier). ` +
      `Resubscribe at ${upgradeUrl} (requires a payment method and accepting the Terms).`;
  }

  return ok({
    tier: sub.tier,
    status: sub.status,
    current_period_end: periodEnd,
    cancel_at_period_end: canceling,
    upgrade_url: upgradeUrl,
    message,
  });
}
