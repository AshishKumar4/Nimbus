#!/usr/bin/env bun
// A process acts only on what is its own, through the session's supervisor
// dispatch (the envelope's pid is the one its binding stamped):
//
//   - a child's handle (its stdin, its output, its wait, its kill) is its
//     parent's, or an ancestor's: another process gets ESRCH, as waitpid
//     answers for a pid that is not a child;
//   - a process reads its own stdin, whatever channel it names: the one it
//     inherited as fd 0 when it did, and never another process's;
//   - a signal reaches its target only as Linux's kill(2) allows it: the
//     caller is root, or has the target's uid; else EPERM.
//
// Red before: every one of these acted on whatever pid the request named, so
// a process could drain another's stdin, write to it, read its output, or
// kill a process of another uid.

import assert from 'node:assert/strict';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const { NimbusSession } = await importWorkerBundle({ 'packages/worker/src/session/nimbus-session.ts': ['NimbusSession'] });

const OTHER = Object.freeze({ uid: 1001, gid: 1001, groups: Object.freeze([1001]), umask: 0o022 });
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const processes = new SessionProcessSupervisor();
const parent = processes.spawn('node', ['parent.js'], '/home/user', { cred: CRED_SESSION_USER });
const child = processes.spawn('node', ['child.js'], '/home/user', { parentPid: parent.pid });
const grandchild = processes.spawn('node', ['grandchild.js'], '/home/user', { parentPid: child.pid });
const sibling = processes.spawn('node', ['sibling.js'], '/home/user', { cred: CRED_SESSION_USER });
const otherUid = processes.spawn('node', ['other.js'], '/home/user', { cred: OTHER });
const otherUidChild = processes.spawn('sudo', ['-u', 'other', 'node'], '/home/user', { parentPid: parent.pid, cred: OTHER });
const root = processes.spawn('node', ['root.js'], '/home/user', { cred: CRED_KERNEL });
// The child's stdin is a pipe its parent writes; the grandchild inherits its parent's.
processes.openInput(child.pid);
processes.openInput(parent.pid);

const asked = [];
const session = Object.create(NimbusSession.prototype);
session.processes = processes;
session._ensureChildProcessManager = () => ({
  // Who spawned each child, as the broker records it at the spawn.
  parentOf: (pid) => processes.get(pid)?.parentPid,
  kill: (pid, signal) => { asked.push(['kill', pid, signal]); return true; },
  readOutput: async (pid) => { asked.push(['readOutput', pid]); return { chunks: [], closed: false, seq: 0 }; },
  drainOutput: (pid) => { asked.push(['drainOutput', pid]); return { stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutClosed: false, stderrClosed: false }; },
  closeOutput: (pid) => { asked.push(['closeOutput', pid]); },
  wait: async (pid) => { asked.push(['wait', pid]); return { done: false }; },
});
const dispatch = createSupervisorOpHandler({ vfs, processes, host: session });
const as = (caller, op, args) => dispatch({ op, pid: caller.pid, run: `run-${caller.pid}`, args });

async function refused(promise, code, what) {
  const before = asked.length;
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `${what}: expected ${code}, got ${error?.code ?? error?.message}`);
    return true;
  }, `${what}: expected ${code}, but it was allowed`);
  assert.equal(asked.length, before, `${what}: nothing was done`);
}

// ── a child's handle is its parent's, or an ancestor's ────────────────────
const handleOps = [
  ['cpKill', (pid) => [pid, 'SIGTERM']],
  ['cpReadOutput', (pid) => [pid, 1, 0, 0, null]],
  ['cpDrainOutput', (pid) => [pid]],
  ['cpCloseOutput', (pid) => [pid, 1]],
  ['cpWait', (pid) => [pid, 0, null, true]],
];
for (const [op, args] of handleOps) {
  await refused(as(sibling, op, args(child.pid)), 'ESRCH', `${op} of another's child`);
  await refused(as(child, op, args(parent.pid)), 'ESRCH', `${op} of its parent`);
  await as(parent, op, args(child.pid));
  await as(parent, op, args(grandchild.pid));
}
await refused(as(sibling, 'cpStdinWrite', [child.pid, new TextEncoder().encode('x')]), 'ESRCH', "a write to another's child's stdin");
await refused(as(sibling, 'cpStdinEnd', [child.pid]), 'ESRCH', "the end of another's child's stdin");
await as(parent, 'cpStdinWrite', [child.pid, new TextEncoder().encode('to the child\n')]);
console.log("  a child's handle is its parent's, or an ancestor's");

// ── a process reads its own stdin, whatever channel it names ──────────────
const text = (packet) => new TextDecoder().decode(packet.data);
assert.equal(text(await as(sibling, 'cpReadStdin', [child.pid, 0, null])), '', "a sibling naming the child's channel drains nothing of it");
assert.equal(text(await as(parent, 'cpReadStdin', [child.pid, 0, null])), '', "nor does its parent");
assert.equal(text(await as(child, 'cpReadStdin', [child.pid, 0, null])), 'to the child\n', 'the child reads its own stdin');
// A grandchild whose stdin is a pipe of its own (not inherited) drains
// nothing of its ancestor's channel by naming it; one that inherited it reads it.
processes.openInput(grandchild.pid);
processes.writeInputBytes(parent.pid, new TextEncoder().encode('to the parent\n'));
assert.equal(text(await as(grandchild, 'cpReadStdin', [parent.pid, 0, null])), '', "a child with a pipe of its own drains nothing of its ancestor's stdin");
const inheriting = processes.spawn('node', ['inheriting.js'], '/home/user', { parentPid: parent.pid });
processes.inheritInput(inheriting.pid, parent.pid);
assert.equal(text(await as(inheriting, 'cpReadStdin', [parent.pid, 0, null])), 'to the parent\n', 'one that inherited it reads it');
console.log('  a process reads its own stdin, whatever channel it names');

// ── a signal reaches its target as Linux's kill(2) allows ─────────────────
await refused(as(parent, 'cpKill', [otherUidChild.pid, 'SIGTERM']), 'EPERM', "a kill of a child of another uid");
assert.equal(processes.maySignal(CRED_SESSION_USER, sibling.pid), true, 'a process of the same uid');
assert.equal(processes.maySignal(CRED_SESSION_USER, otherUid.pid), false, 'not one of another uid');
assert.equal(processes.maySignal(OTHER, parent.pid), false, 'nor the other way');
assert.equal(processes.maySignal(CRED_KERNEL, otherUid.pid), true, 'root, any process');
assert.throws(() => processes.killAs(CRED_SESSION_USER, otherUid.pid), (error) => error?.code === 'EPERM');
assert.equal(processes.get(otherUid.pid)?.state, 'running', 'refused, so still running');
assert.equal(processes.killAs(CRED_SESSION_USER, sibling.pid), true, 'a same-uid sibling is killed');
assert.equal(processes.killAs(processes.cred(root.pid), otherUid.pid), true, 'root kills another uid');
console.log("  a signal reaches its target as Linux's kill(2) allows");

console.log('cp-handle-authority: ok');
