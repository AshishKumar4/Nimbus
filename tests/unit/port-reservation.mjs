#!/usr/bin/env bun
// A port reservation is the durable half of an application's identity: an
// owner holds a port across instances whether or not a capability is
// currently minted for it. This pins the store's rules — the owner's own
// port is answered again, a preferred port that another record or a live
// listener holds is refused rather than moved, clearing a capability keeps
// the reservation, and only the owner can release it. Recovery and
// reservation never mint a capability.

import assert from 'node:assert/strict';
import {
  clearPortCapability,
  persistPortCapability,
  readPortCapability,
  readPortExposure,
  readPortReservation,
  releasePortReservation,
  reservePort,
} from '../../packages/worker/src/session/port-capability.ts';
import { PORT_CAPABILITY_KEY_PREFIX } from '../../packages/worker/src/session/keys.ts';

const rows = new Map();
let transactions = 0;
let queue = Promise.resolve();
// A serialized transaction: each body runs alone on a private copy of the
// committed rows, commits that copy only when it resolves, and always frees
// the queue. get/list outside a transaction answer only committed state.
const transaction = (body) => {
  const run = queue.then(() => {
    transactions += 1;
    const copy = new Map(rows);
    const view = {
      get: async (k) => copy.get(k),
      put: async (k, v) => { copy.set(k, v); },
      delete: async (k) => copy.delete(k),
      list: async ({ prefix }) => new Map([...copy].filter(([k]) => k.startsWith(prefix))),
    };
    const result = body(view);
    return result.then((value) => {
      rows.clear();
      for (const [k, v] of copy) rows.set(k, v);
      return value;
    });
  });
  queue = run.then(() => undefined, () => undefined);
  return run;
};
const storage = {
  get: async (key) => rows.get(key),
  put: async (key, value) => { rows.set(key, value); },
  delete: async (key) => rows.delete(key),
  list: async ({ prefix }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
  transaction,
};
const ctx = { storage };
// A store that offers no transaction must be refused, never fallen back into.
const noTxnStorage = {
  get: async (key) => rows.get(key),
  put: async (key, value) => { rows.set(key, value); },
  delete: async (key) => rows.delete(key),
  list: async ({ prefix }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
};
const noTxnCtx = { storage: noTxnStorage };
const self = { ctx, portRegistry: { restoreCapability: () => true } };
const record = (port) => rows.get(`${PORT_CAPABILITY_KEY_PREFIX}${port}`);
const none = new Set();
const CONFLICT = /port reservation conflict/;

// T1: a fresh store hands out the first port of the range as a bare reservation.
{
  assert.equal(await reservePort(ctx, { owner: 'A', occupiedPorts: none }), 20000);
  assert.deepEqual(record(20000), { owner: 'A', capability: null });
  assert.equal(await readPortExposure(ctx, 20000), null, 'a bare reservation is not an exposure');
  assert.deepEqual(await readPortReservation(ctx, 20000), { owner: 'A', capability: null });
}

// T2: the owner's port is answered again; others get the next free port; live listeners count.
{
  assert.equal(await reservePort(ctx, { owner: 'A', occupiedPorts: none }), 20000);
  assert.equal(await reservePort(ctx, { owner: 'B', occupiedPorts: none }), 20001);
  assert.equal(await reservePort(ctx, { owner: 'C', occupiedPorts: new Set([20002]) }), 20003);
}

// T3: a preferred port is refused, never moved, when anything else holds it.
{
  await assert.rejects(reservePort(ctx, { owner: 'B', preferredPort: 20000, occupiedPorts: none }), CONFLICT);
  assert.deepEqual(record(20000), { owner: 'A', capability: null }, 'a refused claim leaves the holder intact');
  assert.equal(await reservePort(ctx, { owner: 'A', preferredPort: 20000, occupiedPorts: none }), 20000);
  await assert.rejects(reservePort(ctx, { owner: 'D', preferredPort: 20002, occupiedPorts: new Set([20002]) }), CONFLICT);
  await assert.rejects(reservePort(ctx, { owner: 'A', preferredPort: 20005, occupiedPorts: none }), CONFLICT);
  assert.deepEqual(record(20000), { owner: 'A', capability: null });
  assert.equal(record(20005), undefined, 'a conflicting preference claims nothing');
}

// T4: exposing then clearing keeps the reservation with no capability.
{
  // The stored record is the source of truth: the capability takes the
  // reservation's owner, not a hook the test has to mirror.
  await persistPortCapability(self, 20000, 'a'.repeat(24));
  assert.deepEqual(await readPortExposure(ctx, 20000), { capability: 'a'.repeat(24), owner: 'A' });
  await clearPortCapability(self, 20000);
  assert.deepEqual(record(20000), { owner: 'A', capability: null }, 'unexpose keeps the owner reservation');
  assert.equal(await readPortExposure(ctx, 20000), null);
  assert.equal(await readPortCapability(self, 20000), null);
  assert.equal(await reservePort(ctx, { owner: 'A', occupiedPorts: none }), 20000);
}

// T5: an ownerless exposure clears the way it always did — the record is deleted.
{
  rows.set(`${PORT_CAPABILITY_KEY_PREFIX}20010`, { capability: 'b'.repeat(24), owner: null });
  await clearPortCapability(self, 20010);
  assert.equal(record(20010), undefined);
}

// T6: only the owner releases; a released port is free for the next claimant.
{
  await assert.rejects(releasePortReservation(ctx, { owner: 'B', port: 20000 }), CONFLICT);
  assert.deepEqual(record(20000), { owner: 'A', capability: null });
  assert.equal(await releasePortReservation(ctx, { owner: 'A', port: 20000 }), true);
  assert.equal(record(20000), undefined);
  assert.equal(await releasePortReservation(ctx, { owner: 'A', port: 20000 }), false);
  assert.equal(await reservePort(ctx, { owner: 'E', preferredPort: 20000, occupiedPorts: none }), 20000);
}

// T7: a record the store cannot read is occupied, never overwritten.
{
  rows.set(`${PORT_CAPABILITY_KEY_PREFIX}20020`, 'junk');
  await assert.rejects(reservePort(ctx, { owner: 'F', preferredPort: 20020, occupiedPorts: none }), CONFLICT);
  const occupied = new Set([20002, 20004, 20005, 20006, 20007, 20008, 20009, 20010, 20011, 20012, 20013, 20014, 20015, 20016, 20017, 20018, 20019]);
  assert.equal(await reservePort(ctx, { owner: 'F', occupiedPorts: occupied }), 20021, 'the unreadable row is skipped');
  assert.equal(record(20020), 'junk');
}

// T8: every claim — and every release — ran inside the store's transaction.
// Twelve reserves, three releases (T6), plus the persist and two clears in
// T4–T5, which became read-modify-write transactions with the stored-owner
// fix.
{
  assert.equal(transactions, 18);
}

// T9: two owners racing one preferred port — one claims, one is refused, the
// winner's row is intact.
{
  const results = await Promise.allSettled([
    reservePort(ctx, { owner: 'G', preferredPort: 20030, occupiedPorts: none }),
    reservePort(ctx, { owner: 'H', preferredPort: 20030, occupiedPorts: none }),
  ]);
  const claimed = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected' && CONFLICT.test(String(r.reason)));
  assert.equal(claimed.length, 1, 'exactly one owner claims the port');
  assert.equal(claimed[0].value, 20030);
  assert.equal(refused.length, 1, 'the loser sees a conflict');
  assert.match(record(20030).owner, /^[GH]$/, 'the winner holds the row');
  assert.equal(record(20030).capability, null);
}

// T10: an owner racing itself is answered the same port, once.
{
  const results = await Promise.all([
    reservePort(ctx, { owner: 'I', preferredPort: 20040, occupiedPorts: none }),
    reservePort(ctx, { owner: 'I', preferredPort: 20040, occupiedPorts: none }),
  ]);
  assert.deepEqual(results, [20040, 20040], 'both answers name the same port');
  assert.deepEqual(record(20040), { owner: 'I', capability: null });
}

// T11: a foreign release is refused inside the transaction and the record
// survives untouched.
{
  const before = transactions;
  await assert.rejects(releasePortReservation(ctx, { owner: 'H', port: 20040 }), CONFLICT);
  assert.deepEqual(record(20040), { owner: 'I', capability: null }, 'a refused foreign release deletes nothing');
  assert.ok(transactions > before, 'the release ran inside a transaction');
}

// T12: a transaction that fails writes nothing.
{
  const before = new Map(rows);
  const body = async (txn) => {
    await txn.put(`${PORT_CAPABILITY_KEY_PREFIX}20050`, { owner: 'J', capability: null });
    throw new Error('commit never runs');
  };
  await assert.rejects(storage.transaction(body), /commit never runs/);
  assert.equal(record(20050), undefined, 'a rejected transaction commits nothing');
  assert.deepEqual([...rows], [...before], 'committed rows are untouched by the failure');
}

// T13: a store with no transaction is refused, not fallen back into.
{
  const before = rows.size;
  await assert.rejects(reservePort(noTxnCtx, { owner: 'K', preferredPort: 20060, occupiedPorts: none }));
  await assert.rejects(releasePortReservation(noTxnCtx, { owner: 'K', port: 20060 }));
  assert.equal(rows.size, before, 'nothing was allocated without a transaction');
}

console.log('port-reservation: ok');
