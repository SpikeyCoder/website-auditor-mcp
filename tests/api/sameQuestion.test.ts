import { describe, it, expect } from "vitest";
import {
  sameQuestion,
  newestSameQuestion,
  oldestSameQuestion,
  toQuestion,
  questionDifference,
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

  it("does not call a re-spelling of the same name, or the same market, a new one", () => {
    expect(questionDifference(
      question({ business_name: "MAIN LOCK-SHOP", business_location: "austin,  tx", queries: ["x"] }),
      question(),
    )).toMatch(/^different queries/);
  });
});
