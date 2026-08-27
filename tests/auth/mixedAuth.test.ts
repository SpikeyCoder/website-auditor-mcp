/**
 * Mixed Auth — the two halves ChatGPT needs, and the switch that keeps both off.
 *
 * The rejection this work answers came from a listing where every Pro tool
 * returned AUTH_REQUIRED because no credential could reach the server. The
 * failure mode to guard against now is the mirror image: a Mixed Auth setup
 * with only one half wired, which fails SILENTLY — the host simply never offers
 * a login, and every tool answers "not authenticated" forever.
 *
 * So the tests here pin both halves together, and pin the off switch hardest of
 * all: an unconfigured server must be byte-identical to the one that shipped
 * before OAuth existed, because every stdio install and every existing
 * `Authorization: Bearer wa_…` caller is on that path.
 */
import { describe, it, expect } from "vitest";
import {
  looksLikeApiKey,
  oauthEnabled,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  securitySchemesFor,
  wwwAuthenticateChallenge,
} from "../../src/auth/oauth.js";
import { IntrospectionTokenExchange } from "../../src/auth/tokenExchange.js";
import { gateProTool } from "../../src/tools/context.js";
import { toCallResult } from "../../src/mcp/server.js";
import { makeDeps, testConfig } from "../helpers.js";

const OAUTH = {
  oauthIssuer: "https://api.website-auditor.io",
  oauthResourceUrl: "https://mcp.website-auditor.io/mcp",
  oauthScope: "audit",
};

describe("oauthEnabled — both halves or nothing", () => {
  it("is off by default, which is what keeps every pre-OAuth caller unchanged", () => {
    expect(oauthEnabled(testConfig())).toBe(false);
  });

  it("treats a half-configured pair as unset rather than publishing a broken document", () => {
    expect(oauthEnabled(testConfig({ oauthIssuer: OAUTH.oauthIssuer }))).toBe(false);
    expect(oauthEnabled(testConfig({ oauthResourceUrl: OAUTH.oauthResourceUrl }))).toBe(false);
  });

  it("is on only when both an issuer and a resource identifier are present", () => {
    expect(oauthEnabled(testConfig(OAUTH))).toBe(true);
  });
});

describe("protected-resource metadata (RFC 9728)", () => {
  it("is absent entirely when OAuth is not configured", () => {
    expect(protectedResourceMetadata(testConfig())).toBeUndefined();
  });

  it("names the resource, the authorization server, the scope and header-only bearers", () => {
    expect(protectedResourceMetadata(testConfig(OAUTH))).toEqual({
      resource: "https://mcp.website-auditor.io/mcp",
      authorization_servers: ["https://api.website-auditor.io"],
      scopes_supported: ["audit"],
      bearer_methods_supported: ["header"],
    });
  });

  it("derives its own URL from the resource ORIGIN, not the resource path", () => {
    // The document lives at the origin root even though the resource itself is
    // at /mcp — a client that found the resource looks for its metadata there.
    expect(protectedResourceMetadataUrl("https://mcp.website-auditor.io/mcp")).toBe(
      "https://mcp.website-auditor.io/.well-known/oauth-protected-resource",
    );
  });

  it("degrades to the bare path instead of throwing on an unparseable resource", () => {
    expect(protectedResourceMetadataUrl("not a url")).toBe("/.well-known/oauth-protected-resource");
  });
});

describe("the WWW-Authenticate challenge", () => {
  it("is withheld when OAuth is off — a challenge without discovery is a dead end", () => {
    expect(wwwAuthenticateChallenge(testConfig(), "nope")).toBeUndefined();
  });

  it("carries the metadata pointer, the scope, and the error pair the Apps SDK requires", () => {
    const challenge = wwwAuthenticateChallenge(testConfig(OAUTH), "Connect an account.")!;
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(
      'resource_metadata="https://mcp.website-auditor.io/.well-known/oauth-protected-resource"',
    );
    expect(challenge).toContain('scope="audit"');
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain('error_description="Connect an account."');
    // Comma-delimited auth-param list, so a parser sees four parameters.
    expect(challenge.split(", ")).toHaveLength(4);
  });

  it("folds quotes in the description so they cannot terminate the quoted string early", () => {
    const challenge = wwwAuthenticateChallenge(testConfig(OAUTH), 'say "hello" now')!;
    expect(challenge).toContain("error_description=\"say 'hello' now\"");
    expect(challenge.split(", ")).toHaveLength(4);
  });
});

describe("securitySchemes — derived from the registry's own tier", () => {
  it("publishes nothing at all when OAuth is off", () => {
    expect(securitySchemesFor("pro", testConfig())).toBeUndefined();
    expect(securitySchemesFor("free", testConfig())).toBeUndefined();
  });

  it("marks pro tools oauth2 with the configured scope", () => {
    expect(securitySchemesFor("pro", testConfig(OAUTH))).toEqual([{ type: "oauth2", scopes: ["audit"] }]);
  });

  it("marks free tools noauth, so the sample stays reachable without a login", () => {
    expect(securitySchemesFor("free", testConfig(OAUTH))).toEqual([{ type: "noauth" }]);
  });
});

describe("looksLikeApiKey — telling our key from an access token at the same header", () => {
  it("recognizes our own keys", () => {
    expect(looksLikeApiKey("wa_live_abc")).toBe(true);
  });

  it("does not claim an opaque access token", () => {
    expect(looksLikeApiKey("eyJhbGciOi.some.jwt")).toBe(false);
    expect(looksLikeApiKey("at_opaque_token")).toBe(false);
  });
});

describe("IntrospectionTokenExchange", () => {
  const cfg = testConfig({ ...OAUTH, oauthIntrospectionUrl: "https://api.website-auditor.io/api/oauth/introspect" });

  function exchangeWith(impl: typeof fetch, over: Partial<typeof cfg> = {}, now = () => 0) {
    return new IntrospectionTokenExchange({ ...cfg, ...over }, impl, now);
  }

  const jsonResponse = (body: unknown, ok = true) =>
    ({ ok, json: async () => body }) as unknown as Response;

  it("exchanges an active token for the account's key", async () => {
    const ex = exchangeWith(async () => jsonResponse({ active: true, api_key: "wa_from_token" }));
    expect(await ex.resolve("opaque")).toBe("wa_from_token");
  });

  it("answers nothing for an inactive token", async () => {
    const ex = exchangeWith(async () => jsonResponse({ active: false }));
    expect(await ex.resolve("opaque")).toBeUndefined();
  });

  it("answers nothing — never throws — when introspection is unreachable", async () => {
    const ex = exchangeWith(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await ex.resolve("opaque")).toBeUndefined();
  });

  it("answers nothing on a non-2xx, rather than trusting the body", async () => {
    const ex = exchangeWith(async () => jsonResponse({ active: true, api_key: "wa_x" }, false));
    expect(await ex.resolve("opaque")).toBeUndefined();
  });

  it("treats an active token with no key as unauthenticated, not as a key of ''", async () => {
    const ex = exchangeWith(async () => jsonResponse({ active: true, api_key: "" }));
    expect(await ex.resolve("opaque")).toBeUndefined();
  });

  it("authenticates ITSELF to the endpoint — an open introspector is a token oracle", async () => {
    const seen: RequestInit[] = [];
    const ex = exchangeWith(
      async (_u, init) => {
        seen.push(init as RequestInit);
        return jsonResponse({ active: true, api_key: "wa_k" });
      },
      { oauthIntrospectionSecret: "s3cret" },
    );
    await ex.resolve("opaque");
    const headers = seen[0]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer s3cret");
    expect(String(seen[0]!.body)).toContain("token=opaque");
  });

  it("does not call introspection at all when no endpoint is configured", async () => {
    let calls = 0;
    const ex = exchangeWith(
      async () => {
        calls += 1;
        return jsonResponse({ active: true, api_key: "wa_k" });
      },
      { oauthIntrospectionUrl: undefined },
    );
    expect(await ex.resolve("opaque")).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("caches a positive result instead of introspecting on every tool call", async () => {
    let calls = 0;
    const ex = exchangeWith(async () => {
      calls += 1;
      return jsonResponse({ active: true, api_key: "wa_k" });
    });
    await ex.resolve("opaque");
    await ex.resolve("opaque");
    expect(calls).toBe(1);
  });

  it("purges expired entries rather than growing a map for every string ever presented", async () => {
    let clock = 0;
    const ex = exchangeWith(async () => jsonResponse({ active: false }), {}, () => clock);
    for (let i = 0; i < 50; i += 1) await ex.resolve(`junk-${i}`);
    expect(ex.size()).toBe(50);
    // Past the negative TTL: the next resolve sweeps every stale entry, so a
    // flood of tokens that can never authenticate does not accumulate.
    clock = 10_000;
    await ex.resolve("junk-fresh");
    expect(ex.size()).toBe(1);
  });

  it("stays bounded even when nothing has expired yet", async () => {
    // All positives, one clock tick, so the TTL sweep can free nothing and only
    // the hard cap is holding the line.
    const ex = exchangeWith(async () => jsonResponse({ active: true, api_key: "wa_k" }));
    for (let i = 0; i < 5_050; i += 1) await ex.resolve(`tok-${i}`);
    expect(ex.size()).toBeLessThanOrEqual(5_000);
  });

  it("expires a negative far sooner than a positive — a token is invalid right up until login completes", async () => {
    let calls = 0;
    let clock = 0;
    const ex = exchangeWith(
      async () => {
        calls += 1;
        return jsonResponse(calls === 1 ? { active: false } : { active: true, api_key: "wa_k" });
      },
      {},
      () => clock,
    );
    expect(await ex.resolve("opaque")).toBeUndefined();
    // Still inside the negative window: no second call, still nothing.
    clock = 4_000;
    expect(await ex.resolve("opaque")).toBeUndefined();
    expect(calls).toBe(1);
    // Past it — the user has finished signing in and the same token now works.
    clock = 6_000;
    expect(await ex.resolve("opaque")).toBe("wa_k");
    expect(calls).toBe(2);
  });
});

describe("gateProTool — the runtime half, and who gets it", () => {
  async function authError(over: Parameters<typeof makeDeps>[0], transport?: "stdio" | "http") {
    const deps = { ...makeDeps(over), transport };
    const result = await gateProTool(deps);
    expect(result && result.ok).toBe(false);
    return result!.ok === false ? result.error : undefined!;
  }

  it("attaches the challenge on the hosted transport when Mixed Auth is configured", async () => {
    const error = await authError({ tier: "none", config: { ...OAUTH, apiKey: undefined } }, "http");
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.wwwAuthenticate).toContain("resource_metadata=");
    // The copy has to match the mechanism: nobody pastes a key on this surface.
    expect(error.message).toContain("connected Website Auditor account");
    expect(error.message).not.toContain("restart");
  });

  it("keeps the original key-setup copy, and no challenge, when OAuth is off", async () => {
    const error = await authError({ tier: "none", config: { apiKey: undefined } }, "http");
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.wwwAuthenticate).toBeUndefined();
    expect(error.message).toContain("requires a Website Auditor API key");
  });

  it("never challenges over stdio — there is no login to open in a local process", async () => {
    const error = await authError({ tier: "none", config: { ...OAUTH, apiKey: undefined } }, "stdio");
    expect(error.wwwAuthenticate).toBeUndefined();
    expect(error.message).toContain("requires a Website Auditor API key");
  });

  it("re-offers the login when a DERIVED key has expired, instead of naming a key nobody pasted", async () => {
    // The 60s key cache means a derived key can expire mid-window and come
    // back REVOKED_KEY through no fault of the user. Telling them to create a
    // replacement in the portal is advice for a credential they never had.
    const error = await authError(
      {
        subscriptions: { resolve: async () => ({ tier: "invalid" as const, verified: true, rejection: "REVOKED_KEY" as const }) },
        config: { ...OAUTH, apiKey: "wa_dead" },
      },
      "http",
    );
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.wwwAuthenticate).toContain("resource_metadata=");
    expect(error.message).toContain("expired");
    expect(error.message).not.toContain("replace");
  });

  it("keeps the replace-your-key copy for a revoked key when OAuth is off", async () => {
    const error = await authError(
      {
        subscriptions: { resolve: async () => ({ tier: "invalid" as const, verified: true, rejection: "REVOKED_KEY" as const }) },
        config: { apiKey: "wa_dead" },
      },
      "http",
    );
    expect(error.code).toBe("REVOKED_KEY");
    expect(error.wwwAuthenticate).toBeUndefined();
    expect(error.message).toContain("replace the key");
  });

  it("still answers PRO_REQUIRED — not a login — for a connected account without a subscription", async () => {
    // The second gate. Challenging here would loop a signed-in user back
    // through a login that cannot fix what is actually wrong.
    const error = await authError({ tier: "free", config: { ...OAUTH, apiKey: "wa_k" } }, "http");
    expect(error.code).toBe("PRO_REQUIRED");
    expect(error.wwwAuthenticate).toBeUndefined();
  });
});

describe("toCallResult — the challenge is transport metadata, not payload", () => {
  it("lifts it to _meta and strips it from what the model reads", () => {
    const result = toCallResult({
      ok: false,
      error: { code: "AUTH_REQUIRED", message: "connect", wwwAuthenticate: "Bearer resource_metadata=\"x\"" },
    });
    expect(result._meta).toEqual({ "mcp/www_authenticate": 'Bearer resource_metadata="x"' });
    expect(result.structuredContent).not.toHaveProperty("wwwAuthenticate");
    expect(String(result.content[0]!.text)).not.toContain("wwwAuthenticate");
  });

  it("emits no _meta at all when there is no challenge", () => {
    const result = toCallResult({ ok: false, error: { code: "PRO_REQUIRED", message: "subscribe" } });
    expect(result._meta).toBeUndefined();
  });
});
