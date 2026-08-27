/**
 * Shared tool plumbing: dependency bundle, the normalized ToolResult union, and
 * the gating helpers that enforce auth / Pro / metering uniformly across tools.
 */
import type { WaConfig } from "../config.js";
import type { WaApiClientLike } from "../api/client.js";
import type { SubscriptionProvider } from "../auth/entitlements.js";
import type { AuditCache } from "../auth/auditCache.js";
import type { ErrorCode } from "../api/errors.js";
import { WaApiError, isKeyRejection } from "../api/errors.js";
import { isPro } from "../auth/entitlements.js";
import { upgradeLink, tagSource, PRICE } from "./upgrade.js";
import { oauthEnabled, wwwAuthenticateChallenge } from "../auth/oauth.js";
import type { EventSink } from "../telemetry/events.js";

export interface ToolDeps {
  client: WaApiClientLike;
  subscriptions: SubscriptionProvider;
  cache: AuditCache;
  config: WaConfig;
  /** Telemetry sink for P0 success-metric events (fire-and-forget). */
  events: EventSink;
  /**
   * Which entry point built these deps — stamped on telemetry events so the
   * dashboard can split the stdio channel (npx/.mcpb installs) from the hosted
   * HTTP endpoint. Optional: absent means a build predating the field (stdio).
   */
  transport?: "stdio" | "http";
}

export interface ToolError {
  code: ErrorCode;
  message: string;
  upgrade_url?: string;
  details?: unknown;
  /**
   * The Mixed Auth challenge, when this error is the one that should open a
   * login. TRANSPORT METADATA, not part of the error contract: toCallResult
   * lifts it into the result's `_meta["mcp/www_authenticate"]` and strips it
   * from the payload, because the Apps SDK reads it there and the model has no
   * use for a header it cannot act on. See auth/oauth.ts.
   */
  wwwAuthenticate?: string;
}

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: ToolError };

export function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

/**
 * The step after "set WA_API_KEY", without which nothing changes — ON STDIO.
 *
 * `loadConfig(process.env)` runs once, at startup (src/index.ts), so a key set
 * while this server is running is invisible to it. Every message that tells
 * someone to set the key must carry this, or it describes a procedure that
 * ends with the identical error it began with — see tests/keyRequiresRestart.
 *
 * Reach it through keySetupNote rather than inlining it: on the hosted
 * transport the sentence is false, and the guard is the whole note, not this
 * half of it.
 */
export const RESTART_NOTE =
  "The key is read once at startup, so restart your MCP client after setting it " +
  "(in Claude Desktop: quit and reopen the app) — until then this server keeps using the old value.";

/**
 * Where the key goes, and what has to happen after — both transport-specific.
 *
 * RESTART_NOTE exists because a message ending at "set WA_API_KEY" describes an
 * incomplete procedure: the reader edits config, asks again, and gets the
 * byte-identical error they just acted on. On the hosted transport that whole
 * instruction is not merely incomplete, it is impossible. "This server's
 * config" is an env var on a box the reader has no access to, and restarting
 * their client changes nothing, because the key never came from startup env —
 * src/http.ts reads it from the Authorization or X-API-Key header of every
 * request.
 *
 * So the dead end the restart note was written to close reopened for hosted
 * callers, this time pointed at a machine they cannot log into. That path also
 * got MORE reachable in this PR, not less: an unexpanded placeholder Bearer now
 * normalizes to "no key", which is precisely the branch answering AUTH_REQUIRED.
 *
 * deps.transport already separates them — it has tagged tool_call telemetry
 * since the hosted entry point shipped. This is the first user-facing copy to
 * read it.
 */
export function keySetupNote(transport: ToolDeps["transport"]): string {
  return transport === "http"
    ? "On this server the key travels with the request: send it as `Authorization: Bearer wa_…` " +
        "or an `X-API-Key` header — in an MCP client that is the connector's authentication field. " +
        "It is read per request, so there is nothing to restart."
    : `Set it as WA_API_KEY in this server's config. ${RESTART_NOTE}`;
}

export function err(
  code: ErrorCode,
  message: string,
  extra: { upgrade_url?: string; details?: unknown; wwwAuthenticate?: string } = {},
): ToolResult<never> {
  return { ok: false, error: { code, message, ...extra } };
}

/** Map a thrown WaApiError (or unknown error) to a ToolError result. */
export function fromApiError(e: unknown, config: WaConfig): ToolResult<never> {
  if (e instanceof WaApiError) {
    // OVER_QUOTA is deliberately NOT in this list. It is the shared daily audit
    // cap, which only a subscriber can reach (there is no free API tier), so an
    // upgrade link there sells someone their own plan. See the 429 branch in
    // api/client.ts. These two ARE plan boundaries: no key, or no subscription.
    // isKeyRejection, not a code list: a new rejection code must not be able to
    // silently lose the signup link that gets the reader out of the problem.
    const attachUpgrade = isKeyRejection(e.code) || e.code === "PRO_REQUIRED";
    // Tagged HERE rather than by the call sites (they pass the whole config),
    // so no tool can emit an unattributed signup link — see tagSource in
    // upgrade.js. The API's own upgrade_url is tagged too: a 401 followed to
    // the portal is an MCP-driven signup however the link was made.
    //
    // Under "info" style the API's own link is REPLACED, not passed through:
    // the API always answers with the portal, which is exactly the checkout
    // link the style exists to keep out of responses. A link still appears
    // whenever one would have (attachUpgrade or an API-provided URL) — it just
    // points at the informational page (upgradeLink is style-aware).
    const wouldCarryLink = e.upgradeUrl !== undefined || attachUpgrade;
    const target =
      config.upsellStyle === "info"
        ? wouldCarryLink
          ? upgradeLink(config)
          : undefined
        : (e.upgradeUrl ?? (attachUpgrade ? config.upgradeUrl : undefined));
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
    // One tier, two different problems, and under Mixed Auth they need opposite
    // advice. Without OAuth the reader configures a key by hand, which is what
    // this message has always assumed and what keySetupNote explains. WITH it,
    // nobody pastes a key anywhere — the host offers a login and the account
    // behind it carries the key — so "create a key and restart your client"
    // describes a procedure that does not exist on that surface, addressed to
    // someone who never saw a config file.
    //
    // The challenge rides this branch and only this branch. Emitting it without
    // the declarative half would point the host at an authorization server it
    // cannot discover, and oauthEnabled is what keeps the two in step; see
    // auth/oauth.ts for why half a Mixed Auth setup fails silently.
    if (deps.transport === "http" && oauthEnabled(deps.config)) {
      return err(
        "AUTH_REQUIRED",
        `This tool needs a connected Website Auditor account, and this conversation has none yet. ` +
          `Connect one when prompted — there is no key to paste. ` +
          `Meanwhile get_sample_audit needs no account at all and returns a full report in the real output format. ` +
          `Audits also require an active subscription on the connected account (${PRICE}; eligible new customers ` +
          `get a 7-day free trial — payment method required to start, no charge until the trial ends): ${upgradeUrl}`,
        {
          upgrade_url: upgradeUrl,
          wwwAuthenticate: wwwAuthenticateChallenge(
            deps.config,
            "Connect a Website Auditor account to use this tool.",
          ),
        },
      );
    }
    return err(
      "AUTH_REQUIRED",
      `This tool requires a Website Auditor API key, but none is configured. ` +
        `Try get_sample_audit instead — it needs no key and shows exactly what a real audit returns. ` +
        `To audit real domains, subscribe (${PRICE}; eligible new customers get a 7-day free trial — payment method required to start, no charge until the trial ends) and create a key at ${upgradeUrl} . ${keySetupNote(deps.transport)}`,
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
    // Under Mixed Auth this is almost never a pasted key gone bad — it is the
    // OAuth-derived key having expired or been revoked, and that key was never
    // something the reader typed. The stock copy below tells them to create a
    // replacement in the portal, which is advice for a credential they do not
    // have and cannot act on; what they actually need is the login re-offered.
    //
    // Reachable through no fault of theirs, too: the hosted transport caches a
    // resolved key for 60s, so a derived key that expires inside that window
    // sends the next call upstream with a dead credential and lands exactly
    // here. The challenge turns that into a reconnect instead of a dead end.
    if (deps.transport === "http" && oauthEnabled(deps.config)) {
      return err(
        "AUTH_REQUIRED",
        `The Website Auditor connection for this conversation has expired. ` +
          `Reconnect when prompted — there is no key to paste. ` +
          `get_sample_audit keeps working with no account at all in the meantime.`,
        {
          upgrade_url: upgradeUrl,
          wwwAuthenticate: wwwAuthenticateChallenge(
            deps.config,
            "The Website Auditor connection expired. Reconnect to continue.",
          ),
        },
      );
    }
    // The upstream message already carries the "generate a new key" instruction,
    // so only the portal URL and the subscription caveat are added — restating
    // it produced "Generate a new key from the admin portal. Create a
    // replacement at …", which reads like two different steps.
    const base =
      message ?? "This Website Auditor API key is not valid — it may have been revoked.";
    // Same sentence in every case; only the CODE splits, and `rejection`
    // already IS the code — resolve() decided it from the prefix or from the
    // API's own `reason`, so there is nothing to re-derive here.
    //
    // Reading a paste error as "a customer is locked out" costs a support
    // panic; reading the reverse costs a customer. INVALID_KEY remains the
    // fallback for an API that has not shipped the field yet.
    return err(
      rejection ?? "INVALID_KEY",
      `${base} Portal: ${upgradeUrl} — creating a key needs an active subscription (${PRICE}), ` +
        `so if yours has lapsed, resubscribe there first. Then replace the key. ${keySetupNote(deps.transport)}`,
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
