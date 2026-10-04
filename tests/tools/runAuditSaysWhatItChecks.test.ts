import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVED_TOOLS } from "../../src/tools/registry.js";

/**
 * run_audit's description names what the audit measures, and nothing it doesn't.
 *
 * It said "AI visibility plus SEO". There is no SEO module upstream: the
 * `scores.seo` field is seoProxyScore() in src/api/mappers.ts — the share of
 * seven crawlability and markup signals the AI-visibility scan reads
 * (robots.txt present and not blocking everything, no AI crawler blocked,
 * sitemap, structured data, meta description, Open Graph). website-auditor.io
 * stopped claiming checks it does not run on 2026-10-02 (chaos#601); this is
 * the same correction for the tool an assistant reads, on both surfaces it
 * reads it from — the runtime registry and manifest.json (the .mcpb bundle and
 * directory listing). The field keeps its name: renaming it would break every
 * client already reading `scores.seo`.
 */
const root = join(__dirname, "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

const runtime = (SERVED_TOOLS as Array<{ name: string; description: string }>)
  .find((t) => t.name === "run_audit")!.description;
const listed = (manifest.tools as Array<{ name: string; description: string }>)
  .find((t) => t.name === "run_audit")!.description;

const SURFACES: Array<[string, string]> = [["runtime", runtime], ["manifest.json", listed]];

// Each field seoProxyScore() reads, and the phrase the descriptions name it by.
const FIELD_PHRASE: Record<string, string> = {
  robots_txt_present: "robots.txt",
  robots_txt_blocks_all: "robots.txt",
  ai_bots_blocked: "AI crawler",
  sitemap_present: "sitemap",
  has_structured_data: "structured data",
  has_meta_description: "meta description",
  has_open_graph: "Open Graph",
};
const SIGNALS = [...new Set(Object.values(FIELD_PHRASE))];

describe("run_audit says what it checks", () => {
  it.each(SURFACES)("%s: no SEO audit is claimed", (_where, text) => {
    // `scores.seo` may be named as the field; "SEO" as a capability may not.
    expect(text.replace(/`?scores\.seo`?/g, "")).not.toMatch(/\bSEO\b/i);
  });

  it.each(SURFACES)("%s: names the signals behind scores.seo", (_where, text) => {
    for (const signal of SIGNALS) expect(text, signal).toContain(signal);
    expect(text).toContain("scores.seo");
  });

  it.each(SURFACES)("%s: still names the other categories", (_where, text) => {
    for (const part of ["AI visibility", "security headers", "broken links", "performance"]) {
      expect(text, part).toContain(part);
    }
  });

  it("the signals named are the ones the score counts, no more and no fewer", () => {
    // Two-way: every field seoProxyScore() reads maps to a phrase both
    // descriptions carry, and every mapped field is still read. A ninth check
    // added to the score without a phrase fails here (review round 1: a
    // one-way subset check let an added signal through).
    const src = readFileSync(join(root, "src", "api", "mappers.ts"), "utf8");
    const fn = src.slice(src.indexOf("function seoProxyScore"), src.indexOf("export function toAuditSummary"));
    const body = fn.slice(fn.indexOf("const checks"));
    const read = new Set([...body.matchAll(/\bs\.(\w+)/g)].map((m) => m[1]));
    expect([...read].sort()).toEqual(Object.keys(FIELD_PHRASE).sort());
    // One array element per field read (review round 4): a check that reads
    // its field through a helper adds an element but no `s.` read, and the
    // scan above would not see it.
    const elements = body.slice(body.indexOf("[") + 1, body.indexOf("];")).split("\n")
      .filter((line) => line.trim().endsWith(","));
    expect(elements.length).toBe(Object.keys(FIELD_PHRASE).length);
  });

  it.each(SURFACES)("%s: the scores.seo list names nothing the score does not count", (_where, text) => {
    // The text side, two-way (review round 4): containment alone let an
    // added "page titles" or "canonical tags" through. Every item in the
    // parenthetical maps to exactly one counted signal, and every signal
    // is an item.
    const list = text.match(/scores\.seo`?:\s*([^)]*)\)/)?.[1];
    expect(list, "the scores.seo parenthetical").toBeDefined();
    const items = list!.split(/,\s*|\s+and\s+/).map((i) => i.trim()).filter(Boolean);
    const matched = items.map((item) => SIGNALS.filter((signal) => item.includes(signal)));
    items.forEach((item, i) => expect(matched[i], item).toHaveLength(1));
    expect(matched.flat().sort()).toEqual([...SIGNALS].sort());
  });
});
