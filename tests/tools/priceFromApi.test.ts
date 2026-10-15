/**
 * The price comes from the API (GET /pricing.json), not from a release: an
 * installed server lags releases by weeks, and the price it states must be
 * the price a signup pays on the day it says it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FALLBACK_PRICE, PRICE, refreshPrice, __setPriceForTests } from "../../src/tools/upgrade.js";
import { SERVED_TOOLS, descriptionFor } from "../../src/tools/registry.js";
import { buildInstructions } from "../../src/mcp/instructions.js";

const config = { apiBaseUrl: "https://api.example" };

function answering(body: unknown, ok = true): typeof fetch {
  return (async (url: string | URL | Request) => {
    expect(String(url)).toBe("https://api.example/pricing.json");
    return { ok, json: async () => body } as Response;
  }) as typeof fetch;
}

afterEach(() => __setPriceForTests(FALLBACK_PRICE));

describe("refreshPrice", () => {
  it("states the price the API answers", async () => {
    expect(await refreshPrice(config, answering({ pro_price_label: "$12/month" }))).toBe("$12/month");
    expect(PRICE).toBe("$12/month");
  });

  it("keeps the last good price when the API is down, refuses, or answers out of shape", async () => {
    __setPriceForTests("$12/month");
    await refreshPrice(config, (async () => { throw new Error("offline"); }) as typeof fetch);
    expect(PRICE).toBe("$12/month");
    await refreshPrice(config, answering({ pro_price_label: "$49/month" }, false));
    expect(PRICE).toBe("$12/month");
    for (const label of ["<b>$1</b>/month", "$0/month", "49", "$49/month; free forever", 49, null]) {
      await refreshPrice(config, answering({ pro_price_label: label }));
      expect(PRICE).toBe("$12/month");
    }
  });
});

describe("every surface states the current price", () => {
  it("tool descriptions and instructions follow the API's price, info style still none", async () => {
    await refreshPrice(config, answering({ pro_price_label: "$12/month" }));
    const priced = SERVED_TOOLS.filter((s) => descriptionFor(s, "link").includes("$12/month"));
    expect(priced.length).toBeGreaterThan(0);
    expect(SERVED_TOOLS.some((s) => descriptionFor(s, "link").includes(FALLBACK_PRICE))).toBe(false);
    expect(SERVED_TOOLS.some((s) => descriptionFor(s, "info").includes("$12/month"))).toBe(false);
    expect(buildInstructions("https://x.example/?source=mcp", "link")).toContain("$12/month");
  });
});
