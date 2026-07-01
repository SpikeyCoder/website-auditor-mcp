import { describe, it, expect, vi } from "vitest";
import { getAiVisibility } from "../../src/tools/getAiVisibility.js";
import { makeDeps } from "../helpers.js";
import { WaApiError } from "../../src/api/errors.js";
import { unreachableReport } from "../fixtures/reports.js";

describe("get_ai_visibility [Free]", () => {
  it("happy path: valid key returns score, per-engine breakdown and top competitor", async () => {
    const res = await getAiVisibility({ domain: "example.com" }, makeDeps({ tier: "free" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.score).toBe(62);
    expect(res.data.by_engine).toEqual({ chatgpt: 75, perplexity: 62, claude: 50, gemini: 62 });
    expect(res.data.top_competitor).toBe("Globex");
  });

  it("no key -> AUTH_REQUIRED with an upgrade URL (backend requires a key)", async () => {
    const res = await getAiVisibility({ domain: "example.com" }, makeDeps({ tier: "none" }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("AUTH_REQUIRED");
    expect(res.error.upgrade_url).toContain("website-auditor.io");
  });

  it("unreachable domain -> UNREACHABLE_DOMAIN, never a fabricated score", async () => {
    const client = {
      runAudit: vi.fn(async () => ({ runId: "x", report: unreachableReport(), raw: {} })),
    };
    const res = await getAiVisibility({ domain: "not-a-real-domain-zzz.example" }, makeDeps({ tier: "free", client }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("UNREACHABLE_DOMAIN");
    expect(JSON.stringify(res)).not.toContain('"score"');
  });

  it("free tier over quota -> OVER_QUOTA with upgrade path", async () => {
    const meter = { recordQuery: () => ({ ok: false as const, reason: "daily" as const }) };
    const res = await getAiVisibility({ domain: "example.com" }, makeDeps({ tier: "free", meter }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("OVER_QUOTA");
    expect(res.error.upgrade_url).toBeTruthy();
  });

  it("propagates an invalid-key error from the API", async () => {
    const client = {
      runAudit: vi.fn(async () => {
        throw new WaApiError("INVALID_KEY", "Invalid API key.");
      }),
    };
    const res = await getAiVisibility({ domain: "example.com" }, makeDeps({ tier: "free", client }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_KEY");
  });

  it("pro tier bypasses free metering", async () => {
    const recordQuery = vi.fn(() => ({ ok: true as const }));
    const res = await getAiVisibility({ domain: "example.com" }, makeDeps({ tier: "pro", meter: { recordQuery } }));
    expect(res.ok).toBe(true);
    expect(recordQuery).not.toHaveBeenCalled();
  });
});
