#!/usr/bin/env bun
// Facet names come from a reusable free list, not from the pid.
//
// A Durable Object admits 65,536 facets over its LIFETIME — the IDs are
// append-only and never reclaimed, so the bound is on facets ever CREATED, not
// on facets alive at once. Naming a facet `proc-${pid}` when pids never repeat
// burned one of those IDs per spawn, and a long-lived session would eventually
// exhaust its facet index with no way back.
//
// The property under test is therefore not "names are unique" but the opposite:
// a name RETURNED must be handed out again, because reusing a name is what
// costs no new ID.

import assert from 'node:assert/strict';
import { openResidentFacet, residentFacetName } from '../../packages/fabric/src/workerd-facet-host.ts';

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
  return {
    id: { toString: () => id },
    // The lifetime ledger persists its high-water through here; this test's
    // subject is the free list, so the rows themselves are not asserted.
    storage: { async get() { return undefined; }, async put() {} },
    everCreated,
    live,
    facets: {
      get(name) {
        if (!seen.has(name)) { seen.add(name); everCreated.push(name); }
        live.add(name);
        return {
          async startProcess() { return { ok: true }; },
          async handleHttpRequest() { return new Response('ok'); },
        };
      },
      abort(name) { live.delete(name); },
      delete(name) { live.delete(name); },
    },
  };
}

const env = { LOADER: { get: () => ({ getDurableObjectClass: () => class {} }) } };
const disk = () => ({});

function open(ctx, pid) {
  return openResidentFacet(
    ctx,
    env,
    disk,
    { doId: ctx.id.toString(), pid, writerId: `w${pid}` },
    { pid, writerId: `w${pid}`, startArgs: {}, boot: { kind: 'code', code: {} } },
  );
}

// ── Sequential spawn/release must not grow the facet index ──────────────────
//
// This is the regression that matters. Before the free list, 200 sequential
// short-lived processes created 200 facet IDs and none came back.
const ctx = makeCtx();
let pid = 1000;
for (let i = 0; i < 200; i++) {
  const facet = open(ctx, pid++);
  await facet.release();
}
assert.equal(
  ctx.everCreated.length,
  1,
  `200 sequential processes must reuse one slot, but created ${ctx.everCreated.length}`
    + ` facets: ${ctx.everCreated.slice(0, 5).join(', ')}…`,
);
assert.equal(ctx.everCreated[0], 'proc-slot-0');

// ── Concurrent processes must NOT share a slot ──────────────────────────────
//
// The counter-property, and the one a naive free list gets wrong: reuse is
// only legal after the previous tenant is gone.
const ctx2 = makeCtx('concurrent');
const live = [];
for (let i = 0; i < 8; i++) live.push(open(ctx2, 2000 + i));
assert.equal(ctx2.everCreated.length, 8, 'eight concurrent processes need eight distinct slots');
assert.equal(new Set(ctx2.everCreated).size, 8, 'concurrent slots must be distinct');
assert.deepEqual(
  ctx2.everCreated,
  Array.from({ length: 8 }, (_, i) => `proc-slot-${i}`),
);

// ── A released slot is reused before a new one is minted ───────────────────
await live[3].release();
const reused = open(ctx2, 3001);
assert.equal(
  ctx2.everCreated.length,
  8,
  'reusing a returned slot must not create a new facet name',
);
assert.equal(reused.slot, 3, `the lowest free slot must be reused, got ${reused.slot}`);

// Releasing several returns them lowest-first, so the high-water mark stays low.
await live[1].release();
await live[6].release();
const a = open(ctx2, 3002);
const b = open(ctx2, 3003);
assert.equal(a.slot, 1);
assert.equal(b.slot, 6);
assert.equal(ctx2.everCreated.length, 8, 'the facet index must still not have grown');

// ── Release is idempotent and does not double-free a slot ──────────────────
//
// A slot returned twice would be handed to two live processes at once, which
// is the one way a free list can be worse than no free list at all.
await a.release();
await a.release();
const c = open(ctx2, 3004);
const d = open(ctx2, 3005);
assert.notEqual(c.slot, d.slot, 'a double release must not hand one slot to two processes');

// ── Slot books are per hosting actor ───────────────────────────────────────
const ctx3 = makeCtx('other-session');
const elsewhere = open(ctx3, 9000);
assert.equal(elsewhere.slot, 0, 'a different Durable Object has its own slot space');

console.log('resident-facet-slot-pool: ok');
console.log(`  200 sequential spawns → ${ctx.everCreated.length} facet name(s) ever created`);
