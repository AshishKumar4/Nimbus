#!/usr/bin/env bun
// A child_process handle is its parent's for as long as the broker holds the
// child (ChildProcessManager's entry: its queued output and its exit), not
// for as long as the process table keeps the child's row. A table prune (an
// exec starting, a hosted launch) forgets a row that ended more than a
// minute ago, while a paused parent may not have read the child's last
// output or its exit yet. What has to hold, through the session's own RPCs
// with the parent's pid stamped:
//
//   - after the prune the parent reads the rest of the output, to its end,
//     and the exit status;
//   - another process still gets ESRCH for that handle;
//   - a kill of the ended child answers false, as Node's does, not EPERM.
//
// Red before: each RPC asked the table whether the caller is the child's
// ancestor; with the row gone it answered ESRCH, and the parent lost the
// output and status the broker still held.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const { NimbusSession, SessionFilesystem, bindRuntimeServices, NimbusWorkspace } = await importWorkerBundle({
  'packages/worker/src/session/nimbus-session.ts': ['NimbusSession'],
  'packages/worker/src/session/session-filesystem.ts': ['SessionFilesystem'],
  'packages/worker/src/hosted/services.ts': ['bindRuntimeServices'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
});

const decoder = new TextDecoder();
const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const rootVfs = rawVfs.as(CRED_KERNEL);
rootVfs.mkdir('home', { mode: 0o755 });
rootVfs.mkdir('home/user', { mode: 0o755 });
rootVfs.chown('home/user', 1000, 1000);

const processes = new SessionProcessSupervisor();
const parent = processes.spawn('node', ['parent.js'], '/home/user');
const sibling = processes.spawn('node', ['sibling.js'], '/home/user');
const session = Object.create(NimbusSession.prototype);
session.ctx = { facets: {} };
session.env = {};
const services = bindRuntimeServices(session, { ctx: session.ctx, env: session.env, notify() {}, async requestLaunchTurn() { return true; } });
const { childProcessHost, ...delegated } = services;
Object.defineProperty(session, 'childProcessHost', { value: childProcessHost });
Object.assign(session, delegated);
session.processes = processes;
session.filesystem = new SessionFilesystem(rawVfs, session);
session.terminal = { write() {}, writeln() {}, onData() {}, cols: 80, rows: 24, focus() {}, clear() {} };
session.webSocketRelay = { closeForPid() {} };
session.facetManagerComposed = { manager: { setVfs() {}, kill: () => false }, apps: {}, pumpLaunches: async () => {} };
session.childProcessManager = null;
session.esbuildService = null;
session.runtimeWorkspace = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx,
  vfs: rawVfs, filesystem: session.getFilesystemAuthority(), processes, childProcesses: childProcessHost, cwd: '/home/user' });
const registry = session.runtimeWorkspace.registry;
session._setCpRegistry(registry);

// A child that prints one line, waits for the test, prints a second, and exits.
const gates = [];
// A child that ends at once: a parent whose own child outlives it.
registry.register('quick', async () => 0);
registry.register('two-lines', async (ctx) => {
  await ctx.stdout.write('one\n');
  await new Promise((resolve) => gates.push(resolve));
  await ctx.stdout.write('two\n');
  return 0;
});

// The table's clock (ProcessTable reads Date.now), moved forward by `ahead` ms.
const realNow = Date.now;
let ahead = 0;
Date.now = () => realNow() + ahead;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const text = (output) => output.chunks.map((chunk) => decoder.decode(chunk.data)).join('');

/** A child that the parent reads half of, then pauses on, while it ends and a prune of `prune` runs past a minute. */
async function pausedPastPrune(prune) {
  const child = (await session._rpcCpSpawn({ command: 'two-lines', args: [], env: {}, cwd: '/home/user', stdio: ['pipe', 'pipe', 'pipe'], parentPid: parent.pid })).childPid;
  await session._rpcCpStdinEnd(child, parent.pid);
  const first = await session._rpcCpReadOutput(child, 1, 0, 1000, undefined, parent.pid);
  assert.equal(text(first), 'one\n');
  gates.shift()();
  for (let i = 0; i < 100 && processes.get(child)?.state === 'running'; i++) await settle();
  assert.notEqual(processes.get(child)?.state, 'running', 'the child has ended');
  await settle();
  ahead += 61_000;
  await prune();
  assert.equal(processes.get(child), undefined, 'the prune forgot the child\'s row');
  return { child, seq: first.maxSeq };
}

try {
  for (const [what, prune] of [
    ['the next exec', () => session.runtimeWorkspace.exec('true')],
    ['a hosted launch\'s prune', () => processes.reap()],
  ]) {
    const { child, seq } = await pausedPastPrune(prune);
    const rest = await session._rpcCpReadOutput(child, 1, seq, 1000, undefined, parent.pid);
    assert.deepEqual({ text: text(rest), closed: rest.closed }, { text: 'two\n', closed: true }, `${what}: the parent reads the rest, to its end`);
    const waited = await session._rpcCpWait(child, 1000, undefined, parent.pid);
    assert.deepEqual({ done: waited.done, exitCode: waited.exitCode }, { done: true, exitCode: 0 }, `${what}: the parent reads the exit`);
    await assert.rejects(session._rpcCpReadOutput(child, 1, 0, 0, undefined, sibling.pid), (error) => error.code === 'ESRCH', `${what}: another process may not`);
    await assert.rejects(session._rpcCpWait(child, 0, undefined, sibling.pid), (error) => error.code === 'ESRCH', `${what}: nor wait on it`);
    assert.equal(await session._rpcCpKill(child, 'SIGTERM', parent.pid), false, `${what}: a kill of the ended child answers false`);
    console.log(`  ✓ ${what}: the handle outlives the child's row`);
  }

  // A grandparent's handle on its grandchild (G reads C, which P spawned):
  // after P and C have ended and been pruned, who spawned whom is still the
  // broker's record, for each.
  {
    const middle = (await session._rpcCpSpawn({ command: 'quick', args: [], env: {}, cwd: '/home/user', stdio: ['pipe', 'pipe', 'pipe'], parentPid: parent.pid })).childPid;
    const grandchild = (await session._rpcCpSpawn({ command: 'two-lines', args: [], env: {}, cwd: '/home/user', stdio: ['pipe', 'pipe', 'pipe'], parentPid: middle })).childPid;
    await session._rpcCpStdinEnd(grandchild, parent.pid);
    const first = await session._rpcCpReadOutput(grandchild, 1, 0, 1000, undefined, parent.pid);
    assert.equal(text(first), 'one\n');
    gates.shift()();
    for (let i = 0; i < 100 && [middle, grandchild].some((pid) => processes.get(pid)?.state === 'running'); i++) await settle();
    await settle();
    ahead += 61_000;
    await processes.reap();
    assert.deepEqual([processes.get(middle), processes.get(grandchild)], [undefined, undefined], 'the prune forgot both rows');
    const rest = await session._rpcCpReadOutput(grandchild, 1, first.maxSeq, 1000, undefined, parent.pid);
    assert.deepEqual({ text: text(rest), closed: rest.closed }, { text: 'two\n', closed: true }, 'the grandparent reads the rest');
    const waited = await session._rpcCpWait(grandchild, 1000, undefined, parent.pid);
    assert.deepEqual({ done: waited.done, exitCode: waited.exitCode }, { done: true, exitCode: 0 });
    await assert.rejects(session._rpcCpReadOutput(grandchild, 1, 0, 0, undefined, sibling.pid), (error) => error.code === 'ESRCH', 'another process may not');
    console.log('  ✓ a grandparent\'s handle outlives its child\'s and grandchild\'s rows');
  }
} finally {
  Date.now = realNow;
  await session.runtimeWorkspace.close();
}
console.log('cp-handle-outlives-prune: ok');
process.exit(0);
