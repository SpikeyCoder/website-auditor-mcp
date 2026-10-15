/**
 * The price comes from the API (GET /pricing.json), not from a release: an
 * installed server lags releases by weeks, and the price it states must be
 * the price a signup pays on the day it says it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FALLBACK_PRICE, PRICE, PRICE_MAX_AGE_MS, PRICE_RETRY_MS, refreshPrice, refreshPriceIfStale,
} from "../../src/tools/upgrade.js";
import { SERVED_TOOLS, descriptionFor } from "../../src/tools/registry.js";
import { buildInstructions } from "../../src/mcp/instructions.js";
import { createServer } from "../../src/mcp/server.js";
import { createServerWithPrice } from "../../src/mcp/priceBoot.js";
import { startPriceRefresh, PRICE_REFRESH_MS } from "../../src/http.js";
import { getSampleAudit } from "../../src/tools/sampleAudit.js";
import { checkUpgradeStatus } from "../../src/tools/checkUpgradeStatus.js";
import { gateProTool } from "../../src/tools/context.js";
import { makeDeps } from "../helpers.js";

const config = { apiBaseUrl: "https://api.example", upsellStyle: "link" as const };
const TWELVE = "$12/month";

function answering(body: unknown, ok = true): typeof fetch & { calls: number } {
  const f = (async (url: string | URL | Request) => {
    f.calls += 1;
    expect(String(url)).toBe("https://api.example/pricing.json");
    return { ok, status: ok ? 200 : 502, json: async () => body } as Response;
  }) as typeof fetch & { calls: number };
  f.calls = 0;
  return f;
}

const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(async () => {
  await refreshPrice(config, answering({ pro_price_label: FALLBACK_PRICE }), 0);
  vi.restoreAllMocks();
});

describe("refreshPrice", () => {
  it("states the price the API answers", async () => {
    expect(await refreshPrice(config, answering({ pro_price_label: TWELVE }))).toBe(TWELVE);
    expect(PRICE).toBe(TWELVE);
  });

  it("keeps the last good price when the API is down, refuses, or answers out of shape, and says so", async () => {
    const log = quiet();
    await refreshPrice(config, answering({ pro_price_label: TWELVE }));
    await refreshPrice(config, (async () => { throw new Error("offline"); }) as typeof fetch);
    expect(PRICE).toBe(TWELVE);
    await refreshPrice(config, answering({ pro_price_label: "$49/month" }, false));
    expect(PRICE).toBe(TWELVE);
    for (const label of ["<b>$1</b>/month", "$0/month", "49", "$49.50/month", "$49/month; free forever", 49, null]) {
      await refreshPrice(config, answering({ pro_price_label: label }));
      expect(PRICE).toBe(TWELVE);
    }
    expect(log).toHaveBeenCalledTimes(9);
    expect(String(log.mock.calls[1][0])).toContain("answered 502");
  });
});

describe("refreshPriceIfStale", () => {
  it("asks at most once an hour, and never on an info-style server", async () => {
    const f = answering({ pro_price_label: TWELVE });
    const t0 = 1e12;
    await refreshPriceIfStale(config, f, t0);
    await refreshPriceIfStale(config, f, t0 + PRICE_MAX_AGE_MS - 1);
    expect(f.calls).toBe(1);
    await refreshPriceIfStale(config, f, t0 + PRICE_MAX_AGE_MS);
    expect(f.calls).toBe(2);
    await refreshPriceIfStale({ ...config, upsellStyle: "info" }, f, 9e12);
    expect(f.calls).toBe(2);
  });

  it("after a failed ask, asks again in minutes, not an hour", async () => {
    quiet();
    const t0 = 2e12;
    const down = Object.assign((async () => { throw new Error("offline"); }) as unknown as typeof fetch, { calls: 0 });
    await refreshPriceIfStale(config, down, t0);
    const f = answering({ pro_price_label: TWELVE });
    await refreshPriceIfStale(config, f, t0 + PRICE_RETRY_MS - 1);
    expect(f.calls).toBe(0);
    await refreshPriceIfStale(config, f, t0 + PRICE_RETRY_MS);
    expect(f.calls).toBe(1);
    expect(PRICE).toBe(TWELVE);
  });
});

describe("every surface states the current price", () => {
  it("tool descriptions and instructions follow the API's price, info style still none", async () => {
    await refreshPrice(config, answering({ pro_price_label: TWELVE }));
    expect(SERVED_TOOLS.filter((s) => descriptionFor(s, "link").includes(TWELVE)).length).toBeGreaterThan(0);
    expect(SERVED_TOOLS.some((s) => descriptionFor(s, "link").includes(FALLBACK_PRICE))).toBe(false);
    expect(SERVED_TOOLS.some((s) => /\$\d/.test(descriptionFor(s, "info")))).toBe(false);
    expect(buildInstructions("https://x.example/?source=mcp", "link")).toContain(TWELVE);
  });

  it("the sample audit, the upgrade status and the Pro gate say it too", async () => {
    await refreshPrice(config, answering({ pro_price_label: TWELVE }));
    const sample = await getSampleAudit({}, makeDeps({}));
    expect(sample.ok && sample.data.price).toContain(TWELVE);
    const status = await checkUpgradeStatus({}, makeDeps({}));
    expect(status.ok && status.data.message).toContain(TWELVE);
    const gate = await gateProTool(makeDeps({ tier: "free", config: { apiKey: "wa_free_key_for_tests" } }));
    expect(gate && !gate.ok && gate.error.code).toBe("PRO_REQUIRED");
    expect(gate && !gate.ok && gate.error.message).toContain(TWELVE);
    const keyless = await gateProTool(makeDeps({ tier: "none" }));
    expect(keyless && !keyless.ok && keyless.error.code).toBe("AUTH_REQUIRED");
    expect(keyless && !keyless.ok && keyless.error.message).toContain(TWELVE);
  });

  it("messages a member may read state no price: they may still be on an earlier one", async () => {
    await refreshPrice(config, answering({ pro_price_label: TWELVE }));
    const noKey = await checkUpgradeStatus({}, makeDeps({ config: { apiKey: undefined } }));
    expect(noKey.ok && noKey.data.message).toMatch(/No API key is configured/);
    expect(noKey.ok && noKey.data.message).not.toMatch(/\$\d/);
  });
});

describe("the entry points ask before they serve", () => {
  it("stdio builds its server after the price is read", async () => {
    const f = answering({ pro_price_label: TWELVE });
    const deps = makeDeps({ config: { apiBaseUrl: config.apiBaseUrl } });
    const server = await createServerWithPrice(deps, f);
    expect(f.calls).toBe(1);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect(client.getInstructions()).toContain(TWELVE);
    await client.close();
  });

  it("a tool call refreshes the price before its handler states it; a local tool never asks", async () => {
    let refreshed = 0;
    const deps = {
      ...makeDeps({ config: { apiBaseUrl: config.apiBaseUrl } }),
      refreshPrice: async () => { refreshed += 1; await refreshPrice(config, answering({ pro_price_label: TWELVE })); },
    };
    const server = createServer(deps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.callTool({ name: "get_sample_audit", arguments: {} });
    expect(refreshed).toBe(0);
    const res = await client.callTool({ name: "check_upgrade_status", arguments: {} });
    expect(refreshed).toBe(1);
    expect(JSON.stringify(res)).toContain(TWELVE);
    await client.close();
  });

  it("a refresh that fails is the old price, never a failed tool call", async () => {
    const deps = { ...makeDeps({}), refreshPrice: async () => { throw new Error("boom"); } };
    const server = createServer(deps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = await client.callTool({ name: "check_upgrade_status", arguments: {} });
    expect(res.isError).toBeFalsy();
    await client.close();
  });

  it("the hosted server reads it at boot and on a timer, and not at all under info style", async () => {
    vi.useFakeTimers();
    try {
      const f = answering({ pro_price_label: TWELVE });
      const timer = await startPriceRefresh(config, f);
      expect(PRICE).toBe(TWELVE);
      expect(f.calls).toBe(1);
      await vi.advanceTimersByTimeAsync(PRICE_REFRESH_MS);
      expect(f.calls).toBe(2);
      clearInterval(timer!);
      const g = answering({ pro_price_label: TWELVE });
      expect(await startPriceRefresh({ ...config, upsellStyle: "info" }, g)).toBeNull();
      expect(g.calls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
