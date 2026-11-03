/**
 * "Get this fix" (Trello 307, part 1): list_fixes, get_fix_facts, get_fix,
 * confirm_facts and check_fix.
 *
 * The API's refusals are steps of the flow, not crashes: a fix asked for before
 * its facts are confirmed answers with what to show the owner, and a
 * confirmation whose facts changed answers with the facts as they are now. The
 * limits (a check asked again within the minute, the confirmation cap) and the
 * outages stay error results, each with its own code, and keep `retry_after`
 * and `maybe_recorded`.
 */
import { describe, it, expect, vi } from "vitest";
import { getFix } from "../../src/tools/getFix.js";
import { confirmFacts } from "../../src/tools/confirmFacts.js";
import { checkFix } from "../../src/tools/checkFix.js";
import { getFixFacts } from "../../src/tools/getFixFacts.js";
import { listFixes } from "../../src/tools/listFixes.js";
import { WaApiError } from "../../src/api/errors.js";
import { WaApiClient } from "../../src/api/client.js";
import { makeDeps, testConfig } from "../helpers.js";

const ID = "0b6c1f5e-8a4d-4c39-9f1e-2a7d3c5b9e10";
const CONFIRM = {
  kind: "premises",
  facts: [
    { fact: "name", label: "Business name", site: null, confirmed: null },
    { fact: "city", label: "City", site: "Hilo, HI", confirmed: null },
  ],
  confirmed_at: null,
  stale: [],
  can_confirm: true,
};
const SEEN = { kind: "premises", facts: { city: "Hilo, HI" } };
const REQUEST = { id: ID, kind: "business_facts", path: "mcp", platform: "wordpress", status: null, presses: 1 };
const FIX = {
  kind: "business_facts",
  title: "Your business facts, ready to paste",
  facts: { name: "Acme Bakery", city: "Hilo, HI" },
  blocks: [{ id: "structured_data", label: "Structured data", format: "html", content: "<script>…</script>" }],
  advice: null,
  checks: ["Your home page's structured data names your business and states your city, as you confirmed them."],
  steps: { platform: "wordpress", label: "WordPress", steps: ["Open your theme's header."], note: null, agent_prompt: null, picker: null, can_apply: true },
  copy_all: null,
};

const confirmFirst = (reason: string, extra: Record<string, unknown> = {}) => () => {
  throw new WaApiError("CONFIRM_FIRST", "Confirm your business facts first: the fix is written from them.", {
    status: 409,
    details: { code: "confirm_first", reason, confirm: CONFIRM, ...extra },
  });
};

describe("every fix tool is Pro-gated and asks nothing of the API without Pro", () => {
  const cases: Array<[string, (deps: ReturnType<typeof makeDeps>) => Promise<{ ok: boolean }>, string]> = [
    ["list_fixes", (d) => listFixes({ domain: "acme.com" }, d), "listFixes"],
    ["get_fix_facts", (d) => getFixFacts({ domain: "acme.com" }, d), "getFixFacts"],
    ["get_fix", (d) => getFix({ domain: "acme.com" }, d), "getFix"],
    ["confirm_facts", (d) => confirmFacts({ domain: "acme.com", facts: { name: "A" }, seen: SEEN }, d), "confirmFacts"],
    ["check_fix", (d) => checkFix({ domain: "acme.com", id: ID }, d), "checkFix"],
  ];
  for (const [name, run, method] of cases) {
    it(`${name}: no key -> AUTH_REQUIRED, free -> PRO_REQUIRED`, async () => {
      for (const [tier, code] of [["none", "AUTH_REQUIRED"], ["free", "PRO_REQUIRED"]] as const) {
        const fn = vi.fn();
        const res = await run(makeDeps({ tier, client: { [method]: fn } }));
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect((res as unknown as { error: { code: string } }).error.code).toBe(code);
        expect(fn).not.toHaveBeenCalled();
      }
    });
  }
});

describe("get_fix — \"Get this fix\"", () => {
  it("serves the fix with its request, and says how to check it once added", async () => {
    const fn = vi.fn(async () => ({ request: REQUEST, fix: FIX }));
    const res = await getFix({ domain: "acme.com", kind: "business_facts", platform: "wordpress" }, makeDeps({ tier: "pro", client: { getFix: fn } }));
    expect(fn).toHaveBeenCalledWith({ domain: "acme.com", kind: "business_facts", platform: "wordpress" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("served");
    expect(res.data.request).toEqual(REQUEST);
    expect(res.data.fix).toEqual(FIX);
    expect(res.data.message).toContain("WordPress");
    expect(res.data.message).toContain("check_fix");
    expect(res.data.message).toContain(ID);
  });

  it("mentions copy_all when the steps carry an agent prompt", async () => {
    const fix = { ...FIX, steps: { ...FIX.steps, agent_prompt: "Add this.", label: "Deployed from code" }, copy_all: "Add this.\n\nStructured data:\n…" };
    const res = await getFix({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getFix: async () => ({ request: REQUEST, fix }) } }));
    if (!res.ok) throw new Error("expected a fix");
    expect(res.data.message).toContain("copy_all");
  });

  it("confirm_first is a result, not an error: the facts to show the owner, and seen to send back", async () => {
    // As the API words it: with a seen it always adds its next step (its
    // CONFIRM_NEXT, routes rewritten to tools by the client).
    const fn = () => {
      throw new WaApiError("CONFIRM_FIRST", "Confirm your business facts first: the fix is written from them. Show the owner the facts in `confirm`, then confirm_facts with what they confirm and the `seen` beside it.", {
        status: 409, details: { code: "confirm_first", reason: "unconfirmed", confirm: CONFIRM, seen: SEEN },
      });
    };
    const res = await getFix({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getFix: fn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ status: "confirm_first", reason: "unconfirmed", confirm: CONFIRM, seen: SEEN });
    expect(res.data).not.toHaveProperty("fix");
    expect(res.data.message).toContain("Confirm your business facts first");
    // Owner decision 1: the agent shows the owner, and never confirms for them.
    expect(res.data.message).toMatch(/owner/);
    expect(res.data.message).toMatch(/never confirm/i);
    expect(res.data.message).toContain("confirm_facts");
  });

  it("end to end from the API's 409: the real client's CONFIRM_FIRST becomes the result, in tool words", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: false, code: "confirm_first", reason: "no_name", confirm: CONFIRM, seen: SEEN,
      error: "Confirm your business name first. Show the owner the facts in `confirm` (GET /api/fix/facts adds the business `name`, for a name the site doesn't state), then POST /api/fix/confirm with what they confirm and the `seen` beside it.",
    }), { status: 409, headers: { "content-type": "application/json" } }));
    const client = new WaApiClient(testConfig(), { fetch: fetchMock as unknown as typeof fetch });
    const deps = { ...makeDeps({ tier: "pro" }), client };
    const res = await getFix({ domain: "acme.com" }, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ status: "confirm_first", reason: "no_name", confirm: CONFIRM, seen: SEEN });
    expect(res.data.message).toContain("get_fix_facts adds the business `name`");
    expect(res.data.message).toContain("then confirm_facts with what they confirm");
    expect(res.data.message).toMatch(/never confirm facts on their behalf/);
    expect(res.data.message).not.toContain("/api/");
    // Said once, not twice.
    expect(res.data.message.match(/confirm_facts/g)).toHaveLength(1);
  });

  it("confirm_first facts_not_read: nothing to confirm, no seen, wait for the weekly check", async () => {
    const res = await getFix({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getFix: confirmFirst("facts_not_read") } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("confirm_first");
    expect(res.data.reason).toBe("facts_not_read");
    expect(res.data).not.toHaveProperty("seen");
    expect(res.data.message).toMatch(/weekly check/);
    expect(res.data.message).not.toContain("confirm_facts");
  });

  it("an invalid platform stays an error, with the API's code", async () => {
    const fn = vi.fn(async () => {
      throw new WaApiError("INVALID_INPUT", "platform must be one of the platforms list_fixes lists.", { status: 400, details: { code: "invalid_platform" } });
    });
    const res = await getFix({ domain: "acme.com", platform: "geocities" }, makeDeps({ tier: "pro", client: { getFix: fn } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_INPUT");
    expect(res.error.details).toMatchObject({ code: "invalid_platform" });
  });

  it("a press that may have gone through keeps maybe_recorded", async () => {
    const fn = vi.fn(async () => {
      throw new WaApiError("UPSTREAM_ERROR", "The audit service could not answer. Check the fix with list_fixes before asking again: it may have been recorded.", {
        status: 502, details: { code: "upstream_failed", maybe_recorded: true, upstream_status: 500 },
      });
    });
    const res = await getFix({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getFix: fn } }));
    if (res.ok) throw new Error("expected an error");
    expect(res.error.code).toBe("UPSTREAM_ERROR");
    expect(res.error.details).toMatchObject({ maybe_recorded: true, upstream_status: 500 });
    expect(res.error.message).toContain("list_fixes");
  });
});

describe("confirm_facts", () => {
  it("sends the owner's facts and seen exactly as given, and returns the confirmed block", async () => {
    const seen = { ...SEEN, extra: { kept: true } };
    const confirmed = { ...CONFIRM, confirmed_at: "2026-11-03T10:01:00Z" };
    const fn = vi.fn(async () => ({ confirm: confirmed, seen: SEEN }));
    const res = await confirmFacts({ domain: "acme.com", facts: { name: "Acme Bakery", city: "Hilo, HI" }, seen }, makeDeps({ tier: "pro", client: { confirmFacts: fn } }));
    expect(fn).toHaveBeenCalledWith({ domain: "acme.com", facts: { name: "Acme Bakery", city: "Hilo, HI" }, seen });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ status: "confirmed", confirm: confirmed, seen: SEEN });
    expect(res.data.message).toContain("get_fix");
  });

  it("facts_changed is a result: nothing confirmed, read the facts again and show the owner", async () => {
    const fn = vi.fn(async () => {
      throw new WaApiError("FACTS_CHANGED", "Your site's facts changed since they were shown. Read them again (get_fix_facts), show the owner the facts as they are now, and confirm from that.", {
        status: 409, details: { code: "facts_changed", confirm: CONFIRM },
      });
    });
    const res = await confirmFacts({ domain: "acme.com", facts: { name: "A" }, seen: SEEN }, makeDeps({ tier: "pro", client: { confirmFacts: fn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("facts_changed");
    expect(res.data.confirm).toEqual(CONFIRM);
    // No seen: the owner has not seen these facts, so there is nothing to confirm with yet.
    expect(res.data).not.toHaveProperty("seen");
    expect(res.data.message).toContain("get_fix_facts");
  });

  it("facts_not_read is a result: nothing to confirm until the weekly check reads the site", async () => {
    const fn = vi.fn(async () => {
      throw new WaApiError("FACTS_NOT_READ", "Your site hasn't been read yet.", { status: 409, details: { code: "facts_not_read" } });
    });
    const res = await confirmFacts({ domain: "acme.com", facts: { name: "A" }, seen: SEEN }, makeDeps({ tier: "pro", client: { confirmFacts: fn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("facts_not_read");
    expect(res.data.message).toMatch(/weekly check/);
  });

  it("the confirmation cap is an error with its wait", async () => {
    const fn = vi.fn(async () => {
      throw new WaApiError("TOO_MANY_CONFIRMATIONS", "Too many confirmations today. Try again in 3600 seconds.", { status: 429, details: { code: "too_many_confirmations", retry_after: 3600 } });
    });
    const res = await confirmFacts({ domain: "acme.com", facts: { name: "A" }, seen: SEEN }, makeDeps({ tier: "pro", client: { confirmFacts: fn } }));
    if (res.ok) throw new Error("expected an error");
    expect(res.error.code).toBe("TOO_MANY_CONFIRMATIONS");
    expect(res.error.details).toMatchObject({ retry_after: 3600 });
    // Not the daily audit cap, and not an upsell.
    expect(res.error.upgrade_url).toBeUndefined();
  });
});

describe("check_fix — \"I've added it\"", () => {
  it("live: says so", async () => {
    const check = { live: true, reached: true, missing: [], checked_at: "2026-11-03T10:05:00Z" };
    const fn = vi.fn(async () => ({ request: { ...REQUEST, status: "live" }, check }));
    const res = await checkFix({ domain: "acme.com", id: ID }, makeDeps({ tier: "pro", client: { checkFix: fn } }));
    expect(fn).toHaveBeenCalledWith({ domain: "acme.com", id: ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.live).toBe(true);
    expect(res.data.check).toEqual(check);
    expect(res.data.message).toMatch(/live/);
  });

  it("not live: names what is missing", async () => {
    const check = {
      live: false, reached: true, checked_at: "2026-11-03T10:05:00Z",
      missing: [{ fact: "city", what: "City", detail: "Your structured data doesn't state your city yet." }],
    };
    const res = await checkFix({ domain: "acme.com", id: ID }, makeDeps({ tier: "pro", client: { checkFix: async () => ({ request: REQUEST, check }) } }));
    if (!res.ok) throw new Error("expected a check");
    expect(res.data.live).toBe(false);
    expect(res.data.message).toContain("Your structured data doesn't state your city yet.");
  });

  it("a site that did not answer is not called missing the fix", async () => {
    const check = {
      live: false, reached: false, checked_at: "2026-11-03T10:05:00Z",
      missing: [{ fact: "site", what: "Your home page", detail: "We couldn't reach your home page. Try again in a few minutes." }],
    };
    const res = await checkFix({ domain: "acme.com", id: ID }, makeDeps({ tier: "pro", client: { checkFix: async () => ({ request: REQUEST, check }) } }));
    if (!res.ok) throw new Error("expected a check");
    expect(res.data.message).toContain("couldn't reach");
    expect(res.data.message).not.toMatch(/not live yet/i);
  });

  it("checked_recently is CHECKED_RECENTLY with retry_after, never OVER_QUOTA", async () => {
    const fn = vi.fn(async () => {
      throw new WaApiError("CHECKED_RECENTLY", "Checked less than a minute ago. Check again in 42 seconds.", { status: 429, details: { code: "checked_recently", retry_after: 42 } });
    });
    const res = await checkFix({ domain: "acme.com", id: ID }, makeDeps({ tier: "pro", client: { checkFix: fn } }));
    if (res.ok) throw new Error("expected an error");
    expect(res.error.code).toBe("CHECKED_RECENTLY");
    expect(res.error.details).toMatchObject({ retry_after: 42 });
  });

  it("an unknown request id is NOT_FOUND", async () => {
    const fn = vi.fn(async () => {
      throw new WaApiError("NOT_FOUND", "acme.com isn't one of your tracked sites, or it has no fix request x.", { status: 404, details: { code: "not_found" } });
    });
    const res = await checkFix({ domain: "acme.com", id: ID }, makeDeps({ tier: "pro", client: { checkFix: fn } }));
    if (res.ok) throw new Error("expected an error");
    expect(res.error.code).toBe("NOT_FOUND");
  });
});

describe("get_fix_facts", () => {
  it("returns the block, seen and name, and says the owner confirms", async () => {
    const fn = vi.fn(async () => ({ confirm: CONFIRM, seen: SEEN, name: "Acme Bakery" }));
    const res = await getFixFacts({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getFixFacts: fn } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ confirm: CONFIRM, seen: SEEN, name: "Acme Bakery", can_confirm: true });
    expect(res.data.message).toMatch(/owner/);
    expect(res.data.message).toContain("confirm_facts");
  });

  it("no seen: the facts can't be confirmed yet", async () => {
    const confirm = { ...CONFIRM, can_confirm: false };
    const res = await getFixFacts({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getFixFacts: async () => ({ confirm, name: "" }) } }));
    if (!res.ok) throw new Error("expected facts");
    expect(res.data.can_confirm).toBe(false);
    expect(res.data).not.toHaveProperty("seen");
    expect(res.data.message).toMatch(/weekly check/);
  });
});

describe("list_fixes", () => {
  it("relays the overview and names the top fix", async () => {
    const overview = {
      site: { domain: "acme.com" },
      platform: "wordpress",
      platforms: [{ key: "wordpress", label: "WordPress" }],
      top: "business_facts",
      fixes: [
        { kind: "business_facts", title: "Your business facts, ready to paste", needed: true, why: "AI assistants get your city wrong.", can_apply: true, request: null },
        { kind: "llms_txt", title: "An llms.txt for your site", needed: false, why: "Your site's llms.txt is in place.", can_apply: true, request: { ...REQUEST, kind: "llms_txt", status: "live" } },
      ],
    };
    const res = await listFixes({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { listFixes: async () => overview } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ domain: "acme.com", platform: "wordpress", top: "business_facts", fixes: overview.fixes, platforms: overview.platforms });
    expect(res.data.summary).toContain("Your business facts, ready to paste");
    expect(res.data.summary).toContain("AI assistants get your city wrong.");
  });

  it("no top fix: says none is needed that the platform can take", async () => {
    const res = await listFixes({ domain: "acme.com" }, makeDeps({
      tier: "pro",
      client: { listFixes: async () => ({ site: { domain: "acme.com" }, platform: "unknown", platforms: [], top: null, fixes: [] }) },
    }));
    if (!res.ok) throw new Error("expected an overview");
    expect(res.data.top).toBeNull();
    expect(res.data.summary).toMatch(/no fix/i);
  });
});

describe("review round 1", () => {
  it("a fix the platform most likely can't take says so, rather than to paste it", async () => {
    const fix = { ...FIX, kind: "llms_txt", steps: { ...FIX.steps, label: "Wix", can_apply: false, note: "Most website builders can't serve a file at your domain's root." } };
    const res = await getFix({ domain: "acme.com", kind: "llms_txt" }, makeDeps({ tier: "pro", client: { getFix: async () => ({ request: REQUEST, fix }) } }));
    if (!res.ok) throw new Error("expected a fix");
    expect(res.data.message).toContain("most likely can't take it");
    expect(res.data.message).not.toContain("ready to apply");
  });

  it("an unknown platform asks the owner which one it is", async () => {
    const fix = { ...FIX, steps: { ...FIX.steps, label: "Not sure", picker: [{ key: "wordpress", label: "WordPress" }] } };
    const res = await getFix({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getFix: async () => ({ request: REQUEST, fix }) } }));
    if (!res.ok) throw new Error("expected a fix");
    expect(res.data.message).toContain("`platform`");
  });

  it("a confirm_first without a reason reports none, never a guessed one", async () => {
    const fn = () => {
      throw new WaApiError("CONFIRM_FIRST", "Confirm your business facts first.", { status: 409, details: { code: "confirm_first", confirm: CONFIRM, seen: SEEN } });
    };
    const res = await getFix({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getFix: fn } }));
    if (!res.ok || res.data.status !== "confirm_first") throw new Error("expected confirm_first");
    expect(res.data.reason).toBe("unknown");
  });
});

describe("review round 2", () => {
  it("list_fixes says a request's status in words, and what the platform can't take", async () => {
    const res = await listFixes({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { listFixes: async () => ({
      top: null,
      fixes: [
        { kind: "business_facts", title: "Business facts", needed: true, request: { ...REQUEST, status: "missing" } },
        { kind: "llms_txt", title: "llms.txt", needed: true, can_apply: false, request: null },
      ],
    }) } }));
    if (!res.ok) throw new Error("expected the overview");
    expect(res.data.summary).toContain("didn't find it live yet");
    expect(res.data.summary).not.toContain("request is missing");
    expect(res.data.summary).toContain("can't take it");
  });

  it("get_fix_facts reads the block's own can_confirm", async () => {
    const res = await getFixFacts({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { getFixFacts: async () => ({ confirm: CONFIRM, name: "" }) } }));
    if (!res.ok) throw new Error("expected the facts");
    expect(res.data.can_confirm).toBe(false);
    expect(res.data.message).not.toContain("hasn't been read");
  });
});

describe("review round 3", () => {
  it("a fix found live is said as live, not as still needed", async () => {
    const res = await listFixes({ domain: "acme.com" }, makeDeps({ tier: "pro", client: { listFixes: async () => ({
      top: null,
      fixes: [{ kind: "business_facts", title: "Business facts", needed: true, why: "Not stated.", request: { ...REQUEST, status: "live" } }],
    }) } }));
    if (!res.ok) throw new Error("expected the overview");
    expect(res.data.summary).toContain("found live");
    expect(res.data.summary).not.toContain(": needed");
  });

  it("facts_changed's next step comes from the code, not the API's sentence", async () => {
    const fn = () => {
      throw new WaApiError("FACTS_CHANGED", "Something else entirely.", { status: 409, details: { code: "facts_changed", confirm: CONFIRM } });
    };
    const res = await confirmFacts({ domain: "acme.com", facts: { city: "Hilo, HI" }, seen: SEEN }, makeDeps({ tier: "pro", client: { confirmFacts: fn } }));
    if (!res.ok) throw new Error("expected a result");
    expect(res.data.message).toContain("get_fix_facts");
  });
});
