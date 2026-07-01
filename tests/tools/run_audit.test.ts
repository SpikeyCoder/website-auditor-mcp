import { describe, it, expect, vi } from "vitest";
import { runAudit } from "../../src/tools/runAudit.js";
import { makeDeps } from "../helpers.js";
import { WaApiError } from "../../src/api/errors.js";
import { unreachableReport } from "../fixtures/reports.js";

describe("run_audit [Free, rate-limited]", () => {
  it("happy path: returns category scores, top issues and a shareable report url", async () => {
    const res = await runAudit({ domain: "example.com" }, makeDeps({ tier: "free" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.scores.ai_visibility).toBe(62);
    expect(res.data.report_url).toBe("https://website-auditor.io/report/abc123def456");
    expect(res.data.top_issues.length).toBeGreaterThan(0);
  });

  it("free key at its daily cap -> OVER_QUOTA and the upgrade path", async () => {
    const meter = { recordQuery: () => ({ ok: false as const, reason: "daily" as const }) };
    const res = await runAudit({ domain: "example.com" }, makeDeps({ tier: "free", meter }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("OVER_QUOTA");
    expect(res.error.upgrade_url).toBeTruthy();
  });

  it("API-side 429 also surfaces as OVER_QUOTA", async () => {
    const client = {
      runAudit: vi.fn(async () => {
        throw new WaApiError("OVER_QUOTA", "Rate limit exceeded.", { details: { limit: 5 } });
      }),
    };
    const res = await runAudit({ domain: "example.com" }, makeDeps({ tier: "free", client }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("OVER_QUOTA");
  });

  it("unreachable domain -> UNREACHABLE_DOMAIN, never a fabricated score", async () => {
    const client = { runAudit: vi.fn(async () => ({ runId: "x", report: unreachableReport(), raw: {} })) };
    const res = await runAudit({ domain: "not-a-real-domain-zzz.example" }, makeDeps({ tier: "free", client }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("UNREACHABLE_DOMAIN");
    expect(JSON.stringify(res)).not.toContain('"scores"');
  });

  it("no key -> AUTH_REQUIRED", async () => {
    const res = await runAudit({ domain: "example.com" }, makeDeps({ tier: "none" }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("AUTH_REQUIRED");
  });
});
