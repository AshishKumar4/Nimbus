#!/usr/bin/env bun
// N18 reservations: an admitted operation that writes over several turns (a
// copyTree runs in slices, yielding between them) reserves what it was
// admitted for, and every other writer sees those bytes as used until it
// finishes. So a writer between its slices gets only what is left beside it,
// and the copy never runs out of space half-way (a partial copy for that
// reason cannot happen). The reservation is released when the copy ends.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const setup = new SqliteVFS(harness.sql, harness.ctx);
const root = setup.as(CRED_KERNEL);
// Many more rows than one copy slice moves (200 pages of 250): the copy yields.
const ROWS = 120_000;
root.mkdir('src');
const dirs = [];
for (let i = 0; i < ROWS; i++) dirs.push(`src/d${String(i).padStart(6, '0')}`);
for (let i = 0; i < dirs.length; i += 250) root.mkdirBatch(dirs.slice(i, i + 250));

// Room for the copy (256 bytes a row, as admitted) and a little more.
const copyBytes = (ROWS + 1) * 256;
const limit = setup.databaseBytes() + copyBytes + 2_000_000;
const vfs = new SqliteVFS(harness.sql, harness.ctx, undefined, { storageLimit: limit, storageKernelReserve: 0 });
const fs = vfs.as(CRED_KERNEL);

// Bytes no chunk shares (the store keeps each chunk once).
const distinct = (n) => {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i += 65_536) crypto.getRandomValues(bytes.subarray(i, Math.min(n, i + 65_536)));
  return bytes;
};
const copying = fs.copyTreeAsync('src', 'copy');
// The other writer, between the copy's slices, takes every byte the ledger
// shows free. The copy's remaining slices must still have their room.
await new Promise((resolve) => setTimeout(resolve, 0));
const midway = vfs.ledger.view();
const free = limit - midway.used;
const other = (() => {
  try { fs.writeFile('big', distinct(free - 1_048_576)); return 'ok'; } catch (error) { return error.code; }
})();
assert.equal(other, 'ok');
const copied = await copying.then((n) => n, (error) => error.code);

assert.equal(copied, ROWS + 1, 'the admitted copy completes');
assert.ok(midway.reserved > 0, 'the running copy held a reservation');
assert.equal(fs.readdir('copy').length, ROWS);
assert.deepEqual(vfs.ledger.view().reserved, 0, 'the reservation is released when the copy ends');

console.log('n18-reservation: ok');
