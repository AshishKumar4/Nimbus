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
const storage = {
  get: async (key) => rows.get(key),
  put: async (key, value) => { rows.set(key, value); },
  delete: async (key) => rows.delete(key),
  list: async ({ prefix }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
  transaction: async (body) => { transactions += 1; return body(storage); },
};
const ctx = { storage };
const ownerOf = new Map();
const self = { ctx, portRegistry: { restoreCapability: () => true }, portCapabilityOwner: (port) => ownerOf.get(port) ?? null };
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
  ownerOf.set(20000, 'A');
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

// T8: every claim ran inside the store's transaction.
{
  assert.equal(transactions, 12);
}

console.log('port-reservation: ok');
