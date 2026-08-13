/**
 * Tier resolution + gating.
 *
 * The subscription source of truth is website-auditor-api's API-key-authed
 * `GET /api/subscription` endpoint (shipped in PR #7). `DefaultSubscriptionProvider`
 * resolves the caller's tier from it and caches the answer per API key for a
 * short TTL (`subscriptionCacheTtlMs`, default 60s) so it isn't a round-trip on
 * every tool call, while still reflecting upgrades/downgrades reasonably fast.
 *
 * Resolution rules:
 *   - no API key            → { none, verified }        (unauthenticated)
 *   - WA_DEV_TIER set        → { devTier, verified }      (EXPLICIT local override only)
 *   - key without `wa_`      → { invalid, verified, rejection: "malformed" }  (never calls the
 *       endpoint — the API rejects a bad prefix before it looks anything up, so the round trip
 *       is guaranteed waste and the cause is knowable here)
 *   - live active/trialing   → { pro, verified }
 *   - live otherwise         → { free, verified }         (never subscribed / lapsed)
 *
 * Failure handling (deliberate — see the PRD gating requirements):
 *   - endpoint error + WARM cache → last-known tier, verified   (honor last-known)
 *   - endpoint error + COLD cache → { free, UNVERIFIED }        (never fail-open to Pro,
 *       but flagged so a genuine Pro user isn't wrongly told they're "not subscribed"
 *       during an outage — the Pro gate turns this into a retryable signal)
 *   - definitive key rejection (INVALID_KEY / 401) → { free, verified }  (not an outage;
 *       the key genuinely has no Pro — retrying won't change that)
 *
 * The `SubscriptionProvider` interface is the seam: tools depend only on it.
 */
import type { Tier, WaConfig } from "../config.js";
import { WaApiError, isKeyRejection, type KeyRejectionCode } from "../api/errors.js";

/** Every Website Auditor API key starts with this. Enforced by the API too. */
export const API_KEY_PREFIX = "wa_";

/**
 * Verbatim copy of what website-auditor-api answers a bad prefix with
 * (src/middleware/apiKeyAuth.js). Kept identical so short-circuiting the call
 * is invisible to the reader — they get the same sentence either way.
 */
export const MALFORMED_KEY_MESSAGE = "Invalid API key format. Keys start with wa_.";

/** A resolved tier plus whether it is a confirmed answer (vs. an outage default). */
export interface TierResolution {
  tier: Tier;
  /** The upstream's own explanation, when it gave one (invalid/revoked keys). */
  message?: string;
  /**
   * Which kind of rejection produced `tier: "invalid"`, so telemetry can tell a
   * key that was never one of ours from one the API looked up and refused.
   *
   *   MALFORMED_KEY — no `wa_` prefix, decided here without a request. Someone
   *                   pasted the wrong string; nobody's access has changed.
   *   UNKNOWN_KEY   — well-formed, and the API has no record of it.
   *   REVOKED_KEY   — it existed and was turned off. Usually somebody who is
   *                   paying, and the only one that means lost access.
   *   INVALID_KEY   — the API rejected it without saying why (a build older
   *                   than PR #44). Preserved rather than guessed at.
   *
   * Both produce the SAME user-facing message (the API's own text leads it);
   * this only separates them in the event stream, where they were one number
   * and could not be told apart after the fact.
   */
  rejection?: KeyRejectionCode;
  /**
   * true when the tier is a confirmed result (live lookup, no-key `none`, dev
   * override, or a last-known cached tier honored during an outage). false ONLY
   * when we could not verify and defaulted to `free` (transient error + cold
   * cache) — callers use this to emit a "try again" signal for Pro tools rather
   * than a false "not subscribed".
   */
  verified: boolean;
}

export interface SubscriptionProvider {
  /** Resolve the caller's tier. `apiKey` is passed for lookup/caching; the
   *  default reads the configured key when omitted. */
  resolve(apiKey?: string): Promise<TierResolution>;
}

/** The subscription-reading slice of the API client the provider depends on. */
export interface SubscriptionSource {
  getSubscription(): Promise<{ tier: "free" | "pro"; status: string }>;
}

export function isPro(tier: Tier): boolean {
  return tier === "pro";
}

interface CacheEntry {
  tier: Tier;
  expiresAt: number;
}

export class DefaultSubscriptionProvider implements SubscriptionProvider {
  /** Per-API-key tier cache. */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly cfg: WaConfig,
    private readonly client: SubscriptionSource,
    /** Injectable clock for deterministic TTL tests; defaults to wall-clock. */
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(apiKey?: string): Promise<TierResolution> {
    const key = apiKey ?? this.cfg.apiKey;

    // No key → definitively unauthenticated. Never calls the endpoint.
    if (!key) return { tier: "none", verified: true };

    // EXPLICIT local dev override — not the default path (only when a key is set).
    if (this.cfg.devTier) return { tier: this.cfg.devTier, verified: true };

    // A key that cannot be one of ours never reaches the network either.
    // website-auditor-api rejects a missing `wa_` prefix before it hashes or
    // looks anything up, so the call can only come back 401 — the same
    // reasoning gateProTool already applies to Pro gating ("blocking
    // client-side saves the wasted round-trip the server would 403 anyway").
    //
    // Deciding it here is also what makes the distinction reliable. The API
    // says WHY in prose, and its four 401 causes differ only by wording, so
    // classifying downstream would mean matching on copy that is free to
    // change. A prefix is not.
    //
    // BELOW the dev override on purpose: WA_DEV_TIER is an explicit local
    // escape hatch, routinely paired with a stand-in key like "dev-key", so
    // checking the prefix first would break the one workflow that never talks
    // to the API anyway.
    //
    // An unexpanded PLACEHOLDER stand-in is not covered and cannot be:
    // normalizeEnvValue erases `${WA_API_KEY}` to undefined before resolve()
    // ever sees it — on both transports, since the hosted path adopted the
    // rule — so the `!key` return above wins and the override is unreachable.
    // That agrees with the line above it ("only when a key is set") and with
    // WaConfig.devTier's own "Ignored when no API key is set": a placeholder
    // IS no key. Spelled out because this comment used to cite placeholder
    // pairing as the reason for the ordering, which would send the next person
    // to reorder these branches on a rationale the code no longer honors.
    //
    // The message duplicates the API's own string deliberately, so the reader
    // sees identical text whichever side answered. Pinned by a test that fails
    // if the two drift.
    if (!key.startsWith(API_KEY_PREFIX)) {
      return {
        tier: "invalid",
        verified: true,
        rejection: "MALFORMED_KEY",
        message: MALFORMED_KEY_MESSAGE,
      };
    }

    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return { tier: cached.tier, verified: true };
    }

    try {
      const sub = await this.client.getSubscription();
      const tier: Tier = sub.tier === "pro" ? "pro" : "free";
      this.cache.set(key, { tier, expiresAt: now + this.cfg.subscriptionCacheTtlMs });
      return { tier, verified: true };
    } catch (e) {
      // Warm cache (even if expired): honor the last-known tier during an outage.
      if (cached) return { tier: cached.tier, verified: true };

      // A definitive key rejection is NOT a transient outage, and it is NOT the
      // same as "this account has no subscription". Collapsing it into `free`
      // made gateProTool emit PRO_REQUIRED, which told a PAYING customer whose
      // key had been revoked to go and subscribe — advice that cannot fix their
      // problem. Report it as its own state so the gate can say "replace the
      // key" and pass the API's own remediation text through.
      // EVERY key-rejection code, not just INVALID_KEY. The API now names the
      // cause, so a revoked key arrives as REVOKED_KEY — and matching the old
      // single code would drop it through to the transient branch below and
      // answer "try again in a moment", which is the 1.0.8 bug this block was
      // written to fix, reintroduced by making the codes more precise.
      if (e instanceof WaApiError && isKeyRejection(e.code)) {
        return { tier: "invalid", verified: true, rejection: e.code, message: e.message };
      }

      // Transient/unreachable with no cached value: never fail-open to Pro, but
      // flag UNVERIFIED so a real Pro user isn't wrongly told they're not
      // subscribed during an outage.
      return { tier: "free", verified: false };
    }
  }
}
