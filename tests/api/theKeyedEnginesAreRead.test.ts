/**
 * Google AI Overviews and Microsoft Copilot are read like the four
 * (chaos_tester Trello 274).
 *
 * A paid audit scores six engines and pools its overall over all six; a free
 * one asks the four and records the two as locked, with no platform row. So:
 *
 *   - get_ai_visibility reads all six. A free report's two are "not_asked",
 *     which the summary never mentions (only "scored" and "unanswered" reach
 *     prose), so a free audit reads exactly as before.
 *   - get_monitoring_status and get_changes compare the overall only when the
 *     same engines answered both snapshots. mapEngines used to keep the four,
 *     so a member's first six-engine paid week beside a four-engine one read
 *     as movement: the guard was handed the four and saw the same set.
 *   - a recommendation-gap entry for either engine is kept under its key.
 */
import { describe, it, expect } from "vitest";
import { toAiVisibility, computeChanges, toRecommendationGap } from "../../src/api/mappers.js";
import { mapEngines } from "../../src/tools/getMonitoringStatus.js";
import { reachableReport } from "../fixtures/reports.js";

const KEYED = {
  "Google AI Overviews": { score: 50, total: 4, asked: 8, appearances: 2, results: [] },
  "Microsoft Copilot": { score: 75, total: 8, asked: 8, appearances: 6, results: [] },
};

function paid() {
  const r = reachableReport();
  r.ai_visibility = {
    ...r.ai_visibility,
    platform_scores: { ...(r.ai_visibility?.platform_scores ?? {}), ...KEYED },
  } as typeof r.ai_visibility;
  return r;
}

describe("get_ai_visibility reads the keyed engines", () => {
  it("scores both on a paid report, after the four", () => {
    const v = toAiVisibility(paid());
    expect(Object.keys(v.by_engine)).toEqual(
      ["chatgpt", "perplexity", "claude", "gemini", "google_ai_overviews", "copilot"]);
    expect(v.by_engine.google_ai_overviews).toBe(50);
    expect(v.by_engine.copilot).toBe(75);
    expect(v.engine_status.copilot).toBe("scored");
    expect(v.appears_by_engine.copilot).toBe(true);
  });

  it("calls a free report's two not_asked, and its summary is unchanged", () => {
    const free = reachableReport();
    const v = toAiVisibility(free);
    expect(v.by_engine.google_ai_overviews).toBeNull();
    expect(v.engine_status.google_ai_overviews).toBe("not_asked");
    expect(v.appears_by_engine.copilot).toBeNull();
    expect(v.summary).not.toMatch(/Copilot|AI Overviews/);
  });
});

describe("a six-engine overall is never compared with a four-engine one", () => {
  it("mapEngines keeps the keyed two, and the overall is refused", () => {
    const before = mapEngines({ chatgpt: 25, perplexity: 25, claude: 25, gemini: 25 });
    const after = mapEngines({ chatgpt: 25, perplexity: 25, claude: 25, gemini: 25,
                               google_ai_overviews: 50, copilot: 75 });
    expect(after.copilot).toBe(75);
    expect(before.copilot).toBeNull();
    const changes = computeChanges({ score: 45, by_engine: after }, { score: 25, by_engine: before });
    expect(changes.score_delta).toBeNull();
    expect(changes.overall_note).toMatch(/Microsoft Copilot/);
  });
});

describe("the recommendation gap keeps the keyed engines' entries", () => {
  it("under their keys", () => {
    const r = paid();
    const av = { ...r.ai_visibility!, recommendation_gap: {
      state: "behind", gap_points: 25,
      rival: { name: "Northside Bread Co.", recommended: 3 }, client: { recommended: 1 },
      sample: { answers: 16 },
      engines: [
        { engine: "Microsoft Copilot", answers: 8, client: 1, rival: 3, gap_points: 25, state: "behind" },
        { engine: "Bard", answers: 8, client: 1, rival: 3, gap_points: 25, state: "behind" },
      ],
    } } as typeof r.ai_visibility;
    const gap = toRecommendationGap(av!);
    expect(gap?.per_engine.map((e) => e.engine)).toEqual(["copilot"]);
  });
});
