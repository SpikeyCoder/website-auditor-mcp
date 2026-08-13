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
import { upgradeLink } from "../../src/tools/upgrade.js";

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
  /** Instructions as a client actually receives them, over a real handshake. */
  async function served(deps: Parameters<typeof createServer>[0]): Promise<string> {
    const server = createServer(deps);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client.getInstructions() ?? "";
  }

  it("serves exactly this string over the initialize handshake", async () => {
    expect(await served(makeDeps({ tier: "none" }))).toBe(buildInstructions(SIGNUP));
  });

  // These instructions are the FIRST thing a client reads, so telling a hosted
  // caller to "set WA_API_KEY in this server's config and restart the client"
  // misdirects before any tool has run — that config is on a box they cannot
  // reach, and their key arrives per request in a header. The transport has to
  // reach buildInstructions for that to work; without this test the argument
  // could be dropped at the call site with the whole suite staying green.
  it("tells a hosted client where its key actually goes", async () => {
    const hosted = await served({ ...makeDeps({ tier: "none" }), transport: "http" });
    expect(hosted).toMatch(/Authorization: Bearer|X-API-Key/);
    expect(hosted).not.toContain("WA_API_KEY");
    expect(hosted).not.toMatch(/restart the client/i);
  });

  it("keeps the env-var instruction for stdio clients", async () => {
    const stdio = await served({ ...makeDeps({ tier: "none" }), transport: "stdio" });
    expect(stdio).toContain("WA_API_KEY");
    expect(stdio).toMatch(/restart the client/i);
  });

  it("says it under both upsell styles, so the marketplace build is not the broken one", () => {
    // "info" style is what a hosted OpenAI-plugin deployment runs — exactly the
    // deployment where the stdio instruction cannot be carried out.
    for (const style of ["link", "info"] as const) {
      // Both headers, not an alternation — see the note in keyRequiresRestart.
      expect(buildInstructions(SIGNUP, style, "http"), style).toMatch(/Authorization: Bearer/);
      expect(buildInstructions(SIGNUP, style, "http"), style).toMatch(/X-API-Key/);
      expect(buildInstructions(SIGNUP, style, "http"), style).not.toContain("WA_API_KEY");
    }
  });

  it("defaults to the stdio instruction when transport is absent", () => {
    // ToolDeps.transport is optional — absent means a build predating the
    // field, which was stdio-only. Flipping the default to "http" left the
    // suite green, because the handshake test compares served output against
    // buildInstructions(SIGNUP) and BOTH sides route through the same default,
    // making the assertion invariant under any change to it.
    expect(buildInstructions(SIGNUP)).toContain("WA_API_KEY");
    expect(buildInstructions(SIGNUP)).not.toMatch(/Authorization: Bearer/);
  });

  it("carries the configured upsell style from deps, not a hardcoded one", async () => {
    // The neighbouring argument to the one already pinned. Hardcoding "link" at
    // the call site left the suite green: every style test calls
    // buildInstructions directly, and the one handshake test uses a config
    // whose style IS "link". An info-style deployment would then serve
    // link-style instructions — "Sign up and create an API key at <portal>" —
    // which is the purchase-initiating copy marketplace review forbids, and
    // nothing would fail.
    const deps = { ...makeDeps({ tier: "none", config: { upsellStyle: "info" } }), transport: "http" as const };
    const info = await served(deps);
    // upgradeLink resolves to the informational page under this style, so the
    // expected string has to be built from the same config rather than SIGNUP.
    expect(info).toBe(buildInstructions(upgradeLink(deps.config), "info", "http"));
    expect(info).toMatch(/described at/i);
    // The distinguishing property, stated independently of string equality:
    // info style must not carry the purchase-initiating portal link.
    expect(info).not.toContain("admin_portal");
  });
});
