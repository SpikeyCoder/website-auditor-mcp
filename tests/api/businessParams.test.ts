/**
 * The caller can name the business and its city — and we stop inventing one.
 *
 * TWO BUGS, ONE CAUSE. The tool schemas accepted `domain` and nothing else, so
 * every call site passed `{ domain }`. The client then filled the gaps:
 *
 *   businessName: params.businessName?.trim() || deriveBusinessName(host)
 *   businessCity: params.businessCity?.trim() || CITY_SENTINEL   // " "
 *
 * 1. THE MANUFACTURED NAME. `deriveBusinessName` turns "hawaiibackroad.com"
 *    into "Hawaiibackroad" — a name the business does not have. Upstream, a
 *    supplied business_name OVERRIDES detection outright and is stamped
 *    `user_supplied`, the most trusted provenance there is, so chaos_tester
 *    #334's name_warning can never fire. Every MCP audit therefore scored a
 *    hostname slug and reported it as if a human had confirmed it. This is the
 *    exact failure #334 exists to catch, applied to 100% of MCP audits.
 *
 * 2. THE CITY SENTINEL. " " existed to satisfy the upstream's old naive
 *    `if (!businessCity)` check. That check was hardened on 2026-08-01 to
 *    reject blanks — the fix for the Council Bluffs incident — so the sentinel
 *    became a guaranteed 400. api PR #42 makes both fields optional and
 *    normalises blanks to absent, so the workaround can go entirely.
 *
 * WHAT ABSENT MUST MEAN. Not "" and not " " — the parameter simply is not
 * sent, so the engine detects the business itself and labels what it found.
 * Sending an empty string would be the same bug wearing a different value.
 */
import { describe, it, expect } from "vitest";
import { WaApiClient } from "../../src/api/client.js";

function clientWith(captured: URL[]) {
  const fetchImpl = (async (url: URL | string) => {
    captured.push(new URL(String(url)));
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ run_id: "r1", audit: { run_id: "r1", results: [] } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return new WaApiClient(
    { apiBaseUrl: "https://api.test", apiKey: "wa_k", requestTimeoutMs: 5000 } as never,
    { fetch: fetchImpl },
  );
}

describe("the client stops inventing a business name", () => {
  it("sends no businessName when the caller gave none", async () => {
    const seen: URL[] = [];
    await clientWith(seen).runAudit({ domain: "hawaiibackroad.com" });
    // Absent, not "Hawaiibackroad" — the engine must be free to detect, and
    // to warn when what it detects is unverified.
    expect(seen[0].searchParams.has("businessName")).toBe(false);
  });

  it("sends no businessCity when the caller gave none", async () => {
    const seen: URL[] = [];
    await clientWith(seen).runAudit({ domain: "hawaiibackroad.com" });
    expect(seen[0].searchParams.has("businessCity")).toBe(false);
  });

  it("never sends the old whitespace sentinel", async () => {
    // A " " is now a 400 upstream, and before that it was the value that put a
    // Hawaii tour company in Council Bluffs.
    const seen: URL[] = [];
    await clientWith(seen).runAudit({ domain: "example.com" });
    for (const [, v] of seen[0].searchParams) expect(v.trim()).not.toBe("");
  });
});

describe("supplied values are forwarded", () => {
  it("passes a caller-supplied name and city through, trimmed", async () => {
    const seen: URL[] = [];
    await clientWith(seen).runAudit({
      domain: "hawaiibackroad.com",
      businessName: "  Big Island Backroad Adventures ",
      businessCity: " Hilo, HI ",
    });
    expect(seen[0].searchParams.get("businessName")).toBe("Big Island Backroad Adventures");
    expect(seen[0].searchParams.get("businessCity")).toBe("Hilo, HI");
  });

  it("treats a blank string from the caller as absent", async () => {
    const seen: URL[] = [];
    await clientWith(seen).runAudit({
      domain: "example.com", businessName: "   ", businessCity: "  ",
    });
    expect(seen[0].searchParams.has("businessName")).toBe(false);
    expect(seen[0].searchParams.has("businessCity")).toBe(false);
  });

  it("still always sends the domain", async () => {
    const seen: URL[] = [];
    await clientWith(seen).runAudit({ domain: "example.com" });
    expect(seen[0].searchParams.get("businessUrl")).toBe("example.com");
  });
});
