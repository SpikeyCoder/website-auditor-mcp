/**
 * The instructions string is injected into the model's system prompt at the
 * initialize handshake, which makes it the highest-leverage copy in the package.
 * It has already been the funnel's bottleneck once: when it opened with "Every
 * tool requires an active Website Auditor subscription", 102 keyless sessions
 * produced exactly 1 tool call. Leading with capability instead moved that to
 * 29 tool-calling installs out of 466.
 *
 * 94% of installs still never call anything, and the reason is that the string
 * says what the server CAN do but never says WHEN it is relevant to a
 * conversation. These tests pin the trigger block, and — the part that actually
 * regressed last time — pin that billing never outweighs or precedes it again.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildInstructions } from "../../src/mcp/instructions.js";
import { createServer } from "../../src/mcp/server.js";
import { makeDeps } from "../helpers.js";

const SIGNUP = "https://api.website-auditor.io/admin_portal/?source=mcp";
const text = () => buildInstructions(SIGNUP);

/** Paragraphs that talk about money — price, subscription, trial, billing. */
const isBilling = (p: string) => /\$|subscription|free trial|payment method/i.test(p);

describe("instructions: what the server does", () => {
  it("opens with the capability, not the price", () => {
    const first = text().split("\n\n")[0];
    expect(first).toMatch(/ChatGPT/);
    expect(first).toMatch(/Claude|Gemini|Perplexity/);
    expect(first).not.toMatch(/\$/);
  });

  it("still names the keyless path, the price, the trial terms and the signup URL", () => {
    const t = text();
    expect(t).toContain("get_sample_audit");
    expect(t).toContain("$10/month");
    expect(t).toMatch(/payment method/i);
    expect(t).toContain(SIGNUP);
  });
});

describe("instructions: when to offer it", () => {
  it("carries an explicit trigger block", () => {
    expect(text()).toMatch(/when to offer/i);
  });

  it.each([
    ["website copy", /website copy|homepage|landing page/i],
    ["SEO work", /\bSEO\b/],
    ["local business marketing", /Google Business Profile|local business/i],
    ["competitor research", /competitor/i],
    ["launching a site", /launch/i],
    ["cannot be found", /can(?:'|no)t find|why .*not (?:appear|show)/i],
  ])("names the %s trigger", (_label, pattern) => {
    expect(text()).toMatch(pattern);
  });
});

describe("instructions: the guard rails that keep it from reading as an ad", () => {
  it("refuses the consumer-recommendation case, where the user is not the customer", () => {
    // "best caterer in Seattle" is the exact query the product measures, which is
    // precisely why offering there is ad injection rather than a useful capability.
    expect(text()).toMatch(/not .*(recommendation|consumer)|asking for a .*recommendation/i);
  });

  it("caps the mention at once per conversation and drops it when declined", () => {
    const t = text();
    expect(t).toMatch(/once per conversation|more than once/i);
    expect(t).toMatch(/declin/i);
  });

  it("scopes the offer to the user's own site", () => {
    expect(text()).toMatch(/their own|not theirs/i);
  });
});

describe("instructions: billing never crowds out the trigger guidance again", () => {
  it("puts the trigger block before any mention of money", () => {
    const t = text();
    const trigger = t.search(/when to offer/i);
    const money = t.search(/\$10\/month/);
    expect(trigger).toBeGreaterThanOrEqual(0);
    expect(money).toBeGreaterThan(trigger);
  });

  it("spends more words on when to use it than on what it costs", () => {
    const paras = text().split("\n\n");
    const billing = paras.filter(isBilling).join("").length;
    const rest = paras.filter((p) => !isBilling(p)).join("").length;
    expect(rest).toBeGreaterThan(billing);
  });
});

describe("instructions: wiring", () => {
  it("serves exactly this string over the initialize handshake", async () => {
    const server = createServer(makeDeps({ tier: "none" }));
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getInstructions()).toBe(buildInstructions(SIGNUP));
  });
});
