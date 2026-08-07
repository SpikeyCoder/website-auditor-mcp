/**
 * Prompts are the only discovery surface in this package that does not depend on
 * a model inferring relevance: the host renders them as something a human can
 * click. Production says that matters — 466 installs produced 2,531 session_init
 * events and only 29 installs that ever called a tool, so in 94% of installs the
 * tool list was present and never chosen.
 *
 * These tests pin the contract the Claude connector directory renders (stable
 * snake_case names, a human title and description on each) and the one property
 * that makes the set convert: the keyless prompt needs no arguments, and the
 * hero prompt degrades to it instead of dead-ending a user with no API key.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";
import { PROMPT_SPECS } from "../../src/mcp/prompts.js";
import { makeDeps } from "../helpers.js";

async function connect(tier: "none" | "free" | "pro" = "pro"): Promise<Client> {
  const server = createServer(makeDeps({ tier }));
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Flatten a getPrompt result to the text a host would insert. */
function promptText(result: { messages: Array<{ content: unknown }> }): string {
  return result.messages
    .map((m) => (m.content as { type: string; text?: string }).text ?? "")
    .join("\n");
}

const EXPECTED = ["audit_my_site", "check_ai_visibility", "compare_to_competitor", "see_sample_report"];

describe("discovery prompts", () => {
  it("advertises the prompts capability so hosts render them at all", async () => {
    const client = await connect();
    expect(client.getServerCapabilities()?.prompts).toBeDefined();
  });

  it("lists the four discovery prompts under stable snake_case names", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(EXPECTED);
    for (const p of prompts) expect(p.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("gives every prompt a human title and description — the directory renders both", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    for (const p of prompts) {
      expect(p.title, `${p.name} title`).toBeTruthy();
      expect(p.description ?? "", `${p.name} description`).not.toHaveLength(0);
    }
  });

  it("keeps the keyless prompt argument-free, so it is one click for any install", async () => {
    const client = await connect("none");
    const { prompts } = await client.listPrompts();
    const sample = prompts.find((p) => p.name === "see_sample_report")!;
    expect(sample.arguments ?? []).toHaveLength(0);

    const text = promptText(await client.getPrompt({ name: "see_sample_report" }));
    expect(text).toContain("get_sample_audit");
  });

  it("asks the hero prompt for a domain and carries it into the message", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    const hero = prompts.find((p) => p.name === "check_ai_visibility")!;
    expect(hero.arguments?.some((a) => a.name === "domain" && a.required)).toBe(true);

    const text = promptText(
      await client.getPrompt({ name: "check_ai_visibility", arguments: { domain: "acme.test" } }),
    );
    expect(text).toContain("acme.test");
    expect(text).toContain("get_ai_visibility");
  });

  it("routes the hero prompt to the sample rather than dead-ending a keyless user", async () => {
    // The biggest button has to do SOMETHING for the 94% who never activate.
    const client = await connect("none");
    const text = promptText(
      await client.getPrompt({ name: "check_ai_visibility", arguments: { domain: "acme.test" } }),
    );
    expect(text).toContain("get_sample_audit");
  });

  it("names the tool each remaining prompt should drive", async () => {
    const client = await connect();
    const audit = promptText(
      await client.getPrompt({ name: "audit_my_site", arguments: { domain: "acme.test" } }),
    );
    expect(audit).toContain("run_audit");

    const compare = promptText(
      await client.getPrompt({
        name: "compare_to_competitor",
        arguments: { domain: "acme.test", competitor: "rival.test" },
      }),
    );
    expect(compare).toContain("compare_competitors");
    expect(compare).toContain("rival.test");
  });

  it("keeps the exported specs and the served prompts in agreement", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(PROMPT_SPECS.map((s) => s.name).sort()).toEqual(prompts.map((p) => p.name).sort());
  });
});
