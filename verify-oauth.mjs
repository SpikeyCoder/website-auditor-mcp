#!/usr/bin/env node
/**
 * The whole OAuth lifecycle against PRODUCTION — the authorization server, and
 * then the MCP that consumes it. Steps 1-6 and 8 exercise the API; step 7
 * exercises the deployed MCP, including the one failure the curl checks in the
 * runbook cannot see (a mismatched introspection secret, which leaves every
 * structural check green and breaks every real login).
 *
 *   node verify-oauth.mjs
 *
 * Needs, in the environment:
 *   OAUTH_INTROSPECTION_SECRET   the value you just set on Cloud Run
 *   WA_API_BASE_URL              optional, defaults to https://api.website-auditor.io
 *   WA_MCP_BASE_URL              optional, defaults to https://mcp.website-auditor.io
 *
 * You need to be signed in to the portal in your default browser. The script
 * opens one URL there and catches the redirect on 127.0.0.1:8765 — the rest is
 * automatic. If you are NOT signed in, the sign-in happens first and returns
 * through /oauth/authorize/resume, which exercises that path too.
 *
 * Node 20+ (uses global fetch). No dependencies.
 *
 * WHAT IT SPENDS: nothing. Every call is auth/metadata or /api/subscription,
 * which is explicitly not quota-metered. No audit is run.
 *
 * WHAT IT LEAVES BEHIND: one oauth_clients row and one revoked oauth_tokens
 * row, plus the derived api_keys row (revoked). The client_id is printed at the
 * end so it can be deleted.
 */

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const BASE = (process.env.WA_API_BASE_URL || 'https://api.website-auditor.io').replace(/\/+$/, '');
const MCP = (process.env.WA_MCP_BASE_URL || 'https://mcp.website-auditor.io').replace(/\/+$/, '');
const SECRET = process.env.OAUTH_INTROSPECTION_SECRET;
const PORT = 8765;
const REDIRECT = `http://127.0.0.1:${PORT}/cb`;

if (!SECRET) {
  console.error('OAUTH_INTROSPECTION_SECRET is not set. Export the value you put on Cloud Run.');
  process.exit(1);
}

let failed = 0;
const pass = (m, extra = '') => console.log(`  \x1b[32mPASS\x1b[0m  ${m}${extra ? `  ${extra}` : ''}`);
const fail = (m, detail) => { failed++; console.log(`  \x1b[31mFAIL\x1b[0m  ${m}\n        ${detail}`); };
const step = (n, m) => console.log(`\n${n}. ${m}`);

function check(label, cond, detail) {
  cond ? pass(label) : fail(label, detail);
  return cond;
}

async function main() {
  console.log(`\nVerifying OAuth against ${BASE}\n${'─'.repeat(60)}`);

  // ── 1. discovery ────────────────────────────────────────────────────
  step(1, 'Discovery (RFC 8414)');
  const discoRes = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
  if (discoRes.status === 404) {
    fail('discovery document is served',
      'Got 404 — OAUTH_INTROSPECTION_SECRET is not set on the running revision.\n' +
      '        That secret IS the on-switch. Check the deploy actually picked it up.');
    process.exit(1);
  }
  const disco = await discoRes.json();
  check('discovery returns 200', discoRes.status === 200, `got ${discoRes.status}`);
  check('advertises S256 only — never plain',
    JSON.stringify(disco.code_challenge_methods_supported) === '["S256"]',
    `got ${JSON.stringify(disco.code_challenge_methods_supported)}`);
  check('issuer matches the host clients will discover',
    typeof disco.issuer === 'string' && disco.issuer.startsWith('http'),
    `got ${disco.issuer} — if this is not the public origin, clients will reject the endpoints`);
  console.log(`        issuer: ${disco.issuer}`);

  // ── 1b. readable from a browser on another origin ───────────────────
  //
  // Everything else in this file is sent the way curl sends it: no Origin
  // header, and no CORS enforcement of any kind. That blindness cost two
  // rounds. The ChatGPT portal fetches these documents from a BROWSER, on an
  // origin we do not host, and the API's app-wide allowlist did not include it
  // — so the portal reported "OAuth metadata load failed: Failed to fetch",
  // which is what fetch() says for a CORS block and nothing like what an HTTP
  // error says. Every structural check in this script passed throughout.
  //
  // A document a client cannot READ cannot advertise anything to it, so this is
  // a precondition for the rest of the flow, not a detail.
  step('1b', 'The public documents are readable cross-origin  ← what curl cannot see');

  const FOREIGN = 'https://platform.openai.com';
  const PUBLIC_DOCS = [
    [`${BASE}/.well-known/oauth-authorization-server`, 'RFC 8414 metadata'],
    [`${BASE}/.well-known/openid-configuration`, 'OIDC discovery'],
    [`${BASE}/.well-known/jwks.json`, 'JWKS'],
    [`${MCP}/.well-known/oauth-protected-resource`, 'RFC 9728 resource metadata (root form)'],
  ];

  // The SPEC url is checked here too — but its path is READ from the root
  // document rather than written down. Hardcoding `/mcp` hard-fails any
  // deployment whose resource is not /mcp; moving the check to step 7 to avoid
  // that put it behind five process.exit gates and an interactive browser
  // sign-in, so a CORS break went unreported whenever anything earlier failed.
  // Deriving it needs neither compromise, and this stays in the cheap,
  // browserless section its own comment calls "a precondition for the rest of
  // the flow, not a detail".
  try {
    const seed = await (await fetch(`${MCP}/.well-known/oauth-protected-resource`)).json();
    const specPath = `/.well-known/oauth-protected-resource${new URL(seed.resource).pathname.replace(/\/+$/, '')}`;
    if (specPath !== '/.well-known/oauth-protected-resource') {
      PUBLIC_DOCS.push([`${MCP}${specPath}`, 'RFC 9728 resource metadata (spec URL)']);
    }
  } catch {
    // Unreadable or malformed: step 7 diagnoses that properly, with the body in
    // hand. Skipping one CORS check is the right cost for not masking it here.
  }

  for (const [url, label] of PUBLIC_DOCS) {
    const res = await fetch(url, { headers: { Origin: FOREIGN } });
    const allowOrigin = res.headers.get('access-control-allow-origin');
    const allowCreds = res.headers.get('access-control-allow-credentials');

    check(`${label} is readable from another origin`, allowOrigin === '*',
      `${url}\n        answered ${res.status} with Access-Control-Allow-Origin: ${allowOrigin ?? '(absent)'}\n` +
      '        A browser reports this as "Failed to fetch" regardless of the status code.');

    // A wildcard origin alongside Allow-Credentials is rejected outright by
    // every browser for a request in credentials mode `include`. It happens to
    // work for a plain discovery fetch, which is exactly why it survives until
    // it does not.
    check(`${label} does not pair the wildcard with credentials`, allowCreds === null,
      `${url} sent Access-Control-Allow-Credentials: ${allowCreds}`);

    // The PREFLIGHT, separately, because it is answered by the CORS layer
    // before any route handler runs — so a fix applied inside the handlers
    // passes the check above and fails here. The MCP TypeScript SDK sends
    // MCP-Protocol-Version on discovery, which is not a safelisted header, so
    // this is the request the client that matters actually makes.
    const pre = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: FOREIGN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'mcp-protocol-version',
      },
    });
    check(`${label} answers the preflight`, pre.headers.get('access-control-allow-origin') === '*',
      `OPTIONS ${url}\n        answered ${pre.status} with Access-Control-Allow-Origin: ` +
      `${pre.headers.get('access-control-allow-origin') ?? '(absent)'}\n` +
      '        Any client sending a non-safelisted header preflights, and is blocked here.');
  }

  // The other direction, so this cannot pass on a server that has simply become
  // permissive. A one-sided check would read as green on exactly the
  // misconfiguration that matters most.
  const credentialed = await fetch(`${BASE}/api/oauth/introspect`, {
    method: 'POST',
    headers: { Origin: FOREIGN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'token=wao_not_a_real_token',
  });
  check('a credentialed endpoint is NOT wildcarded',
    credentialed.headers.get('access-control-allow-origin') !== '*',
    `/api/oauth/introspect answered with Access-Control-Allow-Origin: * — the allowlist is gone,\n` +
    '        which makes every PASS above meaningless.');

  // ── 2. dynamic client registration ──────────────────────────────────
  step(2, 'Dynamic Client Registration (RFC 7591)');
  const regRes = await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'OAuth verification probe', redirect_uris: [REDIRECT] }),
  });
  const reg = await regRes.json();
  if (!check('a client can self-register', regRes.status === 201, `got ${regRes.status}: ${JSON.stringify(reg)}`)) {
    process.exit(1);
  }
  check('is a public client (PKCE, no secret)', reg.token_endpoint_auth_method === 'none',
    `got ${reg.token_endpoint_auth_method}`);
  console.log(`        client_id: ${reg.client_id}`);

  // ── 3. authorize + consent (the one manual step) ─────────────────────
  step(3, 'Authorize + consent');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(8).toString('hex');
  const authorizeUrl = `${BASE}/oauth/authorize?response_type=code`
    + `&client_id=${encodeURIComponent(reg.client_id)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT)}`
    + `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;

  const caught = new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      if (url.pathname !== '/cb') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' })
        .end('<h2>Done — back to the terminal.</h2>');
      server.close();
      const err = url.searchParams.get('error');
      if (err) return reject(new Error(`${err}: ${url.searchParams.get('error_description') || ''}`));
      resolve({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
    });
    server.listen(PORT);
    setTimeout(() => { server.close(); reject(new Error('timed out after 5 minutes')); }, 300000);
  });

  console.log('\n   Open this in the browser where you are signed in to the portal:\n');
  console.log(`   ${authorizeUrl}\n`);
  console.log('   Click Connect. Waiting for the redirect…');

  let code;
  try {
    const cb = await caught;
    code = cb.code;
    check('state survives the round trip (CSRF)', cb.state === state, `sent ${state}, got ${cb.state}`);
    check('an authorization code came back', Boolean(code), 'no code parameter');
  } catch (e) {
    fail('consent completed', e.message);
    process.exit(1);
  }

  // ── 4. token exchange ───────────────────────────────────────────────
  step(4, 'Token exchange (PKCE verified server-side)');
  const tokRes = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: reg.client_id, code,
      redirect_uri: REDIRECT, code_verifier: verifier,
    }),
  });
  const tok = await tokRes.json();
  if (!check('code exchanges for tokens', tokRes.status === 200, `got ${tokRes.status}: ${JSON.stringify(tok)}`)) {
    process.exit(1);
  }
  check('access token is opaque and prefixed', String(tok.access_token).startsWith('wao_'), tok.access_token);
  check('a refresh token was issued', String(tok.refresh_token || '').startsWith('wor_'), 'missing');

  step('4b', 'The code is single-use');
  const replay = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: reg.client_id, code,
      redirect_uri: REDIRECT, code_verifier: verifier,
    }),
  });
  check('replaying the code is refused', replay.status === 400, `got ${replay.status}`);

  // ── 5. introspection ────────────────────────────────────────────────
  step(5, 'Introspection (RFC 7662) — the MCP\'s side of the contract');
  const introspect = async (token) => {
    const r = await fetch(`${BASE}/api/oauth/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${SECRET}` },
      body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
    });
    return { status: r.status, body: await r.json() };
  };

  const unauth = await fetch(`${BASE}/api/oauth/introspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: tok.access_token }),
  });
  check('refuses an unauthenticated caller (it is a token oracle otherwise)',
    unauth.status === 401, `got ${unauth.status}`);

  const live = await introspect(tok.access_token);
  if (!check('the live token introspects active', live.body.active === true,
    `got ${JSON.stringify(live.body)} (status ${live.status})`)) process.exit(1);
  check('and returns a derived key', String(live.body.api_key || '').startsWith('wa_'), 'no api_key');
  check('scoped to the connected account', Boolean(live.body.sub), 'no sub');

  // ── 6. the derived key actually authenticates ───────────────────────
  step(6, 'The derived key works as an X-API-Key  ← the whole point');
  const subRes = await fetch(`${BASE}/api/subscription`, { headers: { 'X-API-Key': live.body.api_key } });
  const sub = await subRes.json();
  check('it authenticates against the real API', subRes.status === 200,
    `got ${subRes.status}: ${JSON.stringify(sub)}`);
  if (subRes.status === 200) {
    console.log(`        tier: ${sub.tier}   status: ${sub.status}`);
    if (sub.tier !== 'pro') {
      console.log('        NOTE: not a subscriber — a Pro MCP tool will answer PRO_REQUIRED,');
      console.log('              which is correct. AUTH_REQUIRED here would be the bug.');
    }
  }

  // ── 7. the MCP is wired to THIS authorization server ────────────────
  // Everything above proves the API. None of it proves the MCP: `oauthEnabled`
  // gates on the two URL variables alone and never reads the introspection
  // secret, so a server with the WRONG secret still publishes a 200 metadata
  // document and a full set of security schemes, and fails only at the moment
  // a real user tries to log in. 7d is the only check here that catches that.
  step(7, 'The MCP end-to-end  ← what the curl checks cannot see');

  const rpc = async (method, params, token) => {
    const r = await fetch(`${MCP}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* left null; `text` carries the truth */ }
    return { status: r.status, body, text };
  };

  // THE ROOT FORM FIRST — and the ordering is the whole point, twice over.
  //
  // It is the location served in EVERY configuration, including the ones that
  // are broken: an unconfigured server answers it `no oauth configured`, a
  // pre-OAuth image answers it `not found`, and those two bodies are the entire
  // diagnosis below. Probing the spec URL first, as a previous version did,
  // destroyed that: on an unconfigured server the spec path is not registered
  // at all, so it falls into the catch-all and returns `not found` — and this
  // script confidently reported a stale image and told the operator to redeploy
  // when the actual fix was two environment variables.
  //
  // The spec URL is then asserted separately, because a check that only ever
  // asks for the fallback cannot see a broken primary — which is exactly how
  // the 404 on it survived until Cloud Run logs showed ChatGPT taking it.
  const rootUrl = `${MCP}/.well-known/oauth-protected-resource`;
  const prRes = await fetch(rootUrl);
  const prText = (await prRes.text()).trim();
  if (prRes.status !== 200) {
    // The two 404 bodies this server can emit mean different things and point
    // at different fixes. Naming which one came back is the whole diagnosis.
    const cause = prText.includes('no oauth configured')
      ? 'the OAuth build IS deployed, but WA_OAUTH_ISSUER / WA_OAUTH_RESOURCE_URL are\n' +
        '        unset or are not absolute http(s) URLs. Re-run the --update-env-vars step.'
      : prText.includes('not found')
        ? 'the running image PREDATES the OAuth code — that route does not exist in it.\n' +
          '        `gcloud run deploy --source .` builds from the LOCAL directory, so a stale\n' +
          '        checkout deploys successfully and ships nothing. Check `git rev-parse HEAD`\n' +
          '        and that src/auth/oauth.ts is on disk, then redeploy.'
        : `unrecognised body: ${prText.slice(0, 120)}`;
    fail('the MCP serves protected-resource metadata', `got ${prRes.status} — ${cause}`);
    process.exit(1);
  }
  pass('the MCP serves protected-resource metadata');
  const pr = JSON.parse(prText);

  // The RFC 9728 §3.1 location, derived from the resource identifier THE SERVER
  // JUST REPORTED rather than from a literal here. `${MCP}/mcp` was hardcoded,
  // which is the copy this PR's own http.ts comment argues against — and it
  // hard-failed any other legal WA_OAUTH_RESOURCE_URL, including the
  // origin-as-resource shape the server explicitly supports. Reading it back
  // also turns this into a cross-check of the deployed configuration.
  // FIRST: that the identifier itself is right. Everything below derives from
  // `pr.resource`, so on its own it is circular — a server publishing the wrong
  // resource passes every check by agreeing with itself. An operator who set
  // WA_OAUTH_RESOURCE_URL to a bare origin while the endpoint is at /mcp gets a
  // green step 7 and a document naming a URL no client ever POSTs to, which is
  // exactly what this file's .env.example warning exists to prevent.
  //
  // GATED, because everything below parses this value. Reporting it and then
  // calling `new URL(pr.resource)` two lines later turns a friendly FAIL into
  // a HARNESS ERROR that skips 7b, 7c, 7d — including the introspection-secret
  // check this file's header calls the only one that catches a mismatched
  // secret — and step 8. `check()` returns the boolean for exactly this.
  if (!check('the published resource identifier is the URL clients actually POST to',
    pr.resource === `${MCP}/mcp`,
    `document says resource="${pr.resource}", but this script POSTs to ${MCP}/mcp.\n` +
    '        Set WA_OAUTH_RESOURCE_URL to the endpoint URL, path included.')) {
    process.exit(1);
  }

  const specPath = `/.well-known/oauth-protected-resource${new URL(pr.resource).pathname.replace(/\/+$/, '')}`;
  // One fetch, carrying Origin: the route sets Access-Control-Allow-Origin
  // unconditionally and does not vary the body by it, so status, body and the
  // CORS header all come from this single production round trip.
  const specRes = await fetch(`${MCP}${specPath}`, { headers: { Origin: FOREIGN } });
  const specText = (await specRes.text()).trim();
  check('it is served at the RFC 9728 path-inserted URL, which clients build first',
    specRes.status === 200,
    `GET ${specPath} answered ${specRes.status}. A conforming client builds this URL from\n` +
    `        resource="${pr.resource}" and does not have to guess further — so it never\n` +
    '        discovers the authorization server, and the failure looks like OAuth being off.');
  // Two locations are safe only while they cannot disagree.
  if (specRes.status === 200) {
    check('and the two locations answer the same document', specText === prText,
      'the path-inserted and root forms have drifted apart');
    // Step 1b already checked this URL's CORS headers (it derives the same path
    // from the same document). What it cannot send is a preflight, so that is
    // checked here: a browser sends the real GET only if the preflight
    // succeeds, and the MCP SDK sends MCP-Protocol-Version on discovery, so the
    // client that matters always preflights.
    const pre = await fetch(`${MCP}${specPath}`, {
      method: 'OPTIONS',
      headers: { Origin: FOREIGN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'mcp-protocol-version' },
    });
    check('and answers the preflight a browser sends before it',
      pre.headers.get('access-control-allow-origin') === '*',
      `OPTIONS answered ${pre.status} with Access-Control-Allow-Origin: ${pre.headers.get('access-control-allow-origin') ?? '(absent)'}.\n` +
      '        The GET never runs, and the caller sees "Failed to fetch".');
  }

  // A mismatch here is silent and fatal: the host discovers an authorization
  // server that is not the one holding the account, and every login 404s.
  check('it names the issuer discovery just returned',
    Array.isArray(pr.authorization_servers) && pr.authorization_servers[0] === disco.issuer,
    `metadata says ${JSON.stringify(pr.authorization_servers)}, discovery says ${disco.issuer}`);

  // The resource must not UNDER-declare relative to its own authorization
  // server. ChatGPT reads this document to learn what it may ask for, so a
  // resource claiming only `audit` cannot be granted identity scopes however
  // many the AS offers — which is one of the ways a connector ends up unable to
  // offer enterprise domain restrictions, with every other check green.
  //
  // Compared against discovery rather than against a literal, because the pair
  // has to AGREE; pinning either side here would just add a third place to keep
  // in step. The MCP's list defaults to its single audit scope, so a build
  // carrying the wider list still serves the narrow one until WA_OAUTH_SCOPES
  // is actually set — this checks the document, not the intent.
  const asScopes = [...(disco.scopes_supported ?? [])].sort();
  const prScopes = [...(pr.scopes_supported ?? [])].sort();
  check('it declares every scope the authorization server offers',
    JSON.stringify(asScopes) === JSON.stringify(prScopes),
    `resource says ${JSON.stringify(pr.scopes_supported)}, the AS offers ${JSON.stringify(disco.scopes_supported)}\n` +
    '        Set WA_OAUTH_SCOPES on the MCP; it defaults to WA_OAUTH_SCOPE alone.');

  step('7b', 'Every tool declares a scheme (the half ChatGPT reads first)');
  const FREE = new Set(['get_sample_audit', 'check_upgrade_status']);
  const list = await rpc('tools/list', {});
  const tools = list.body?.result?.tools ?? [];
  if (!check('tools/list answers', tools.length > 0, `got ${list.status}: ${list.text.slice(0, 200)}`)) {
    process.exit(1);
  }
  const typeOf = (t) => t?._meta?.securitySchemes?.[0]?.type;
  const bare = tools.filter((t) => !typeOf(t)).map((t) => t.name);
  check('no tool is missing one', bare.length === 0,
    `${bare.length}/${tools.length} carry no scheme — Mixed Auth is off on the MCP.\n` +
    `        (${bare.slice(0, 4).join(', ')}${bare.length > 4 ? ', …' : ''})`);
  if (bare.length < tools.length) {
    // Skipped entirely when nothing carries a scheme: "the split is correct"
    // over an empty set is a PASS that reads as reassurance, directly under the
    // line saying every tool is bare.
    const miscast = tools
      .filter((t) => typeOf(t) && typeOf(t) !== (FREE.has(t.name) ? 'noauth' : 'oauth2'))
      .map((t) => `${t.name}=${typeOf(t)}`);
    check('the two free tools are noauth, the rest oauth2', miscast.length === 0, miscast.join(', '));

    // WHAT IS ASKED FOR MUST EQUAL WHAT IS OFFERED.
    //
    // The resource document says which scopes it accepts; these say which the
    // connector will actually request. They were allowed to disagree, and did:
    // the document advertised audit/openid/email while every tool asked for
    // `audit` alone, so nothing ever requested the identity scopes, no ID token
    // or verified email could exist, and the ChatGPT portal reported enterprise
    // domain restrictions as unavailable — with every other check on this page
    // green. Nothing compared the two.
    //
    // Compared to each other rather than to a literal: the pair has to agree,
    // and pinning either side would add a third place to keep in step.
    const offered = [...(pr.scopes_supported ?? [])].sort();
    const mismatched = tools
      .filter((t) => typeOf(t) === 'oauth2')
      .filter((t) => JSON.stringify([...(t._meta.securitySchemes[0].scopes ?? [])].sort()) !== JSON.stringify(offered))
      .map((t) => `${t.name}=${JSON.stringify(t._meta.securitySchemes[0].scopes)}`);
    check('every protected tool asks for exactly the scopes the resource offers',
      mismatched.length === 0,
      `the resource offers ${JSON.stringify(pr.scopes_supported)} but:\n` +
      `        ${mismatched.slice(0, 4).join('\n        ')}\n` +
      '        Set WA_OAUTH_SCOPES on the MCP — it feeds both, and defaults to the audit scope alone.');
  }

  step('7c', 'An unauthenticated Pro tool challenges (the half it reads second)');
  // list_tracked_sites is Pro and read-only, and with no credential it never
  // reaches the API at all — it fails at auth. Costs nothing.
  const chal = await rpc('tools/call', { name: 'list_tracked_sites', arguments: {} });
  const wwwAuth = chal.body?.result?._meta?.['mcp/www_authenticate'];
  if (check('the error carries _meta["mcp/www_authenticate"]', typeof wwwAuth === 'string',
    'absent — without it the Apps SDK never renders the account-linking UI.\n' +
    `        got: ${JSON.stringify(chal.body?.result ?? chal.text).slice(0, 200)}`)) {
    check('and points at a resolvable resource_metadata',
      /resource_metadata="https?:\/\//.test(wwwAuth),
      `${wwwAuth}\n        A bare path here is unresolvable at the client.`);
  }

  step('7d', 'An OAuth bearer resolves to the account  ← proves the secret matches');
  const asOauth = await rpc('tools/call', { name: 'check_upgrade_status', arguments: {} }, tok.access_token);
  const seenTier = asOauth.body?.result?.structuredContent?.tier;
  check(`the MCP reports the same tier the API did (${sub?.tier})`,
    seenTier === sub?.tier,
    seenTier === 'none'
      ? 'the MCP saw NOBODY for a token the API says is live. Introspection was\n' +
        '        rejected: WA_OAUTH_INTROSPECTION_SECRET on the MCP does not match the\n' +
        '        API\'s. Every check above passes with a wrong secret — only this one fails.'
      : `MCP says ${JSON.stringify(seenTier)}, API says ${JSON.stringify(sub?.tier)}`);

  // ── 8. revocation ends it immediately ───────────────────────────────
  // Deliberately not re-probed through the MCP: IntrospectionTokenExchange
  // caches a positive for 60s, so the MCP would still answer for ~a minute and
  // the check would read as a failure of revocation rather than of nothing.
  step(8, 'Revocation kills the token AND its key');
  const rev = await fetch(`${BASE}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: tok.access_token }),
  });
  check('revoke returns 200', rev.status === 200, `got ${rev.status}`);
  check('the token now introspects inactive', (await introspect(tok.access_token)).body.active === false,
    'still active');
  const deadRes = await fetch(`${BASE}/api/subscription`, { headers: { 'X-API-Key': live.body.api_key } });
  const dead = await deadRes.json();
  check('and the derived key stops authenticating', deadRes.status === 401, `got ${deadRes.status}`);
  check('naming the reason the MCP already maps', dead.reason === 'revoked_key', `got ${dead.reason}`);

  const unknown = await fetch(`${BASE}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'wao_never_existed' }),
  });
  check('an unknown token also answers 200 (no oracle)', unknown.status === 200, `got ${unknown.status}`);

  // ── done ────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  if (failed === 0) {
    console.log('\x1b[32mALL CHECKS PASSED\x1b[0m — the authorization server and the MCP agree.\n');
    console.log('The Mixed Auth gate is met: metadata, per-tool schemes, a challenge,');
    console.log('and an OAuth bearer resolving to the account. Safe to rescan in the portal.\n');
    console.log(`Leftover test client: ${reg.client_id}`);
    console.log('(one oauth_clients row, one revoked token, one revoked derived key)\n');
  } else {
    console.log(`\x1b[31m${failed} CHECK(S) FAILED\x1b[0m — do not point the MCP at this yet.\n`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
