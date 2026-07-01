import { vi } from "vitest";
import type { WaConfig, Tier } from "../src/config.js";
import type { WaApiClientLike, AuditResponse } from "../src/api/client.js";
import type { SubscriptionProvider } from "../src/auth/entitlements.js";
import type { Meter } from "../src/auth/meter.js";
import type { AuditCache } from "../src/auth/auditCache.js";
import { InMemoryAuditCache } from "../src/auth/auditCache.js";
import type { ToolDeps } from "../src/tools/context.js";
import type { AuditReport, RateLimit } from "../src/api/types.js";
import { WaApiError } from "../src/api/errors.js";
import { reachableReport } from "./fixtures/reports.js";
import { NoopEventSink, type EventSink, type McpEvent } from "../src/telemetry/events.js";

/** Captures emitted telemetry events so tests can assert their shape. */
export class RecordingEventSink implements EventSink {
  readonly events: McpEvent[] = [];
  emit(event: McpEvent): void {
    this.events.push(event);
  }
}

export function testConfig(over: Partial<WaConfig> = {}): WaConfig {
  return {
    apiBaseUrl: "https://api.website-auditor.io",
    siteUrl: "https://website-auditor.io",
    apiKey: "wa_test",
    upgradeUrl: "https://website-auditor.io/admin_portal",
    freeDailyAuditLimit: 3,
    freeMaxDomains: 1,
    requestTimeoutMs: 120000,
    auditCacheTtlMs: 24 * 60 * 60 * 1000,
    metricsEnabled: true,
    ...over,
  };
}

export function fixedTier(tier: Tier): SubscriptionProvider {
  return { getTier: async () => tier };
}

/** Meter that always allows. */
export function openMeter(): Meter {
  return { recordQuery: () => ({ ok: true }) };
}

export function makeClient(over: Partial<WaApiClientLike> = {}): WaApiClientLike {
  const base: WaApiClientLike = {
    runAudit: vi.fn(async (): Promise<AuditResponse> => ({
      runId: "abc123def456",
      report: reachableReport(),
      raw: {},
    })),
    getSubscription: vi.fn(async () => {
      throw new WaApiError("NOT_YET_AVAILABLE", "no subscription endpoint");
    }),
    getRemainingQuota: vi.fn(async () => null),
    getChanges: vi.fn(async () => {
      throw new WaApiError("NOT_YET_AVAILABLE", "no changes endpoint");
    }),
    compareCompetitors: vi.fn(async () => {
      throw new WaApiError("NOT_YET_AVAILABLE", "no compare endpoint");
    }),
    trackSite: vi.fn(async ({ domain }) => ({
      domain,
      cadence: "weekly",
      active: true,
      created: true,
      already_tracked: false,
    })),
    listTrackedDomains: vi.fn(async () => ({ limit: 5, used: 0, remaining: 5, tracked: [] })),
    untrackSite: vi.fn(async ({ domain }) => ({ domain, removed: true })),
  };
  return { ...base, ...over };
}

export function makeDeps(over: {
  tier?: Tier;
  client?: Partial<WaApiClientLike>;
  meter?: Meter;
  cache?: AuditCache;
  config?: Partial<WaConfig>;
  events?: EventSink;
} = {}): ToolDeps {
  return {
    client: makeClient(over.client ?? {}),
    subscriptions: fixedTier(over.tier ?? "free"),
    meter: over.meter ?? openMeter(),
    cache: over.cache ?? new InMemoryAuditCache({ ttlMs: 24 * 60 * 60 * 1000 }),
    config: testConfig(over.config ?? {}),
    events: over.events ?? new NoopEventSink(),
  };
}

/**
 * A client that simulates the API's per-key daily audit counter: each runAudit
 * spends one unit and returns the post-call `X-RateLimit-Remaining` in
 * `rateLimit`; when exhausted it throws OVER_QUOTA like the real 429. Used to
 * drive the quota-aware fan-out in compare_competitors.
 */
export function makeQuotaClient(opts: {
  start: number; // remaining audits available when the call begins
  limit?: number;
  reset?: string;
  report: (domain: string) => AuditReport;
  /** If true, getRemainingQuota reports the current remaining (simulating the
   *  future subscription endpoint). Default false → null (header-learning). */
  preflight?: boolean;
}): WaApiClientLike {
  const limit = opts.limit ?? 5;
  const reset = opts.reset ?? "2026-06-30T23:59:59.999Z";
  let remaining = opts.start;

  const runAudit = vi.fn(async ({ domain }: { domain: string }): Promise<AuditResponse> => {
    if (remaining <= 0) {
      throw new WaApiError("OVER_QUOTA", "Rate limit exceeded. You can make 5 requests per day.", {
        status: 429,
        details: { limit, remaining: 0, resets_at: reset },
      });
    }
    remaining -= 1;
    const rateLimit: RateLimit = { limit, remaining, reset };
    return { runId: `run-${domain}`, report: opts.report(domain), rateLimit, raw: {} };
  });

  const getRemainingQuota = vi.fn(async (): Promise<RateLimit | null> =>
    opts.preflight ? { limit, remaining, reset } : null,
  );

  return makeClient({ runAudit, getRemainingQuota });
}
