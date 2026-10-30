/**
 * The recommendation gap and the stance counts (chaos_tester Trello 226 / 225).
 *
 * The engine computes `ai_visibility.recommendation_gap`, how far behind the top
 * beatable rival the business is in points of the answers that RECOMMEND it, and
 * `ai_visibility.stance_counts`, how many answers recommended, mentioned or
 * cautioned against it. Trialists who come through Claude or ChatGPT do their
 * work in these tools and never open the dashboard, so get_ai_visibility and
 * run_audit return both, with one plain sentence the assistant can read back,
 * and compare_competitors says how far behind each competitor you are.
 *
 * A field the model never reads changes nothing, so the sentence is also folded
 * into get_ai_visibility's `summary`.
 */
import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { getAiVisibility } from "../../src/tools/getAiVisibility.js";
import { runAudit } from "../../src/tools/runAudit.js";
import { compareCompetitors } from "../../src/tools/compareCompetitors.js";
import { createServer } from "../../src/mcp/server.js";
import { OUTPUT_SCHEMAS } from "../../src/tools/outputSchemas.js";
import { makeDeps } from "../helpers.js";
import { toComparisonRecommendationGap } from "../../src/api/mappers.js";
import { reachableReport } from "../fixtures/reports.js";
import type { AuditReport } from "../../src/api/types.js";

/** What the engine puts on ai_visibility.recommendation_gap (modules/recommendation_gap.py). */
function engineGap(over: Record<string, unknown> = {}) {
  return {
    state: "behind",
    gap_points: 22,
    rival: { name: "Northside Bread Co.", recommended: 11, tied_with: [], included: false },
    client: { recommended: 4 },
    sample: { answers: 32, questions: 8, assistants: 4 },
    engines: [
      { engine: "ChatGPT", answers: 8, client: 1, rival: 3, gap_points: 25, state: "behind" },
      { engine: "Perplexity", answers: 8, client: 1, rival: 3, gap_points: 25, state: "behind" },
      { engine: "Claude", answers: 8, client: 1, rival: 3, gap_points: 25, state: "behind" },
      { engine: "Gemini", answers: 8, client: 1, rival: 2, gap_points: 13, state: "behind" },
    ],
    rivals: [{ name: "Northside Bread Co.", recommended: 11, excluded: false, included: false }],
    sentence: "Northside Bread Co. is recommended in 11 of 32 answers, you in 4: 22 points behind.",
    ...over,
  };
}

const ENGINE_COUNTS = {
  recommended: 4, mentioned: 10, cautioned: 0, uncertain: 3, not_named: 15, answers: 32,
};

/** No stance_counts key at all, which `undefined` cannot say (it picks the default). */
const NO_COUNTS = Symbol("no stance_counts");

function reportWith(gap: unknown, counts: unknown = ENGINE_COUNTS): AuditReport {
  const base = reachableReport();
  return {
    ...base,
    ai_visibility: {
      ...base.ai_visibility,
      ...(gap === undefined ? {} : { recommendation_gap: gap }),
      ...(counts === NO_COUNTS ? {} : { stance_counts: counts }),
    },
  } as AuditReport;
}

function depsFor(report: AuditReport) {
  return makeDeps({
    tier: "pro",
    client: { runAudit: vi.fn(async () => ({ runId: "abc123def456", report, raw: {} })) },
  });
}

describe("get_ai_visibility: the gap", () => {
  it("returns the gap, the sample and a sentence the assistant can read back", async () => {
    const res = await getAiVisibility({ domain: "example.com" }, depsFor(reportWith(engineGap())));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const gap = res.data.recommendation_gap!;
    expect(gap).toMatchObject({
      state: "behind", gap_points: 22, rival: "Northside Bread Co.",
      rival_recommended: 11, you_recommended: 4, answers: 32,
      sentence: "Northside Bread Co. is recommended in 11 of 32 answers, you in 4: 22 points behind.",
    });
    expect(gap.per_engine.map((e) => [e.engine, e.gap_points, e.you_recommended, e.rival_recommended, e.answers]))
      .toEqual([["chatgpt", 25, 1, 3, 8], ["perplexity", 25, 1, 3, 8], ["claude", 25, 1, 3, 8], ["gemini", 13, 1, 2, 8]]);
  });

  it("folds the sentence into summary, because a field the model never reads changes nothing", async () => {
    const res = await getAiVisibility({ domain: "example.com" }, depsFor(reportWith(engineGap())));
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.summary).toContain("Northside Bread Co. is recommended in 11 of 32 answers, you in 4: 22 points behind.");
  });

  it("returns the stance counts, 'unclear' being the engine's 'uncertain'", async () => {
    const res = await getAiVisibility({ domain: "example.com" }, depsFor(reportWith(engineGap())));
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.stance_counts).toEqual({
      recommended: 4, mentioned: 10, cautioned: 0, unclear: 3, not_named: 15, answers: 32,
    });
  });

  it.each([
    ["level", { state: "level", gap_points: 0, sentence: "Northside Bread Co. and you are level: recommended in 4 of 32 answers each." }],
    ["ahead", { state: "ahead", gap_points: -13, sentence: "You lead Northside Bread Co.: recommended in 8 of 32 answers, Northside Bread Co. in 4: 13 points ahead." }],
    ["no_rival", { state: "no_rival", gap_points: null, rival: null, sentence: "No rival is recommended in these 32 answers." }],
    ["no_local_rival", { state: "no_local_rival", gap_points: null, rival: null, sentence: "No local rival is recommended in these 32 answers." }],
  ])("says what %s means, in the summary too", async (_name, over) => {
    const res = await getAiVisibility({ domain: "example.com" }, depsFor(reportWith(engineGap(over))));
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.recommendation_gap!.state).toBe((over as { state: string }).state);
    expect(res.data.recommendation_gap!.sentence).toBe((over as { sentence: string }).sentence);
    expect(res.data.summary).toContain((over as { sentence: string }).sentence);
  });

  it("no local rival has no rival name and no points, never a gap against a platform", async () => {
    const res = await getAiVisibility({ domain: "example.com" }, depsFor(reportWith(
      engineGap({ state: "no_local_rival", gap_points: null, rival: null, sentence: "No local rival is recommended in these 32 answers." }))));
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.recommendation_gap).toMatchObject({ rival: null, gap_points: null, rival_recommended: null });
  });

  it("not enough answers says so, never a 0", async () => {
    const res = await getAiVisibility({ domain: "example.com" }, depsFor(reportWith(
      engineGap({ state: "not_enough_answers", gap_points: null, rival: null, sentence: "",
        sample: { answers: 0, questions: 0, assistants: 0 }, engines: [] }))));
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.recommendation_gap).toMatchObject({ state: "not_enough_answers", gap_points: null });
    expect(res.data.recommendation_gap!.sentence).toBe("Not enough answers yet to measure a gap.");
    expect(res.data.summary).toContain("Not enough answers yet to measure a gap.");
  });

  it("a tie for top rival names both, from the engine's own sentence", async () => {
    const res = await getAiVisibility({ domain: "example.com" }, depsFor(reportWith(engineGap({
      rival: { name: "Harbor Loaf", recommended: 9, tied_with: ["Northside Bread Co."], included: false },
      sentence: "Harbor Loaf and Northside Bread Co. are each recommended in 9 of 32 answers, you in 4: 16 points behind.",
    }))));
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.recommendation_gap!.rival).toBe("Harbor Loaf");
    expect(res.data.recommendation_gap!.tied_with).toEqual(["Northside Bread Co."]);
  });

  it("an engine with no answers is 'not_enough_answers' per engine, not 0", async () => {
    const engines = engineGap().engines.map((e, i) => (i === 3
      ? { engine: "Gemini", answers: 0, client: 0, rival: 0, gap_points: null, state: "not_enough_answers" } : e));
    const res = await getAiVisibility({ domain: "example.com" }, depsFor(reportWith(engineGap({ engines }))));
    if (!res.ok) throw new Error("expected ok");
    const gemini = res.data.recommendation_gap!.per_engine.find((e) => e.engine === "gemini")!;
    expect(gemini).toMatchObject({ state: "not_enough_answers", gap_points: null });
  });
});

describe("an engine that reports no gap", () => {
  it.each([
    ["absent", undefined],
    ["not measured (the rows predate stance)", engineGap({ state: "not_measured", gap_points: null, rival: null, sentence: "" })],
    ["null", null],
    ["a string", "behind"],
  ])("%s: no recommendation_gap key and the summary is untouched", async (_name, gap) => {
    const baseline = await getAiVisibility({ domain: "example.com" }, depsFor(reportWith(undefined, NO_COUNTS)));
    const res = await getAiVisibility({ domain: "example.com" }, depsFor(reportWith(gap, NO_COUNTS)));
    if (!res.ok || !baseline.ok) throw new Error("expected ok");
    expect("recommendation_gap" in res.data).toBe(false);
    expect("stance_counts" in res.data).toBe(false);
    expect(res.data.summary).toBe(baseline.data.summary);
  });

  it("a malformed gap does not crash and invents no number", async () => {
    const res = await getAiVisibility({ domain: "example.com" }, depsFor(reportWith(
      engineGap({ gap_points: "22", client: { recommended: "4" }, sample: null, engines: [7, null, { engine: "ChatGPT", gap_points: "x", state: "behind" }] }),
      { recommended: "4", answers: -3 })));
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.recommendation_gap).toMatchObject({ gap_points: null, you_recommended: null, answers: null });
    expect(res.data.recommendation_gap!.per_engine).toEqual([
      expect.objectContaining({ engine: "chatgpt", gap_points: null, state: "behind" }),
    ]);
    expect(res.data.stance_counts).toBeUndefined();
  });
});

describe("run_audit: the gap and the counts", () => {
  it("returns both beside the scores", async () => {
    const res = await runAudit({ domain: "example.com" }, depsFor(reportWith(engineGap())));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.recommendation_gap).toMatchObject({
      state: "behind", gap_points: 22, rival: "Northside Bread Co.",
      sentence: "Northside Bread Co. is recommended in 11 of 32 answers, you in 4: 22 points behind.",
    });
    expect(res.data.stance_counts).toMatchObject({ recommended: 4, answers: 32, unclear: 3 });
  });

  it("returns neither when the engine reported neither", async () => {
    const res = await runAudit({ domain: "example.com" }, depsFor(reportWith(undefined, NO_COUNTS)));
    if (!res.ok) throw new Error("expected ok");
    expect("recommendation_gap" in res.data).toBe(false);
    expect("stance_counts" in res.data).toBe(false);
  });
});

describe("compare_competitors: how far behind each competitor you are", () => {
  /** Each domain's audit carries its own recommended count over its own answers. */
  function compareDeps(counts: Record<string, { recommended: number; answers: number } | undefined>) {
    return makeDeps({
      tier: "pro",
      client: {
        runAudit: vi.fn(async (req: { domain: string }) => {
          const c = counts[req.domain];
          const base = reachableReport({ base_url: `https://${req.domain}` });
          const report = {
            ...base,
            ai_visibility: {
              ...base.ai_visibility,
              ...(c ? { stance_counts: { ...ENGINE_COUNTS, recommended: c.recommended, answers: c.answers } } : {}),
            },
          } as AuditReport;
          return { runId: req.domain, report, raw: {} };
        }),
      },
    });
  }

  it("is a head-to-head in recommended answers, as points of each site's own answers", async () => {
    const res = await compareCompetitors(
      { domain: "you.com", competitors: ["rival.com"] },
      compareDeps({ "you.com": { recommended: 4, answers: 32 }, "rival.com": { recommended: 11, answers: 32 } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.recommendation_gap).toMatchObject({
      state: "behind", gap_points: 22, rival: "rival.com",
      rival_recommended: 11, rival_answers: 32, you_recommended: 4, you_answers: 32,
      sentence: "rival.com is recommended in 11 of 32 answers, you in 4 of 32: 22 points behind.",
    });
  });

  it("compares RATES, so two sites with different answer counts are still comparable", async () => {
    const res = await compareCompetitors(
      { domain: "you.com", competitors: ["rival.com"] },
      compareDeps({ "you.com": { recommended: 4, answers: 32 }, "rival.com": { recommended: 3, answers: 8 } }));
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.recommendation_gap!.gap_points).toBe(25);          // 37.5% - 12.5%
  });

  it("the top rival is the competitor recommended at the highest rate; every competitor is listed", async () => {
    const res = await compareCompetitors(
      { domain: "you.com", competitors: ["a.com", "b.com"] },
      compareDeps({ "you.com": { recommended: 8, answers: 32 }, "a.com": { recommended: 4, answers: 32 }, "b.com": { recommended: 16, answers: 32 } }));
    if (!res.ok) throw new Error("expected ok");
    const gap = res.data.recommendation_gap!;
    expect(gap.rival).toBe("b.com");
    expect(gap.by_competitor.map((c) => [c.domain, c.state, c.gap_points])).toEqual([
      ["b.com", "behind", 25], ["a.com", "ahead", -13],
    ]);
  });

  it("you lead, and level, by points", async () => {
    const lead = await compareCompetitors({ domain: "you.com", competitors: ["rival.com"] },
      compareDeps({ "you.com": { recommended: 16, answers: 32 }, "rival.com": { recommended: 8, answers: 32 } }));
    if (!lead.ok) throw new Error("expected ok");
    expect(lead.data.recommendation_gap).toMatchObject({ state: "ahead", gap_points: -25 });
    const level = await compareCompetitors({ domain: "you.com", competitors: ["rival.com"] },
      compareDeps({ "you.com": { recommended: 8, answers: 32 }, "rival.com": { recommended: 8, answers: 32 } }));
    if (!level.ok) throw new Error("expected ok");
    expect(level.data.recommendation_gap).toMatchObject({ state: "level", gap_points: 0 });
  });

  it("says nothing when either side has no stance counts: no gap is invented", async () => {
    for (const counts of [
      { "you.com": undefined, "rival.com": { recommended: 3, answers: 8 } },
      { "you.com": { recommended: 3, answers: 8 }, "rival.com": undefined },
      { "you.com": { recommended: 3, answers: 0 }, "rival.com": { recommended: 3, answers: 8 } },
    ]) {
      const res = await compareCompetitors({ domain: "you.com", competitors: ["rival.com"] }, compareDeps(counts));
      if (!res.ok) throw new Error("expected ok");
      expect("recommendation_gap" in res.data).toBe(false);
    }
  });
});

describe("the declared output schemas accept the gap (through the real server)", () => {
  async function connect(deps: ReturnType<typeof depsFor>) {
    const server = createServer(deps);
    const client = new Client({ name: "gap-schema-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.listTools();      // arms the client-side validator, as every real client does
    return client;
  }

  it.each(["get_ai_visibility", "run_audit"])("%s", async (name) => {
    const client = await connect(depsFor(reportWith(engineGap())));
    const result = await client.callTool({ name, arguments: { domain: "example.com" } });
    expect(result.isError).not.toBe(true);
    const parsed = z.object(OUTPUT_SCHEMAS[name]).safeParse(result.structuredContent);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    expect((result.structuredContent as { recommendation_gap?: unknown }).recommendation_gap).toBeDefined();
  });

  it("compare_competitors", async () => {
    const deps = makeDeps({
      tier: "pro",
      client: {
        runAudit: vi.fn(async (req: { domain: string }) => ({
          runId: req.domain,
          report: { ...reachableReport(), ai_visibility: { ...reachableReport().ai_visibility, stance_counts: { ...ENGINE_COUNTS, recommended: req.domain === "you.com" ? 4 : 11 } } } as AuditReport,
          raw: {},
        })),
      },
    });
    const client = await connect(deps as ReturnType<typeof depsFor>);
    const result = await client.callTool({ name: "compare_competitors", arguments: { domain: "you.com", competitors: ["rival.com"] } });
    expect(result.isError).not.toBe(true);
    const parsed = z.object(OUTPUT_SCHEMAS.compare_competitors).safeParse(result.structuredContent);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    expect((result.structuredContent as { recommendation_gap?: unknown }).recommendation_gap).toBeDefined();
  });
});

describe("a gap that exists is never zero points", () => {
  it("rounds 1 more recommendation in 300 answers to 1 point behind, not level", () => {
    const counts = (recommended: number) => ({ recommended, mentioned: 0, cautioned: 0, unclear: 0, not_named: 300 - recommended, answers: 300 });
    const out = toComparisonRecommendationGap(counts(1), [{ domain: "rival.example", counts: counts(2) }]);
    expect(out?.state).toBe("behind");
    expect(out?.gap_points).toBe(1);
  });
});
