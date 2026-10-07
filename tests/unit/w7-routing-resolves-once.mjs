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
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
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
  const files = new ProcessFiles(engine);
  const router = engine.waveRouter;
  assert.ok(router, 'the namespace installs its wave router');
  const lookups = { count: 0, routed: 0 };
  const resolve = router.resolveDirectory.bind(router);
  router.resolveDirectory = (...args) => { lookups.count++; return resolve(...args); };
  // The asynchronous router path, which a record that lands here never takes.
  const routeRecord = engine.routeRecord.bind(engine);
  engine.routeRecord = (...args) => { lookups.routed++; return routeRecord(...args); };
  return { engine, files, kernel, user: engine.as(CRED_SESSION_USER), lookups };
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

// ── Review (LongTarantula): what may change a placement between the wave's own commits ──
// Each case: a wave of files under `alias` (a link to /home/user/repo/real),
// in many groups; something changes where `alias` resolves after the first
// group commits. No later file may be written where `alias` no longer leads:
// the wave lands it where it leads now, or refuses (ESTALE, ENOTDIR).
const aliased = (count, extra = []) => wave([...Array.from({ length: count }, (_, i) => ({ ...inode(i), path: `home/user/repo/alias/f${i}`, parentPath: 'home/user/repo/alias' })), ...extra]);
function aliasSession() {
  const s = session();
  s.kernel.mkdir('home/user/repo/real');
  s.kernel.chown('home/user/repo/real', 1000, 1000);
  s.user.symlink('/home/user/repo/real', 'home/user/repo/alias');
  const real = () => s.user.readdir('home/user/repo/real').length;
  return { ...s, real };
}
/**
 * Run `change` once, at a publication some groups into the wave, in its turn:
 * a synchronous listener of the store's change events, which the commit
 * delivers before it returns.
 */
function atFirstCommit(s, change) {
  let seen = 0;
  let committed = -1;
  const stop = s.engine.events.on(() => {
    // Some groups in: the wave's view has held across its own commits by now.
    if (++seen !== 3) return;
    change();
    // What that commit published, counted once it returns (before the next).
    queueMicrotask(() => { committed = s.real(); });
  });
  return () => { stop(); return committed; };
}

// P1: a mount made at the alias between groups (the mount table moved, not the store).
{
  const s = aliasSession();
  const mounted = new MemoryVFS();
  const done = atFirstCommit(s, () => s.files.vfs.mount('/home/user/repo/alias', mounted));
  const result = await s.user.writeStream(encodeWriteBatchStream(aliased(FILES)));
  const before = done();
  assert.ok(before > 0 && before < FILES, `the mount came between groups (${before} committed before it)`);
  assert.equal(s.real(), before, `${s.real() - before} files were written to SQLite under a name a mount now covers`);
  if (result.ok) assert.equal(mounted.readdir('/').length, FILES - before);
  else assert.equal(result.error.errno, 'ESTALE', JSON.stringify(result.error));
}

// P1: a listener of the wave's own commit repoints the alias into a mount.
// (The store delivers its events once the commit returns, so this is a peer
// commit between groups: it passes on the reviewed code as well. The case
// the review names, a write inside the commit absorbed as the wave's own,
// is closed by taking the revision at the publication itself (publishWatch),
// which no public hook can run inside.)
{
  const s = aliasSession();
  const shared = new MemoryVFS();
  s.files.vfs.mount('/shared', shared);
  const done = atFirstCommit(s, () => {
    s.kernel.unlink('home/user/repo/alias');
    s.kernel.symlink('/shared', 'home/user/repo/alias');
  });
  const result = await s.user.writeStream(encodeWriteBatchStream(aliased(FILES)));
  const before = done();
  assert.ok(before > 0 && before < FILES, `the repoint came between groups (${before} committed before it)`);
  assert.equal(s.real(), before, `${s.real() - before} files were written to /real after the alias led to /shared`);
  // Refused (the name no longer lands where it was placed), or landed where the link leads now.
  if (result.ok) assert.equal(shared.readdir('/').length, FILES - before);
  else assert.ok(['ESTALE', 'ENOENT'].includes(result.error.errno), JSON.stringify(result.error));
}

// P2: a regular file of the wave's own replaces the link: a name under it is ENOTDIR, not written through the stale link.
{
  const s = aliasSession();
  const shared = new MemoryVFS();
  s.files.vfs.mount('/shared', shared);
  s.user.unlink('home/user/repo/alias');
  s.user.symlink('/shared', 'home/user/repo/alias');
  const filler = Array.from({ length: 400 }, (_, i) => inode(i));
  const late = { path: 'home/user/repo/alias/b', parentPath: 'home/user/repo/alias', kind: 'file', isDir: false, size: 200, mtime: 1, mode: 0o644, chunkCount: 1 };
  const replacing = { path: 'home/user/repo/alias', parentPath: 'home/user/repo', kind: 'file', isDir: false, size: 200, mtime: 1, mode: 0o644, chunkCount: 1 };
  const result = await s.user.writeStream(encodeWriteBatchStream(aliased(40, [replacing, ...filler, late])));
  assert.equal(shared.readdir('/').includes('b'), false, 'a name under the replaced link was written through it, to /shared/b');
  assert.equal(result.ok, false, 'the wave wrote a name under a regular file');
  assert.equal(result.error.errno, 'ENOTDIR', JSON.stringify(result.error));
}

console.log('w7-routing-resolves-once: ok');
