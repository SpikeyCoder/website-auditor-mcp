/**
 * OAuth access token → Website Auditor API key, for the hosted transport.
 *
 * Standalone rather than a method on WaApiClient, because it runs BEFORE a
 * tenant exists. A WaApiClient is constructed with a config carrying the
 * tenant's own key and sends it on every request; introspection is the step
 * that decides which tenant we are talking to, so it has no key to send and no
 * client to send it from.
 *
 * WHY A KEY AT ALL, rather than forwarding the access token upstream: every
 * tool in this package reaches the API through a key, TenantDeps is keyed by
 * one, and the 24h audit cache and 60s subscription cache both hang off that
 * bundle. Exchanging once at the edge leaves all of that untouched — the
 * alternative (teaching every API endpoint to accept OAuth tokens) is a much
 * larger change in a repo this one only wraps.
 *
 * THE CONTRACT THIS RELIES ON, which the API side must honor: an active token
 * resolves to a key for ANY authenticated account, subscribed or not. It is
 * tempting to withhold the key from a non-subscriber, but that strands them —
 * with no key they resolve to tier "none", which answers AUTH_REQUIRED and asks
 * them to connect an account they just connected. Returning the key lets the
 * normal subscription path answer PRO_REQUIRED instead, which is the true
 * statement and the one with a way forward. Two gates, two different answers;
 * see gateProTool.
 */
import type { WaConfig } from "../config.js";

/** The seam tools and tests depend on: a token in, a `wa_` key or nothing out. */
export interface TokenExchange {
  resolve(token: string): Promise<string | undefined>;
}

/** Positive results live this long — same 60s reasoning as the subscription cache. */
const DEFAULT_TTL_MS = 60_000;
/**
 * Negatives are cached far more briefly, and deliberately not for the same
 * window. A flood of junk tokens should not become a flood of introspection
 * calls, but a token that was invalid a moment ago is exactly what a user holds
 * in the seconds AFTER completing a login — caching that answer for a full
 * minute would make the first thing they do after connecting fail, which is the
 * worst possible moment to be stale.
 */
const NEGATIVE_TTL_MS = 5_000;

/**
 * Cache bound. An entry is minted for any distinct string presented as a
 * bearer, including one that can never authenticate, so without a cap a caller
 * sending junk tokens grows this map until the process dies — the same attack
 * TenantDeps.evict exists to blunt, one layer earlier.
 *
 * Eviction drops the entries expiring SOONEST, which is not arbitrary: a
 * negative lives 5s and a positive 60s, so a flood of junk is always ahead of a
 * real session in the queue and the working set survives its own overflow.
 */
const MAX_ENTRIES = 5_000;

interface CacheEntry {
  key?: string;
  expiresAt: number;
}

export class IntrospectionTokenExchange implements TokenExchange {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly cfg: WaConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async resolve(token: string): Promise<string | undefined> {
    const at = this.now();
    const cached = this.cache.get(token);
    if (cached && cached.expiresAt > at) return cached.key;

    const key = await this.introspect(token);
    this.evict(at);
    this.cache.set(token, {
      key,
      expiresAt: at + (key ? this.ttlMs : NEGATIVE_TTL_MS),
    });
    return key;
  }

  /** Live entry count, post-eviction. For tests. */
  size(): number {
    return this.cache.size;
  }

  private evict(at: number): void {
    for (const [token, entry] of this.cache) {
      if (entry.expiresAt <= at) this.cache.delete(token);
    }
    if (this.cache.size < MAX_ENTRIES) return;
    // Still over after purging what already expired: drop by nearest expiry
    // until there is room for the entry about to be written.
    const byExpiry = [...this.cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [token] of byExpiry.slice(0, this.cache.size - MAX_ENTRIES + 1)) {
      this.cache.delete(token);
    }
  }

  /**
   * RFC 7662 introspection, plus the `api_key` extension described in this
   * file's header.
   *
   * Every failure — unreachable, non-2xx, unparseable, inactive, no key —
   * answers `undefined`, which lands the caller on the keyless surface. That is
   * the safe direction and the same one DefaultSubscriptionProvider takes on a
   * cold-cache outage: never fail OPEN into someone else's account. It does
   * mean an introspection outage looks like "not signed in" rather than "try
   * again", which is worth knowing when reading a support report; the challenge
   * on the resulting error at least re-offers the login.
   */
  private async introspect(token: string): Promise<string | undefined> {
    const endpoint = this.cfg.oauthIntrospectionUrl;
    if (!endpoint) return undefined;

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    // The resource server authenticates to the introspection endpoint (RFC 7662
    // §2.1) — without this anyone who can reach it could test tokens against it.
    if (this.cfg.oauthIntrospectionSecret) {
      headers.Authorization = `Bearer ${this.cfg.oauthIntrospectionSecret}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    try {
      const resp = await this.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString(),
        signal: controller.signal,
      });
      if (!resp.ok) return undefined;
      const body = (await resp.json()) as { active?: unknown; api_key?: unknown };
      if (body?.active !== true) return undefined;
      return typeof body.api_key === "string" && body.api_key ? body.api_key : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
