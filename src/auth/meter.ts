/**
 * Free-tier metering + abuse guard, layered on top of the API portal's own
 * per-key daily rate limit. Meters by (a) queries per key per UTC day and
 * (b) distinct domains per key, per the PRD's "1 domain, capped audits/day"
 * free tier. Pro callers bypass metering entirely (the tools skip it).
 *
 * The default implementation is in-memory (per process). The interface is the
 * seam for a shared/persistent store (e.g. the subscription DB) when metering
 * needs to be attributable across restarts — a Phase-2 concern.
 */

export type MeterResult = { ok: true } | { ok: false; reason: "daily" | "domains" };

export interface Meter {
  recordQuery(apiKey: string, domain: string): MeterResult;
  reset?(): void;
}

interface MeterConfig {
  dailyLimit: number;
  maxDomains: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface KeyState {
  day: string; // UTC yyyy-mm-dd
  count: number;
  domains: Set<string>;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class InMemoryMeter implements Meter {
  private readonly dailyLimit: number;
  private readonly maxDomains: number;
  private readonly now: () => number;
  private readonly state = new Map<string, KeyState>();

  constructor(cfg: MeterConfig) {
    this.dailyLimit = cfg.dailyLimit;
    this.maxDomains = cfg.maxDomains;
    this.now = cfg.now ?? Date.now;
  }

  recordQuery(apiKey: string, domain: string): MeterResult {
    const today = utcDay(this.now());
    let st = this.state.get(apiKey);
    if (!st || st.day !== today) {
      st = { day: today, count: 0, domains: new Set() };
      this.state.set(apiKey, st);
    }

    // Distinct-domain cap: a brand-new domain beyond the cap is rejected;
    // repeat queries on an already-seen domain are allowed.
    const isNewDomain = !st.domains.has(domain);
    if (isNewDomain && st.domains.size >= this.maxDomains) {
      return { ok: false, reason: "domains" };
    }

    // Daily query cap.
    if (st.count >= this.dailyLimit) {
      return { ok: false, reason: "daily" };
    }

    st.count += 1;
    st.domains.add(domain);
    return { ok: true };
  }

  reset(): void {
    this.state.clear();
  }
}
