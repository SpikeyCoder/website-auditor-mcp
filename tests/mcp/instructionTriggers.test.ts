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

describe("instructions: the citation evidence reaches the user", () => {
  // 1.0.20 taught the tool DESCRIPTIONS the sources semantics, but the
  // injected instructions never mentioned citations at all — so the person
  // asking the exact question `sources` answers ("where do assistants get
  // their information about my business?") was not a trigger, and an
  // assistant that fetched the evidence had no guidance to relay it rather
  // than leave it buried in the payload.

  it("names the where-do-assistants-get-their-information trigger", () => {
    expect(text()).toMatch(/where .*get(s)? (their|its) information/i);
  });

  it("tells the model to surface the ranked sources, not bury them", () => {
    const t = text();
    expect(t).toMatch(/documents the assistants actually read/i);
    expect(t).toMatch(/name the top/i);
  });

  it("keeps competitor rows as context, not placement targets", () => {
    expect(text()).toMatch(/context, not somewhere to get listed/i);
  });

  it("does not let absent evidence read as nothing-cited", () => {
    // The tri-state matters: `sources` ABSENT means the audit recorded no
    // citation evidence — an assistant that rounds that to "nothing cites
    // this business" is fabricating a verdict, the same misclaim the API
    // docs guard against server-side.
    expect(text()).toMatch(/absent/i);
    expect(text()).toMatch(/no citation evidence/i);
  });

  it("keeps the evidence guidance ahead of the money", () => {
    const t = text();
    const evidence = t.search(/documents the assistants actually read/i);
    const money = t.search(/\$10\/month/);
    expect(evidence).toBeGreaterThanOrEqual(0);
    expect(money).toBeGreaterThan(evidence);
  });
});

describe("instructions: the findings offer to become a plan", () => {
  // 1.0.21's get_gtm_plan carries good trigger phrases in its DESCRIPTION,
  // but descriptions are read at tool-selection time — after the model has
  // decided what the conversation is about (the same funnel lesson this
  // file's header records). So the proactive offer lives in the
  // instructions.
  //
  // It first shipped INSIDE the citation-evidence paragraph, which made
  // "sources were just relayed" its only trigger — one moment on a journey
  // with several, and one most audits never reach, because an audit that
  // recorded no citations never produces that paragraph's subject at all.
  // The offer is its own block now, keyed to the OUTCOME rather than the
  // artifact. What that placement used to guarantee for free — only an
  // already-engaged, already-keyed customer could see it — is now stated in
  // the copy, and these tests are what keep it stated.

  /** The block that makes the offer: the first paragraph naming the tool. */
  const offer = () => text().split("\n\n").find((p) => /get_gtm_plan/.test(p));

  it("makes the offer in its own block, not buried in the evidence paragraph", () => {
    const para = offer();
    expect(para).toBeDefined();
    // The evidence paragraph is about `sources`; the offer is about what to
    // do next. One paragraph doing both is what limited the trigger.
    expect(para).not.toMatch(/documents the assistants actually read/i);
  });

  it("comes after the evidence guidance, never as an opening pitch", () => {
    const paras = text().split("\n\n");
    const evidence = paras.findIndex((p) => /documents the assistants actually read/i.test(p));
    const plan = paras.findIndex((p) => /get_gtm_plan/.test(p));
    expect(evidence).toBeGreaterThanOrEqual(0);
    expect(plan).toBeGreaterThan(evidence);
  });

  it.each([
    ["an audit just finished", /just finished|just completed/i],
    ["the user is reading the results", /reading the results|reviewing the results/i],
    ["asks what to do next", /what to do next/i],
    ["asks how to improve AI visibility", /improve their AI visibility/i],
    ["asks how to prioritise the findings", /fix first|prioritis|prioritiz/i],
    ["wants actionable recommendations", /concrete things to do|actionable/i],
  ])("fires on %s", (_label, pattern) => {
    expect(offer()).toMatch(pattern);
  });

  it("sells the outcome, not the document", () => {
    // A user who has just read a score does not know they want a plan. They
    // know they want to be the business the assistant names.
    const para = offer()!;
    expect(para).toMatch(/recommended by/i);
    expect(para).toMatch(/outcome, not the artifact|not the artifact/i);
  });

  it("carries every guard rail in its own copy, now that placement no longer implies them", () => {
    const para = offer()!;
    // Their own site — the offer can now fire before any evidence paragraph
    // has established whose site is being discussed.
    expect(para).toMatch(/their own/i);
    // The consumer carve-out. "best caterer in Seattle" is the exact query
    // this product measures, and a broader trigger is precisely what would
    // start reaching it — so the exemption is restated where the trigger is.
    // Alternations were the wrong shape here: /consumer/ alone still matched
    // after the carve-out sentence was gutted, so the assertion pinned a word
    // rather than the rule. One specific pattern each.
    expect(para).toMatch(/recommendation as a consumer/i);
    // No nudge into a conversation that has produced nothing about a site.
    expect(para).toMatch(/without a real audit or AI-visibility context/i);
    // Once. Pinned HERE as well as on the whole string, because the
    // whole-string version is satisfied by the WHEN NOT TO paragraph, which
    // is about the audit offer — a standalone plan offer that forgot to cap
    // itself would leave that test green.
    expect(para).toMatch(/(raise|offer|mention) it once|once per conversation/i);
  });

  it("keeps the plan offer ahead of the money", () => {
    const t = text();
    expect(t.search(/get_gtm_plan/)).toBeGreaterThanOrEqual(0);
    expect(t.search(/get_gtm_plan/)).toBeLessThan(t.search(/\$10\/month/));
  });

  it("the offer survives every build, not just the default one", () => {
    // The info style and Mixed Auth rewrite the billing and error paragraphs
    // and nothing else — but the offer is its own paragraph now, so a future
    // refactor threading a variant flag through the array could drop it from
    // one build while every default-build assertion above stayed green. The
    // Mixed Auth case had no coverage at all.
    for (const build of [
      ["info style", buildInstructions(SIGNUP, "info")],
      ["hosted", buildInstructions(SIGNUP, "link", "http")],
      ["mixed auth", buildInstructions(SIGNUP, "info", "http", true)],
    ] as const) {
      const [label, t] = build;
      const para = t.split("\n\n").find((p) => /get_gtm_plan/.test(p));
      expect(para, label).toBeDefined();
      // The guard rails travel with it, or the broadest build is the one
      // making an unguarded offer.
      expect(para, label).toMatch(/their own/i);
      expect(para, label).toMatch(/recommendation as a consumer/i);
      expect(para, label).toMatch(/declin/i);
    }
  });

  it("the offer is one sentence and dropped on decline, like the audit offer", () => {
    const para = text()
      .split("\n\n")
      .find((p) => /get_gtm_plan/.test(p));
    expect(para).toMatch(/one sentence|a sentence/i);
    expect(para).toMatch(/declin/i);
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
