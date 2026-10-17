#!/usr/bin/env bun
// A time utimes and futimes set is one of utimensat(2)'s: explicit ms, 'now'
// or 'omit'. It travels unchanged from the guest's call to the filesystem
// that commits it. That filesystem resolves 'now' at commit and judges
// explicitness per side: an explicit time needs the owner, 'now' and 'omit'
// a writer. This holds by name and by descriptor, through the supervisor's
// dispatch, on the session's SQLite, on a SQLite mount and on an awaiting
// mount.
//
// Red before: the supervisor's path route decoded only numbers, so 'now'
// and 'omit' by name were refused (EINVAL). Layers above a mount resolved
// 'now' and 'omit' into explicit times themselves (a stat, then a set), so a
// writer who is not the owner was refused 'now' on a mount (EPERM). An
// 'omit' wrote back a time read before the change, so a change in between
// was lost.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { asyncOnly } from './lib/async-memory-vfs.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

/** A file root owns and anyone may write (`key`, in `kernel`), its times 1000 and 2000. */
function shared(kernel, key) {
  kernel.writeFile(key, 's');
  kernel.chmod(key, 0o666);
  kernel.utimes(key, 1_000, 2_000);
}

/** A session with the user's process; `mount`, a backend for /home/user/m, made from its own engine's kernel view. */
function session(mount) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user/m', { recursive: true });
  kernel.chown('home/user', 1000, 1000);
  shared(kernel, 'home/user/s');
  const filesystem = new ProcessFiles(engine);
  const mountedHarness = createSqliteVfsTestHarness();
  const mountEngine = new SqliteVFS(mountedHarness.sql, mountedHarness.ctx);
  const mountKernel = mountEngine.as(CRED_KERNEL);
  shared(mountKernel, 'f');
  if (mount) filesystem.vfs.mount('/home/user/m', mount(new SqliteFiles(mountEngine, mountKernel)), { resolvesPaths: true });
  const processes = new SessionProcessSupervisor();
  const op = createSupervisorOpHandler({ vfs: engine, filesystem, processes });
  const { pid } = processes.spawn('touch', [], '/home/user', { cred: user });
  return { kernel, mountKernel, filesystem, op, pid, fs: filesystem.bind({ pid, cred: user }) };
}

const outcome = (call) => Promise.resolve().then(call).then(() => 'ok', (error) => error.code ?? String(error?.message ?? error));
const failures = [];
const check = async (what, run) => {
  try { await run(); console.log(`  ✓ ${what}`); } catch (error) { failures.push(`${what}: ${error.message}`); console.log(`  ✗ ${what}: ${error.message.split('\n')[0]}`); }
};

// ── By name and by descriptor, through the supervisor's dispatch, as a
//    writer who is not the owner ────────────────────────────────────────────
for (const [where, mount] of [['the session', null], ['a SQLite mount', (files) => files]]) await check(`${where}: explicit times by the owner, now and omit by a writer, by name and by descriptor`, async () => {
  const s = session(mount);
  const [kernel, path, at] = mount === null ? [s.kernel, '/home/user/s', 'home/user/s'] : [s.mountKernel, '/home/user/m/f', 'f'];
  const times = () => { const st = kernel.stat(at); return [st.atime, st.mtime]; };
  const byName = (a, m) => outcome(() => s.op({ op: 'utimes', args: [path, a, m], pid: s.pid }));
  assert.equal(await byName(5_000, 'omit'), 'EPERM', `${where}: an explicit time by name, by a writer who is not the owner`);
  const before = Date.now();
  assert.equal(await byName('now', 'now'), 'ok', `${where}: now by name, by a writer`);
  const [atime, mtime] = times();
  assert.ok(atime >= before - 1_000 && mtime >= before - 1_000, `${where}: the times are now: ${atime} ${mtime}`);
  kernel.utimes(at, 1_000, 2_000);
  assert.equal(await byName('omit', 'now'), 'ok', `${where}: mtime now, atime omitted, by name`);
  assert.equal(times()[0], 1_000, `${where}: an omitted atime is kept`);

  const opened = await s.op({ op: 'fsOpen', args: [path, { write: true }], pid: s.pid });
  const byFd = (a, m) => outcome(() => s.op({ op: 'fsFutimes', args: [opened.id, a, m], pid: s.pid }));
  assert.equal(await byFd('omit', 6_000), 'EPERM', `${where}: an explicit time by descriptor, by a writer who is not the owner`);
  kernel.utimes(at, 1_000, 2_000);
  assert.equal(await byFd('now', 'now'), 'ok', `${where}: now by descriptor, by a writer`);
  assert.ok(times()[1] >= before - 1_000, `${where}: mtime is now by descriptor`);
  kernel.utimes(at, 1_000, 2_000);
  assert.equal(await byFd('omit', 'now'), 'ok', `${where}: mtime now, atime omitted, by descriptor`);
  assert.equal(times()[0], 1_000, `${where}: an omitted atime is kept by descriptor`);
  await s.op({ op: 'fsClose', args: [opened.id], pid: s.pid });
});

// ── The owner sets now on a file it may not write, as utimensat(2) lets
//    it: owner, writer or root. Red before: refused EACCES ───────────────
for (const [where, mount] of [['the session', null], ['a SQLite mount', (files) => files]]) await check(`${where}: now by the owner of a file it may not write`, async () => {
  const s = session(mount);
  const key = mount === null ? 'home/user/mine' : 'mine';
  const kernel = mount === null ? s.kernel : s.mountKernel;
  kernel.writeFile(key, 'm');
  kernel.chown(key, 1000, 1000);
  kernel.chmod(key, 0o444);
  const path = mount === null ? '/home/user/mine' : '/home/user/m/mine';
  assert.equal(await outcome(() => s.fs.utimes(path, 'now', 'now')), 'ok', `${where}: now by the owner`);
  assert.equal(await outcome(() => s.fs.utimes(path, 'omit', 'now')), 'ok', `${where}: mtime now by the owner`);
});

// ── On an awaiting mount, an omitted time is the one there as the change
//    commits: a change to it between the call and its commit stands ────────
await check('an awaiting mount keeps an omitted time as it is at commit', async () => {
  let gate = null;
  const s = session((files) => asyncOnly(files, {
    async beforeCall(method) {
      if (method !== 'utimes' || gate === null) return;
      const { reached, held } = gate;
      gate = null;
      reached();
      await held;
    },
  }));
  s.mountKernel.chown('f', 1000, 1000);
  const paused = () => {
    let reached; let release;
    const at = new Promise((resolve) => { reached = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    gate = { reached, held };
    return { at, release };
  };
  const opened = await s.fs.open('/home/user/m/f', { write: true });
  for (const [how, call] of [
    ['by name', () => s.fs.utimes('/home/user/m/f', 'omit', 9_000)],
    ['by descriptor', () => s.fs.futimes(opened.id, 'omit', 9_000)],
  ]) {
    s.mountKernel.utimes('f', 1_000, 2_000);
    const pause = paused();
    const done = outcome(call);
    await pause.at;
    // Between the call and its commit: another change to the file's atime.
    s.mountKernel.utimes('f', 3_000, s.mountKernel.stat('f').mtime);
    pause.release();
    assert.equal(await done, 'ok', how);
    const st = s.mountKernel.stat('f');
    assert.deepEqual([st.atime, st.mtime], [3_000, 9_000], `${how}: the omitted atime is the one there at commit, the change in between kept`);
  }
  await s.fs.close(opened.id);
});

assert.deepEqual(failures, []);
console.log('fs-time-contract: ok');
