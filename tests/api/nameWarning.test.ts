/**
 * An unverified business name reaches the model, in words.
 *
 * WHY. The browser flow confirms the detected name with a human before
 * auditing. This server has no such step: whatever the engine identified is
 * used to build the AI-visibility query set and scored, and the caller is a
 * model that will read the result aloud as fact. A wrong name does not lower
 * the score — it makes the score describe a different business.
 *
 * chaos_tester #334 added the provenance to the payload
 * (`ai_visibility.identification.name_warning`, plus `name_source` and
 * `name_verified`). Availability is not delivery: a structured field the model
 * never reads changes nothing, which is why the caveat is folded into the
 * `summary` sentence as well — the same treatment `is_simulated` already gets,
 * for the same reason.
 *
 * Two shapes arrive unverified, both from real production data:
 *   - domain_fallback: identification found nothing and the name was
 *     manufactured from the hostname slug ("Hawaiibackroad").
 *   - a single uncorroborated witness: confidence "high" off one source, which
 *     is how the LLM's "Castillo" was adopted for canlis.com.
 *
 * Back-compat is load-bearing: chaos_tester ships these fields, but a report
 * produced BEFORE that deploy (or replayed from cache) has no `identification`
 * block at all. Absent must mean "no warning", never a crash and never a
 * fabricated caveat.
 */
import { describe, it, expect } from "vitest";
import { toAiVisibility, toAuditSummary } from "../../src/api/mappers.js";
import { reachableReport } from "../fixtures/reports.js";

function reportWith(identification: unknown) {
  const base = reachableReport();
  return {
    ...base,
    ai_visibility: {
      ...(base.ai_visibility ?? {}),
      business_info: { business_name: "Castillo" },
      identification,
    },
  } as never;
}

const UNVERIFIED_ONE_SOURCE = {
  confidence: "high",
  identification_sources: ["llm"],
  name_source: "detected",
  name_verified: false,
  name_warning:
    "The business name was identified from one source with nothing corroborating it. " +
    "If it is wrong, the AI-visibility results describe a different business — pass business_name to correct it.",
};

const DOMAIN_FALLBACK = {
  confidence: "",
  identification_sources: [],
  name_source: "domain_fallback",
  name_verified: false,
  name_warning:
    "The business name was derived from the domain, not found on the site. " +
    "AI-visibility results describe whatever business that name refers to, which may not be this one — " +
    "pass business_name to correct it.",
};

const VERIFIED = {
  confidence: "high",
  identification_sources: ["google_places_verified", "page_text"],
  name_source: "detected",
  name_verified: true,
  name_warning: "",
};

// ── The warning reaches the structured payload ──────────────────────

describe("get_ai_visibility surfaces name provenance", () => {
  it("carries the warning verbatim from the engine", () => {
    const av = toAiVisibility(reportWith(UNVERIFIED_ONE_SOURCE));
    expect(av.name_warning).toBe(UNVERIFIED_ONE_SOURCE.name_warning);
    expect(av.name_verified).toBe(false);
  });

  it("reports the provenance so a caller can branch on it", () => {
    expect(toAiVisibility(reportWith(DOMAIN_FALLBACK)).name_source).toBe("domain_fallback");
    expect(toAiVisibility(reportWith(UNVERIFIED_ONE_SOURCE)).name_source).toBe("detected");
  });

  it("a verified name carries no warning and says so", () => {
    const av = toAiVisibility(reportWith(VERIFIED));
    expect(av.name_verified).toBe(true);
    expect(av.name_warning).toBeUndefined();
  });
});

// ── …and the summary sentence, which is what the model reads ────────

describe("the summary sentence carries the caveat", () => {
  it("an unverified name is flagged in the prose, not only in a field", () => {
    const av = toAiVisibility(reportWith(UNVERIFIED_ONE_SOURCE));
    expect(av.summary).toContain("Castillo");
    expect(av.summary.toLowerCase()).toContain("business name");
    // The actionable remedy must survive into the sentence.
    expect(av.summary).toContain("business_name");
  });

  it("the domain-fallback case says the name was not found on the site", () => {
    const av = toAiVisibility(reportWith(DOMAIN_FALLBACK));
    expect(av.summary.toLowerCase()).toContain("domain");
  });

  it("a verified name leaves the summary exactly as it was", () => {
    const verified = toAiVisibility(reportWith(VERIFIED));
    const noBlock = toAiVisibility(reportWith(undefined));
    expect(verified.summary).toBe(noBlock.summary);
  });

  it("the caveat does not displace the score the summary exists to report", () => {
    const av = toAiVisibility(reportWith(UNVERIFIED_ONE_SOURCE));
    expect(av.summary).toMatch(/\/100/);
  });
});

// ── run_audit gets it too — it is the tool most agents call first ───

describe("run_audit surfaces the same caveat", () => {
  it("an unverified name is reported alongside the scores", () => {
    const s = toAuditSummary(reportWith(UNVERIFIED_ONE_SOURCE), { siteUrl: "https://x.test" });
    expect(s.name_warning).toBe(UNVERIFIED_ONE_SOURCE.name_warning);
  });

  it("a verified name adds nothing to the summary payload", () => {
    const s = toAuditSummary(reportWith(VERIFIED), { siteUrl: "https://x.test" });
    expect(s.name_warning).toBeUndefined();
  });
});

// ── Back-compat: pre-#334 reports have no identification block ──────

describe("reports without an identification block", () => {
  it("do not crash and do not invent a warning", () => {
    const av = toAiVisibility(reportWith(undefined));
    expect(av.name_warning).toBeUndefined();
    expect(av.name_verified).toBeUndefined();
    expect(av.score).toBeTypeOf("number");
  });

  it("survive a malformed block without throwing", () => {
    for (const junk of [null, "nope", 42, [], { name_warning: 7 }]) {
      const av = toAiVisibility(reportWith(junk));
      expect(av.summary).toBeTypeOf("string");
      expect(av.name_warning).toBeUndefined();
    }
  });

  it("leave run_audit unchanged", () => {
    const s = toAuditSummary(reportWith(undefined), { siteUrl: "https://x.test" });
    expect(s.name_warning).toBeUndefined();
    expect(s.report_url).toContain("/report/");
  });
});
