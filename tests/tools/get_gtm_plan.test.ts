import { describe, it, expect, vi } from "vitest";
import { getGtmPlan } from "../../src/tools/getGtmPlan.js";
import { makeDeps, fixedResolution } from "../helpers.js";

// get_gtm_plan [Pro] — the MCP face of the citations-driven GTM chatbot.
// One-shot BY DESIGN: MCP tools are stateless and the conversation loop
// belongs to the HOST, so refinement is "call again with prior_plan", not a
// transcript argument. The tool maps its args onto the proxy's messages[]
// contract (POST /api/gtm-plan takes {domain, messages}); the plan itself is
// composed engine-side from the audit's citation evidence — this tool must
// never fabricate one.

const PLAN = {
  plan_markdown: "# GTM Plan\n## Positioning\n...",
  plan_sections: [
    { title: "Positioning", body_lines: ["Lead with the cited strengths."] },
    { title: "Channel priorities", body_lines: ["forbes.com first."] },
  ],
  sources_used: ["forbes.com", "yelp.com"],
  model: "claude-sonnet-4-6",
};

function planClient(result = PLAN) {
  return vi.fn(async () => ({ ...result }));
}

describe("get_gtm_plan [Pro]", () => {
  it("no key -> AUTH_REQUIRED that names the keyless path (does not run)", async () => {
    const fn = planClient();
    const res = await getGtmPlan({ domain: "example.com" }, makeDeps({ tier: "none", client: { getGtmPlan: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("AUTH_REQUIRED");
    expect(res.error.message).toContain("get_sample_audit");
    expect(fn).not.toHaveBeenCalled();
  });

  it("free key -> PRO_REQUIRED (does not run)", async () => {
    const fn = planClient();
    const res = await getGtmPlan({ domain: "example.com" }, makeDeps({ tier: "free", client: { getGtmPlan: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("PRO_REQUIRED");
    expect(fn).not.toHaveBeenCalled();
  });

  it("unverifiable subscription -> SUBSCRIPTION_UNVERIFIED, not an upsell", async () => {
    const fn = planClient();
    const res = await getGtmPlan(
      { domain: "example.com" },
      makeDeps({ subscriptions: fixedResolution({ tier: "free", verified: false }), client: { getGtmPlan: fn } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("SUBSCRIPTION_UNVERIFIED");
    expect(fn).not.toHaveBeenCalled();
  });

  it("pro: relays the plan, the evidence, and a prose summary", async () => {
    const fn = planClient();
    const res = await getGtmPlan({ domain: "example.com" }, makeDeps({ tier: "pro", client: { getGtmPlan: fn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.domain).toBe("example.com");
    expect(res.data.plan.markdown).toBe(PLAN.plan_markdown);
    expect(res.data.plan.sections).toEqual(PLAN.plan_sections);
    expect(res.data.sources_used).toEqual(["forbes.com", "yelp.com"]);
    expect(res.data.model).toBe(PLAN.model);
    // The house style: structured fields plus a summary the host model reads.
    expect(res.data.summary).toContain("example.com");
    expect(res.data.summary).toContain("2");
    // One-shot request: a single opening user message naming the domain.
    const sent = fn.mock.calls[0][0];
    expect(sent.domain).toBe("example.com");
    expect(sent.messages).toHaveLength(1);
    expect(sent.messages[0].role).toBe("user");
    expect(sent.messages[0].content).toContain("example.com");
  });

  it("focus and constraints steer the brief", async () => {
    const fn = planClient();
    await getGtmPlan(
      { domain: "example.com", focus: "local directories", constraints: "solo founder, $200/mo" },
      makeDeps({ tier: "pro", client: { getGtmPlan: fn } }),
    );
    const content = fn.mock.calls[0][0].messages[0].content;
    expect(content).toContain("local directories");
    expect(content).toContain("solo founder, $200/mo");
  });

  it("prior_plan turns the call into a refinement transcript", async () => {
    const fn = planClient();
    await getGtmPlan(
      { domain: "example.com", prior_plan: "# GTM Plan v1\n...", focus: "double down on content" },
      makeDeps({ tier: "pro", client: { getGtmPlan: fn } }),
    );
    const messages = fn.mock.calls[0][0].messages;
    expect(messages).toHaveLength(3);
    expect(messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1].content).toBe("# GTM Plan v1\n...");
    expect(messages[2].content).toContain("double down on content");
  });

  it("no attributable sources degrades additively, never to an error", async () => {
    const fn = planClient({ ...PLAN, sources_used: [] });
    const res = await getGtmPlan({ domain: "example.com" }, makeDeps({ tier: "pro", client: { getGtmPlan: fn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.evidence_note).toMatch(/no citation evidence|issues and stats/i);
    expect(res.data.plan.markdown).toBe(PLAN.plan_markdown);
  });

  it("an upstream failure is an error, never a fabricated plan", async () => {
    const { WaApiError } = await import("../../src/api/errors.js");
    const fn = vi.fn(async () => {
      throw new WaApiError("UPSTREAM_ERROR", "Website Auditor API returned HTTP 503.");
    });
    const res = await getGtmPlan({ domain: "example.com" }, makeDeps({ tier: "pro", client: { getGtmPlan: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("UPSTREAM_ERROR");
    expect(JSON.stringify(res)).not.toContain("plan_markdown");
  });

  it("oversize steering args are refused locally without a call", async () => {
    const fn = planClient();
    const res = await getGtmPlan(
      { domain: "example.com", focus: "x".repeat(301) },
      makeDeps({ tier: "pro", client: { getGtmPlan: fn } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_INPUT");
    expect(fn).not.toHaveBeenCalled();
  });

  it("an oversize prior_plan is truncated to the transcript cap, not refused", async () => {
    // The engine caps assistant messages at 4000 chars; a longer prior plan
    // is a normal artifact of this very tool, so it is trimmed (keeping the
    // tail, where the most recent sequencing lives) rather than bounced.
    const fn = planClient();
    await getGtmPlan(
      { domain: "example.com", prior_plan: "A".repeat(3000) + "B".repeat(3000) },
      makeDeps({ tier: "pro", client: { getGtmPlan: fn } }),
    );
    const assistant = fn.mock.calls[0][0].messages[1];
    expect(assistant.content.length).toBeLessThanOrEqual(4000);
    expect(assistant.content.endsWith("B")).toBe(true);
  });
});
