/**
 * Tier resolution + gating.
 *
 * The real subscription source is website-auditor-api, but it does NOT yet
 * expose an API-key-authed way to read subscription state (PRD open question
 * #1: "how does the server validate subscription state per call?"). Until it
 * does, `DefaultSubscriptionProvider` resolves conservatively:
 *
 *   - no API key            → "none"  (unauthenticated)
 *   - key present + devTier  → devTier (local/testing override only)
 *   - key present            → "free" (we cannot confirm Pro, so we don't grant it)
 *
 * The `SubscriptionProvider` interface is the seam: swap in a real
 * implementation calling `client.getSubscription()` the moment that endpoint
 * ships, with no change to the tools.
 */
import type { Tier, WaConfig } from "../config.js";

export interface SubscriptionProvider {
  /** Resolve the caller's tier. `apiKey` is passed for provider implementations
   *  that look it up; the default reads the configured key. */
  getTier(apiKey?: string): Promise<Tier>;
}

export function isPro(tier: Tier): boolean {
  return tier === "pro";
}

export class DefaultSubscriptionProvider implements SubscriptionProvider {
  constructor(private readonly cfg: WaConfig) {}

  async getTier(apiKey?: string): Promise<Tier> {
    const key = apiKey ?? this.cfg.apiKey;
    if (!key) return "none";
    if (this.cfg.devTier) return this.cfg.devTier;
    return "free";
  }
}
