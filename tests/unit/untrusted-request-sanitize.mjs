// untrusted-request-sanitize.mjs — the Nimbus/user-code trust boundary.
//
// Regression: the strip removed only `nimbus_token` by name, so the sealed
// Cloudflare OAuth cookies (`nimbus_agent_oauth`, `__Host-nimbus_demo_auth`)
// and `Proxy-Authorization` reached untrusted user code through both the
// `/s/<sid>/port/<n>/` and `<port>--<sid>` ingress forms. Proven live on prod
// before the fix.
import assert from 'node:assert';
import {
  isPlatformCookie,
  sanitizeUntrustedHeaders,
  sanitizeUntrustedRequest,
} from '../../packages/core/dist/_shared/untrusted-request.js';
import { NIMBUS_TOKEN_COOKIE } from '../../packages/worker/dist/auth/middleware.js';

// ── every platform cookie in the codebase is recognised ───────────────────
for (const name of [
  '__Host-nimbus_token',               // auth/middleware.ts
  'nimbus_agent_oauth',                // session/agent-oauth.ts  (sealed CF OAuth)
  '__Host-nimbus_demo_auth',           // apps/hosted-demo        (sealed CF OAuth)
  '__Host-nimbus_demo_state',
  '__Host-nimbus_agent_oauth_state',
  '__Secure-nimbus_future',            // namespace is closed, not enumerated
]) {
  assert.equal(isPlatformCookie(name), true, `${name} must be treated as a platform cookie`);
}
// ...and the session cookie stays inside the namespace whatever it is named.
assert.equal(isPlatformCookie(NIMBUS_TOKEN_COOKIE), true);
// Its `__Host-` prefix is what stops untrusted preview code on a subdomain
// from setting a shadowing copy for the parent domain.
assert.equal(NIMBUS_TOKEN_COOKIE.startsWith('__Host-'), true, NIMBUS_TOKEN_COOKIE);
// ...and a user's own cookies are not
for (const name of ['theme', 'session', 'my_app_sid', 'connect.sid', 'nimbusish']) {
  assert.equal(isPlatformCookie(name), false, `${name} is the user's cookie and must survive`);
}

// ── header sanitizer ──────────────────────────────────────────────────────
{
  const h = new Headers({
    cookie: 'nimbus_agent_oauth=SEALED; __Host-nimbus_demo_auth=SEALED2; theme=dark; my_app=keep',
    authorization: 'Bearer secret',
    'proxy-authorization': 'Basic secret',
    'x-nimbus-port': '9999',
    'x-nimbus-internal': 'y',
    'content-type': 'text/plain',
  });
  sanitizeUntrustedHeaders(h);
  assert.equal(h.get('cookie'), 'theme=dark; my_app=keep');
  assert.equal(h.get('authorization'), null);
  assert.equal(h.get('proxy-authorization'), null);
  assert.equal(h.get('x-nimbus-port'), null);
  assert.equal(h.get('x-nimbus-internal'), null);
  assert.equal(h.get('content-type'), 'text/plain', 'application headers must pass through');
}

// only platform cookies present → the header is removed entirely
{
  const h = new Headers({ cookie: 'nimbus_token=a; __Host-nimbus_demo_auth=b' });
  sanitizeUntrustedHeaders(h);
  assert.equal(h.get('cookie'), null);
}

// no cookie header at all → no crash, nothing invented
{
  const h = new Headers({ 'content-type': 'application/json' });
  sanitizeUntrustedHeaders(h);
  assert.equal(h.get('cookie'), null);
}

// malformed entries must not resurrect a credential
{
  const h = new Headers({ cookie: '; ;; nimbus_token=a ; =bare; theme=dark' });
  sanitizeUntrustedHeaders(h);
  assert.equal(/nimbus_token/.test(h.get('cookie') || ''), false);
  assert.equal(/theme=dark/.test(h.get('cookie') || ''), true);
}

// ── request sanitizer ─────────────────────────────────────────────────────
{
  const req = new Request('https://example.test/a', {
    method: 'GET',
    headers: { cookie: 'nimbus_agent_oauth=SEALED; theme=dark', authorization: 'Bearer s' },
  });
  const out = sanitizeUntrustedRequest(req);
  assert.equal(out.headers.get('cookie'), 'theme=dark');
  assert.equal(out.headers.get('authorization'), null);
  assert.equal(out.method, 'GET');
  assert.equal(out.url, 'https://example.test/a');
}

// POST keeps its body
{
  const req = new Request('https://example.test/p', {
    method: 'POST',
    headers: { cookie: 'nimbus_token=a; keep=1', 'content-type': 'text/plain' },
    body: 'payload',
  });
  const out = sanitizeUntrustedRequest(req);
  assert.equal(out.headers.get('cookie'), 'keep=1');
  assert.equal(out.method, 'POST');
  assert.equal(await out.text(), 'payload');
}

// WebSocket upgrades pass through untouched — reconstructing drops the handshake
{
  const req = new Request('https://example.test/ws', { headers: { upgrade: 'websocket', cookie: 'nimbus_token=a' } });
  assert.equal(sanitizeUntrustedRequest(req), req);
}

console.log('untrusted-request-sanitize: ok');
