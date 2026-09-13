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
  breaksTheSeries,
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

  it("re-baselines on a weekly re-audit, or where there is no weekly series, and not on an audit beside one", () => {
    expect(breaksTheSeries({ source: "scheduled" }, [{ source: "scheduled" }])).toBe(true);
    expect(breaksTheSeries({ source: "extension" }, [{ source: "scheduled" }, { source: null }])).toBe(false);
    expect(breaksTheSeries({ source: null }, [{ source: null }, { source: "extension" }])).toBe(true);
    expect(breaksTheSeries({}, [])).toBe(true);
  });
});
