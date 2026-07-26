import { describe, it, expect, vi } from "vitest";
import { runAudit } from "../../src/tools/runAudit.js";
import { makeDeps } from "../helpers.js";
import { WaApiError } from "../../src/api/errors.js";
import { unreachableReport } from "../fixtures/reports.js";

describe("run_audit [Subscription]", () => {
  it("happy path (subscriber): returns category scores, top issues and a shareable report url", async () => {
    const res = await runAudit({ domain: "example.com" }, makeDeps({ tier: "pro" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.scores.ai_visibility).toBe(62);
    expect(res.data.report_url).toBe("https://website-auditor.io/report/abc123def456");
    expect(res.data.top_issues.length).toBeGreaterThan(0);
  });

  it("free tier (no subscription) -> PRO_REQUIRED pre-flight; the audit API is never called", async () => {
    // No free API tier since api PR #17 — the server would 403 this anyway;
    // the pre-flight saves the round-trip and never spends server resources.
    const runAuditCall = vi.fn();
    const res = await runAudit({ domain: "example.com" }, makeDeps({ tier: "free", client: { runAudit: runAuditCall } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(res.error.upgrade_url).toBeTruthy();
    expect(runAuditCall).not.toHaveBeenCalled();
  });

  it("API-side 429 surfaces as OVER_QUOTA (subscriber at the server's daily cap)", async () => {
    const client = {
      runAudit: vi.fn(async () => {
        throw new WaApiError("OVER_QUOTA", "Rate limit exceeded.", { details: { limit: 5 } });
      }),
    };
    const res = await runAudit({ domain: "example.com" }, makeDeps({ tier: "pro", client }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("OVER_QUOTA");
  });

  it("unreachable domain -> UNREACHABLE_DOMAIN, never a fabricated score", async () => {
    const client = { runAudit: vi.fn(async () => ({ runId: "x", report: unreachableReport(), raw: {} })) };
    const res = await runAudit({ domain: "not-a-real-domain-zzz.example" }, makeDeps({ tier: "pro", client }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("UNREACHABLE_DOMAIN");
    expect(JSON.stringify(res)).not.toContain('"scores"');
  });

  it("no key -> AUTH_REQUIRED (not an upsell)", async () => {
    const res = await runAudit({ domain: "example.com" }, makeDeps({ tier: "none" }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("AUTH_REQUIRED");
  });
});
