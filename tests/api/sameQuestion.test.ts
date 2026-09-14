import { describe, it, expect } from "vitest";
import {
  sameQuestion,
  newestSameQuestion,
  oldestSameQuestion,
  toQuestion,
  questionDifference,
  notCompared,
  notComparedPhrase,
  newestRecorded,
  newestComparablePair,
  movement,
  day,
  seriesOf,
  measuredTheBusiness,
  laterNote,
  SERIES_ANCHOR_REACH_MS,
} from "../../src/api/mappers.js";
import type { SnapshotQuestion } from "../../src/api/types.js";

/**
 * A difference between two scores is a change only when both answered the same
 * question. The API decides sameness (`question.key`, website-auditor-api
 * snapshotQuestion.js); these pin that this client never subtracts across keys
 * that differ or are missing, and that it says in words what changed.
 */

const question = (over: Partial<SnapshotQuestion> = {}): SnapshotQuestion => ({
  key: "q-austin",
  business_name: "Main Lock Shop",
  name_source: "detected",
  business_location: "Austin, TX",
  market_scope: "local",
  queries: ["best locksmith in Austin, TX"],
  ...over,
});
const snapshot = (id: string, q: SnapshotQuestion | null) => ({ id, question: q });

describe("sameQuestion: the key decides, and missing is never the same", () => {
  it("matches equal keys, whatever the explanatory fields say", () => {
    expect(sameQuestion({ question: question() }, { question: question({ name_source: "user_supplied" }) })).toBe(true);
  });

  it("refuses different keys", () => {
    expect(sameQuestion({ question: question() }, { question: question({ key: "q-global" }) })).toBe(false);
  });

  it("refuses a missing key on either side, and on both", () => {
    expect(sameQuestion({ question: question() }, { question: null })).toBe(false);
    expect(sameQuestion({ question: null }, { question: null })).toBe(false);
    expect(sameQuestion({}, {})).toBe(false);
    expect(sameQuestion(null, undefined)).toBe(false);
    expect(sameQuestion({ question: question({ key: null }) }, { question: question({ key: null }) })).toBe(false);
    expect(sameQuestion({ question: question({ key: "" }) }, { question: question({ key: "" }) })).toBe(false);
  });
});

describe("the base: the newest, or for a window the oldest, that asked the same question", () => {
  const asked = question();
  const elsewhere = question({ key: "q-global", business_location: "", queries: ["best locksmith"] });
  const series = [
    snapshot("week-1", asked),
    snapshot("week-2", asked),
    snapshot("by-hand-elsewhere", elsewhere),
    snapshot("before-034", null),
  ];

  it("newest passes over the snapshots after it that asked something else", () => {
    const { base, skipped } = newestSameQuestion(series, snapshot("now", asked));
    expect(base?.id).toBe("week-2");
    expect(skipped).toBe(2);
  });

  it("oldest counts every snapshot in the window that asked something else", () => {
    const { base, skipped } = oldestSameQuestion([snapshot("older-unrecorded", null), ...series], snapshot("now", asked));
    expect(base?.id).toBe("week-1");
    expect(skipped).toBe(3);
  });

  it("no base when nothing earlier asked it, or when the current snapshot recorded nothing", () => {
    expect(newestSameQuestion([snapshot("by-hand-elsewhere", elsewhere)], snapshot("now", asked)))
      .toEqual({ base: null, skipped: 0 });
    expect(oldestSameQuestion([snapshot("by-hand-elsewhere", elsewhere)], snapshot("now", asked)))
      .toEqual({ base: null, skipped: 0 });
    expect(newestSameQuestion(series, snapshot("now", null)).base).toBeNull();
    expect(oldestSameQuestion(series, snapshot("now", null)).base).toBeNull();
  });
});

describe("toQuestion reads the wire defensively", () => {
  it("keeps what is well formed", () => {
    expect(toQuestion(question())).toEqual(question());
  });

  it("reads anything malformed as absent, never as a guess", () => {
    const unrecorded = {
      key: null, business_name: null, name_source: null, business_location: null, market_scope: null, queries: null,
    };
    expect(toQuestion(null)).toBeNull();
    expect(toQuestion(undefined)).toBeNull();
    expect(toQuestion("q-austin")).toBeNull();
    expect(toQuestion([question()])).toBeNull();
    expect(toQuestion({ key: 7, business_name: 3, queries: ["best locksmith", 4] })).toEqual(unrecorded);
    expect(toQuestion(question({ key: "" }))!.key).toBeNull();
  });
});

describe("questionDifference says what changed, and only that", () => {
  it("names a different business name", () => {
    expect(questionDifference(question(), question({ business_name: "Mainlock" })))
      .toBe('the business name "Main Lock Shop" rather than "Mainlock"');
  });

  it("names a different market, and an empty side plainly", () => {
    expect(questionDifference(question({ business_location: "" }), question()))
      .toBe('no market rather than "Austin, TX"');
    expect(questionDifference(question({ business_location: "Honolulu, HI" }), question({ business_location: "" })))
      .toBe('the market "Honolulu, HI" rather than none');
  });

  it("names both when both differ", () => {
    expect(questionDifference(
      question({ business_name: "Shoes.com Inc", business_location: "" }),
      question({ business_name: "Shoes" }),
    )).toBe('the business name "Shoes.com Inc" rather than "Shoes" and no market rather than "Austin, TX"');
  });

  it("falls back to the queries when neither the name nor the market differs", () => {
    expect(questionDifference(question({ queries: ["best hardware store in Austin, TX"] }), question()))
      .toMatch(/^different queries/);
  });

  it("does not call the same name in another case, or the same market re-spaced, a new one", () => {
    expect(questionDifference(
      question({ business_name: "  MAIN LOCK SHOP", business_location: "austin,  tx", queries: ["x"] }),
      question(),
    )).toMatch(/^different queries/);
  });

  it("does call a name spaced or punctuated differently a new one, as the API's key does", () => {
    // The engine looks for the lowercased name as written, so "Main Lock-Shop" is
    // credited with different answers than "Main Lock Shop".
    expect(questionDifference(question({ business_name: "Main Lock-Shop" }), question()))
      .toBe('the business name "Main Lock-Shop" rather than "Main Lock Shop"');
  });
});

describe("what was passed over, and why", () => {
  const asked = question();
  const elsewhere = question({ key: "q-global", business_location: "", queries: ["best locksmith"] });

  it("counts a different question apart from a question nobody recorded", () => {
    // The second is most snapshots for weeks after the API began recording, and
    // calling it "a different question" says something nobody knows.
    expect(notCompared(
      [
        snapshot("same", asked),
        snapshot("elsewhere", elsewhere),
        snapshot("before-034", null),
        snapshot("a-name-without-queries", question({ key: null, queries: [] })),
      ],
      snapshot("now", asked),
    )).toEqual({ different: 1, unrecorded: 2 });
  });

  it("says each reason with its own count, and leaves out a reason with none", () => {
    expect(notComparedPhrase({ different: 1, unrecorded: 2 }))
      .toBe("1 snapshot that asked a different question and 2 snapshots that do not record what they asked");
    expect(notComparedPhrase({ different: 2, unrecorded: 0 })).toBe("2 snapshots that asked a different question");
    expect(notComparedPhrase({ different: 0, unrecorded: 1 })).toBe("1 snapshot that does not record what it asked");
  });
});

describe("what a refusal can still say", () => {
  const asked = question();
  const elsewhere = question({ key: "q-global", business_location: "", queries: ["best locksmith"] });

  it("explains a re-baseline with the newest snapshot that recorded its question", () => {
    expect(newestRecorded([snapshot("asked", asked), snapshot("elsewhere", elsewhere), snapshot("before-034", null)])?.id)
      .toBe("elsewhere");
    expect(newestRecorded([snapshot("before-034", null)])).toBeNull();
  });

  it("finds the most recent like-for-like pair, passing over what sits between", () => {
    const pair = newestComparablePair([
      snapshot("week-1", asked), snapshot("by-hand", elsewhere), snapshot("week-2", asked), snapshot("before-034", null),
    ]);
    expect([pair?.from.id, pair?.to.id]).toEqual(["week-1", "week-2"]);

    const newer = newestComparablePair([
      snapshot("week-1", asked), snapshot("week-2", asked), snapshot("by-hand-1", elsewhere), snapshot("by-hand-2", elsewhere),
    ]);
    expect([newer?.from.id, newer?.to.id]).toEqual(["by-hand-1", "by-hand-2"]);

    expect(newestComparablePair([snapshot("week-1", asked), snapshot("by-hand", elsewhere)])).toBeNull();
    expect(newestComparablePair([snapshot("a", null), snapshot("b", null)])).toBeNull();
  });

  it("reads a movement and a date plainly, whatever arrives", () => {
    expect(movement(5)).toBe("up 5");
    expect(movement(-3)).toBe("down 3");
    expect(movement(0)).toBe("unchanged");
    expect(day("2026-09-08T09:00:00Z")).toBe("2026-09-08");
    expect(day(undefined)).toBe("an unknown date");
    expect(day(20260908)).toBe("an unknown date");
    expect(day("2026")).toBe("an unknown date");
  });

  it("finds the newest like-for-like pair among several that asked the same question", () => {
    const pair = newestComparablePair([snapshot("week-1", asked), snapshot("week-2", asked), snapshot("week-3", asked)]);
    expect([pair?.from.id, pair?.to.id]).toEqual(["week-2", "week-3"]);
  });
});

describe("the series: the weekly re-audits, and whatever asked their question", () => {
  const asked = question();
  const elsewhere = question({ key: "q-global", business_location: "", queries: ["best locksmith"] });
  const row = (id: string, source: string | null, q: SnapshotQuestion | null) => ({ id, source, question: q });
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

  it("is every snapshot until one is a weekly re-audit", () => {
    expect(ids(seriesOf([row("by-hand", null, asked), row("scan", "extension", elsewhere)]))).toEqual(["by-hand", "scan"]);
  });

  it("then keeps the weekly re-audits and what asked the newest one's question, whoever wrote it", () => {
    expect(ids(seriesOf([
      row("by-hand-asked", null, asked),
      row("week-1", "scheduled", elsewhere),
      row("by-hand-elsewhere", null, elsewhere),
      row("week-2", "scheduled", asked),
      row("scan-asked", "extension", asked),
      row("by-hand-elsewhere-later", null, elsewhere),
    ]))).toEqual(["by-hand-asked", "week-1", "week-2", "scan-asked"]);
  });

  it("is anchored on the newest weekly re-audit that recorded its question", () => {
    // One that recorded nothing matches nothing, so it cannot be the anchor.
    expect(ids(seriesOf([
      row("week-1", "scheduled", asked), row("week-2", "scheduled", null),
      row("by-hand", null, asked), row("by-hand-elsewhere", null, elsewhere),
    ]))).toEqual(["week-1", "week-2", "by-hand"]);
    // And until one has, the series is every snapshot.
    expect(ids(seriesOf([row("week-1", "scheduled", null), row("by-hand", null, elsewhere)])))
      .toEqual(["week-1", "by-hand"]);
  });

  it("lets a weekly re-audit anchor the series only while it is current", () => {
    const dated = (id: string, source: string | null, q: SnapshotQuestion | null, captured_at: string) =>
      ({ ...row(id, source, q), captured_at });
    const stale = [
      dated("week-1", "scheduled", asked, "2026-02-01T09:00:00Z"),
      dated("by-hand-1", null, elsewhere, "2026-09-01T12:00:00Z"),
      dated("by-hand-2", null, elsewhere, "2026-09-10T12:00:00Z"),
    ];
    expect(ids(seriesOf(stale))).toEqual(["week-1", "by-hand-1", "by-hand-2"]);
    // Within four weeks and a day of the newest snapshot, it still anchors the series.
    const current = [{ ...stale[0]!, captured_at: "2026-08-13T09:00:00Z" }, stale[1]!, stale[2]!];
    expect(ids(seriesOf(current))).toEqual(["week-1"]);
    // Kept while audits of the weekly question follow it within the reach.
    const measuredSince = [
      dated("week-1", "scheduled", asked, "2026-07-25T09:00:00Z"),
      dated("by-hand-asked", null, asked, "2026-08-22T12:00:00Z"),
      dated("by-hand-elsewhere", null, elsewhere, "2026-09-01T12:00:00Z"),
    ];
    expect(ids(seriesOf(measuredSince))).toEqual(["week-1", "by-hand-asked"]);
    // Broken by a longer step between them, and not brought back by an audit of it a year later.
    const broken = [measuredSince[0]!, { ...measuredSince[1]!, captured_at: "2026-08-29T12:00:00Z" }, measuredSince[2]!];
    expect(ids(seriesOf(broken))).toEqual(["week-1", "by-hand-asked", "by-hand-elsewhere"]);
    const yearLater = [
      dated("week-1", "scheduled", asked, "2025-09-01T09:00:00Z"),
      dated("by-hand-asked", null, asked, "2026-09-03T12:00:00Z"),
      dated("by-hand-elsewhere", null, elsewhere, "2026-09-08T12:00:00Z"),
    ];
    expect(ids(seriesOf(yearLater))).toEqual(["week-1", "by-hand-asked", "by-hand-elsewhere"]);
  });

  it("stops anchoring the series four weeks and a day after its newest snapshot, to the millisecond", () => {
    const last = Date.parse("2026-08-08T09:00:00.000Z");
    const at = (gap: number) => [
      { ...row("week-1", "scheduled", asked), captured_at: new Date(last).toISOString() },
      { ...row("by-hand", null, elsewhere), captured_at: new Date(last + gap).toISOString() },
    ];
    expect(SERIES_ANCHOR_REACH_MS).toBe(29 * 24 * 60 * 60 * 1000);
    expect(ids(seriesOf(at(SERIES_ANCHOR_REACH_MS)))).toEqual(["week-1"]);
    expect(ids(seriesOf(at(SERIES_ANCHOR_REACH_MS + 1)))).toEqual(["week-1", "by-hand"]);
    // And between two measurements of the question.
    const step = (gap: number) => [
      { ...row("week-1", "scheduled", asked), captured_at: new Date(last).toISOString() },
      { ...row("by-hand-asked", null, asked), captured_at: new Date(last + gap).toISOString() },
      { ...row("by-hand", null, elsewhere), captured_at: new Date(last + gap + 60_000).toISOString() },
    ];
    expect(ids(seriesOf(step(SERIES_ANCHOR_REACH_MS)))).toEqual(["week-1", "by-hand-asked"]);
    expect(ids(seriesOf(step(SERIES_ANCHOR_REACH_MS + 1)))).toEqual(["week-1", "by-hand-asked", "by-hand"]);
  });

  it("starts again at weekly re-audits that resume after a break", () => {
    const dated = (id: string, source: string | null, q: SnapshotQuestion | null, captured_at: string) =>
      ({ ...row(id, source, q), captured_at });
    expect(ids(seriesOf([
      dated("week-old", "scheduled", asked, "2025-09-01T09:00:00Z"),
      dated("week-1", "scheduled", asked, "2026-09-01T09:00:00Z"),
      dated("week-2", "scheduled", asked, "2026-09-08T09:00:00Z"),
      dated("by-hand-elsewhere", null, elsewhere, "2026-09-10T12:00:00Z"),
    ]))).toEqual(["week-old", "week-1", "week-2"]);
  });

  it("counts weekly re-audits that recorded no question as steps of the series", () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    const start = Date.parse("2026-06-01T09:00:00.000Z");
    const weeks = Array.from({ length: 15 }, (_, i) =>
      ({ ...row(`week-${i}`, "scheduled", i === 0 ? asked : null), captured_at: new Date(start + i * week).toISOString() }));
    const later = { ...row("by-hand-elsewhere", null, elsewhere), captured_at: new Date(start + 14 * week + 3 * 24 * 60 * 60 * 1000).toISOString() };
    expect(ids(seriesOf([...weeks, later]))).toEqual(weeks.map((w) => w.id));
  });

  it("breaks at any step, and snapshots outside the series bridge no gap", () => {
    const dated = (id: string, source: string | null, q: SnapshotQuestion | null, captured_at: string) =>
      ({ ...row(id, source, q), captured_at });
    // A six-week gap between two audits of the weekly question, each close to its neighbours.
    const middle = [
      dated("week-1", "scheduled", asked, "2026-06-01T09:00:00Z"),
      dated("by-hand-1", null, asked, "2026-06-08T12:00:00Z"),
      dated("by-hand-2", null, asked, "2026-07-20T12:00:00Z"),
      dated("by-hand-3", null, asked, "2026-07-27T12:00:00Z"),
      dated("by-hand-elsewhere", null, elsewhere, "2026-07-28T12:00:00Z"),
    ];
    expect(ids(seriesOf(middle))).toEqual(ids(middle));
    // Audits of another market every two weeks since the weekly re-audits stopped.
    const bridged = [
      dated("week-1", "scheduled", asked, "2026-05-04T09:00:00Z"),
      dated("week-2", "scheduled", asked, "2026-05-11T09:00:00Z"),
      ...["2026-05-25", "2026-06-08", "2026-06-22", "2026-07-06", "2026-07-20"].map((d) =>
        dated(`elsewhere-${d}`, null, elsewhere, `${d}T12:00:00Z`)),
    ];
    expect(ids(seriesOf(bridged))).toEqual(ids(bridged));
  });

  it("starts the steps at the anchoring re-audit, whatever came before it", () => {
    const dated = (id: string, source: string | null, q: SnapshotQuestion | null, captured_at: string) =>
      ({ ...row(id, source, q), captured_at });
    // Audited elsewhere before it was tracked, re-audited weekly, then paused.
    const history = [
      dated("by-hand-before", null, elsewhere, "2026-07-20T12:00:00Z"),
      dated("week-1", "scheduled", asked, "2026-07-25T09:00:00Z"),
      dated("week-2", "scheduled", asked, "2026-08-01T09:00:00Z"),
      dated("by-hand-elsewhere-1", null, elsewhere, "2026-08-20T12:00:00Z"),
      dated("by-hand-elsewhere-2", null, elsewhere, "2026-09-10T12:00:00Z"),
    ];
    expect(ids(seriesOf(history))).toEqual(ids(history));
  });

  it("opens no gap with time alone", () => {
    const dated = (id: string, source: string | null, q: SnapshotQuestion | null, captured_at: string) =>
      ({ ...row(id, source, q), captured_at });
    // Years old, with nothing newer: the weekly question still anchors the series.
    expect(ids(seriesOf([
      dated("week-1", "scheduled", asked, "2020-03-01T09:00:00Z"),
      dated("by-hand-elsewhere", null, elsewhere, "2020-03-10T12:00:00Z"),
    ]))).toEqual(["week-1"]);
  });

  it("does not count a weekly re-audit that measured nothing of the business", () => {
    expect(measuredTheBusiness({ source: "scheduled_unmeasured" })).toBe(false);
    expect(measuredTheBusiness({ source: "scheduled" })).toBe(true);
    expect(measuredTheBusiness({ source: null })).toBe(true);
    expect(measuredTheBusiness({})).toBe(true);
  });

  it("names what it leaves out after the latest, and says nothing when nothing is left out", () => {
    const latest = { captured_at: "2026-09-08T09:00:00Z", score: 50, question: asked };
    expect(laterNote([], latest)).toBe("");
    expect(laterNote([
      { captured_at: "2026-09-09T09:00:00Z", score: 40, question: null },
      { captured_at: "2026-09-10T09:00:00Z", score: 60, question: elsewhere },
    ], latest)).toBe(
      " Left out as not part of the weekly series: 1 snapshot that asked a different question and 1 snapshot that "
      + "does not record what it asked, newer than 2026-09-08. The newest of them that records its question, on "
      + '2026-09-10, asked about no market rather than "Austin, TX".');

    // Beside a latest that recorded nothing, nothing is said about what they asked.
    expect(laterNote([
      { captured_at: "2026-09-09T09:00:00Z", score: 40, question: elsewhere },
      { captured_at: "2026-09-10T09:00:00Z", score: 60, question: asked },
    ], { captured_at: "2026-09-08T09:00:00Z", score: 50, question: null as SnapshotQuestion | null })).toBe(
      " Left out as not part of the weekly series: 2 newer snapshots, the newest on 2026-09-10.");
  });

  it("names the most recent like-for-like change among what it leaves out", () => {
    const latest = { captured_at: "2026-09-08T09:00:00Z", score: 50, question: asked as SnapshotQuestion | null };
    const later = [
      { captured_at: "2026-09-09T09:00:00Z", score: 20, question: elsewhere },
      { captured_at: "2026-09-10T09:00:00Z", score: 35, question: null },
      { captured_at: "2026-09-11T09:00:00Z", score: 90, question: elsewhere },
    ];
    expect(laterNote(later, latest)).toBe(
      " Left out as not part of the weekly series: 2 snapshots that asked a different question and 1 snapshot that "
      + "does not record what it asked, newer than 2026-09-08. The newest of them that records its question, on "
      + '2026-09-11, asked about no market rather than "Austin, TX". The most recent like-for-like change among '
      + "them was up 70, from 2026-09-09 to 2026-09-11.");
    // And beside a latest that recorded nothing.
    expect(laterNote(later, { ...latest, question: null })).toBe(
      " Left out as not part of the weekly series: 3 newer snapshots, the newest on 2026-09-11. The most recent "
      + "like-for-like change among them was up 70, from 2026-09-09 to 2026-09-11.");
  });
});
