import { describe, it, expect, vi } from "vitest";
import { compareCompetitors } from "../../src/tools/compareCompetitors.js";
import { makeDeps } from "../helpers.js";
import { reachableReport, unreachableReport } from "../fixtures/reports.js";
import type { AuditResponse } from "../../src/api/client.js";

function reportForDomain(domain: string): AuditResponse {
  const report = reachableReport({ base_url: `https://${domain}` });
  if (domain === "rival.com") {
    report.ai_visibility.overall_score = 80;
    report.ai_visibility.platform_scores!.ChatGPT!.score = 90;
    report.ai_visibility.platform_scores!.Claude!.score = 70;
  }
  return { runId: `run-${domain}`, report, raw: {} };
}

describe("compare_competitors [Pro]", () => {
  it("non-pro -> PRO_REQUIRED with upgrade URL (does not run)", async () => {
    const runAudit = vi.fn();
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com"] },
      makeDeps({ tier: "free", client: { runAudit } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(runAudit).not.toHaveBeenCalled();
  });

  it("valid Pro key: ranks the domain against competitors by AI-visibility score", async () => {
    const runAudit = vi.fn(async ({ domain }: { domain: string }) => reportForDomain(domain));
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com"] },
      makeDeps({ tier: "pro", client: { runAudit } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // rival.com (80) ranks above example.com (62)
    expect(res.data.ranking.map((r) => r.domain)).toEqual(["rival.com", "example.com"]);
    expect(res.data.ranking[0]).toMatchObject({ domain: "rival.com", score: 80 });
    // a gap exists where the competitor's per-engine score beats ours (ChatGPT 90 > 75)
    const chatgptGap = res.data.gaps.find((g) => g.engine === "chatgpt" && g.competitor === "rival.com");
    expect(chatgptGap).toBeTruthy();
  });

  it("primary domain unreachable -> UNREACHABLE_DOMAIN", async () => {
    const runAudit = vi.fn(async ({ domain }: { domain: string }) =>
      domain === "example.com"
        ? { runId: "x", report: unreachableReport(), raw: {} }
        : reportForDomain(domain),
    );
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com"] },
      makeDeps({ tier: "pro", client: { runAudit } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("UNREACHABLE_DOMAIN");
  });

  it("rejects an empty competitor list (INVALID_INPUT)", async () => {
    const res = await compareCompetitors(
      { domain: "example.com", competitors: [] },
      makeDeps({ tier: "pro" }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_INPUT");
  });
});
