import assert from 'node:assert/strict';
import { cacheSession, clearCachedSession, createSession, readCachedSession, SandboxUnavailableError } from '../../apps/docs/src/lib/anonymous-session.ts';

const records = new Map();
const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key) => records.get(key) ?? null,
  setItem: (key, value) => records.set(key, value),
  removeItem: (key) => records.delete(key),
} });
const realNow = Date.now;
let now = realNow();
let expiresAt = now + 600_000;
let status = 200;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  assert.equal(request.method, 'POST');
  return Response.json({ wsUrl: '/s/job_123/ws?nimbus_token=attach', expiresAt }, { status });
} });
try {
  Date.now = () => now;
  const session = await createSession(new URL('/api/anon-session', server.url).href);
  assert.equal(session.expiresAt, expiresAt);
  assert.equal(new URL(session.wsUrl).protocol, 'ws:');
  assert.equal(new URL(session.wsUrl).pathname, '/s/job_123/ws');
  cacheSession('cached', session);
  now += 200_000;
  assert.deepEqual(readCachedSession('cached'), session, 'reuse follows the server lifetime, not a private 110-second window');
  now = expiresAt - 5_000;
  assert.equal(readCachedSession('cached'), null, 'the transport margin prevents attaching at expiry');
  expiresAt = now + 20_000;
  const short = await createSession(new URL('/api/anon-session', server.url).href);
  cacheSession('cached', short);
  now += 20_000;
  assert.equal(readCachedSession('cached'), null, 'a shorter server lifetime is honored too');
  records.set('legacy', JSON.stringify({ wsUrl: session.wsUrl, mintedAt: now }));
  assert.equal(readCachedSession('legacy'), null, 'old cached records cannot invent an expiry');
  const direct = await createSession('wss://direct.test/session');
  assert.equal(direct.expiresAt, null, 'a direct WebSocket URL has no invented server lifetime');
  cacheSession('direct', direct);
  now += 1_000_000;
  assert.deepEqual(readCachedSession('direct'), direct);
  clearCachedSession('direct');
  assert.equal(readCachedSession('direct'), null);
  status = 429;
  await assert.rejects(createSession(new URL('/api/anon-session', server.url).href), (error) => error instanceof SandboxUnavailableError && error.status === 429);
} finally {
  await server.stop(true);
  Date.now = realNow;
  if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else delete globalThis.localStorage;
}
console.log('docs-anon-expiry: ok');
