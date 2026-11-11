import { describe, it, expect } from "vitest";
import { z } from "zod";
import { P0_TOOLS, P1_TOOLS, ALL_TOOL_SPECS, SERVED_TOOLS } from "../../src/tools/registry.js";
import { PLACES_RULES } from "../fixtures/placesRules.js";
import { computeChanges } from "../../src/api/mappers.js";

describe("tool registry", () => {
  it("registers exactly the four Phase-0 tools with the exact names agents bind to", () => {
    expect(P0_TOOLS.map((t) => t.name).sort()).toEqual(
      ["compare_competitors", "get_ai_visibility", "get_changes", "run_audit"].sort(),
    );
  });

  it("marks the correct gate per tool: everything is subscription-gated except check_upgrade_status", () => {
    // No free API tier since website-auditor-api PR #17 (1.0.5 retier).
    const gate = Object.fromEntries(ALL_TOOL_SPECS.map((t) => [t.name, t.tier]));
    expect(gate.get_ai_visibility).toBe("pro");
    expect(gate.run_audit).toBe("pro");
    expect(gate.get_changes).toBe("pro");
    expect(gate.compare_competitors).toBe("pro");
    expect(gate.check_upgrade_status).toBe("free");
  });

  it("get_ai_visibility describes `places`: separate from the citywide score, not-measured is not zero", () => {
    const av = P0_TOOLS.find((t) => t.name === "get_ai_visibility")!;
    for (const [rule, pattern] of PLACES_RULES) expect(av.description, rule).toMatch(pattern);
  });

  it("uses the verbatim, trigger-first descriptions from the listing doc", () => {
    const av = P0_TOOLS.find((t) => t.name === "get_ai_visibility")!;
    // The differentiator phrase must be present so we own the intent in registries.
    expect(av.description).toContain("does ChatGPT/Perplexity/Claude/Gemini/Copilot recommend");
    expect(av.description.startsWith("Check how visible a website is to AI assistants right now.")).toBe(true);

    const audit = P0_TOOLS.find((t) => t.name === "run_audit")!;
    expect(audit.description.startsWith("Run a full one-time audit of a website")).toBe(true);
  });

  it("describes get_changes by what it computes", () => {
    // computeChanges skips an engine measured on one side only, refuses the
    // overall when different engines answered the two snapshots, and fills no
    // competitor or issue list, so the description promises none of them, and
    // sends no question about competitors here: compare_competitors answers it.
    const changes = computeChanges(
      { score: 50, by_engine: { chatgpt: 60, claude: null } },
      { score: 40, by_engine: { chatgpt: 50, claude: 30 } },
    );
    expect(changes).toEqual({
      score_delta: null,
      engine_changes: [{ engine: "chatgpt", from: 50, to: 60, delta: 10 }],
      competitor_changes: [],
      new_issues: [],
      resolved_issues: [],
      overall_note:
        "The overall score is not compared: ChatGPT and Claude answered the earlier snapshot and ChatGPT the later one, "
        + "so the two scores were each computed over a different set of engines. Engines that answered both are still "
        + "compared one by one.",
    });
    const tool = P0_TOOLS.find((t) => t.name === "get_changes")!;
    expect(tool.description).toContain("the change in the overall score and the per-engine score changes, for engines measured both times");
    expect(tool.description).toContain("the overall only when the same engines answered both snapshots");
    expect(tool.description.startsWith("Report what changed in a website's AI-visibility score, only between two snapshots that asked the same question.")).toBe(true);
    const monitoring = SERVED_TOOLS.find((t) => t.name === "get_monitoring_status")!;
    expect(monitoring.description).toContain("a change carries competitor_changes, new_issues and resolved_issues, always empty");
    expect(monitoring.description).toContain("when different engines answered the two snapshots");
    expect(tool.description).toContain("competitor_changes, new_issues and resolved_issues are always empty");
    expect(tool.description).not.toMatch(/\bgained\b|\blost\b|competitors? (that )?moved|competitor (moves|changes)|(new|resolved) issues|overtake/i);
  });

  it("does not tell an agent that get_changes requires the domain to be tracked", () => {
    // The endpoint behind this tool (website-auditor-api's getAiVisibilityHistory)
    // reads the caller's own snapshots for the domain — keyed by user and domain
    // only, with no tracked-domains check — and snapshots accrue from any audit,
    // so two audits of an untracked domain already answer a change question.
    // A description that demanded tracking would either suppress that answer or
    // make an agent spend one of only five monitoring slots (track_site) to get
    // it, neither of which the API asks for.
    const tool = P0_TOOLS.find((t) => t.name === "get_changes")!;
    expect(tool.description).not.toMatch(/requires? the domain to be tracked/i);
    expect(tool.description).toContain("The domain need not be tracked");
    expect(tool.description).toContain("do not track a site just to answer a change question");
  });

  it("track_site's copy does not claim to be what get_changes reads from", () => {
    // The other half of the same correction: get_changes need not be preceded by
    // tracking, so track_site must not read as the source of the history it
    // reads. Its weekly re-audits JOIN a history audits already accrue; an agent
    // that read "establishes the history" as "creates what get_changes needs"
    // would spend one of only five monitoring slots to enable a tool that was
    // never disabled.
    const track = P1_TOOLS.find((t) => t.name === "track_site")!;
    expect(track.description).not.toMatch(/establish(es)? the history/i);
    expect(track.description).toContain("a history every audit already accrues, tracked or not");
    expect(track.description).toContain("not to make get_changes work");
  });

  it("list_tracked_sites states each plan's site limit, Agency's included, and no price", () => {
    // The limits the API enforces: Pro 3 (5 before 2026-10-18), Agency 10 included. Agency's extra
    // client sites are bought in the command center on the website; the key-authed route the
    // tools call never buys one, so the copy sends the reader there instead of promising it here.
    // No price: the hosted deployment's info style states none anywhere (upsellStyle.test.ts).
    const list = ALL_TOOL_SPECS.find((t) => t.name === "list_tracked_sites")!;
    expect(list.description).toContain("3 sites, or 5 for a subscription started before 18 October 2026");
    expect(list.description).toContain("an Agency account includes 10 client sites");
    expect(list.description).toContain("added from the Agency command center on the website, not through this tool");
    expect(list.description).not.toMatch(/\$\d/);
  });

  it("keeps the verbatim compare_competitors copy but appends quota guidance for agents", () => {
    const compare = P0_TOOLS.find((t) => t.name === "compare_competitors")!;
    // Original listing-doc opening is preserved (agents still match on it)...
    expect(
      compare.description.startsWith(
        "Compare a website's AI visibility head-to-head against named competitors.",
      ),
    ).toBe(true);
    // ...and the new quota behavior is spelled out so an agent knows what to expect.
    expect(compare.description).toMatch(/quota/i);
    expect(compare.description).toMatch(/skipped/i);
  });

  it("declares the P1 tools so they are ready to add next, but they are not in P0", () => {
    const p1Names = P1_TOOLS.map((t) => t.name).sort();
    expect(p1Names).toEqual(
      ["generate_schema", "get_benchmark", "get_recommendations", "get_report", "track_site"].sort(),
    );
    const p0Names = new Set(P0_TOOLS.map((t) => t.name));
    for (const t of P1_TOOLS) expect(p0Names.has(t.name)).toBe(false);
  });

  it("serves all 20 tools: Phase-0 + scheduled-monitoring + the four Phase-1 read tools + the five fix tools + check_upgrade_status", () => {
    expect(SERVED_TOOLS).toHaveLength(20);
    expect(SERVED_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "check_fix",
        "check_upgrade_status",
        "confirm_facts",
        "get_fix",
        "get_fix_facts",
        "get_sample_audit",
        "list_fixes",
        "compare_competitors",
        "generate_schema",
        "get_ai_visibility",
        "get_benchmark",
        "get_changes",
        "get_monitoring_status",
        "get_gtm_plan",
        "get_recommendations",
        "get_report",
        "list_tracked_sites",
        "run_audit",
        "track_site",
        "untrack_site",
      ].sort(),
    );
  });

  it("check_upgrade_status is served, free-tier, and takes no arguments", () => {
    const spec = SERVED_TOOLS.find((t) => t.name === "check_upgrade_status")!;
    expect(spec.tier).toBe("free");
    expect(Object.keys(spec.inputSchema)).toHaveLength(0);
  });

  it("the four Phase-1 read tools are served; three are Pro-gated", () => {
    const gate = Object.fromEntries(ALL_TOOL_SPECS.map((t) => [t.name, t.tier]));
    for (const name of ["get_benchmark", "generate_schema", "get_report"]) {
      expect(SERVED_TOOLS.some((t) => t.name === name)).toBe(true);
      expect(gate[name]).toBe("pro");
    }
  });

  it("the five \"Get this fix\" tools are served and Pro-gated", () => {
    const gate = Object.fromEntries(SERVED_TOOLS.map((t) => [t.name, t.tier]));
    for (const name of ["list_fixes", "get_fix_facts", "get_fix", "confirm_facts", "check_fix"]) {
      expect(gate[name], name).toBe("pro");
    }
  });

  it("get_fix is \"Get this fix\" (owner decision 2)", () => {
    const spec = SERVED_TOOLS.find((t) => t.name === "get_fix")!;
    expect(spec.title).toBe("Get this fix");
    expect(spec.description).toContain('"Get this fix"');
    expect(Object.keys(spec.inputSchema).sort()).toEqual(["domain", "kind", "platform"]);
    const schema = z.object(spec.inputSchema);
    expect(schema.safeParse({ domain: "acme.com", kind: "llms_txt" }).success).toBe(true);
    // Any kind the engine lists: the API refuses one it doesn't serve.
    expect(schema.safeParse({ domain: "acme.com", kind: "sitemap" }).success).toBe(true);
    expect(schema.safeParse({ domain: "acme.com", kind: 3 }).success).toBe(false);
  });

  it("confirm_facts tells the agent to show the owner and never confirm for them (owner decision 1)", () => {
    const spec = SERVED_TOOLS.find((t) => t.name === "confirm_facts")!;
    expect(spec.description).toMatch(/show(ing)? the owner/i);
    expect(spec.description).toMatch(/never confirm facts on the owner's behalf/i);
    expect(spec.description).toMatch(/`seen`[^.]*exactly as it was handed out/);
    // seen is required, and sent on exactly: an extra key is kept, not stripped.
    const schema = z.object(spec.inputSchema);
    const seen = { kind: "premises", facts: { city: "Hilo, HI", phone: null }, extra: 1 };
    expect(schema.safeParse({ domain: "acme.com", facts: { name: "Acme" } }).success).toBe(false);
    const parsed = schema.parse({ domain: "acme.com", facts: { name: "Acme", city: null }, seen });
    expect(parsed.seen).toEqual(seen);
  });

  it("generate_schema keeps its triggers and points at get_fix for a finished fix (owner decision 3)", () => {
    const spec = SERVED_TOOLS.find((t) => t.name === "generate_schema")!;
    for (const trigger of ['"schema,"', '"structured data,"', '"JSON-LD,"']) expect(spec.description).toContain(trigger);
    expect(spec.description).toContain("get_fix");
    expect(spec.description).toMatch(/confirmed facts/);
  });

  it("get_recommendations answers any key: free-tier, and says what Pro adds", () => {
    // Card 227: the API answers a key without Pro with the free list.
    const spec = SERVED_TOOLS.find((t) => t.name === "get_recommendations")!;
    expect(spec.tier).toBe("free");
    expect(spec.description).toMatch(/any Website Auditor API key/i);
    expect(spec.description).toMatch(/Pro/);
    expect(spec.description).toMatch(/evidence/i);
  });

  it("the monitoring management tools are all Pro-gated", () => {
    const gate = Object.fromEntries(ALL_TOOL_SPECS.map((t) => [t.name, t.tier]));
    expect(gate.untrack_site).toBe("pro");
    expect(gate.list_tracked_sites).toBe("pro");
    expect(gate.get_monitoring_status).toBe("pro");
  });

  it("compare_competitors takes an OPTIONAL business_location, and no name", () => {
    const cmp = P0_TOOLS.find((t) => t.name === "compare_competitors")!;
    const schema = z.object(cmp.inputSchema);
    const base = { domain: "example.com", competitors: ["rival.com"] };

    // Optional: the tool is unchanged for callers who do not scope it.
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, business_location: "Chiang Mai, Thailand" })
      .success).toBe(true);

    // The place belongs to the question, so it is offered here as it is on
    // get_ai_visibility and run_audit. A NAME identifies one business, and
    // forwarding the caller's to their rivals would score each of them as the
    // caller — so this tool deliberately does not take one.
    expect(Object.keys(cmp.inputSchema).sort())
      .toEqual(["business_location", "competitors", "domain"]);
  });

  it("track_site is weekly-only in v1 (rejects 'daily', defaults to 'weekly')", () => {
    const track = P1_TOOLS.find((t) => t.name === "track_site")!;
    const schema = z.object(track.inputSchema);
    // 'daily' is no longer accepted.
    expect(schema.safeParse({ domain: "example.com", cadence: "daily" }).success).toBe(false);
    // 'weekly' parses, and it's the default when omitted.
    expect(schema.safeParse({ domain: "example.com", cadence: "weekly" }).success).toBe(true);
    const parsed = schema.parse({ domain: "example.com" });
    expect(parsed.cadence).toBe("weekly");
  });
});
