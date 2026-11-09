import { describe, it, expect } from "vitest";
import { getAiVisibility } from "../../src/tools/getAiVisibility.js";
import { toAiVisibility } from "../../src/api/mappers.js";
import { makeDeps, makeClient } from "../helpers.js";
import { reachableReport } from "../fixtures/reports.js";
import type { AuditReport } from "../../src/api/types.js";

// Neighborhood-level results: the engine adds
// ai_visibility.places beside the citywide score; get_ai_visibility returns
// them per place, with a plain sentence for each, so Claude and ChatGPT users
// see them too.
function withPlaces(places: unknown): AuditReport {
  const report = reachableReport();
  return { ...report, ai_visibility: { ...report.ai_visibility, places } as never };
}

const BLOCK = {
  method: "places-v1",
  places: [
    { place_key: "pl_a", label: "Highland", state: "behind", named: 2, sample: 12, gap: -5,
      top_rival: "Pop-A-Lock Denver", measured_at: "2026-11-09",
      sentence: "Highland: named in 2 of 12 answers; behind Pop-A-Lock Denver (7 of 12)." },
    { place_key: "pl_b", label: "Baker", state: "not_measured", named: null, sample: 0, gap: null,
      sentence: "Baker: not measured yet." },
    { place_key: "pl_c", label: "LoDo", state: "level", named: 4, sample: 12, gap: 0, top_rival: "Rival",
      sentence: "LoDo: named in 4 of 12 answers; level with Rival (4 of 12)." },
  ],
};

describe("get_ai_visibility places", () => {
  it("returns each place with its own sample and sentence", () => {
    const out = toAiVisibility(withPlaces(BLOCK));
    expect(out.places?.map((p) => p.label)).toEqual(["Highland", "Baker", "LoDo"]);
    expect(out.places?.[0]).toMatchObject({ state: "behind", named: 2, sample: 12 });
  });

  it("a place with no answers is not measured, never 0", () => {
    const baker = toAiVisibility(withPlaces(BLOCK)).places![1];
    expect(baker.state).toBe("not_measured");
    expect(baker.named).toBeNull();
    expect(baker.sentence).toContain("not measured");
  });

  it("puts the per-place sentences in the summary, which is what the model reads", () => {
    const out = toAiVisibility(withPlaces(BLOCK));
    expect(out.summary).toContain("Highland: named in 2 of 12 answers; behind Pop-A-Lock Denver (7 of 12).");
    expect(out.summary).toContain("Baker: not measured yet.");
  });

  it("leaves the citywide score and summary untouched by the places", () => {
    const base = toAiVisibility(reachableReport());
    const out = toAiVisibility(withPlaces(BLOCK));
    expect(out.score).toBe(base.score);
    expect(out.by_engine).toEqual(base.by_engine);
    expect(out.summary.startsWith(base.summary)).toBe(true);
  });

  it("is absent when the report has no places (a report from before, or the flag off)", () => {
    const out = toAiVisibility(reachableReport());
    expect(out).not.toHaveProperty("places");
    expect(out.summary).not.toContain("Asked from each area");
  });

  it("drops malformed places rather than inventing one, and a bad block reads as absent", () => {
    const out = toAiVisibility(withPlaces({ places: [
      { place_key: "pl_ok", label: "Ok", state: "ahead", named: 5, sample: 12, sentence: "Ok: named in 5 of 12 answers; no rival was named." },
      { label: 7, state: "ahead" },
      { label: "NoState", state: "wonderful", sentence: "x" },
      { label: "Zero", state: "ahead", named: 0, sample: 0, sentence: "x" },
      null,
    ] }));
    expect(out.places?.map((p) => p.label)).toEqual(["Ok"]);
    expect(toAiVisibility(withPlaces("nonsense"))).not.toHaveProperty("places");
    expect(toAiVisibility(withPlaces({ places: [] }))).not.toHaveProperty("places");
  });

  it("a place with no usable key, or a key already used, is dropped", () => {
    const ok = (key: unknown, label: string) =>
      ({ place_key: key, label, state: "ahead", named: 5, sample: 12, gap: 5, sentence: `${label}: named in 5 of 12 answers.` });
    const out = toAiVisibility(withPlaces({ places: [
      ok("pl_a", "First"), ok("pl_a", "Same key again"), ok(undefined, "No key"), ok("", "Empty key"),
      ok({ nested: 1 }, "Object key"), ok(7, "Number key"), ok("pl_b", "Second"),
    ] }));
    expect(out.places?.map((p) => p.label)).toEqual(["First", "Second"]);
    expect(out.summary).not.toContain("Same key again");
  });

  it("keeps a place where nobody was named, and one not measured this week", () => {
    const out = toAiVisibility(withPlaces({ places: [
      { place_key: "pl_n", label: "Quiet", state: "no_rival", named: 0, sample: 12, gap: 0,
        sentence: "Quiet: named in 0 of 12 answers, and no rival was named." },
      { place_key: "pl_w", label: "Late", state: "not_measured_this_week", named: null, sample: 0, gap: null,
        sentence: "Late: not measured this week." },
    ] }));
    expect(out.places?.map((p) => [p.label, p.state, p.named])).toEqual([["Quiet", "no_rival", 0], ["Late", "not_measured_this_week", null]]);
    expect(out.summary).toContain("Late: not measured this week.");
  });

  it("a measured place with a sample of 0 is refused: that would be a 0, not a gap in the data", () => {
    const out = toAiVisibility(withPlaces({ places: [
      { label: "Zero", state: "behind", named: 0, sample: 0, sentence: "Zero: named in 0 of 0" }] }));
    expect(out).not.toHaveProperty("places");
  });

  it("shows no places for an estimated run or one where no engine answered", () => {
    const report = withPlaces(BLOCK);
    const simulated = { ...report, ai_visibility: { ...report.ai_visibility, is_simulated: true } as never };
    const out = toAiVisibility(simulated);
    expect(out).not.toHaveProperty("places");
    expect(out.summary).not.toContain("Asked from each area");

    const none = withPlaces(BLOCK);
    for (const key of ["ChatGPT", "Perplexity", "Claude", "Gemini"]) {
      const ps = none.ai_visibility.platform_scores![key] as Record<string, unknown>;
      ps.total = 0; ps.asked = 8; ps.score = 0; ps.appearances = 0; ps.results = [];
    }
    const empty = toAiVisibility(none);
    expect(empty.summary).toContain("no AI-visibility score");
    expect(empty).not.toHaveProperty("places");
    expect(empty.summary).not.toContain("Asked from each area");
  });

  it("reaches the tool result for a subscriber", async () => {
    const client = makeClient({ runAudit: async () => ({ runId: "r", report: withPlaces(BLOCK), raw: {} }) });
    const res = await getAiVisibility({ domain: "example.com" }, makeDeps({ tier: "pro", client }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.places).toHaveLength(3);
    expect(res.data.summary).toContain("LoDo: named in 4 of 12 answers");
  });
});
