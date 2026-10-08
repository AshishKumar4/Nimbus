#!/usr/bin/env bun
// Facet names are slots: `proc-slot-<n>`, numbered per hosting actor.
//
// A Durable Object admits 65,536 facets over its LIFETIME: the IDs are
// append-only and never reclaimed, so every name ever created spends one, and
// the lifetime ledger (budgets.ts) counts them and names the wall.
//
// A released name is still never handed to a later process of the same
// incarnation. Getting a name a just-released process held, with the next
// process's class, failed on Cloudflare with "internal error" and
// durableObjectReset: vite8 after vinext, 7 of 7 on a throwaway; with a fresh
// name, 4 of 4 started (2026-10-07). So each process takes the next name, and
// concurrent processes never share one.

import assert from 'node:assert/strict';
import { processes, residentFacetName } from '../../packages/fabric/src/workerd-facet-host.ts';

// ── The name is a slot, and slots are what get reused ───────────────────────
assert.equal(residentFacetName(0), 'proc-slot-0');
assert.equal(residentFacetName(7), 'proc-slot-7');

/**
 * A `ctx.facets` that records every DISTINCT name ever used.
 *
 * That is the quantity the platform's 65,536 bound applies to: facet IDs are
 * append-only and are assigned per name, so re-getting a name that was used
 * before costs nothing, while a name never seen before burns an ID that is
 * never given back. Counting `get` calls instead would measure spawns, which
 * is not what runs out.
 */
function makeCtx(id = 'session-under-test') {
  const everCreated = [];
  const seen = new Set();
  const live = new Set();
  // Names whose SQLite exists: get creates it, abort keeps it, delete drops it.
  const stored = new Set();
  const reopenedStores = [];
  return {
    id: { toString: () => id },
    // The lifetime ledger persists its high-water through here; this test's
    // subject is the free list, so the rows themselves are not asserted.
    storage: { async get() { return undefined; }, async put() {} },
    everCreated,
    live,
    reopenedStores,
    facets: {
      get(name) {
        if (!seen.has(name)) { seen.add(name); everCreated.push(name); }
        if (stored.has(name)) reopenedStores.push(name);
        stored.add(name);
        live.add(name);
        return {
          async startProcess() { return { ok: true }; },
          async handleHttpRequest() { return new Response('ok'); },
        };
      },
      abort(name) { live.delete(name); },
      delete(name) { live.delete(name); stored.delete(name); },
    },
  };
}

const env = { LOADER: { get: () => ({ getDurableObjectClass: () => class {} }) } };
const disk = () => ({});

function open(ctx, pid) {
  return processes(ctx, env).spawn(
    disk,
    { doId: ctx.id.toString(), pid, writerId: `w${pid}` },
    { pid, writerId: `w${pid}`, startArgs: {}, boot: { kind: 'code', code: {} } },
  );
}

// ── A released name is never handed out again ────────────────────────────────
const ctx = makeCtx();
let pid = 1000;
for (let i = 0; i < 20; i++) {
  const facet = open(ctx, pid++);
  await facet.release();
}
assert.deepEqual(
  ctx.everCreated,
  Array.from({ length: 20 }, (_, i) => `proc-slot-${i}`),
  'twenty sequential processes take twenty names, in order',
);

// ── Concurrent processes never share a slot ──────────────────────────────────
const ctx2 = makeCtx('concurrent');
const live = [];
for (let i = 0; i < 8; i++) live.push(open(ctx2, 2000 + i));
assert.equal(ctx2.everCreated.length, 8, 'eight concurrent processes need eight distinct slots');
assert.equal(new Set(ctx2.everCreated).size, 8, 'concurrent slots must be distinct');
assert.deepEqual(
  ctx2.everCreated,
  Array.from({ length: 8 }, (_, i) => `proc-slot-${i}`),
);

// A released slot among live ones is not reused either: the next process takes the next name.
await live[3].release();
const next = open(ctx2, 3001);
assert.equal(next.slot, 8, `the next process takes the next name, got slot ${next.slot}`);

// ── Release is idempotent ────────────────────────────────────────────────────
await next.release();
await next.release();
const c = open(ctx2, 3004);
const d = open(ctx2, 3005);
assert.notEqual(c.slot, d.slot, 'a double release must not hand one slot to two processes');

// ── Slot books are per hosting actor ───────────────────────────────────────
const ctx3 = makeCtx('other-session');
const elsewhere = open(ctx3, 9000);
assert.equal(elsewhere.slot, 0, 'a different Durable Object has its own slot space');

// ── An ephemeral slot never reopens a store a previous process left ─────────
//
// Re-getting an aborted facet's preserved SQLite reset the whole session DO
// ("Internal error in Durable Object storage caused object to be reset") on
// ~1-2% of reuses; with release deleting the store, 0 in 480 launches. So a
// released ephemeral slot is always handed out empty, whatever the spawn
// carries (the manager used to pass a per-credential store key).
{
  const ctx4 = makeCtx('fresh-stores');
  for (let i = 0; i < 20; i++) {
    const p = 4000 + i;
    const facet = processes(ctx4, env).spawn(
      disk,
      { doId: 'fresh-stores', pid: p, writerId: `w${p}` },
      { pid: p, writerId: `w${p}`, startArgs: {}, boot: { kind: 'code', code: {} }, storeKey: 'fresh-stores:1000:1000:1000' },
    );
    await facet.release();
  }
  assert.deepEqual(ctx4.reopenedStores, [], 'every ephemeral grant starts from empty storage');
}

// ── A newly minted name never inherits a previous incarnation's store ───────
//
// The slot book is per instance, but facet storage outlives the instance: a
// fresh incarnation that mints proc-slot-0 again finds the old SQLite there.
{
  const before = makeCtx('reincarnated');
  await processes(before, env).spawn(disk, { doId: 'reincarnated', pid: 1, writerId: 'w1' },
    { pid: 1, writerId: 'w1', startArgs: {}, boot: { kind: 'code', code: {} } });
  // Same facets (same storage), fresh ctx object: what a new incarnation sees.
  const after = { ...before, storage: before.storage };
  const fresh = processes(after, env).spawn(disk, { doId: 'reincarnated', pid: 2, writerId: 'w2' },
    { pid: 2, writerId: 'w2', startArgs: {}, boot: { kind: 'code', code: {} } });
  assert.equal(fresh.slot, 0);
  assert.deepEqual(before.reopenedStores, [], 'a minted name is emptied before its first get');
}

console.log('resident-facet-slot-pool: ok');
