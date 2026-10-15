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
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
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

console.log('filesystem recovery: ok');
