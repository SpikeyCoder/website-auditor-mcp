/**
 * check_upgrade_status [Free]
 *
 * Reports the caller's own subscription standing: tier, raw status, period
 * end, and what upgrading unlocks. Works with any valid key (the upstream
 * /api/subscription endpoint is deliberately not Pro-gated) and never spends
 * audit quota — it isn't an audit, so it bypasses the free-tier meter.
 *
 * The 7-day free trial was restored for new subscriptions on 2026-08-04
 * (removed 2026-07-27), so the upsell messages name it — always WITH its
 * prerequisites (price, payment method, Terms) in the same sentence, per the
 * disclosure rule the web surfaces follow: the trial is when billing starts
 * on the paid plan, never a second free tier. The eligibility caveat matters
 * too: a customer who used a trial in the last 12 months is billed
 * immediately, so the copy says "may", and checkout tells the truth.
 */
import { API_KEY_PREFIX, MALFORMED_KEY_MESSAGE } from "../auth/entitlements.js";
import { WaApiError } from "../api/errors.js";
import { fromApiError, keySetupNote, ok, type ToolDeps, type ToolResult } from "./context.js";
import { oauthEnabled } from "../auth/oauth.js";
import { PRICE, upgradeLink } from "./upgrade.js";

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
  // upgradeLink, not the raw config value: this is the tool people run BECAUSE
  // they have no working key, so its link is among the likeliest to be followed
  // — and was the one guaranteed not to attribute the signup it produced.
  const upgradeUrl = upgradeLink(deps.config);

  if (!deps.config.apiKey) {
    return ok({
      tier: "none",
      status: "none",
      current_period_end: null,
      cancel_at_period_end: false,
      upgrade_url: upgradeUrl,
      // Not "a free account and API key": the account is free, the key is not
      // — POST /api/keys is behind requireProSession. Read as one phrase it
      // promises a working key for nothing, which strands the reader one step
      // earlier than the missing restart does. This branch also covers people
      // who ARE subscribed and simply haven't set a key, so it states the
      // requirement rather than pitching the trial (the never-subscribed
      // branch below does that, with the full disclosure).
      // This is the tool an UNLINKED ChatGPT user actually reaches — it is one
      // of the two declared `noauth`, so it answers before any login exists.
      // Telling that reader to mint a key and put it in a header describes a
      // procedure their client does not have, and contradicts the "there is no
      // key to paste" copy the same model reads from every other tool. It
      // cannot carry a challenge (this is a success, and `_meta` is lifted only
      // from errors), so the wording is the whole remedy.
      message:
        deps.transport === "http" && oauthEnabled(deps.config)
          ? `No Website Auditor account is connected to this conversation yet. ` +
            `Connect one when prompted — there is no key to paste. Audits also need an ` +
            `active subscription (${PRICE}) on the connected account: ${upgradeUrl}`
          : `No API key is configured. Create one at ${upgradeUrl} — minting a key requires an ` +
            `active subscription (${PRICE}). ${keySetupNote(deps.transport)}`,
    });
  }

  // A key that cannot be one of ours is settled here, exactly as
  // DefaultSubscriptionProvider.resolve settles it — the API rejects a missing
  // `wa_` prefix before it hashes or looks anything up, so the round trip can
  // only come back 401.
  //
  // This tool does not go through resolve() (it reports standing rather than
  // gating on it, and is the one tool a caller with a broken key is MEANT to
  // reach), so the prefix short-circuit added there in 1.0.15 never covered
  // this path. It was the last one still making the call: production
  // api_request_logs show /api/subscription as the ONLY route in the whole API
  // that records a malformed_key 401, because every other Pro tool is gated
  // client-side and never reaches the network with a bad key.
  //
  // The reader sees no difference from the 401 it replaces. The API answers a
  // bad prefix with this exact sentence, and fromApiError attaches the same
  // signup link — MALFORMED_KEY is a key rejection, so `attachUpgrade` holds.
  //
  // It carries keySetupNote because the bare sentence dead-ends. Every OTHER
  // key failure in the package ends by saying where the key goes: gateProTool's
  // invalid branch appends it, and so does the no-key branch above. This one
  // did not, which left the tool whose own header calls it "the one tool a
  // caller with a broken key is MEANT to reach" as the only surface that names
  // the problem and not the remedy — and a typo'd key is exactly what still
  // lands here now that a placeholder is normalized away upstream.
  if (!deps.config.apiKey.startsWith(API_KEY_PREFIX)) {
    return fromApiError(
      new WaApiError("MALFORMED_KEY", `${MALFORMED_KEY_MESSAGE} ${keySetupNote(deps.transport)}`),
      deps.config,
      deps.transport,
      deps.authVia,
    );
  }

  let sub;
  try {
    sub = await deps.client.getSubscription();
  } catch (e) {
    return fromApiError(e, deps.config, deps.transport, deps.authVia);
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
      `Subscribe at ${upgradeUrl} — eligible new customers get a 7-day free trial, then $10/month; ` +
      `starting requires adding a payment method and accepting the Terms, with no charge until the trial ends.`;
  } else {
    message =
      `Subscription lapsed (status: ${sub.status}) — all Website Auditor tools are locked (there is no free API tier). ` +
      `Resubscribe at ${upgradeUrl} (requires a payment method and accepting the Terms; ` +
      `a free trial is only available if your last one began more than 12 months ago — otherwise billing starts immediately).`;
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
