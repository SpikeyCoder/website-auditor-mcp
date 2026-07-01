import { describe, it, expect } from "vitest";
import { z } from "zod";
import { P0_TOOLS, P1_TOOLS, ALL_TOOL_SPECS, SERVED_TOOLS } from "../../src/tools/registry.js";

describe("tool registry", () => {
  it("registers exactly the four Phase-0 tools with the exact names agents bind to", () => {
    expect(P0_TOOLS.map((t) => t.name).sort()).toEqual(
      ["compare_competitors", "get_ai_visibility", "get_changes", "run_audit"].sort(),
    );
  });

  it("marks the correct free/pro gate per the listing doc", () => {
    const gate = Object.fromEntries(ALL_TOOL_SPECS.map((t) => [t.name, t.tier]));
    expect(gate.get_ai_visibility).toBe("free");
    expect(gate.run_audit).toBe("free");
    expect(gate.get_changes).toBe("pro");
    expect(gate.compare_competitors).toBe("pro");
  });

  it("uses the verbatim, trigger-first descriptions from the listing doc", () => {
    const av = P0_TOOLS.find((t) => t.name === "get_ai_visibility")!;
    // The differentiator phrase must be present so we own the intent in registries.
    expect(av.description).toContain("does ChatGPT/Perplexity/Claude/Gemini recommend");
    expect(av.description.startsWith("Check how visible a website is to AI assistants right now.")).toBe(true);

    const audit = P0_TOOLS.find((t) => t.name === "run_audit")!;
    expect(audit.description.startsWith("Run a full one-time audit of a website")).toBe(true);
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

  it("serves the four Phase-0 tools plus track_site (its cadence job has shipped)", () => {
    expect(SERVED_TOOLS.map((t) => t.name).sort()).toEqual(
      ["compare_competitors", "get_ai_visibility", "get_changes", "run_audit", "track_site"].sort(),
    );
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
