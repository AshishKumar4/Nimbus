import assert from 'node:assert/strict';
import { VERSION_HEADER, createProbeTarget, deletionResult } from '../behavioral/_session-transport.mjs';

const calls = [];
let anon = 0;
const request = async (url, init) => {
  calls.push({ url, ...init });
  if (url.endsWith('/new')) {
    if (init.headers.Authorization) return new Response(null, { status: 302, headers: { location: '/s/authenticated/', [VERSION_HEADER]: 'v1' } });
    return Response.json({ code: 'E_DEMO_LOGIN_REQUIRED' }, { status: 401 });
  }
  if (url.endsWith('/api/demo/anon-session')) {
    const id = ++anon;
    return Response.json({ sessionId: `anon-${id}`, wsUrl: `wss://one.test/s/anon-${id}/?nimbus_token=token-${id}` });
  }
  return Response.json({ ok: true, result: { ok: true, killed: 0, destroyedAt: 1, reason: 'probe' } },
    { headers: { [VERSION_HEADER]: 'v1' } });
};
const one = createProbeTarget({ base: 'https://one.test', request });
const two = createProbeTarget({ base: 'https://two.test', token: 'root-two', cookie: 'tenant=two', request });
const [a, b, c] = await Promise.all([one.create({ anonymous: true }), one.create({ anonymous: true }), two.create()]);
assert.notEqual(a.sessionId, b.sessionId);
assert.equal(one.headers({}, a.sessionId).Authorization, 'Bearer token-1');
assert.equal(one.headers({}, b.sessionId).Authorization, 'Bearer token-2');
assert.deepEqual(one.headers(), {}, 'anonymous session credentials never mutate target-wide defaults');
assert.deepEqual(two.headers({}, c.sessionId), { Authorization: 'Bearer root-two', Cookie: 'tenant=two' });
assert.equal(c.versionId, 'v1');
assert.match(a.attachPath, /nimbus_token=token-1/);
assert.equal(a.reap, 'ttl');
await one.delete(a.sessionId, { reason: 'first' });
await one.delete(b.sessionId, { reason: 'second' });
await two.delete(c.sessionId, { reason: 'third' });
const deletions = calls.filter(call => call.method === 'DELETE');
assert.deepEqual(deletions.map(call => [new URL(call.url).host, call.headers.Authorization]),
  [['one.test', 'Bearer token-1'], ['one.test', 'Bearer token-2'], ['two.test', 'Bearer root-two']]);
assert.equal(deletions[0].headers['X-Nimbus-Cleanup-Reason'], 'first');
assert.equal((await deletionResult(new Response('<html>session shell</html>', { headers: { 'content-type': 'text/html' } }))).ok, false);
assert.equal((await deletionResult(Response.json({ ok: true }))).ok, false);
const rejected = createProbeTarget({ base: 'https://no.test', token: 'secret', request: async () => new Response('Bearer secret', { status: 401 }) });
await assert.rejects(rejected.create({ anonymous: true }), /rejected.*bearer token/);

// The driver's deleteSession: an anonymous demo session's DELETE answers 401
// by design and the demo's TTL reaps it, which the ledger already counts as
// TTL-reaped, not leaked; so the probe's own cleanup check passes. Any other
// answer, and a 401 for a session a credential minted, stays a failure.
// The exit hook is off: these targets have no network to DELETE on.
process.env.NIMBUS_PROBE_KEEP_SESSIONS = '1';
const { deleteSession, mintSession } = await import('../behavioral/_driver.mjs');
/** A target whose DELETE answers `status` with no destroy result. */
const refusing = (status, token = '') => createProbeTarget({ base: 'https://demo.test', token, request: async (url, init) => {
  if (url.endsWith('/new')) return token ? new Response(null, { status: 302, headers: { location: '/s/keyed/' } }) : Response.json({ code: 'E_DEMO_LOGIN_REQUIRED' }, { status: 401 });
  if (url.endsWith('/api/demo/anon-session')) return Response.json({ sessionId: 'anon', wsUrl: 'wss://demo.test/s/anon/?nimbus_token=t' });
  return Response.json({ error: 'refused' }, { status });
} });
assert.equal((await deleteSession(await mintSession(refusing(401)))).ok, true, 'an anonymous session the demo refuses to DELETE is left to its TTL');
assert.equal((await deleteSession(await mintSession(refusing(500)))).ok, false, 'an anonymous session whose DELETE fails otherwise is not');
assert.equal((await deleteSession(await mintSession(refusing(401, 'probe-token')))).ok, false, 'a session a token minted must be deleted');
console.log('probe-session-transport: target/session credential isolation, confirmed destruction, and anonymous sessions left to the TTL');
