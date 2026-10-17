#!/usr/bin/env bun
// The docs sandbox keeps the anonymous session it booted under one key per
// attach endpoint (localStorage is already per browser and origin), so a
// returning visitor reattaches to it. A browser that cached its session
// under the per-browser id the docs once made (nimbus:client-id) keeps it:
// the first boot moves it to the endpoint's key and removes the old keys,
// after which nothing reads them.
import assert from 'node:assert/strict';
import { adoptLegacyCachedSession, cacheSession, readCachedSession, sessionCacheKey } from '../../apps/docs/src/lib/anonymous-session.ts';

const records = new Map();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key) => records.get(key) ?? null,
  setItem: (key, value) => records.set(key, value),
  removeItem: (key) => records.delete(key),
} });
const live = (wsUrl) => ({ wsUrl, expiresAt: Date.now() + 600_000 });
const A = 'https://nimbus.example/api/demo/anon-session';
const B = 'https://other.example/api/demo/anon-session';

// One key per endpoint, the same on every boot.
assert.equal(sessionCacheKey(A), sessionCacheKey(A));
assert.notEqual(sessionCacheKey(A), sessionCacheKey(B));
cacheSession(sessionCacheKey(A), live('wss://nimbus.example/s/a/ws'));
cacheSession(sessionCacheKey(B), live('wss://other.example/s/b/ws'));
assert.equal(readCachedSession(sessionCacheKey(A)).wsUrl, 'wss://nimbus.example/s/a/ws');
assert.equal(readCachedSession(sessionCacheKey(B)).wsUrl, 'wss://other.example/s/b/ws');

// A session cached under the old per-browser id moves to the endpoint's key, once.
records.clear();
records.set('nimbus:client-id', 'browser-1');
records.set('nimbus:anon-session:browser-1', JSON.stringify(live('wss://nimbus.example/s/old/ws')));
adoptLegacyCachedSession(sessionCacheKey(A));
assert.equal(readCachedSession(sessionCacheKey(A))?.wsUrl, 'wss://nimbus.example/s/old/ws', 'the returning visitor keeps their sandbox');
assert.deepEqual([...records.keys()], [sessionCacheKey(A)], 'the old keys are gone');
adoptLegacyCachedSession(sessionCacheKey(A));
assert.deepEqual([...records.keys()], [sessionCacheKey(A)], 'a second boot finds nothing to move');

// A session already under the endpoint's key wins; the old keys still go.
records.clear();
cacheSession(sessionCacheKey(A), live('wss://nimbus.example/s/new/ws'));
records.set('nimbus:client-id', 'browser-2');
records.set('nimbus:anon-session:browser-2', JSON.stringify(live('wss://nimbus.example/s/old/ws')));
adoptLegacyCachedSession(sessionCacheKey(A));
assert.equal(readCachedSession(sessionCacheKey(A)).wsUrl, 'wss://nimbus.example/s/new/ws');
assert.deepEqual([...records.keys()], [sessionCacheKey(A)]);

// A per-browser id with nothing cached under it goes too.
records.clear();
records.set('nimbus:client-id', 'browser-3');
adoptLegacyCachedSession(sessionCacheKey(A));
assert.equal(records.size, 0);
console.log('docs-anon-session-key: one key per endpoint; an old per-browser cache moves once and leaves nothing behind');
