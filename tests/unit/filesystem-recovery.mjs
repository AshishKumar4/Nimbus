#!/usr/bin/env bun
// A process's log drains through its own binding (NimbusFilesystemAuthority
// .recovery): its release ends every ordinary binding at once, as it always
// did, while the one recovery keeps its descriptions and the grants that
// reserved its inodes until the drain ends; and the release settles only
// then, so whatever waits for it (a destroy) comes after the drain.
//
// Red before: with a recovery taken, the release left the process's scope
// open, so an ordinary binding kept reading and writing and an in-flight
// commit through one landed beside the drain; a second recovery was granted
// over the same scope; and the release settled before the drain had ended.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { encodeWriteBatch, encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { asyncOnly } from './lib/async-memory-vfs.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const text = (data) => new TextDecoder().decode(data);
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A session's filesystem and process table, composed as a workspace composes them. */
function session() {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user/repo', { recursive: true });
  kernel.chown('home/user', 1000, 1000);
  kernel.chown('home/user/repo', 1000, 1000);
  const filesystem = new ProcessFiles(engine);
  const processes = new SessionProcessSupervisor();
  processes.setRelease((pid) => filesystem.releaseProcess(pid), (pid) => filesystem.processEnded(pid));
  const op = createSupervisorOpHandler({ vfs: engine, filesystem, processes });
  return { engine, kernel, filesystem, processes, op };
}

// ── An ordinary binding ends with the release; the recovery does not, and
//    the release settles when the recovery ends ──────────────────────────
{
  const s = session();
  const { pid } = s.processes.spawn('git commit', [], '/home/user', { cred: user });
  const fs = s.filesystem.bind({ pid, cred: user });
  fs.writeFile('/home/user/repo/kept', 'k');
  const opened = fs.open('/home/user/repo/kept', { read: true });
  const grant = await s.op({ op: 'fsAcquireExclusiveMutation', args: ['/home/user/repo', { delegate: { reads: true } }], pid });
  const recovery = s.filesystem.recovery(pid, user);
  s.processes.kill(pid, 137);
  const released = s.processes.released(pid);
  let settled = false;
  void released.then(() => { settled = true; });
  assert.throws(() => fs.readFile('/home/user/repo/kept'), { code: 'EBADF' }, 'an ordinary binding read after the release');
  assert.throws(() => fs.writeFile('/home/user/repo/late', 'l'), { code: 'EBADF' }, 'an ordinary binding wrote after the release');
  assert.throws(() => fs.read(opened.id, 0, 1), { code: 'EBADF' });
  assert.throws(() => fs.close(opened.id), { code: 'EBADF' }, 'an ordinary binding closed a descriptor after the release');
  assert.equal(text(recovery.fs.readFile('/home/user/repo/kept')), 'k', 'the recovery lost the binding');
  assert.equal(text(recovery.fs.read(opened.id, 0, 1)), 'k', 'the recovery lost the process\'s descriptions');
  assert.equal(s.engine.hasExclusiveMutation(), true, 'the grant went before the drain ended');
  recovery.fs.writeFile('/home/user/repo/drained', 'd');
  await turn();
  assert.equal(settled, false, 'the release settled before the drain ended');
  await recovery.dispose();
  await released;
  assert.equal(s.engine.hasExclusiveMutation(), false, 'the grant outlived the drain');
  assert.throws(() => recovery.fs.readFile('/home/user/repo/kept'), { code: 'EBADF' });
  assert.equal(text(s.kernel.readFile('home/user/repo/drained')), 'd');
  assert.ok(grant.owner);
  console.log('  an ordinary binding ends with the release; the recovery, and the release, with the drain');
}

// ── A commit in flight through an ordinary binding does not land beside the
//    drain ─────────────────────────────────────────────────────────────────
{
  const s = session();
  const { pid } = s.processes.spawn('git commit', [], '/home/user', { cred: user });
  const fs = s.filesystem.bind({ pid, cred: user });
  const payload = {
    inodes: [{ path: 'home/user/repo/cancelled', parentPath: 'home/user/repo', isDir: false, size: 3, mtime: 1, mode: 0o644, chunkCount: 1 }],
    chunks: [{ path: 'home/user/repo/cancelled', chunkId: 0, data: new TextEncoder().encode('abc') }],
  };
  const encoded = new Uint8Array(await new Response(encodeWriteBatchStream(payload)).arrayBuffer());
  let resume;
  const resumed = new Promise((resolve) => { resume = resolve; });
  // The head, then the rest once the release has come: paused mid-commit.
  const paused = new ReadableStream({
    type: 'bytes',
    pull(controller) {
      if (this.sent === undefined) {
        this.sent = true;
        controller.enqueue(encoded.slice(0, 24));
        return;
      }
      return resumed.then(() => { controller.enqueue(encoded.slice(24)); controller.close(); });
    },
  });
  const commit = fs.writeStream(paused).then((result) => ({ resolved: result }), (error) => ({ rejected: error }));
  const recovery = s.filesystem.recovery(pid, user);
  s.processes.kill(pid, 137);
  resume();
  const outcome = await commit;
  assert.ok(outcome.rejected || outcome.resolved.ok === false, 'a commit in flight through an ordinary binding landed after the release');
  assert.equal(s.kernel.exists('home/user/repo/cancelled'), false, 'the commit published its inode');
  await recovery.dispose();
  console.log('  a commit in flight through an ordinary binding does not land beside the drain');
}

// ── What an ordinary binding wrote to a mount, buffered in its description,
//    is flushed by the release, as a release flushes it, with its log
//    draining as without ─────────────────────────────────────────────────
{
  const s = session();
  const mounted = new MemoryVFS({ uid: 1000, gid: 1000 });
  /** No writeRange, its credentialed views too: a description buffers what is written through it. */
  const unranged = (vfs) => new Proxy(vfs, {
    get(target, key) {
      if (key === 'writeRange') return undefined;
      const value = target[key];
      if (key === 'sync') return value === undefined ? undefined : unranged(value);
      if (typeof value !== 'function') return value;
      if (key === 'as') return (...args) => unranged(value.apply(target, args));
      return value.bind(target);
    },
    has: (target, key) => key !== 'writeRange' && key in target,
  });
  s.filesystem.vfs.mount('/home/user/b', unranged(mounted));
  const { pid } = s.processes.spawn('git commit', [], '/home/user', { cred: user });
  const fs = s.filesystem.bind({ pid, cred: user });
  const opened = await fs.open('/home/user/b/l.txt', { write: true, create: true });
  await fs.write(opened.id, 0, new TextEncoder().encode('flushed'));
  const recovery = s.filesystem.recovery(pid, user);
  s.processes.kill(pid, 137);
  await recovery.dispose();
  await s.processes.released(pid);
  assert.equal(text(mounted.readFile('/l.txt')), 'flushed', 'the release lost what was written to a mount');
  console.log('  what an ordinary binding wrote to a mount is flushed by the release');
}

// ── A description a wave opened on a mount, its open answered and a write
//    through it not, lands when the drain sends that write ──────────────────
{
  const s = session();
  const mounted = new MemoryVFS({ uid: 1000, gid: 1000 });
  s.filesystem.vfs.mount('/home/user/m', mounted);
  const { pid } = s.processes.spawn('git commit', [], '/home/user', { cred: user });
  const fs = s.filesystem.bind({ pid, cred: user });
  const recovery = s.filesystem.recovery(pid, user);
  const wave = async (through, ops) => {
    const bytes = await encodeWriteBatch({ inodes: [], chunks: [], ops });
    return through.writeStream(new ReadableStream({ type: 'bytes', start(controller) { controller.enqueue(bytes); controller.close(); } }));
  };
  const written = (offset, data) => ({ type: 'call', call: { call: 'write', path: 'home/user/m/f.txt', description: 'd1', offset, data: new TextEncoder().encode(data) } });
  const opened = await wave(fs, [{ type: 'call', call: { call: 'open', path: 'home/user/m/f.txt', mode: 0o644, access: 'write', create: true, description: 'd1' } }, written(0, 'A')]);
  assert.equal(opened.ok, true, JSON.stringify(opened.error));
  s.processes.kill(pid, 137);
  // The drain: what the process logged after, never answered.
  const drained = await wave(recovery.fs, [written(1, 'B')]);
  assert.equal(drained.ok, true, `the drain lost the description its log names: ${JSON.stringify(drained.error)}`);
  await recovery.dispose();
  await s.processes.released(pid);
  assert.equal(text(mounted.readFile('/f.txt')), 'AB');
  console.log('  a description a wave opened on a mount is the drain\'s to write through');
}

// ── An ordinary binding's call on an awaiting mount, paused past the
//    release, is refused where it would reach the mount: a pathname change,
//    a write through a descriptor, an fsync; the recovery's goes on ───────
{
  /** A mount whose next call of `method` waits until let go (arm). */
  const pausing = () => {
    let armed = null;
    return {
      arm(method) {
        let release;
        let reached;
        const held = new Promise((resolve) => { release = resolve; });
        const at = new Promise((resolve) => { reached = resolve; });
        armed = { method, held, reached };
        return { at, release };
      },
      async beforeCall(method) {
        const now = armed;
        if (now === null || now.method !== method) return;
        armed = null;
        now.reached();
        await now.held;
      },
    };
  };
  const enc = new TextEncoder();
  const s = session();
  const mounted = new MemoryVFS({ uid: 1000, gid: 1000 });
  mounted.writeFile('/doomed', new TextEncoder().encode('d'));
  const pause = pausing();
  s.filesystem.vfs.mount('/home/user/am', asyncOnly(mounted, { beforeCall: (method) => pause.beforeCall(method) }));
  const { pid } = s.processes.spawn('git commit', [], '/home/user', { cred: user });
  const fs = s.filesystem.bind({ pid, cred: user });
  const opened = await fs.open('/home/user/am/w', { write: true, create: true });
  const recovery = s.filesystem.recovery(pid, user);
  const outcome = (call) => call.then(() => 'landed', (error) => error.code);
  const unlinkAt = pause.arm('stat');
  const unlinked = outcome(fs.unlink('/home/user/am/doomed'));
  await unlinkAt.at;
  const writeAt = pause.arm('stat');
  const written = outcome(fs.write(opened.id, 0, enc.encode('LATE')));
  s.processes.kill(pid, 137);
  unlinkAt.release();
  await writeAt.at;
  writeAt.release();
  const synced = await outcome(Promise.resolve().then(() => fs.fsync(opened.id)));
  assert.deepEqual(
    { unlink: await unlinked, write: await written, fsync: synced },
    { unlink: 'EBADF', write: 'EBADF', fsync: 'EBADF' },
    'an ordinary binding\'s call, paused past the release (or after it), reached the mount',
  );
  assert.equal(text(mounted.readFile('/doomed')), 'd');
  await recovery.fs.write(opened.id, 0, enc.encode('DRAINED'));
  assert.equal(text(mounted.readFile('/w')), 'DRAINED', 'the recovery lost the process\'s descriptor');
  await recovery.dispose();
  await s.processes.released(pid);
  console.log('  an ordinary binding\'s paused call is refused where it would reach the mount; the recovery\'s goes on');
}

// ── One recovery per process ─────────────────────────────────────────────
{
  const s = session();
  const { pid } = s.processes.spawn('git commit', [], '/home/user', { cred: user });
  s.filesystem.bind({ pid, cred: user });
  const recovery = s.filesystem.recovery(pid, user);
  assert.throws(() => s.filesystem.recovery(pid, user), { code: 'EBUSY' }, 'a second recovery was granted beside the first');
  await recovery.dispose();
  console.log('  one recovery per process');
}

// ── A binding's stream commits leave no listener on the signals it is bound
//    under: 10,000 of them, landed and refused ────────────────────────────
{
  const s = session();
  s.kernel.mkdir('home/root-only', { mode: 0o755 });
  const { pid } = s.processes.spawn('git commit', [], '/home/user', { cred: user });
  const fs = s.filesystem.bind({ pid, cred: user });
  const recovery = s.filesystem.recovery(pid, user);
  const live = new Map();
  let added = 0;
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, ...rest) {
    if (type === 'abort') { added++; live.set(this, (live.get(this) ?? 0) + 1); }
    return add.call(this, type, ...rest);
  };
  EventTarget.prototype.removeEventListener = function (type, ...rest) {
    if (type === 'abort') live.set(this, (live.get(this) ?? 0) - 1);
    return remove.call(this, type, ...rest);
  };
  const commit = (path) => fs.writeStream(encodeWriteBatchStream({
    inodes: [{ path, parentPath: path.slice(0, path.lastIndexOf('/')), isDir: false, size: 1, mtime: 1, mode: 0o644, chunkCount: 1 }],
    chunks: [{ path, chunkId: 0, data: new Uint8Array([120]) }],
  }));
  try {
    let landed = 0;
    let refused = 0;
    for (let i = 0; i < 5_000; i++) {
      if ((await commit(`home/user/repo/f${i % 10}`)).ok) landed++;
      const outcome = await commit('home/root-only/f').then((result) => result.ok, () => false);
      if (!outcome) refused++;
    }
    assert.deepEqual([landed, refused], [5_000, 5_000], 'the commits did not land and refuse as set up');
  } finally {
    EventTarget.prototype.addEventListener = add;
    EventTarget.prototype.removeEventListener = remove;
  }
  assert.ok(added >= 20_000, `the commits were not seen listening (${added} listeners added)`);
  const left = [...live.values()].filter((count) => count > 0);
  assert.deepEqual(left, [], 'a stream commit left an abort listener behind');
  await recovery.dispose();
  console.log('  10,000 stream commits leave no abort listener behind');
}

console.log('filesystem recovery: ok');
