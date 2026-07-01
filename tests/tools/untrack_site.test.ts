import { describe, it, expect, vi } from "vitest";
import { untrackSite } from "../../src/tools/untrackSite.js";
import { makeDeps } from "../helpers.js";

describe("untrack_site [Pro]", () => {
  it("free/no key -> PRO_REQUIRED, does not call the API", async () => {
    const untrackFn = vi.fn();
    const res = await untrackSite({ domain: "example.com" }, makeDeps({ tier: "free", client: { untrackSite: untrackFn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(untrackFn).not.toHaveBeenCalled();
  });

  it("Pro: stops monitoring and confirms the freed slot count", async () => {
    const untrackFn = vi.fn(async () => ({ domain: "example.com", removed: true, limit: 5, used: 2, remaining: 3 }));
    const res = await untrackSite({ domain: "example.com" }, makeDeps({ tier: "pro", client: { untrackSite: untrackFn } }));
    expect(untrackFn).toHaveBeenCalledWith({ domain: "example.com" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.tracking).toBe(false);
    expect(res.data.removed).toBe(true);
    expect(res.data.remaining).toBe(3);
    expect(res.data.message).toMatch(/3 of 5 monitoring slots/i);
  });

  it("Pro: idempotent — stopping a non-tracked domain succeeds (removed:false)", async () => {
    const untrackFn = vi.fn(async () => ({ domain: "nope.com", removed: false, limit: 5, used: 2, remaining: 3 }));
    const res = await untrackSite({ domain: "nope.com" }, makeDeps({ tier: "pro", client: { untrackSite: untrackFn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.removed).toBe(false);
    expect(res.data.message).toMatch(/wasn't being monitored/i);
  });
});
