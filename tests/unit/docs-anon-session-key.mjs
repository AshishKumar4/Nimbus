#!/usr/bin/env bun
// The docs sandbox keeps the anonymous session it booted under one key per
// attach endpoint (localStorage is already per browser and origin), so a
// returning visitor reattaches to it. A browser that cached its session
// under the per-browser id the docs once made (nimbus:client-id) keeps it:
// the first boot removes the old keys and moves it to the endpoint's key
// (into the room they leave, else handing it to that boot), after which
// nothing reads them.
import assert from 'node:assert/strict';
import { adoptLegacyCachedSession, cacheSession, readCachedSession, sessionCacheKey } from '../../apps/docs/src/lib/anonymous-session.ts';

const records = new Map();
// Room for this many records, as a full localStorage refuses one more.
let room = Infinity;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key) => records.get(key) ?? null,
  setItem: (key, value) => {
    if (!records.has(key) && records.size >= room) throw new DOMException('quota exceeded', 'QuotaExceededError');
    records.set(key, value);
  },
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

// A full localStorage: the old keys go first, so the session moves into the room they leave.
records.clear();
records.set('nimbus:client-id', 'browser-4');
records.set('nimbus:anon-session:browser-4', JSON.stringify(live('wss://nimbus.example/s/full/ws')));
room = 2;
assert.equal(adoptLegacyCachedSession(sessionCacheKey(A)), null);
assert.deepEqual([...records.keys()], [sessionCacheKey(A)]);
assert.equal(readCachedSession(sessionCacheKey(A)).wsUrl, 'wss://nimbus.example/s/full/ws');
// With no room even then, this boot is handed the session, and the old keys are gone all the same.
records.clear();
records.set('nimbus:client-id', 'browser-5');
records.set('nimbus:anon-session:browser-5', JSON.stringify(live('wss://nimbus.example/s/none/ws')));
room = 0;
assert.equal(adoptLegacyCachedSession(sessionCacheKey(A))?.wsUrl, 'wss://nimbus.example/s/none/ws');
assert.equal(records.size, 0);
room = Infinity;

// A per-browser id with nothing cached under it goes too.
records.clear();
records.set('nimbus:client-id', 'browser-3');
adoptLegacyCachedSession(sessionCacheKey(A));
assert.equal(records.size, 0);
console.log('docs-anon-session-key: one key per endpoint; an old per-browser cache moves once and leaves nothing behind');
