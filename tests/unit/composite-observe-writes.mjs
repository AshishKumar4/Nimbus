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
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

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

/** `files`, asynchronous: each call answers after a timer turn, as a remote backend does. */
function remote(files, delayMs = 2) {
  return new Proxy(files, {
    get(target, key) {
      if (key === 'sync' || key === 'as' || key === 'observeWrites') return undefined;
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return value.apply(target, args);
      };
    },
  });
}

// ── A write through a link is captured as the write sees it: the file the
//    link leads to, not the link's text ──
{
  const { vfs, pc } = namespace();
  pc.writeFile('/docs/real.txt', enc.encode('old'));
  pc.symlink('/docs/real.txt', '/docs/link');
  const { events } = record(vfs);
  await vfs.writeFile('/pc/docs/link', enc.encode('new'));
  await vfs.truncate('/pc/docs/link', 1);
  assert.deepEqual(events.map(({ type, path, before, after }) => [type, path, before, after]), [
    ['modify', '/pc/docs/link', 'old', 'new'],
    ['modify', '/pc/docs/link', 'new', 'n'],
  ]);
}

// ── The guard is asked right before the write, after the reads the report
//    waited on: a holder closed during them writes nothing ──
{
  const { vfs } = namespace();
  const backing = new MemoryVFS({ uid: 1000, gid: 1000 });
  backing.writeFile('/f', enc.encode('kept'));
  vfs.mount('/dev-remote', remote(backing), { resolvesPaths: true });
  record(vfs);
  let live = true;
  const holder = vfs.as(user).scoped(() => { if (!live) throw Object.assign(new Error('EBADF: the process is gone'), { code: 'EBADF' }); });
  const write = holder.writeFile('/dev-remote/f', enc.encode('late'));
  await new Promise((resolve) => setTimeout(resolve, 1));
  live = false;
  await assert.rejects(write, /the process is gone/);
  assert.equal(dec.decode(backing.readFile('/f')), 'kept', 'a write landed after its holder was closed');
}

// ── Observed writes of one path on an asynchronous backend take turns: each
//    reads what the one before it wrote ──
{
  const { vfs } = namespace();
  const backing = new MemoryVFS();
  backing.writeFile('/shared', enc.encode('old'));
  vfs.mount('/r', remote(backing), { resolvesPaths: true });
  const { events } = record(vfs);
  await Promise.all(['a', 'b', 'c'].map((text) => vfs.writeFile('/r/shared', enc.encode(text))));
  const chain = events.map(({ before, after }) => [before, after]);
  assert.equal(chain.length, 3);
  assert.equal(chain[0][0], 'old');
  for (let index = 1; index < chain.length; index++) {
    assert.equal(chain[index][0], chain[index - 1][1], `concurrent writes read each other's content: ${JSON.stringify(chain)}`);
  }
}

// ── A file copied onto a link is captured as the copy writes it: through
//    the link, to the file it leads to; a copied link is its own ──
{
  const { vfs, pc } = namespace();
  pc.writeFile('/docs/real.txt', enc.encode('old'));
  pc.symlink('/docs/real.txt', '/docs/link');
  await vfs.writeFile('/home/user/src.txt', enc.encode('copied'));
  const { events } = record(vfs);
  await vfs.copy('/home/user/src.txt', '/pc/docs/link');
  assert.deepEqual(events.map(({ type, path, before, after }) => [type, path, before, after]), [
    ['modify', '/pc/docs/link', 'old', 'copied'],
  ]);
}

// ── Writes that change one file take turns, whatever path names it: a link
//    on the backend, or the same backend mounted twice ──
{
  const { vfs } = namespace();
  const backing = new MemoryVFS();
  backing.writeFile('/real', enc.encode('old'));
  backing.symlink('/real', '/link');
  const shared = remote(backing);
  vfs.mount('/r1', shared, { resolvesPaths: true });
  vfs.mount('/r2', shared, { resolvesPaths: true });
  const { events } = record(vfs);
  await Promise.all([
    vfs.writeFile('/r1/link', enc.encode('a')),
    vfs.writeFile('/r1/real', enc.encode('b')),
    vfs.writeFile('/r2/real', enc.encode('c')),
  ]);
  const chain = events.map(({ before, after }) => [before, after]);
  assert.equal(chain.length, 3);
  assert.equal(chain[0][0], 'old');
  for (let index = 1; index < chain.length; index++) {
    assert.equal(chain[index][0], chain[index - 1][1], `writes to one file under two names read each other's content: ${JSON.stringify(chain)}`);
  }
}

// ── A synchronous write cannot run inside an asynchronous one's section on
//    a backend with both faces: it is refused, as an asynchronous mount
//    refuses a caller that cannot wait ──
{
  const { vfs } = namespace();
  const backing = new MemoryVFS();
  backing.writeFile('/f', enc.encode('old'));
  const dual = remote(backing, 5);
  const both = new Proxy(dual, { get: (target, key) => (key === 'sync' ? backing : Reflect.get(target, key)) });
  vfs.mount('/dual', both, { resolvesPaths: true });
  const { events } = record(vfs);
  const pending = vfs.writeFile('/dual/f', enc.encode('async'));
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.throws(() => vfs.sync.writeFile('/dual/f', enc.encode('sync')), (error) => error.code === 'EAGAIN' && error.asyncMount === true,
    'a synchronous write ran inside an asynchronous write\'s section');
  await pending;
  vfs.sync.writeFile('/dual/f', enc.encode('sync'));
  assert.deepEqual(events.map(({ before, after }) => [before, after]), [['old', 'async'], ['async', 'sync']]);
}

// ── A factory that answers a fresh adapter on every lookup is still one
//    backend: its writes take one turn queue, and a synchronous call meets
//    its busy section ──
{
  const { vfs } = namespace();
  const backing = new MemoryVFS();
  backing.writeFile('/f', enc.encode('old'));
  vfs.mount('/fresh', () => remote(backing), { resolvesPaths: true });
  const dualBacking = new MemoryVFS();
  dualBacking.writeFile('/f', enc.encode('old'));
  vfs.mount('/fresh-dual', () => new Proxy(remote(dualBacking, 5), { get: (target, key) => (key === 'sync' ? dualBacking : Reflect.get(target, key)) }), { resolvesPaths: true });
  const { events } = record(vfs);
  await Promise.all(['a', 'b', 'c'].map((text) => vfs.writeFile('/fresh/f', enc.encode(text))));
  const chain = events.map(({ before, after }) => [before, after]);
  assert.equal(chain[0][0], 'old');
  for (let index = 1; index < chain.length; index++) {
    assert.equal(chain[index][0], chain[index - 1][1], `a factory's writes took separate turns: ${JSON.stringify(chain)}`);
  }
  const pending = vfs.writeFile('/fresh-dual/f', enc.encode('async'));
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.throws(() => vfs.sync.writeFile('/fresh-dual/f', enc.encode('sync')), (error) => error.code === 'EAGAIN' && error.asyncMount === true,
    "a synchronous write ran inside a factory backend's busy section");
  await pending;
}

// ── One backend mounted directly and through a factory is one backend:
//    writes through either alias take one turn queue, asynchronous or not ──
{
  const { vfs } = namespace();
  const backing = new MemoryVFS();
  backing.writeFile('/f', enc.encode('old'));
  const shared = new Proxy(remote(backing, 5), { get: (target, key) => (key === 'sync' ? backing : Reflect.get(target, key)) });
  vfs.mount('/a', shared, { resolvesPaths: true });
  vfs.mount('/b', () => shared, { resolvesPaths: true });
  const { events } = record(vfs);
  await Promise.all([
    vfs.writeFile('/a/f', enc.encode('a1')),
    vfs.writeFile('/b/f', enc.encode('b1')),
    vfs.writeFile('/a/f', enc.encode('a2')),
  ]);
  const chain = events.map(({ before, after }) => [before, after]);
  assert.equal(chain[0][0], 'old');
  for (let index = 1; index < chain.length; index++) {
    assert.equal(chain[index][0], chain[index - 1][1], `writes through a fixed and a factory alias read each other's content: ${JSON.stringify(chain)}`);
  }
  for (const [busy, other] of [['/a/f', '/b/f'], ['/b/f', '/a/f']]) {
    const pending = vfs.writeFile(busy, enc.encode('async'));
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.throws(() => vfs.sync.writeFile(other, enc.encode('sync')), (error) => error.code === 'EAGAIN' && error.asyncMount === true,
      `a synchronous write through ${other} ran inside ${busy}'s busy section`);
    await pending;
  }
}

// ── A root write the namespace does not show (beneath a mount point) is not
//    the namespace's; a rename half shown is the delete it is there ──
{
  const { engine, kernel, vfs } = namespace();
  kernel.mkdir('home/user/mnt');
  kernel.chown('home/user/mnt', 1000, 1000);
  vfs.mount('/home/user/mnt', new MemoryVFS());
  const { events } = record(vfs);
  const proc = engine.as(user);
  proc.writeFile('home/user/mnt/hidden', 'under the mount');
  proc.writeFile('home/user/out', 'shown');
  proc.rename('home/user/out', 'home/user/mnt/in');
  assert.deepEqual(events.map(({ type, path, before, after }) => [type, path, before, after]), [
    ['create', '/home/user/out', null, 'shown'],
    ['delete', '/home/user/out', 'shown', null],
  ]);
}

// ── Content the namespace read itself is let go once the observer is done,
//    however it finished ──
{
  const { vfs, pc } = namespace();
  pc.writeFile('/docs/r.txt', enc.encode('before'));
  let kept;
  const stopSync = vfs.observeWrites((event) => { kept = event; });
  await vfs.writeFile('/pc/docs/r.txt', enc.encode('after'));
  stopSync();
  assert.throws(() => kept.before.read(), /EBADF/, 'a synchronous observer kept the content after it returned');
  let resolveLater;
  const stopAsync = vfs.observeWrites((event) => { kept = event; return new Promise((resolve) => { resolveLater = resolve; }); });
  await vfs.writeFile('/pc/docs/r.txt', enc.encode('again'));
  assert.equal(dec.decode(kept.before.read()), 'after', 'content was let go before the observer was done');
  resolveLater();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.throws(() => kept.after.read(), /EBADF/);
  stopAsync();
  const stopThrowing = vfs.observeWrites((event) => { kept = event; throw new Error('observer failed'); });
  await vfs.writeFile('/pc/docs/r.txt', enc.encode('third'));
  stopThrowing();
  assert.throws(() => kept.after.read(), /EBADF/, 'a failed observer kept the content');
}

// ── Only what actually landed is reported ──
{
  const { vfs, pc } = namespace();
  const { events } = record(vfs);
  // rm -r that keeps its operand: only what it removed.
  const keeping = new MemoryVFS();
  keeping.mkdir('/d');
  keeping.writeFile('/d/a', enc.encode('a'));
  keeping.writeFile('/d/b', enc.encode('b'));
  keeping.removeRecursive = (path) => {
    keeping.unlink(`${path}/a`);
    return { removed: [`${path}/a`], kept: [path, `${path}/b`], failures: [{ path: `${path}/b`, error: { code: 'EACCES', syscall: 'unlink' } }] };
  };
  vfs.mount('/keep', keeping);
  await vfs.removeRecursive('/keep/d');
  // A name renamed onto itself, and mkdir -p of a directory that is there.
  pc.writeFile('/docs/same', enc.encode('same'));
  await vfs.rename('/pc/docs/same', '/pc/docs/same');
  await vfs.mkdir('/pc/docs', { recursive: true });
  assert.deepEqual(events.map(({ type, path, after }) => [type, path, after]), [
    ['delete', '/keep/d/a', null],
  ], `a mutation that did not land was reported: ${JSON.stringify(events)}`);
}

// ── A compare-and-write is reported when it wins, on a backend reported at
//    the namespace (a factory-rooted SqliteFiles), and never when it loses ──
{
  const { vfs } = namespace();
  const harness = createSqliteVfsTestHarness();
  const other = new SqliteVFS(harness.sql, harness.ctx);
  other.as(CRED_KERNEL).writeFile('cas.txt', 'one');
  vfs.mount('/db', () => sqliteFiles(other, CRED_KERNEL));
  const { events } = record(vfs);
  const { revision } = await vfs.stat('/db/cas.txt');
  assert.equal((await vfs.writeFileIfRevision('/db/cas.txt', enc.encode('two'), revision)).ok, true);
  assert.equal((await vfs.writeFileIfRevision('/db/cas.txt', enc.encode('three'), revision)).ok, false);
  assert.equal(vfs.sync.writeFileIfRevision('/db/cas.txt', enc.encode('four'), revision).ok, false);
  const current = vfs.sync.stat('/db/cas.txt').revision;
  assert.equal(vfs.sync.writeFileIfRevision('/db/cas.txt', enc.encode('five'), current).ok, true);
  assert.deepEqual(events.map(({ type, path, before, after }) => [type, path, before, after]), [
    ['modify', '/db/cas.txt', 'one', 'two'],
    ['modify', '/db/cas.txt', 'two', 'five'],
  ]);
}

console.log('composite observeWrites: ok');
