import { vi } from "vitest";
import type { WaConfig, Tier } from "../src/config.js";
import type { WaApiClientLike, AuditResponse } from "../src/api/client.js";
import type { SubscriptionProvider } from "../src/auth/entitlements.js";
import type { Meter } from "../src/auth/meter.js";
import type { ToolDeps } from "../src/tools/context.js";
import { WaApiError } from "../src/api/errors.js";
import { reachableReport } from "./fixtures/reports.js";

export function testConfig(over: Partial<WaConfig> = {}): WaConfig {
  return {
    apiBaseUrl: "https://api.website-auditor.io",
    siteUrl: "https://website-auditor.io",
    apiKey: "wa_test",
    upgradeUrl: "https://website-auditor.io/admin_portal",
    freeDailyAuditLimit: 3,
    freeMaxDomains: 1,
    requestTimeoutMs: 120000,
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
    getChanges: vi.fn(async () => {
      throw new WaApiError("NOT_YET_AVAILABLE", "no changes endpoint");
    }),
    compareCompetitors: vi.fn(async () => {
      throw new WaApiError("NOT_YET_AVAILABLE", "no compare endpoint");
    }),
  };
  return { ...base, ...over };
}

export function makeDeps(over: {
  tier?: Tier;
  client?: Partial<WaApiClientLike>;
  meter?: Meter;
  config?: Partial<WaConfig>;
} = {}): ToolDeps {
  return {
    client: makeClient(over.client ?? {}),
    subscriptions: fixedTier(over.tier ?? "free"),
    meter: over.meter ?? openMeter(),
    config: testConfig(over.config ?? {}),
  };
}
