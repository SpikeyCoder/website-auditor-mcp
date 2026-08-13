import { vi } from "vitest";
import type { WaConfig, Tier } from "../src/config.js";
import type { WaApiClientLike, AuditResponse } from "../src/api/client.js";
import type { SubscriptionProvider, TierResolution } from "../src/auth/entitlements.js";
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
    upgradeUrl: "https://api.website-auditor.io/admin_portal/",
    upsellStyle: "link",
    upsellInfoUrl: "https://website-auditor.io",
    requestTimeoutMs: 120000,
    auditCacheTtlMs: 24 * 60 * 60 * 1000,
    subscriptionCacheTtlMs: 60_000,
    metricsEnabled: true,
    ...over,
  };
}

/** A provider that always resolves to a fixed, VERIFIED tier. */
export function fixedTier(tier: Tier): SubscriptionProvider {
  return { resolve: async () => ({ tier, verified: true }) };
}

/** A provider that resolves to a fixed tier + verified flag (for outage tests). */
export function fixedResolution(resolution: TierResolution): SubscriptionProvider {
  return { resolve: async () => resolution };
}

export function makeClient(over: Partial<WaApiClientLike> = {}): WaApiClientLike {
  const base: WaApiClientLike = {
    runAudit: vi.fn(async (): Promise<AuditResponse> => ({
      runId: "abc123def456",
      report: reachableReport(),
      raw: {},
    })),
    getSubscription: vi.fn(async () => ({ tier: "free" as const, status: "none" })),
    getRemainingQuota: vi.fn(async () => null),
    getChanges: vi.fn(async () => {
      throw new WaApiError("NOT_YET_AVAILABLE", "no changes endpoint");
    }),
    // Default: empty history — tools must treat this as "no trend yet".
    getAiVisibilityHistory: vi.fn(async () => []),
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
    untrackSite: vi.fn(async ({ domain }) => ({ domain, removed: true, limit: 5, used: 0, remaining: 5 })),
    getMonitoringStatus: vi.fn(async () => ({ limit: 5, used: 0, remaining: 5, sites: [] })),
    getBenchmark: vi.fn(async () => ({ percentile: 50, peer_median: 50, sample_size: 0, position_summary: "" })),
    getRecommendations: vi.fn(async () => ({ recommendations: [] })),
    generateSchema: vi.fn(async () => ({ jsonld: {}, placement_notes: "" })),
    getReport: vi.fn(async () => ({ report_url: "", badge_html: "" })),
  };
  return { ...base, ...over };
}

export function makeDeps(over: {
  tier?: Tier;
  /** Full provider override — takes precedence over `tier` (e.g. outage/unverified tests). */
  subscriptions?: SubscriptionProvider;
  client?: Partial<WaApiClientLike>;
  cache?: AuditCache;
  config?: Partial<WaConfig>;
  events?: EventSink;
} = {}): ToolDeps {
  return {
    client: makeClient(over.client ?? {}),
    subscriptions: over.subscriptions ?? fixedTier(over.tier ?? "free"),
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
      throw new WaApiError("OVER_QUOTA", "Rate limit exceeded. You can make 10 requests per day.", {
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

/**
 * Every client-substitution syntax isUnexpandedPlaceholder must read as "unset".
 *
 * One list, iterated by both the stdio test (config.test.ts) and the hosted one
 * (http/server.test.ts). They each hand-maintained their own, which is how the
 * HTTP side ended up silently missing `${input:apiKey}` while its comment
 * claimed to prove the two transports "discard exactly" the same set — a
 * drift guard that could not detect drift.
 */
export const UNEXPANDED_PLACEHOLDERS = [
  "${WA_API_KEY}", // Cursor plugin variables
  "${env:WA_API_KEY}", // VS Code / Cursor mcp.json interpolation
  "${input:apiKey}", // VS Code input prompts
  "{{WA_API_KEY}}", // moustache-style templating
  "$WA_API_KEY", // bare shell-style
] as const;
