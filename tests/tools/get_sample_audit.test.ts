import { describe, it, expect } from "vitest";
import { getSampleAudit } from "../../src/tools/sampleAudit.js";
import { makeDeps, testConfig } from "../helpers.js";
import { RESTART_NOTE, type ToolDeps } from "../../src/tools/context.js";
import type { WaApiClientLike } from "../../src/api/client.js";
import type { SubscriptionProvider } from "../../src/auth/entitlements.js";
import type { AuditCache } from "../../src/auth/auditCache.js";
import { NoopEventSink } from "../../src/telemetry/events.js";

/**
 * get_sample_audit is the only tool a developer with no key can call, so its
 * whole value rests on working when nothing else does — no key, no
 * subscription, no network, API down.
 *
 * "Doesn't call the network" is exactly the kind of claim a test can appear to
 * cover while asserting nothing, so the client and subscription provider are
 * booby-trapped rather than mocked: every method throws. If the tool reaches
 * for either, these tests fail loudly instead of passing for the wrong reason.
 */
function explodingDeps(over: Partial<ToolDeps> = {}): ToolDeps {
  const boom = (what: string) => () => {
    throw new Error(`get_sample_audit must not touch ${what} — it has to work with no key and no network`);
  };
  const client = new Proxy({} as WaApiClientLike, { get: (_t, prop) => boom(`the API client (.${String(prop)})`) });
  const subscriptions = new Proxy({} as SubscriptionProvider, { get: (_t, prop) => boom(`the subscription provider (.${String(prop)})`) });
  const cache = new Proxy({} as AuditCache, { get: (_t, prop) => boom(`the audit cache (.${String(prop)})`) });
  return {
    config: testConfig({ apiKey: undefined }),
    client,
    subscriptions,
    cache,
    events: new NoopEventSink(),
    ...over,
  };
}

describe("get_sample_audit [Free, no key]", () => {
  it("succeeds with no API key configured", async () => {
    const res = await getSampleAudit({}, explodingDeps());
    expect(res.ok).toBe(true);
  });

  it("succeeds with an invalid key, without validating it", async () => {
    // A bad key must not degrade the demo — the point is to show the product
    // before anyone has a good key at all.
    const res = await getSampleAudit({}, explodingDeps({ config: testConfig({ apiKey: "wa_totally_invalid" }) }));
    expect(res.ok).toBe(true);
  });

  it("makes no network call and consults no subscription — the exploding deps prove it", async () => {
    // Passes only because nothing above threw.
    const res = await getSampleAudit({}, explodingDeps());
    expect(res.ok).toBe(true);
  });

  it("is unmistakably marked as sample data", async () => {
    const res = await getSampleAudit({}, explodingDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Canned output must never read as a real audit of the caller's own site.
    expect(res.data.is_sample).toBe(true);
    expect(res.data.domain).toBe("example.com");
    expect(res.data.note.toLowerCase()).toContain("sample");
  });

  it("carries the price and the upgrade URL, so the model can quote both", async () => {
    const res = await getSampleAudit({}, explodingDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.price).toContain("$10");
    expect(res.data.upgrade_url).toContain("admin_portal");
  });

  it("returns a real-shaped audit, not a stub — it has to show what is actually bought", async () => {
    const res = await getSampleAudit({}, explodingDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const audit = res.data.audit;
    expect(audit.summary.pass_rate).toBeTypeOf("number");
    expect(Array.isArray(audit.results)).toBe(true);
    expect(audit.results.length).toBeGreaterThan(0);
    // The AI-visibility block is the differentiator and the reason to subscribe.
    expect(audit.ai_visibility?.overall_score).toBeTypeOf("number");
    expect(Object.keys(audit.ai_visibility?.platform_scores ?? {}).length).toBeGreaterThan(0);
  });

  it("takes no arguments — it cannot be pointed at a caller's domain", async () => {
    // If it accepted a domain, canned data would masquerade as a real result for
    // that site. Extra args are ignored rather than honoured.
    const res = await getSampleAudit({ domain: "acme.com" } as Record<string, never>, explodingDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.domain).toBe("example.com");
  });
});

/**
 * The note is the only copy on this tool, and this tool is the only one a
 * keyless hosted caller can invoke — the first thing a marketplace reviewer or
 * an unauthenticated user sees. Mutation testing found the whole hunk here
 * revertible to its pre-branch text with CI green: nothing asserted the
 * key-setup sentence, and the shared deps helper never sets `transport`, so the
 * hosted branch was never reached.
 */
describe("get_sample_audit: the setup note", () => {
  it("tells a keyless stdio caller where the key goes, restart included", async () => {
    const res = await getSampleAudit({}, makeDeps({ config: { apiKey: undefined } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.note).toContain("WA_API_KEY");
    expect(res.data.note).toMatch(/restart/i);
  });

  it("names the header for a keyless hosted caller, never the env var", async () => {
    const res = await getSampleAudit({}, {
      ...makeDeps({ config: { apiKey: undefined } }),
      transport: "http" as const,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.note).toMatch(/Authorization: Bearer/);
    expect(res.data.note).toMatch(/X-API-Key/);
    expect(res.data.note).not.toContain("WA_API_KEY");
    // Not "no mention of restarting" — the hosted text deliberately says there
    // is NOTHING to restart, the sentence that closes the loop for a reader who
    // has heard "restart your client" from every other MCP server. What must be
    // absent is the stdio instruction itself.
    expect(res.data.note).toContain("nothing to restart");
    expect(res.data.note).not.toContain(RESTART_NOTE);
  });

  it("says nothing about setup to a caller who already has a key", async () => {
    // The regression this replaces: the note was appended unconditionally, so a
    // paying subscriber running the demo was told to set a key and restart
    // their client — which reads as "your key isn't working".
    for (const transport of ["stdio", "http"] as const) {
      const res = await getSampleAudit({}, {
        ...makeDeps({ config: { apiKey: "wa_live_key" } }),
        transport,
      });
      expect(res.ok, transport).toBe(true);
      if (!res.ok) return;
      expect(res.data.note, transport).not.toMatch(/WA_API_KEY|restart|Authorization/);
      // Still states what a real audit needs — the requirement is not the
      // instruction, and dropping both would be its own kind of silence.
      expect(res.data.note, transport).toMatch(/subscription/i);
    }
  });
});

/**
 * chaos_tester #447: real reports carry `ai_visibility.sources` — the ranked
 * cited-documents list. The header of sampleData.ts promises "the exact shape
 * a real audit returns", so the sample must carry it too, and carry it in a
 * form the real engine could actually produce: upstream injects `sources` ONLY
 * when at least one `all_results` row holds a readable `citations` container,
 * so a fixture with `sources` but an empty `all_results` would depict an
 * impossible payload — and tell an evaluating developer the raw per-answer
 * citations are not part of what they'd buy, which is false.
 */
describe("get_sample_audit: cited sources", () => {
  const sources = async () => {
    const res = await getSampleAudit({}, explodingDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    return { sources: res.data.audit.ai_visibility.sources!, audit: res.data.audit };
  };

  it("carries ai_visibility.sources in the documented entry shape", async () => {
    const { sources: rows } = await sources();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["answers", "domain", "ownership", "platforms", "title", "url"]);
      expect(["yours", "competitor", "third_party"]).toContain(row.ownership);
    }
    // All three ownership kinds appear, so the demo shows what the field is FOR.
    expect(new Set(rows.map((r) => r.ownership))).toEqual(new Set(["yours", "competitor", "third_party"]));
  });

  it("a source with no linkable page has url null AND an empty title — never a fabricated link", async () => {
    const { sources: rows } = await sources();
    const unlinkable = rows.filter((r) => r.url === null);
    expect(unlinkable.length).toBeGreaterThan(0);
    for (const row of unlinkable) expect(row.title).toBe("");
  });

  it("ranks by cross-engine agreement, then answers, then domain — the documented order", async () => {
    const { sources: rows } = await sources();
    const resorted = [...rows].sort(
      (a, b) => b.platforms.length - a.platforms.length || b.answers - a.answers || a.domain.localeCompare(b.domain),
    );
    expect(rows).toEqual(resorted);
  });

  it("every ranked domain is backed by a citation in all_results — the upstream precondition for the key", async () => {
    const { sources: rows, audit } = await sources();
    // Minimal replica of chaos_tester's citation_domain(): host of the cited
    // url (www-stripped), except through Google's grounding-redirect shim,
    // where only a bare-domain title attributes the citation.
    const SHIMS = ["vertexaisearch.cloud.google.com", "googleusercontent.com"];
    const hostOf = (url: string) =>
      (/^https?:\/\/([^/?#]+)/.exec(url)?.[1] ?? "").toLowerCase().split(":")[0]!.replace(/^www\./, "");
    const citedDomain = (c: { url?: string; title?: string }) => {
      const host = hostOf(c.url ?? "");
      if (!host) return "";
      if (!SHIMS.some((s) => host === s || host.endsWith("." + s))) return host;
      const title = (c.title ?? "").trim().toLowerCase();
      return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(title) ? title : "";
    };
    const allResults = audit.ai_visibility.all_results!;
    expect(allResults.length).toBeGreaterThan(0);
    for (const row of rows) {
      const backing = allResults.filter((r) => (r.citations ?? []).some((c) => citedDomain(c) === row.domain));
      expect(backing.length, row.domain).toBe(row.answers);
      expect(new Set(backing.map((r) => r.platform)), row.domain).toEqual(new Set(row.platforms));
    }
    // And the converse: every attributable cited domain is ranked. The fixture
    // is small enough that nothing can fall off the top-ten cut, so a citation
    // missing from `sources` means the two halves have drifted — a payload the
    // real engine could never emit.
    const cited = new Set(allResults.flatMap((r) => (r.citations ?? []).map(citedDomain).filter(Boolean)));
    expect(cited).toEqual(new Set(rows.map((r) => r.domain)));
  });
});
