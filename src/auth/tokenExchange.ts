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
 * with no key they resolve as an unresolved token (http.ts, authVia
 * "unresolved_token"), which answers AUTH_REQUIRED "unverified" and sends a
 * member who just connected round a reconnect loop. Returning the key lets the
 * normal subscription path answer PRO_REQUIRED instead, which is the true
 * statement and the one with a way forward. Two gates, two different answers;
 * see gateProTool.
 */
import type { WaConfig } from "../config.js";

/**
 * One warn per distinct reason per minute. During an outage every token
 * re-introspects every NEGATIVE_TTL_MS, and an unthrottled line per attempt is
 * the log flood the cache bound exists to blunt — billed, on Cloud Run.
 */
const WARN_INTERVAL_MS = 60_000;
const lastWarned = new Map<string, number>();
function warnIntrospection(reason: string, now: number = Date.now()): void {
  const last = lastWarned.get(reason);
  if (last !== undefined && now - last < WARN_INTERVAL_MS) return;
  lastWarned.set(reason, now);
  console.warn(`[website-auditor-mcp http] OAuth introspection ${reason}; treating the token as unresolved`);
}

/**
 * Why a token did not resolve, for the one caller that must tell them apart.
 *
 *   "inactive"    — the authorization server answered and said no: expired,
 *                   revoked, unknown, or a grant without the audit scope. Signing
 *                   in again is the remedy.
 *   "unavailable" — it could not answer: unreachable, timed out, non-2xx (a
 *                   wrong WA_OAUTH_INTROSPECTION_SECRET answers 401 for
 *                   everyone), or a body that is not JSON. Signing in again
 *                   fixes nothing.
 *
 * The Claude box needs the difference: it answers "inactive" with an HTTP 401,
 * which makes Claude refresh and then ask the user to reconnect. Answering an
 * outage the same way would push every connected user round a reconnect loop
 * that cannot succeed while the endpoint is down; it gets the 200 "could not
 * verify, try again" answer instead, as on every other box.
 */
export type TokenResolution =
  | { status: "active"; key: string }
  | { status: "inactive" }
  | { status: "unavailable" };

/** The seam tools and tests depend on: a token in, a `wa_` key or nothing out. */
export interface TokenExchange {
  resolve(token: string): Promise<string | undefined>;
  /**
   * The same lookup, saying why when there is no key. Optional so a test double
   * can stay a one-line `resolve`; a caller without it reads every miss as
   * "inactive", which is what an exchange that cannot tell would have to mean.
   */
  resolveDetailed?(token: string): Promise<TokenResolution>;
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
  resolution: TokenResolution;
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
    const resolution = await this.resolveDetailed(token);
    return resolution.status === "active" ? resolution.key : undefined;
  }

  async resolveDetailed(token: string): Promise<TokenResolution> {
    const at = this.now();
    const cached = this.cache.get(token);
    if (cached && cached.expiresAt > at) return cached.resolution;

    const resolution = await this.introspect(token);
    // Re-sampled AFTER the await, not reused from before it. The introspection
    // call can take up to requestTimeoutMs (120s by default), and dating the
    // entry from before it meant a degraded endpoint wrote negatives that were
    // already expired — so every junk token re-introspected on every request
    // and the flood bound this cache exists to provide silently disappeared,
    // precisely when the endpoint was least able to absorb it.
    const storedAt = this.now();
    this.evict(storedAt);
    // Both kinds of miss take the short TTL: it is the flood bound for junk
    // tokens, and an outage should be re-tried within seconds of recovering.
    this.cache.set(token, {
      resolution,
      expiresAt: storedAt + (resolution.status === "active" ? this.ttlMs : NEGATIVE_TTL_MS),
    });
    return resolution;
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
   * yields no key, which lands the caller on the keyless surface. That is the
   * safe direction and the same one DefaultSubscriptionProvider takes on a
   * cold-cache outage: never fail OPEN into someone else's account.
   *
   * What it does say is which KIND of failure (TokenResolution): "inactive"
   * when the authorization server answered no, "unavailable" when it could not
   * answer. A "result"-challenge box answers both the same way, "could not
   * verify the connection — try again, or reconnect" (http.ts, authVia
   * "unresolved_token"); an "http"-challenge box (Claude) answers "inactive"
   * with a 401 so the client refreshes, and keeps the 200 for "unavailable".
   */
  private async introspect(token: string): Promise<TokenResolution> {
    const endpoint = this.cfg.oauthIntrospectionUrl;
    // Nothing to ask: a configuration fault, not the user's sign-in.
    if (!endpoint) return { status: "unavailable" };

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
      if (!resp.ok) {
        // Logged (status only, never the token): an inactive token answers 200,
        // so a non-2xx is the endpoint or its secret failing — a misconfigured
        // WA_OAUTH_INTROSPECTION_SECRET answers 401 for every connected user,
        // and their "could not verify, try again" looks like a passing glitch.
        warnIntrospection(`answered HTTP ${resp.status}`);
        return { status: "unavailable" };
      }
      let body: { active?: unknown; api_key?: unknown } | null;
      try {
        body = (await resp.json()) as typeof body;
      } catch {
        warnIntrospection("answered a body that is not JSON");
        return { status: "unavailable" };
      }
      // A clear answer from the authorization server: only these mean "sign in
      // again". Active without a key is a grant lacking the audit scope, which
      // a fresh sign-in (asking for the scopes the challenge names) fixes.
      if (body?.active !== true) return { status: "inactive" };
      return typeof body.api_key === "string" && body.api_key
        ? { status: "active", key: body.api_key }
        : { status: "inactive" };
    } catch (err) {
      // fetch wraps the network cause (ENOTFOUND, ECONNREFUSED, a TLS code) in
      // err.cause, and the bare name reads TypeError for all of them.
      const cause = err instanceof Error ? (err.cause as { code?: string } | undefined)?.code : undefined;
      warnIntrospection(`failed: ${cause ?? (err instanceof Error ? err.name : "unknown error")}`);
      return { status: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
}
