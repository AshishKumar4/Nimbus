#!/usr/bin/env bun
// A workspace keeps no per-file state for the files it writes or removes.
//
// An embedder keeps one NimbusWorkspace per Durable Object for the isolate's
// life, under a 128 MB limit, so anything the engine holds per file written
// is unbounded growth there. SQLite holds every file: the inode cache admits
// only what a lookup asks for, and a revision stamp is a directory's, never a
// file's. Measured as the JS heap after a full GC, per file, over files
// written through the public filesystem and then removed through it.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { heapStats } from 'bun:jsc';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';

const FILES = 6_000;
const PER_DIRECTORY = 100;
// Before: ~350 B written (an inode and a revision per file), ~80 B removed (a revision).
const MAX_BYTES_PER_FILE = 48;

const db = new Database(':memory:');
const sql = {
  exec(query, ...bindings) {
    const statement = db.prepare(query);
    const rows = statement.all(...bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)));
    statement.finalize();
    return rows;
  },
  get databaseSize() { return 0; },
};
const transactions = { storage: { transactionSync: (write) => db.transaction(write)() } };

function heap() {
  Bun.gc(true);
  Bun.gc(true);
  return heapStats().heapSize;
}

const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user' });
const body = new Uint8Array(2048).fill(97);
const pathOf = (round, i) => `/home/user/${round}/d${Math.floor(i / PER_DIRECTORY)}/f${i % PER_DIRECTORY}.txt`;

async function writeAll(round) {
  for (let i = 0; i < FILES; i++) {
    if (i % PER_DIRECTORY === 0) await ws.fs.mkdir(`/home/user/${round}/d${i / PER_DIRECTORY}`, { recursive: true });
    await ws.fs.writeFile(pathOf(round, i), body);
  }
}

async function removeAll(round) {
  for (let i = 0; i < FILES; i++) await ws.fs.unlink(pathOf(round, i));
}

try {
  // Warm: code, statements, and the bounded invalidation log at its cap.
  await writeAll('warm');
  await removeAll('warm');
  const before = heap();

  await writeAll('data');
  const written = (heap() - before) / FILES;
  assert.ok(written < MAX_BYTES_PER_FILE, `${written.toFixed(0)} B of heap held per file written (at most ${MAX_BYTES_PER_FILE})`);
  assert.equal((await ws.fs.readFile(pathOf('data', FILES - 1))).byteLength, body.byteLength);

  await removeAll('data');
  const removed = (heap() - before) / FILES;
  assert.ok(removed < MAX_BYTES_PER_FILE, `${removed.toFixed(0)} B of heap held per file removed (at most ${MAX_BYTES_PER_FILE})`);
  assert.equal(await ws.fs.exists(pathOf('data', 0)), false);

  console.log(`sqlite-vfs-write-retention: ok (${written.toFixed(0)} B per file written, ${removed.toFixed(0)} B per file removed)`);
} finally {
  await ws.close();
  db.close();
}
