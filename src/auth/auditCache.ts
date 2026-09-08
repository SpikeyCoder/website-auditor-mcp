/**
 * Audit cache — a seam for reusing a recent audit for a domain instead of
 * spending a fresh audit against the account's daily quota.
 *
 * `compare_competitors` (and, later, the other read tools) consults this before
 * calling `runAudit`, so repeating a comparison — or comparing overlapping
 * competitor sets — doesn't re-spend quota on domains audited moments ago.
 *
 * The default is in-memory (per process) with a TTL that mirrors the upstream
 * audit engine's own 24h AI-visibility cache, so reuse never returns data older
 * than the engine would itself have refreshed. The interface is the seam for an
 * API-backed cache (e.g. fetching a recent report by domain) when one exists.
 */
import type { AiVisibility } from "../api/types.js";

export interface AuditCache {
  /**
   * The cached AI-visibility for a KEY, or undefined if absent/expired.
   *
   * A key, not a domain, since compare_competitors began scoping audits by
   * market: the same host measured in Chiang Mai and measured globally are
   * two different answers, so the caller mints `host` or `host\u001fmarket`
   * and this stores whatever it is handed. The interface said "domain" while
   * a composite was already being passed, which left the next consumer to
   * reinvent the encoding — or, worse, to pass a bare host and collide.
   */
  get(key: string): AiVisibility | undefined;
  /** Store the AI-visibility for a key, stamping it at "now". */
  set(key: string, av: AiVisibility): void;
}

interface CacheEntry {
  av: AiVisibility;
  storedAt: number;
}

export interface AuditCacheConfig {
  ttlMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class InMemoryAuditCache implements AuditCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(cfg: AuditCacheConfig) {
    this.ttlMs = cfg.ttlMs;
    this.now = cfg.now ?? Date.now;
  }

  get(key: string): AiVisibility | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.storedAt > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry.av;
  }

  set(key: string, av: AiVisibility): void {
    this.store.set(key, { av, storedAt: this.now() });
  }
}

/** A cache that never stores anything — disables reuse (e.g. for tests). */
export class NoopAuditCache implements AuditCache {
  get(): undefined {
    return undefined;
  }
  set(): void {
    /* no-op */
  }
}
