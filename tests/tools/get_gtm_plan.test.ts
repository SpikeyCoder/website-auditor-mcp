import { describe, it, expect, vi } from "vitest";
import { getGtmPlan } from "../../src/tools/getGtmPlan.js";
import { makeDeps, fixedResolution } from "../helpers.js";
import { WaApiError } from "../../src/api/errors.js";

// get_gtm_plan [Pro] — the MCP face of the citations-driven GTM chatbot.
// One-shot BY DESIGN: MCP tools are stateless and the conversation loop
// belongs to the HOST, so refinement is "call again with prior_plan", not a
// transcript argument. The tool maps its args onto the proxy's messages[]
// contract (POST /api/growth-plan takes {domain, messages}); the plan itself is
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
    // The note now claims only what the wire proves — see the honesty test
    // below; "the audit recorded no citation evidence" was one of three
    // indistinguishable causes of an empty sources_used.
    expect(res.data.evidence_note).toMatch(/names no domains/i);
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
    // The engine caps assistant messages at 8192 chars (its chat token
    // budget x 8, mirrored by the proxy); a longer prior plan is a normal
    // artifact of this very tool, so it is trimmed (keeping the tail, where
    // the most recent sequencing lives) rather than bounced.
    const fn = planClient();
    await getGtmPlan(
      { domain: "example.com", prior_plan: "A".repeat(5000) + "B".repeat(5000) },
      makeDeps({ tier: "pro", client: { getGtmPlan: fn } }),
    );
    const assistant = fn.mock.calls[0][0].messages[1];
    expect(assistant.content.length).toBeLessThanOrEqual(8192);
    expect(assistant.content.endsWith("B")).toBe(true);
  });
});

// ── the wire contract the proxy actually enforces ────────────────────
// Cross-repo verification caught these: the tool's own unit tests mock the
// client, so a mismatch with website-auditor-api's validation is invisible
// here until a real customer hits it — inside an un-unpublishable release.

describe("get_gtm_plan: the wire the proxy actually accepts", () => {
  it("normalizes a URL-shaped domain, like every other domain tool", async () => {
    // run_audit and get_ai_visibility accept "https://acme.com" (client
    // normalizeDomain); the proxy's DOMAIN_RE rejects it outright. Passing
    // the argument through verbatim broke the audit-then-plan handoff the
    // 1.0.21 instructions nudge explicitly scripts — on the SAME string.
    const fn = planClient();
    const res = await getGtmPlan(
      { domain: "https://Acme.com/pricing" },
      makeDeps({ tier: "pro", client: { getGtmPlan: fn } }),
    );
    expect(res.ok).toBe(true);
    expect(fn.mock.calls[0]![0].domain).toBe("acme.com");
    if (!res.ok) return;
    expect(res.data.domain).toBe("acme.com");
  });

  it("rejects a domain that is not one, before spending a call", async () => {
    const fn = planClient();
    const res = await getGtmPlan({ domain: "not a domain !!" }, makeDeps({ tier: "pro", client: { getGtmPlan: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_INPUT");
    expect(fn).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only prior_plan as absent, never an empty turn", async () => {
    // The engine refuses empty content ("a message must not be empty"), and
    // a blank assistant turn reached it as a generic upstream failure the
    // user could only answer by retrying the same thing.
    const fn = planClient();
    await getGtmPlan({ domain: "acme.com", prior_plan: "   \n  " }, makeDeps({ tier: "pro", client: { getGtmPlan: fn } }));
    const sent = fn.mock.calls[0]![0].messages;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.role).toBe("user");
    for (const m of sent) expect(m.content.trim()).not.toBe("");
  });

  it("keeps a long prior plan up to the cap the wire really carries", async () => {
    // The trim mirrors the transcript's assistant cap. Left at the old 4000
    // it silently discarded half of a plan both the proxy and the engine
    // would have accepted — on the refinement path, where losing the tail
    // loses the sequencing the user is refining.
    const fn = planClient();
    await getGtmPlan({ domain: "acme.com", prior_plan: "x".repeat(9000) }, makeDeps({ tier: "pro", client: { getGtmPlan: fn } }));
    const sent = fn.mock.calls[0]![0].messages;
    expect(sent).toHaveLength(3);
    expect(sent[1]!.content.length).toBe(8192);
  });

  it("a domain with no audit on record points at run_audit, not a REST route", async () => {
    const fn = vi.fn(async () => {
      throw new WaApiError("UPSTREAM_ERROR", "No audit on record for that run. Run one first via GET /api/audit.", {
        status: 404,
      });
    });
    const res = await getGtmPlan({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getGtmPlan: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toMatch(/run_audit/);
    expect(res.error.message).not.toMatch(/GET \/api\/audit/);
  });
});

describe("get_gtm_plan: the evidence note claims only what the wire proves", () => {
  it("an empty sources_used does not assert the audit recorded no evidence", async () => {
    // sources_used is DERIVED from the plan prose (engine derive_sources_used):
    // it is [] when no citations were recorded, when the answers cited
    // nothing attributable, AND when evidence exists but the plan never
    // typed a bare domain. Only the last is common — and asserting "no
    // citation evidence" there contradicts the sources list the host may
    // have relayed seconds earlier.
    const fn = planClient({ ...PLAN, sources_used: [] });
    const res = await getGtmPlan({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getGtmPlan: fn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.evidence_note).toBeDefined();
    expect(res.data.evidence_note).not.toMatch(/recorded no citation evidence/i);
    expect(res.data.evidence_note).toMatch(/names no domains|does not name/i);
  });
});

// ── the plan the screens draw (chaos_tester #489 via api PR #84) ─────
// plan_phases is the SAME plan as plan_markdown, parsed into cards. It is
// additive, it is optional, and its empty value is load-bearing: [] means
// this engine parsed no cards and the caller should render the prose;
// absent means an engine that predates cards. Collapsing the two reports a
// failed card contract where none was attempted.

const PHASES = [
  {
    phase: 30,
    range: "Days 1–30",
    name: "Foundation",
    short: "30 Days",
    headline: "Get listed where the assistants already look",
    focus: null,
    actions: [
      {
        title: "Claim the Yelp listing",
        effort: "2 hours",
        priority: "High",
        why: null,
        goal: null,
        steps: ["Open the claim form", "Verify by phone"],
      },
      { title: "Add FAQ schema", effort: null, priority: null, why: null, goal: null, steps: [] },
    ],
  },
  { phase: 60, range: "Days 31–60", name: "Authority", short: "60 Days", headline: null, focus: null, actions: [] },
];

describe("get_gtm_plan: the phase cards ride along, unedited", () => {
  it("relays plan_phases verbatim, nulls included", async () => {
    const fn = planClient({ ...PLAN, plan_phases: PHASES });
    const res = await getGtmPlan({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getGtmPlan: fn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.plan.phases).toEqual(PHASES);
    // Nothing is defaulted: a field the plan did not write stays null, so the
    // host never renders an effort or a priority no model produced.
    expect(res.data.plan.phases![0]!.actions[1]!.effort).toBeNull();
    expect(res.data.plan.phases![0]!.focus).toBeNull();
  });

  it("keeps [] and absent apart all the way out to the caller", async () => {
    const empty = await getGtmPlan(
      { domain: "acme.com" },
      makeDeps({ tier: "pro", client: { getGtmPlan: planClient({ ...PLAN, plan_phases: [] }) } }),
    );
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.data.plan.phases).toEqual([]);

    const older = await getGtmPlan(
      { domain: "acme.com" },
      makeDeps({ tier: "pro", client: { getGtmPlan: planClient() } }),
    );
    expect(older.ok).toBe(true);
    if (!older.ok) return;
    expect(older.data.plan.phases).toBeUndefined();
    expect("phases" in older.data.plan).toBe(false);
  });

  it("counts the cards in the summary, and says nothing when there are none", async () => {
    // Counting what arrived is not composing a plan: the numbers come from
    // the wire, and a plan with no cards simply does not mention them.
    const withCards = await getGtmPlan(
      { domain: "acme.com" },
      makeDeps({ tier: "pro", client: { getGtmPlan: planClient({ ...PLAN, plan_phases: PHASES }) } }),
    );
    expect(withCards.ok).toBe(true);
    if (!withCards.ok) return;
    expect(withCards.data.summary).toMatch(/2 actions/);

    const without = await getGtmPlan(
      { domain: "acme.com" },
      makeDeps({ tier: "pro", client: { getGtmPlan: planClient({ ...PLAN, plan_phases: [] }) } }),
    );
    expect(without.ok).toBe(true);
    if (!without.ok) return;
    expect(without.data.summary).not.toMatch(/action/i);
  });

  it("never invents cards from the prose", async () => {
    const fn = planClient();
    const res = await getGtmPlan({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getGtmPlan: fn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(JSON.stringify(res.data.plan.phases ?? null)).toBe("null");
  });
});
