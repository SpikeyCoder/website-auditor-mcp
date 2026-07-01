import { describe, it, expect } from "vitest";
import { InMemoryMeter } from "../../src/auth/meter.js";

describe("InMemoryMeter (free-tier metering + abuse guard)", () => {
  it("allows queries up to the daily audit limit, then blocks with reason 'daily'", () => {
    let t = Date.parse("2026-06-30T09:00:00Z");
    const meter = new InMemoryMeter({ dailyLimit: 3, maxDomains: 5, now: () => t });
    const key = "wa_free";
    expect(meter.recordQuery(key, "a.com")).toEqual({ ok: true });
    expect(meter.recordQuery(key, "a.com")).toEqual({ ok: true });
    expect(meter.recordQuery(key, "a.com")).toEqual({ ok: true });
    expect(meter.recordQuery(key, "a.com")).toEqual({ ok: false, reason: "daily" });
  });

  it("enforces the distinct-domain cap for the free tier", () => {
    const t = Date.parse("2026-06-30T09:00:00Z");
    const meter = new InMemoryMeter({ dailyLimit: 100, maxDomains: 1, now: () => t });
    const key = "wa_free";
    expect(meter.recordQuery(key, "a.com")).toEqual({ ok: true });
    // same domain is fine
    expect(meter.recordQuery(key, "a.com")).toEqual({ ok: true });
    // a second distinct domain exceeds the free cap
    expect(meter.recordQuery(key, "b.com")).toEqual({ ok: false, reason: "domains" });
  });

  it("resets the daily counter on a new UTC day", () => {
    let t = Date.parse("2026-06-30T23:00:00Z");
    const meter = new InMemoryMeter({ dailyLimit: 1, maxDomains: 5, now: () => t });
    const key = "wa_free";
    expect(meter.recordQuery(key, "a.com")).toEqual({ ok: true });
    expect(meter.recordQuery(key, "a.com")).toEqual({ ok: false, reason: "daily" });
    // next day
    t = Date.parse("2026-07-01T00:05:00Z");
    expect(meter.recordQuery(key, "a.com")).toEqual({ ok: true });
  });

  it("meters each key independently", () => {
    const t = Date.parse("2026-06-30T09:00:00Z");
    const meter = new InMemoryMeter({ dailyLimit: 1, maxDomains: 5, now: () => t });
    expect(meter.recordQuery("wa_k1", "a.com")).toEqual({ ok: true });
    expect(meter.recordQuery("wa_k2", "a.com")).toEqual({ ok: true });
  });
});
