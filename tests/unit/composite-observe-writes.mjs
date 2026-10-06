#!/usr/bin/env bun
// CompositeVFS.observeWrites (Kinu's ask 24): one observer for every
// mutation that lands in the namespace, on any mount, once each, with what
// stood at its path before, what stands there after, and the principal it
// was made as. SQLite reports its own (so a write that never went through
// the namespace — a process's, a stream's — is reported too, its replaced
// content held until the observer is done); any other backend is reported
// at the namespace, which reads what the path held where the observer
// wants it. A refused or failed write reports nothing.

import assert from 'node:assert/strict';
import { CHUNK_SIZE } from '../../packages/platform/src/limits.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

function namespace() {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home');
  kernel.mkdir('home/user');
  kernel.chown('home/user', 1000, 1000);
  const vfs = new CompositeVFS(sqliteFiles(engine, CRED_KERNEL));
  const pc = new MemoryVFS({ uid: 1000, gid: 1000 });
  pc.mkdir('/docs');
  vfs.mount('/pc', pc, { resolvesPaths: true });
  vfs.mount('/ro', new MemoryVFS(), { readOnly: true });
  return { engine, kernel, vfs, pc };
}

const text = (ref) => (ref === null || ref === undefined ? ref : ref.type === 'directory' ? 'dir' : dec.decode(ref.read()));

function record(vfs, options) {
  const events = [];
  const stop = vfs.observeWrites((event) => {
    events.push({
      type: event.type,
      path: event.path,
      ...(event.oldPath !== undefined ? { oldPath: event.oldPath } : {}),
      before: text(event.before),
      after: text(event.after),
      uid: event.principal.cred?.uid ?? null,
      actor: event.principal.actor,
    });
  }, options);
  return { events, stop };
}

// ── SQLite: once per write through the namespace, with the view's principal ──
{
  const { vfs } = namespace();
  const head = vfs.as(user, 'head-1');
  await head.writeFile('/home/user/a.txt', enc.encode('one'));
  const { events } = record(vfs);
  await head.writeFile('/home/user/a.txt', enc.encode('two'));
  await head.writeFile('/home/user/b.txt', enc.encode('new'));
  await head.rename('/home/user/b.txt', '/home/user/c.txt');
  await head.unlink('/home/user/a.txt');
  assert.deepEqual(events, [
    { type: 'modify', path: '/home/user/a.txt', before: 'one', after: 'two', uid: 1000, actor: 'head-1' },
    { type: 'create', path: '/home/user/b.txt', before: null, after: 'new', uid: 1000, actor: 'head-1' },
    { type: 'rename', path: '/home/user/c.txt', oldPath: '/home/user/b.txt', before: null, after: 'new', uid: 1000, actor: 'head-1' },
    { type: 'delete', path: '/home/user/a.txt', before: 'two', after: null, uid: 1000, actor: 'head-1' },
  ]);
}

// ── SQLite: a write that never went through the namespace is reported too ──
{
  const { engine, vfs } = namespace();
  const { events } = record(vfs);
  // A process's bridge writes the engine through its own credentialed view.
  engine.as(user).writeFile('home/user/proc.txt', 'from a process');
  assert.deepEqual(events, [
    { type: 'create', path: '/home/user/proc.txt', before: null, after: 'from a process', uid: 1000, actor: undefined },
  ]);
}

// ── Another mount: reported at the namespace, with what the path held ──
{
  const { vfs, pc } = namespace();
  pc.writeFile('/docs/report.md', enc.encode('draft'));
  const { events } = record(vfs);
  const head = vfs.as(user, 'head-2');
  await head.writeFile('/pc/docs/report.md', enc.encode('final'));
  await head.writeFile('/pc/docs/new.md', enc.encode('fresh'));
  await head.rename('/pc/docs/new.md', '/pc/docs/report.md');
  await head.mkdir('/pc/docs/sub');
  await head.unlink('/pc/docs/report.md');
  assert.deepEqual(events, [
    { type: 'modify', path: '/pc/docs/report.md', before: 'draft', after: 'final', uid: 1000, actor: 'head-2' },
    { type: 'create', path: '/pc/docs/new.md', before: null, after: 'fresh', uid: 1000, actor: 'head-2' },
    { type: 'rename', path: '/pc/docs/report.md', oldPath: '/pc/docs/new.md', before: 'final', after: 'fresh', uid: 1000, actor: 'head-2' },
    { type: 'create', path: '/pc/docs/sub', before: null, after: 'dir', uid: 1000, actor: 'head-2' },
    { type: 'delete', path: '/pc/docs/report.md', before: 'fresh', after: null, uid: 1000, actor: 'head-2' },
  ]);
}

// ── A refused or failed write reports nothing, on any mount ──
{
  const { vfs } = namespace();
  const { events } = record(vfs);
  const head = vfs.as(user);
  await assert.rejects(head.writeFile('/ro/x', enc.encode('x')), /EROFS/);
  await assert.rejects(head.writeFile('/etc-file', enc.encode('x')), /EACCES/);
  await assert.rejects(head.writeFile('/home/user/missing/x', enc.encode('x')), /ENOENT/);
  await assert.rejects(head.mkdir('/pc/docs'), /EEXIST/);
  assert.deepEqual(events, [], `a refused write was reported: ${JSON.stringify(events)}`);
}

// ── `wants`: content is read only where the observer wants it ──
{
  const { vfs, pc } = namespace();
  pc.writeFile('/docs/skip.bin', enc.encode('old'));
  const { events } = record(vfs, { wants: (path) => !path.endsWith('.bin') });
  await vfs.writeFile('/pc/docs/skip.bin', enc.encode('new'));
  await vfs.writeFile('/pc/docs/keep.txt', enc.encode('kept'));
  assert.deepEqual(events.map(({ type, path, before, after }) => ({ type, path, before, after })), [
    { type: 'modify', path: '/pc/docs/skip.bin', before: undefined, after: undefined },
    { type: 'create', path: '/pc/docs/keep.txt', before: null, after: 'kept' },
  ]);
}

// ── An observer that is not done holds SQLite's replaced content ──
{
  const { engine, vfs } = namespace();
  const old = new Uint8Array(CHUNK_SIZE * 2 + 1).fill(7);
  await vfs.writeFile('/home/user/big', old);
  let release;
  let before;
  const stop = vfs.observeWrites((event) => {
    before = event.before;
    return new Promise((resolve) => { release = resolve; });
  });
  await vfs.writeFile('/home/user/big', enc.encode('small'));
  for (let pass = 0; pass < 100 && engine.runContentMaintenance(64).transactions > 0; pass++);
  assert.deepEqual(before.read(), old, "collection took content the namespace's observer holds");
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.throws(() => before.read(), /EBADF/);
  stop();
}

// ── A mount made after observing is observed; stopping stops every report ──
{
  const { vfs } = namespace();
  const { events, stop } = record(vfs);
  const later = new MemoryVFS();
  vfs.mount('/later', later);
  await vfs.writeFile('/later/x', enc.encode('x'));
  stop();
  await vfs.writeFile('/later/y', enc.encode('y'));
  await vfs.writeFile('/home/user/z', enc.encode('z'));
  assert.deepEqual(events.map((event) => event.path), ['/later/x']);
}

console.log('composite observeWrites: ok');
