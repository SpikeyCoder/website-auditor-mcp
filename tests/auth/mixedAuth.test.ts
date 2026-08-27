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
import { fromApiError, gateProTool } from "../../src/tools/context.js";
import { WaApiError } from "../../src/api/errors.js";
import { toCallResult } from "../../src/mcp/server.js";
import { buildInstructions } from "../../src/mcp/instructions.js";
import { makeDeps, testConfig } from "../helpers.js";
import { loadConfig } from "../../src/config.js";

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

  it("requires them to be real URLs, not merely non-empty", () => {
    // A truthy-only test turned Mixed Auth fully on for a value that is not a
    // URL: a 200 metadata document with an invalid resource, and challenges
    // carrying a bare relative path no client can resolve.
    expect(oauthEnabled(testConfig({ ...OAUTH, oauthResourceUrl: "mcp.website-auditor.io/mcp" }))).toBe(false);
    expect(oauthEnabled(testConfig({ ...OAUTH, oauthIssuer: "not a url" }))).toBe(false);
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
    expect(securitySchemesFor("pro", testConfig(), "http")).toBeUndefined();
    expect(securitySchemesFor("free", testConfig(), "http")).toBeUndefined();
  });

  it("marks pro tools oauth2 with the configured scope", () => {
    expect(securitySchemesFor("pro", testConfig(OAUTH), "http")).toEqual([{ type: "oauth2", scopes: ["audit"] }]);
  });

  it("marks free tools noauth, so the sample stays reachable without a login", () => {
    expect(securitySchemesFor("free", testConfig(OAUTH), "http")).toEqual([{ type: "noauth" }]);
  });

  it("publishes nothing over stdio, which can never answer the login it would advertise", () => {
    // Half a Mixed Auth setup fails silently: a stdio process with the OAuth
    // variables set would offer oauth2 on thirteen tools and be structurally
    // unable to emit a challenge.
    expect(securitySchemesFor("pro", testConfig(OAUTH), "stdio")).toBeUndefined();
    expect(securitySchemesFor("pro", testConfig(OAUTH), undefined)).toBeUndefined();
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

  it("dates a negative from when it was STORED, not from before a slow introspection", async () => {
    // requestTimeoutMs is 120s by default, so a degraded endpoint could take
    // far longer than the 5s negative window. Dating the entry from before the
    // await wrote negatives that were already expired, and the flood bound
    // vanished exactly when the endpoint could least absorb it.
    let clock = 0;
    let calls = 0;
    const ex = exchangeWith(
      async () => {
        clock += 30_000;
        calls += 1;
        return jsonResponse({ active: false });
      },
      {},
      () => clock,
    );
    await ex.resolve("opaque");
    expect(calls).toBe(1);
    await ex.resolve("opaque");
    expect(calls).toBe(1);
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
  async function authError(
    over: Parameters<typeof makeDeps>[0],
    transport?: "stdio" | "http",
    authVia?: "oauth" | "key",
  ) {
    const deps = { ...makeDeps(over), transport, authVia };
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
      "oauth",
    );
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.wwwAuthenticate).toContain("resource_metadata=");
    expect(error.message).toContain("expired");
    expect(error.message).not.toContain("replace");
  });

  it("leaves a PASTED key's rejection alone, even with OAuth configured", async () => {
    // http.ts promises curl, Codex and README callers byte-identical behaviour,
    // and their key is a key. Answering "there is no key to paste — reconnect
    // when prompted", with a challenge for a login they never started, breaks
    // exactly that promise and drops the upstream remediation.
    const error = await authError(
      {
        subscriptions: { resolve: async () => ({ tier: "invalid" as const, verified: true, rejection: "REVOKED_KEY" as const }) },
        config: { ...OAUTH, apiKey: "wa_pasted" },
      },
      "http",
      "key",
    );
    expect(error.code).toBe("REVOKED_KEY");
    expect(error.wwwAuthenticate).toBeUndefined();
    expect(error.message).toContain("replace the key");
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

describe("handshake instructions", () => {
  it("stop telling the model to obtain a key once Mixed Auth is live", () => {
    // These are the first thing the model reads. Leaving the header
    // instruction in place made them contradict the "there is no key to paste"
    // copy every tool returns later — two procedures, no way to choose.
    const mixed = buildInstructions("https://website-auditor.io/?source=mcp", "info", "http", true);
    expect(mixed).toContain("connect a Website Auditor account");
    expect(mixed).not.toContain("connector's authentication field");
    // The earlier version of this test checked only that the delivery clause
    // changed, which let the SUBSCRIPTION sentence keep saying "creating an API
    // key happen on the website" three words before "there is no key to paste".
    expect(mixed).not.toContain("creating an API key");
    expect(mixed).not.toContain("create an API key");
    // AUTH_REQUIRED now also carries an expired connection, so answering it
    // with a price would sell somebody a plan they already have.
    expect(mixed).toContain("reconnect when prompted");
    expect(mixed).toContain("do not quote a price for it");

    const plain = buildInstructions("https://website-auditor.io/?source=mcp", "info", "http", false);
    expect(plain).toContain("connector's authentication field");
  });
});

describe("fromApiError — where an expired connection ACTUALLY surfaces", () => {
  // gateProTool's matching branch only catches a connection that expired before
  // it was ever used. Once a derived key has resolved once,
  // DefaultSubscriptionProvider returns the cached tier before it tests for a
  // key rejection, so the gate passes and the tool's own call is what 401s.
  it("turns a key rejection into a reconnect, with the challenge", () => {
    const result = fromApiError(
      new WaApiError("REVOKED_KEY", "This API key has been revoked."),
      testConfig(OAUTH),
      "http",
      "oauth",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("AUTH_REQUIRED");
    expect(result.error.wwwAuthenticate).toContain("resource_metadata=");
    expect(result.error.message).toContain("expired");
  });

  it("leaves a pasted key's rejection alone — the credential decides, not the config", () => {
    const asKey = fromApiError(new WaApiError("REVOKED_KEY", "revoked"), testConfig(OAUTH), "http", "key");
    expect(asKey.ok === false && asKey.error.code).toBe("REVOKED_KEY");
    expect(asKey.ok === false && asKey.error.wwwAuthenticate).toBeUndefined();
  });

  it("leaves the upstream answer alone when OAuth is off", () => {
    const result = fromApiError(new WaApiError("REVOKED_KEY", "revoked"), testConfig(), "http", "oauth");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REVOKED_KEY");
    expect(result.error.wwwAuthenticate).toBeUndefined();
  });

  it("leaves it alone over stdio, and leaves non-key errors alone entirely", () => {
    const overStdio = fromApiError(new WaApiError("REVOKED_KEY", "revoked"), testConfig(OAUTH), "stdio", "oauth");
    expect(overStdio.ok === false && overStdio.error.code).toBe("REVOKED_KEY");
    const quota = fromApiError(new WaApiError("OVER_QUOTA", "slow down"), testConfig(OAUTH), "http", "oauth");
    expect(quota.ok === false && quota.error.code).toBe("OVER_QUOTA");
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

describe("the resource's advertised scopes", () => {
  it("defaults to the single audit scope, so an unset WA_OAUTH_SCOPES changes nothing", () => {
    expect(loadConfig({}).oauthScopes).toEqual(["audit"]);
    expect(loadConfig({ WA_OAUTH_SCOPE: "custom" }).oauthScopes).toEqual(["custom"]);
  });

  it("publishes every scope the authorization requests use, not just the tool's", () => {
    // ChatGPT reads this document to learn what it may ask for. Publishing
    // ["audit"] alone under-declares the resource and is one of the ways a
    // connector ends up unable to offer enterprise domain restrictions.
    const config = testConfig({ ...OAUTH, oauthScopes: ["audit", "openid", "email"] });
    expect(protectedResourceMetadata(config)).toMatchObject({
      scopes_supported: ["audit", "openid", "email"],
    });
  });

  it("splits WA_OAUTH_SCOPES on whitespace and drops empties", () => {
    expect(loadConfig({ WA_OAUTH_SCOPES: "  audit   openid  email " }).oauthScopes)
      .toEqual(["audit", "openid", "email"]);
  });

  it("leaves the challenge and the per-tool scheme naming the AUDIT scope alone", () => {
    // A tool needs the audit capability, never an identity claim, so widening
    // the resource document must not widen either of these.
    const config = testConfig({ ...OAUTH, oauthScopes: ["audit", "openid", "email"] });
    expect(wwwAuthenticateChallenge(config, "nope")).toContain('scope="audit"');
    expect(securitySchemesFor("pro", config, "http")).toEqual([{ type: "oauth2", scopes: ["audit"] }]);
  });
});
