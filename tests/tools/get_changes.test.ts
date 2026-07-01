import { describe, it, expect, vi } from "vitest";
import { getChanges } from "../../src/tools/getChanges.js";
import { makeDeps, fixedResolution } from "../helpers.js";

describe("get_changes [Pro]", () => {
  it("no key -> PRO_REQUIRED with upgrade URL (does not run)", async () => {
    const client = { getChanges: vi.fn() };
    const res = await getChanges({ domain: "example.com" }, makeDeps({ tier: "none", client }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(res.error.upgrade_url).toContain("website-auditor.io");
    expect(client.getChanges).not.toHaveBeenCalled();
  });

  it("free key (verified) -> PRO_REQUIRED with upgrade URL (does not run)", async () => {
    const client = { getChanges: vi.fn() };
    const res = await getChanges({ domain: "example.com" }, makeDeps({ tier: "free", client }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(client.getChanges).not.toHaveBeenCalled();
  });

  it("subscription unverifiable (outage, cold cache) -> SUBSCRIPTION_UNVERIFIED, NOT a false 'not subscribed'", async () => {
    const client = { getChanges: vi.fn() };
    const res = await getChanges(
      { domain: "example.com" },
      makeDeps({ subscriptions: fixedResolution({ tier: "free", verified: false }), client }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // A genuine Pro user in an outage must NOT be told they're not subscribed.
    expect(res.error.code).toBe("SUBSCRIPTION_UNVERIFIED");
    expect(res.error.code).not.toBe("PRO_REQUIRED");
    expect(res.error.message).toMatch(/try again/i);
    expect(res.error.upgrade_url).toContain("website-auditor.io");
    expect(client.getChanges).not.toHaveBeenCalled();
  });

  it("valid Pro key: passes the gate and returns deltas once the endpoint lands", async () => {
    // Simulate the pending delta endpoint being available by stubbing the client.
    const delta = {
      score_delta: 12,
      engine_changes: [{ engine: "chatgpt", from: 40, to: 75, delta: 35 }],
      competitor_changes: [],
      new_issues: [],
      resolved_issues: [],
    };
    const client = { getChanges: vi.fn(async () => delta) };
    const res = await getChanges({ domain: "example.com", since: "last_check" }, makeDeps({ tier: "pro", client }));
    expect(client.getChanges).toHaveBeenCalledWith({ domain: "example.com", since: "last_check" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.score_delta).toBe(12);
  });

  it("valid Pro key but endpoint still pending -> NOT_YET_AVAILABLE (clearly flagged, not fabricated)", async () => {
    // Default client (helpers) throws NOT_YET_AVAILABLE for getChanges.
    const res = await getChanges({ domain: "example.com" }, makeDeps({ tier: "pro" }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("NOT_YET_AVAILABLE");
  });
});
