import { describe, it, expect } from "vitest";
import { getAiVisibility } from "../../src/tools/getAiVisibility.js";
import { toAiVisibility } from "../../src/api/mappers.js";
import { makeDeps, makeClient } from "../helpers.js";
import { reachableReport } from "../fixtures/reports.js";
import type { AuditReport } from "../../src/api/types.js";

// Neighborhood-level results (chaos_tester Trello 306): the engine adds
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
    expect(out.summary).not.toContain("by area");
  });

  it("drops malformed places rather than inventing one, and a bad block reads as absent", () => {
    const out = toAiVisibility(withPlaces({ places: [
      { label: "Ok", state: "ahead", named: 5, sample: 12, sentence: "Ok: named in 5 of 12 answers; no rival was named." },
      { label: 7, state: "ahead" },
      { label: "NoState", state: "wonderful", sentence: "x" },
      { label: "Zero", state: "ahead", named: 0, sample: 0, sentence: "x" },
      null,
    ] }));
    expect(out.places?.map((p) => p.label)).toEqual(["Ok"]);
    expect(toAiVisibility(withPlaces("nonsense"))).not.toHaveProperty("places");
    expect(toAiVisibility(withPlaces({ places: [] }))).not.toHaveProperty("places");
  });

  it("a measured place with a sample of 0 is refused: that would be a 0, not a gap in the data", () => {
    const out = toAiVisibility(withPlaces({ places: [
      { label: "Zero", state: "behind", named: 0, sample: 0, sentence: "Zero: named in 0 of 0" }] }));
    expect(out).not.toHaveProperty("places");
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
