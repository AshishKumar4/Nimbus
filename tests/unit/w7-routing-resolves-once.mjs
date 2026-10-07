#!/usr/bin/env bun
// A wave places each directory once while nothing else changes the namespace
// (SqliteVFS consumeStream: `view`).
//
// Every record of a wave is placed by the namespace's lookup (the wave
// router), and a placement holds while the namespace it was made in does.
// The wave's own commit of files that are not links changes no directory a
// later name resolves through, so it keeps the view. Red before: each commit
// of the wave's own files started a new one, and the later records went back
// through the lookup. Measured: 569 lookups for a 960-file wave over 40
// directories, against 40 now, and the routed wave took about twice the
// unrouted one's CPU (live: 272 ms against 124 ms per slow clone wave).
// Anything else that commits still starts a new view: a link of the wave's
// own, here, and another writer's change (w7-mount-routing.mjs). And a record
// that lands here is placed in its own turn: only one that may route to a
// mount takes the asynchronous router path (routeRecord).

import assert from 'node:assert/strict';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const DIRS = 40;
const FILES = 960;
const data = new TextEncoder().encode('x'.repeat(200));

function session() {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user/repo', { recursive: true });
  kernel.chown('home/user', 1000, 1000);
  kernel.chown('home/user/repo', 1000, 1000);
  for (let d = 0; d < DIRS; d++) {
    kernel.mkdir(`home/user/repo/d${d}`);
    kernel.chown(`home/user/repo/d${d}`, 1000, 1000);
  }
  new ProcessFiles(engine);
  const router = engine.waveRouter;
  assert.ok(router, 'the namespace installs its wave router');
  const lookups = { count: 0, routed: 0 };
  const resolve = router.resolveDirectory.bind(router);
  router.resolveDirectory = (...args) => { lookups.count++; return resolve(...args); };
  // The asynchronous router path, which a record that lands here never takes.
  const routeRecord = engine.routeRecord.bind(engine);
  engine.routeRecord = (...args) => { lookups.routed++; return routeRecord(...args); };
  return { user: engine.as(CRED_SESSION_USER), lookups };
}

const inode = (i) => ({ path: `home/user/repo/d${i % DIRS}/f${i}`, parentPath: `home/user/repo/d${i % DIRS}`, kind: 'file', isDir: false, size: 200, mtime: 1, mode: 0o644, chunkCount: 1 });
/** A wave of whole files (inodes and their chunks), as a checkout sends. */
const wave = (inodes, chunkData = () => data) => ({ inodes, chunks: inodes.map((entry) => ({ path: entry.path, chunkId: 0, data: chunkData(entry) })) });

// ── Files only: each directory is looked up once ──
{
  const { user, lookups } = session();
  const result = await user.writeStream(encodeWriteBatchStream(wave(Array.from({ length: FILES }, (_, i) => inode(i)))));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(user.readdir('home/user/repo/d7').length, FILES / DIRS);
  assert.equal(lookups.count, DIRS, `a ${FILES}-file wave over ${DIRS} directories looked them up ${lookups.count} times`);
  // Placed in their own turn, no await per record (red before: every record, ${FILES * 3} and more, went through it).
  assert.equal(lookups.routed, 0, `${lookups.routed} records of a wave that lands here took the asynchronous router path`);
}

// ── A link of the wave's own starts a new view: the names after it are placed again ──
{
  const { user, lookups } = session();
  const inodes = Array.from({ length: 400 }, (_, i) => inode(i));
  inodes.push({ path: 'home/user/repo/link', parentPath: 'home/user/repo', kind: 'symlink', isDir: false, size: 2, mtime: 1, mode: 0o777, chunkCount: 1 });
  for (let i = 400; i < 800; i++) inodes.push(inode(i));
  const link = new TextEncoder().encode('d0');
  const result = await user.writeStream(encodeWriteBatchStream(wave(inodes, (entry) => (entry.kind === 'symlink' ? link : data))));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(user.readlink('home/user/repo/link'), 'd0');
  assert.ok(lookups.count > DIRS + 1, `the names after the wave's own link were not placed again (${lookups.count} lookups)`);
}

console.log('w7-routing-resolves-once: ok');
