import { describe, it, expect, vi } from "vitest";
import { compareCompetitors } from "../../src/tools/compareCompetitors.js";
import { makeDeps, makeQuotaClient } from "../helpers.js";
import { reachableReport, unreachableReport } from "../fixtures/reports.js";
import { InMemoryAuditCache } from "../../src/auth/auditCache.js";
import { toAiVisibility } from "../../src/api/mappers.js";
import type { AuditReport } from "../../src/api/types.js";
import type { AuditResponse } from "../../src/api/client.js";

function reportFor(domain: string): AuditReport {
  const report = reachableReport({ base_url: `https://${domain}` });
  if (domain === "rival.com") {
    report.ai_visibility.overall_score = 80;
    report.ai_visibility.platform_scores!.ChatGPT!.score = 90;
    report.ai_visibility.platform_scores!.Claude!.score = 70;
  }
  return report;
}

describe("compare_competitors [Pro] — gating & basics", () => {
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

  it("rejects an empty competitor list (INVALID_INPUT)", async () => {
    const res = await compareCompetitors(
      { domain: "example.com", competitors: [] },
      makeDeps({ tier: "pro" }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_INPUT");
  });

  it("primary domain unreachable -> UNREACHABLE_DOMAIN", async () => {
    const runAudit = vi.fn(async ({ domain }: { domain: string }): Promise<AuditResponse> =>
      domain === "example.com"
        ? { runId: "x", report: unreachableReport(), raw: {} }
        : { runId: "y", report: reportFor(domain), raw: {} },
    );
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com"] },
      makeDeps({ tier: "pro", client: { runAudit } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("UNREACHABLE_DOMAIN");
  });

  it("ranks the domain against competitors by AI-visibility score (header-less client)", async () => {
    const runAudit = vi.fn(async ({ domain }: { domain: string }): Promise<AuditResponse> => ({
      runId: `run-${domain}`,
      report: reportFor(domain),
      raw: {},
    }));
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com"] },
      makeDeps({ tier: "pro", client: { runAudit } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ranking.map((r) => r.domain)).toEqual(["rival.com", "example.com"]);
    expect(res.data.ranking[0]).toMatchObject({ domain: "rival.com", score: 80 });
    // Gaps are APPEARANCE-based, not score-based: rival.com outscores example.com
    // on ChatGPT (90 > 75) but both APPEAR there, so it is not a gap.
    expect(res.data.gaps).toEqual([]);
    // No rate-limit headers -> remaining unknown, but both were audited.
    expect(res.data.quota.audits_used).toBe(2);
    expect(res.data.quota.remaining).toBeNull();
    expect(res.data.skipped).toEqual([]);
  });
});

describe("compare_competitors [Pro] — quota awareness", () => {
  it("enough quota: audits every domain and reports remaining", async () => {
    const client = makeQuotaClient({ start: 10, report: reportFor });
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com", "b.com"] },
      makeDeps({ tier: "pro", client }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ranking).toHaveLength(3);
    expect(res.data.quota.audits_used).toBe(3);
    expect(res.data.quota.audits_skipped).toBe(0);
    expect(res.data.quota.remaining).toBe(7); // 10 - 3
    expect(res.data.quota.limit).toBe(5);
    expect(res.data.skipped).toEqual([]);
  });

  it("partial quota: ranks what it could audit and clearly reports the skipped rest", async () => {
    // Only 3 audits available: primary + 2 competitors; 3 competitors skipped.
    const client = makeQuotaClient({ start: 3, report: reportFor });
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["c1.com", "c2.com", "c3.com", "c4.com", "c5.com"] },
      makeDeps({ tier: "pro", client }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // primary + 2 competitors ranked; scores are real numbers, never fabricated for skips.
    expect(res.data.ranking).toHaveLength(3);
    for (const r of res.data.ranking) expect(typeof r.score).toBe("number");

    // 3 competitors skipped, all for quota, none silently dropped.
    const quotaSkips = res.data.skipped.filter((s) => s.reason === "quota");
    expect(quotaSkips.map((s) => s.domain).sort()).toEqual(["c3.com", "c4.com", "c5.com"]);
    expect(res.data.quota.audits_used).toBe(3);
    expect(res.data.quota.audits_skipped).toBe(3);
    expect(res.data.quota.remaining).toBe(0);

    // Skipped domains must not appear in the ranking at all.
    const ranked = new Set(res.data.ranking.map((r) => r.domain));
    for (const s of quotaSkips) expect(ranked.has(s.domain)).toBe(false);

    // Summary tells the agent what happened and how many remain.
    expect(res.data.summary).toMatch(/skipped/i);
    expect(res.data.summary).toMatch(/quota/i);
  });

  it("zero quota (primary audit 429s) -> actionable OVER_QUOTA error", async () => {
    const client = makeQuotaClient({ start: 0, report: reportFor });
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com"] },
      makeDeps({ tier: "pro", client }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("OVER_QUOTA");
    expect(res.error.upgrade_url).toContain("website-auditor.io");
    expect(res.error.message).toMatch(/quota|remain|reset/i);
  });

  it("zero quota known up-front (subscription endpoint) -> OVER_QUOTA without spending an audit", async () => {
    const client = makeQuotaClient({ start: 0, preflight: true, report: reportFor });
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com"] },
      makeDeps({ tier: "pro", client }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("OVER_QUOTA");
    // Pre-flight told us there was nothing to spend, so no audit was attempted.
    expect(client.runAudit).not.toHaveBeenCalled();
  });
});

describe("compare_competitors [Pro] — cache reuse & dedup", () => {
  it("dedupes the primary domain and duplicate competitors before spending quota", async () => {
    const client = makeQuotaClient({ start: 10, report: reportFor });
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com", "rival.com", "example.com"] },
      makeDeps({ tier: "pro", client }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Only example.com + rival.com are distinct → 2 audits, not 4.
    expect(client.runAudit).toHaveBeenCalledTimes(2);
    expect(res.data.ranking.map((r) => r.domain).sort()).toEqual(["example.com", "rival.com"]);
  });

  it("reuses a recent cached audit across calls instead of re-spending quota", async () => {
    const client = makeQuotaClient({ start: 10, report: reportFor });
    const cache = new InMemoryAuditCache({ ttlMs: 10 * 60 * 1000 });
    const deps = makeDeps({ tier: "pro", client, cache });

    const first = await compareCompetitors({ domain: "example.com", competitors: ["rival.com"] }, deps);
    expect(first.ok).toBe(true);
    expect(client.runAudit).toHaveBeenCalledTimes(2);

    const second = await compareCompetitors({ domain: "example.com", competitors: ["rival.com"] }, deps);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // No new audits — both domains served from cache.
    expect(client.runAudit).toHaveBeenCalledTimes(2);
    expect(second.data.quota.audits_used).toBe(0);
    expect(second.data.quota.cached_reused).toBe(2);
    // Ranking is still correct from cached data.
    expect(second.data.ranking.map((r) => r.domain)).toEqual(["rival.com", "example.com"]);
  });

  it("still serves a cached competitor for free even after quota is exhausted mid-fan-out", async () => {
    // c2.com is already cached; only 1 audit remains. The primary spends it, an
    // uncached competitor (c1.com) exhausts the budget — but the cached c2.com
    // must still be ranked (zero cost), not dropped as a quota skip.
    const cache = new InMemoryAuditCache({ ttlMs: 10 * 60 * 1000 });
    cache.set("c2.com", toAiVisibility(reportFor("c2.com")));
    const client = makeQuotaClient({ start: 1, report: reportFor });
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["c1.com", "c2.com"] },
      makeDeps({ tier: "pro", client, cache }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const ranked = res.data.ranking.map((r) => r.domain);
    expect(ranked).toContain("c2.com"); // cached competitor served for free
    expect(ranked).toContain("example.com");
    expect(res.data.quota.audits_used).toBe(1); // only the primary
    expect(res.data.quota.cached_reused).toBe(1);
    // Only the genuinely-uncached competitor is a quota skip.
    expect(res.data.skipped.filter((s) => s.reason === "quota").map((s) => s.domain)).toEqual(["c1.com"]);
  });
});

describe("compare_competitors [Pro] — appearance-based gaps", () => {
  type Presence = { chatgpt: boolean; perplexity: boolean; claude: boolean; gemini: boolean };

  // Builds a report where each engine's per-query client_appears (and the
  // appearances count) is set explicitly, so gap logic can be tested precisely.
  function reportWithPresence(domain: string, p: Presence): AuditReport {
    const report = reachableReport({ base_url: `https://${domain}` });
    const ps = report.ai_visibility.platform_scores!;
    const apply = (key: "ChatGPT" | "Perplexity" | "Claude" | "Gemini", appears: boolean) => {
      const s = ps[key]!;
      s.appearances = appears ? 3 : 0;
      s.results = [
        {
          platform: key,
          query: "best tech company in Seattle, WA",
          recommended: appears ? [domain, "Rival Co"] : ["Rival Co"],
          client_appears: appears,
          position: appears ? 1 : 0,
          competitors: ["Rival Co"],
          is_simulated: false,
        },
      ];
    };
    apply("ChatGPT", p.chatgpt);
    apply("Perplexity", p.perplexity);
    apply("Claude", p.claude);
    apply("Gemini", p.gemini);
    return report;
  }

  function presenceDeps(map: Record<string, Presence>) {
    const runAudit = vi.fn(async ({ domain }: { domain: string }): Promise<AuditResponse> => ({
      runId: `run-${domain}`,
      report: reportWithPresence(domain, map[domain]!),
      raw: {},
    }));
    return makeDeps({ tier: "pro", client: { runAudit } });
  }

  it("flags a gap on an engine where the competitor appears and the site does not", async () => {
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com"] },
      presenceDeps({
        "example.com": { chatgpt: false, perplexity: true, claude: true, gemini: true },
        "rival.com": { chatgpt: true, perplexity: true, claude: true, gemini: true },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.gaps).toEqual([{ engine: "chatgpt", competitor: "rival.com" }]);
  });

  it("no gap when both the site and the competitor appear on an engine", async () => {
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com"] },
      presenceDeps({
        "example.com": { chatgpt: true, perplexity: true, claude: true, gemini: true },
        "rival.com": { chatgpt: true, perplexity: true, claude: true, gemini: true },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.gaps).toEqual([]);
  });

  it("no gap when neither the site nor the competitor appears on an engine", async () => {
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com"] },
      presenceDeps({
        "example.com": { chatgpt: false, perplexity: true, claude: true, gemini: true },
        "rival.com": { chatgpt: false, perplexity: true, claude: true, gemini: true },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.gaps).toEqual([]);
  });

  it("mixed engines: lists only the engines missing for the site where the competitor appears", async () => {
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com"] },
      presenceDeps({
        // site absent on chatgpt + perplexity; competitor present on chatgpt only.
        "example.com": { chatgpt: false, perplexity: false, claude: true, gemini: true },
        "rival.com": { chatgpt: true, perplexity: false, claude: true, gemini: true },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // perplexity: competitor also absent -> no gap. claude/gemini: both present -> no gap.
    expect(res.data.gaps).toEqual([{ engine: "chatgpt", competitor: "rival.com" }]);
  });

  it("attributes gaps to the right competitor across multiple competitors", async () => {
    const res = await compareCompetitors(
      { domain: "example.com", competitors: ["rival.com", "other.com"] },
      presenceDeps({
        "example.com": { chatgpt: false, perplexity: false, claude: true, gemini: true },
        "rival.com": { chatgpt: true, perplexity: false, claude: true, gemini: true }, // gap: chatgpt
        "other.com": { chatgpt: false, perplexity: true, claude: true, gemini: true }, // gap: perplexity
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.gaps).toContainEqual({ engine: "chatgpt", competitor: "rival.com" });
    expect(res.data.gaps).toContainEqual({ engine: "perplexity", competitor: "other.com" });
    expect(res.data.gaps).toHaveLength(2);
  });
});
