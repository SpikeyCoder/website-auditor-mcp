import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PROMPT_SPECS } from "../src/mcp/prompts.js";
import { buildInstructions } from "../src/mcp/instructions.js";
import { createServer } from "../src/mcp/server.js";
import { makeDeps } from "./helpers.js";

/**
 * No surface that describes this server claims an SEO audit.
 *
 * There is no SEO module upstream. The `scores.seo` run_audit returns is a
 * proxy — seoProxyScore() in src/api/mappers.ts, the share of crawlability and
 * markup signals the AI-visibility scan reads — and
 * tests/tools/runAuditSaysWhatItChecks.test.ts pins how run_audit names it.
 * website-auditor.io stopped claiming checks it does not run on 2026-10-02
 * (chaos#601); the owner asked for every mention here to follow (mcp#88).
 *
 * Allowed, each only where it is meant: naming the field (`scores.seo`
 * anywhere; the README scores row's "as `seo`"), and the instructions' cue
 * "doing SEO work", which describes what the USER is doing, not a capability.
 *
 * Review round 2 (mcp#88): the runtime text a model reads — tools/list (every
 * tool's title, description and input schema) and the served instructions —
 * was not scanned, so it is read here over a real in-memory handshake.
 */
const root = join(__dirname, "..");
const text = (f: string) => readFileSync(join(root, f), "utf8");
const json = (f: string) => JSON.parse(text(f));

const ALLOWED: Record<string, RegExp[]> = {
  "*": [/`?scores\.seo`?/g],
  "README.md": [/as `seo`/g],
  "docs/SUBMISSION-TESTS.md": [/`seo` \(the\s+crawlability-and-markup proxy\)/g],
  "served instructions": [/doing SEO work/g],
};
const allowedFor = (where: string) =>
  where.startsWith("buildInstructions") ? ALLOWED["served instructions"] : (ALLOWED[where] ?? []);
const claims = (where: string, s: string) =>
  [...ALLOWED["*"], ...allowedFor(where)].reduce((acc, re) => acc.replace(re, ""), s);

const skills = (plugin: string) =>
  readdirSync(join(root, plugin, "skills")).map((d) => `${plugin}/skills/${d}/SKILL.md`);

const manifest = json("manifest.json");
const SURFACES: Array<[string, string]> = [
  ["manifest.description", manifest.description],
  ["manifest.long_description", manifest.long_description],
  ...manifest.tools.map((t: { name: string; description: string }) => [`manifest tool ${t.name}`, t.description]),
  ...manifest.prompts.map((p: { name: string; description: string; text: string }) =>
    [`manifest prompt ${p.name}`, `${p.description}\n${p.text}`]),
  // render() is what a host inserts; JSON.stringify would skip it.
  ...PROMPT_SPECS.map((p) => [`prompt ${p.name}`, `${p.description}\n${p.render({ domain: "example.com", competitor: "rival.com" })}`] as [string, string]),
  ["server.json", JSON.stringify(json("server.json"))],
  ["package.json description", json("package.json").description],
  // Whole files too (review round 6): field-by-field missed user_config —
  // the title and description Claude Desktop's .mcpb install dialog shows
  // — and display_name; package.json the same way.
  ["manifest.json", text("manifest.json")],
  ["package.json", text("package.json")],
  ["README.md", text("README.md")],
  ...(["link", "info"] as const).flatMap((style) => (["stdio", "http"] as const).flatMap((t) =>
    [false, true].map((mixed) => [`buildInstructions ${style} ${t}${mixed ? " mixed" : ""}`,
      buildInstructions("https://example.com", style, t, mixed)] as [string, string]))),
  [".cursor-plugin/marketplace.json", text(".cursor-plugin/marketplace.json")],
  [".agents/plugins/marketplace.json", text(".agents/plugins/marketplace.json")],
  ...PROMPT_SPECS.map((p) => [`prompt title ${p.name}`, p.title] as [string, string]),
  ["codex-plugin/README.md", text("codex-plugin/README.md")],
  ["cursor-plugin/README.md", text("cursor-plugin/README.md")],
  ["docs/CODEX-PLUGIN.md", text("docs/CODEX-PLUGIN.md")],
  ["docs/CURSOR-PLUGIN.md", text("docs/CURSOR-PLUGIN.md")],
  // The submission checklist a directory reviewer follows (review round 5).
  ["docs/SUBMISSION-TESTS.md", text("docs/SUBMISSION-TESTS.md")],
  ["codex plugin.json", text("codex-plugin/.codex-plugin/plugin.json")],
  ["cursor plugin.json", text("cursor-plugin/.cursor-plugin/plugin.json")],
  ...[...skills("codex-plugin"), ...skills("cursor-plugin")].map((f) => [f, text(f)] as [string, string]),
];

describe("no surface claims an SEO audit", () => {
  it.each(SURFACES)("%s", (where, s) => {
    expect(claims(where, s)).not.toMatch(/\bSEO\b/i);
  });

  // Both servers a client can meet (review round 4): a bare stdio server
  // publishes no tool `_meta` at all, so scanning only that one could never
  // fail on it. The hosted server with OAuth configured publishes
  // securitySchemes there.
  const OAUTH = { oauthIssuer: "https://api.website-auditor.io",
                  oauthResourceUrl: "https://mcp.website-auditor.io/mcp" };
  it.each([
    ["stdio", () => makeDeps({ tier: "none" })],
    ["http with OAuth", () => ({ ...makeDeps({ tier: "none", config: OAUTH }), transport: "http" as const })],
  ])("nothing a client is served over the handshake claims one (%s)", async (kind, deps) => {
    const server = createServer(deps());
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(10);
    if (kind !== "stdio") expect(tools.some((t) => t._meta !== undefined), "a tool carries _meta").toBe(true);
    for (const t of tools) {
      const served = JSON.stringify({ title: t.title, description: t.description, input: t.inputSchema,
                                      annotations: t.annotations, meta: t._meta });
      expect(claims(`tool ${t.name}`, served), t.name).not.toMatch(/\bSEO\b/i);
      // outputSchema too (review round 3): its .describe() strings reach the
      // model. The field's own name — the "seo" property key and its entry in
      // `required` — is the field, not a claim, and is exempt HERE only (review
      // round 5: a strip over the whole tool would also have hidden an input
      // option named "seo").
      const output = JSON.stringify(t.outputSchema ?? {})
        .replace(/"seo":/g, "")
        .replace(/"required":\[[^\]]*\]/g, (r) => r.replace(/"seo"/g, ""));
      expect(claims(`tool ${t.name} output`, output), t.name).not.toMatch(/\bSEO\b/i);
    }
    const { prompts } = await client.listPrompts();
    for (const p of prompts) {
      expect(claims(`prompt ${p.name}`, JSON.stringify(p)), p.name).not.toMatch(/\bSEO\b/i);
    }
    const served = client.getInstructions() ?? "";
    expect(served).toContain("doing SEO work");
    expect(claims("served instructions", served)).not.toMatch(/\bSEO\b/i);
  });

  it("no listing is tagged 'seo'", () => {
    for (const f of ["manifest.json", "package.json", "codex-plugin/.codex-plugin/plugin.json",
                     "cursor-plugin/.cursor-plugin/plugin.json"]) {
      const kw: string[] = json(f).keywords ?? [];
      expect(kw.map((k) => k.toLowerCase()), f).not.toContain("seo");
    }
  });

  it("the user-activity cue survives — it is not a capability claim", () => {
    expect(buildInstructions("https://example.com")).toContain("doing SEO work");
  });
});
