import { describe, it, expect } from "vitest";
import { InMemoryAuditCache } from "../../src/auth/auditCache.js";
import type { AiVisibility } from "../../src/api/types.js";

const av = (score: number): AiVisibility => ({
  score,
  by_engine: { chatgpt: score, perplexity: score, claude: score, gemini: score },
  top_competitor: null,
  summary: "s",
});

describe("InMemoryAuditCache", () => {
  it("returns a stored audit within the TTL", () => {
    let t = 1_000_000;
    const cache = new InMemoryAuditCache({ ttlMs: 60_000, now: () => t });
    cache.set("example.com", av(62));
    t += 30_000;
    expect(cache.get("example.com")).toMatchObject({ score: 62 });
  });

  it("expires an audit past the TTL", () => {
    let t = 1_000_000;
    const cache = new InMemoryAuditCache({ ttlMs: 60_000, now: () => t });
    cache.set("example.com", av(62));
    t += 60_001;
    expect(cache.get("example.com")).toBeUndefined();
  });

  it("returns undefined for an unknown domain", () => {
    const cache = new InMemoryAuditCache({ ttlMs: 60_000 });
    expect(cache.get("nope.com")).toBeUndefined();
  });

  it("overwrites an existing entry with the newer audit and refreshes its timestamp", () => {
    let t = 1_000_000;
    const cache = new InMemoryAuditCache({ ttlMs: 60_000, now: () => t });
    cache.set("example.com", av(50));
    t += 59_000;
    cache.set("example.com", av(70)); // refresh
    t += 2_000; // 61s since first set, but only 2s since refresh
    expect(cache.get("example.com")).toMatchObject({ score: 70 });
  });
});
