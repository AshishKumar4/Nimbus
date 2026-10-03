#!/usr/bin/env bun
//
// A resident server comes back from an instance reset under the credential
// it ran under.
//
// A resident's credential is its process entry's, taken from the command
// that started it. A reset takes the process table with it, and the
// re-drive spawns the resident with no command behind it, so it came back at
// the top of the table, as the session user, whoever had started it: a
// server a confined principal ran was served with the session user's access
// after the next reset. The journal row now carries the credential; a row
// written before it did names none, and is not re-driven rather than
// re-driven as anyone else.
//
// A reset is modelled as in exec-id-resident-reset.mjs: a new FacetManager
// over the SAME durable storage and filesystem, whose process table starts at
// the next generation's pid base, nothing carried over in memory.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { resolveDurableWorkerImage } from '../../packages/worker/src/facets/durable-images.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { processFiles } from './lib/process-bridge.mjs';

adoptCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
vfs.as(CRED_KERNEL).mkdir('home/user/app', { recursive: true, mode: 0o755 });
const storage = new Map();

/** One instance of the session Durable Object over the shared storage and filesystem. */
function createInstance(generation) {
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }));
  const processes = new SessionProcessSupervisor();
  processes.setPidBase(generation * PID_GEN_STRIDE);
  const spawns = [];
  const notices = [];
  const env = {
    LOADER: world.loader,
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname.replace(/^\//, '');
        return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)), { status: 200 });
      },
    },
  };
  const ctx = createFacetCtx(world, 'resident-credential-reset', storage);
  const manager = new FacetManager(ctx, env, processes, new PortRegistry(), processHostFor, {
    requestLaunchTurn: () => { setTimeout(() => { void manager.pumpResidentLaunches(); }, 0); },
    notify: (message) => { notices.push(message); },
    onSpawn: (pid, command) => { spawns.push({ pid, command }); },
    resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(vfs, recipe),
  });
  manager.setVfs(vfs, processFiles(vfs));
  return { manager, processes, spawns, notices };
}

const settle = async (predicate, tries = 400) => {
  for (let i = 0; i < tries && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const row = (pid) => storage.get(`resident-launch:${pid}`);

// ── generation 1: a confined principal starts a node and a python server ──
const AGENT = { uid: 2000, gid: 2000, groups: [2000], umask: 0o022 };
const gen1 = createInstance(1);
const agent = gen1.processes.spawn('sh', ['sh'], '/home/user/app', { cred: AGENT });
const user = gen1.processes.spawn('sh', ['sh'], '/home/user/app', { cred: CRED_SESSION_USER });
const node = await gen1.manager.spawnNode("require('http').createServer(() => {}).listen(8080);", {
  filename: '/home/user/app/server.js', cwd: '/home/user/app', command: 'node server.js',
  argv: ['/home/user/app/server.js'], invokerPid: agent.pid,
});
const python = await gen1.manager.spawnWorker('export default {}', 'python -m http.server 8000', '/home/user/app', {
  resident: { runtime: 'python', argv: ['python', '-m', 'http.server', '8000'] }, invokerPid: agent.pid,
});
const legacy = await gen1.manager.spawnNode("require('http').createServer(() => {}).listen(8081);", {
  filename: '/home/user/app/legacy.js', cwd: '/home/user/app', command: 'node legacy.js',
  argv: ['/home/user/app/legacy.js'], invokerPid: user.pid,
});
await settle(() => [node.pid, python.pid, legacy.pid].every((pid) => row(pid)?.phase === 'running'));

assert.equal(gen1.processes.get(node.pid).cred.uid, AGENT.uid, 'the node server runs as the principal who started it');
assert.equal(gen1.processes.get(python.pid).cred.uid, AGENT.uid, 'so does the python server');
assert.deepEqual(row(node.pid)?.cred, AGENT, `the journal row carries its credential: ${JSON.stringify(row(node.pid))}`);
assert.deepEqual(row(python.pid)?.cred, AGENT, 'for the python resident too');
// A row as a release before this one wrote it: no credential.
const { cred: _cred, ...unnamed } = row(legacy.pid);
storage.set(`resident-launch:${legacy.pid}`, unnamed);
console.log('  [1] a resident runs as its invoker, and its journal row carries that credential');

// ── generation 2: the reset; the re-drive restores them as the agent ────
const gen2 = createInstance(2);
await gen2.manager.pumpResidentLaunches();
await settle(() => gen2.spawns.length >= 2 && gen2.notices.some((notice) => notice.includes('node legacy.js')));
const back = (command) => {
  const found = gen2.spawns.filter((spawn) => spawn.command === command);
  assert.equal(found.length, 1, `${command} was re-driven once: ${JSON.stringify(gen2.spawns)}`);
  return gen2.processes.get(found[0].pid);
};
assert.equal(back('node server.js').cred.uid, AGENT.uid, 'the re-driven node server runs as the agent, not the session user');
assert.equal(back('python -m http.server 8000').cred.uid, AGENT.uid, 'so does the re-driven python server');
assert.deepEqual(gen2.spawns.filter((spawn) => spawn.command === 'node legacy.js'), [],
  'a row that names no credential is not re-driven as anyone');
assert.ok(gen2.notices.some((notice) => /node legacy\.js.*could not be restarted.*credential/.test(notice)),
  `and the reason is reported: ${JSON.stringify(gen2.notices)}`);
const node2 = back('node server.js');
await settle(() => row(node2.pid)?.phase === 'running');
assert.deepEqual(row(node2.pid)?.cred, AGENT, 'the re-drive journals the credential again, for the next reset');
console.log('  [2] a reset re-drives node and python residents as their principal, and refuses a row with none');

console.log('resident-credential-reset OK');
