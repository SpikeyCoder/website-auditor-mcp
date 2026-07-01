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
import { WaApiError } from "../api/errors.js";

/** A resolved tier plus whether it is a confirmed answer (vs. an outage default). */
export interface TierResolution {
  tier: Tier;
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

      // A definitive key rejection is NOT a transient outage: the key genuinely
      // has no Pro, and retrying won't change that. Report a verified free.
      if (e instanceof WaApiError && e.code === "INVALID_KEY") {
        return { tier: "free", verified: true };
      }

      // Transient/unreachable with no cached value: never fail-open to Pro, but
      // flag UNVERIFIED so a real Pro user isn't wrongly told they're not
      // subscribed during an outage.
      return { tier: "free", verified: false };
    }
  }
}
