#!/usr/bin/env bun
//
// A resident server keeps its exec id across an instance reset.
//
// A server's exec id is its process entry's, taken from the command that
// started it. A reset takes the process table with it, and the re-drive
// spawns the resident with no command behind it, so a dev server the
// embedder linked to its job would come back unnamed, its port no longer
// "serving" for that job. The journal row carries the id instead; the
// launch inputs it re-drives from carry no invoker pid, which names a
// process of the reset instance.
//
// A reset is modelled as in resident-launch-survives-instance-reset.mjs: a new
// FacetManager over the SAME durable storage and filesystem, whose process
// table starts at the next generation's pid base, nothing carried over in
// memory.

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
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
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
  const env = {
    LOADER: world.loader,
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname.replace(/^\//, '');
        return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)), { status: 200 });
      },
    },
  };
  const ctx = createFacetCtx(world, 'exec-id-reset', storage);
  const manager = new FacetManager(ctx, env, processes, new PortRegistry(), processHostFor, {
    requestLaunchTurn: () => { setTimeout(() => { void manager.pumpResidentLaunches(); }, 0); },
    notify: () => {},
    onSpawn: (pid, command) => { spawns.push({ pid, command }); },
    resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(vfs, recipe),
  });
  manager.setVfs(vfs, processFiles(vfs));
  return { manager, processes, spawns };
}

const settle = async (predicate, tries = 400) => {
  for (let i = 0; i < tries && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const row = (pid) => storage.get(`resident-launch:${pid}`);

// ── generation 1: an exec's shell starts a node server and a python one ──
const gen1 = createInstance(1);
const tagged = gen1.processes.spawn('node server.js', ['node server.js'], '/home/user/app', { execId: 'j1' });
const untagged = gen1.processes.spawn('node plain.js', ['node plain.js'], '/home/user/app');
const node = await gen1.manager.spawnNode("require('http').createServer(() => {}).listen(8080);", {
  filename: '/home/user/app/server.js', cwd: '/home/user/app', command: 'node server.js',
  argv: ['/home/user/app/server.js'], invokerPid: tagged.pid,
});
const plain = await gen1.manager.spawnNode("require('http').createServer(() => {}).listen(8081);", {
  filename: '/home/user/app/plain.js', cwd: '/home/user/app', command: 'node plain.js',
  argv: ['/home/user/app/plain.js'], invokerPid: untagged.pid,
});
const python = await gen1.manager.spawnWorker('export default {}', 'python -m http.server 8000', '/home/user/app', {
  resident: { runtime: 'python', argv: ['python', '-m', 'http.server', '8000'] }, invokerPid: tagged.pid,
});
await settle(() => [node.pid, plain.pid, python.pid].every((pid) => row(pid)?.phase === 'running'));

assert.equal(gen1.processes.get(node.pid).execId, 'j1', 'the node server carries the execId of the command that started it');
assert.equal(gen1.processes.get(python.pid).execId, 'j1', 'so does the python server');
assert.equal(gen1.processes.get(plain.pid).execId, undefined, 'an untagged exec\'s server carries none');
assert.equal(row(node.pid)?.execId, 'j1', `the journal row carries it: ${JSON.stringify(row(node.pid))}`);
assert.equal(row(python.pid)?.execId, 'j1', 'for the python resident too');
assert.equal('execId' in row(plain.pid), false, 'an untagged row has no field');
assert.equal('invokerPid' in row(node.pid).recipe.opts, false, 'the recipe names no invoker: its pid dies with the instance');
console.log('  [1] a resident started under an exec carries its execId, and its journal row does');

// ── generation 2: the reset; the re-drive restores it ───────────────────
const gen2 = createInstance(2);
await gen2.manager.pumpResidentLaunches();
await settle(() => gen2.spawns.length === 3);
const back = (command) => {
  const found = gen2.spawns.filter((spawn) => spawn.command === command);
  assert.equal(found.length, 1, `${command} was re-driven once: ${JSON.stringify(gen2.spawns)}`);
  return gen2.processes.get(found[0].pid);
};
const node2 = back('node server.js');
const python2 = back('python -m http.server 8000');
const plain2 = back('node plain.js');
assert.ok(node2.pid > 2 * PID_GEN_STRIDE, 'under a pid of the new generation');
assert.equal(node2.execId, 'j1', 'the re-driven node server keeps j1');
assert.equal(python2.execId, 'j1', 'so does the re-driven python server');
assert.equal(plain2.execId, undefined, 'and the untagged one is still untagged');
await settle(() => row(node2.pid)?.phase === 'running');
assert.equal(row(node2.pid)?.execId, 'j1', 'the re-drive journals it again, for the next reset');

// ── generation 3: and the next one ──────────────────────────────────────
const gen3 = createInstance(3);
await gen3.manager.pumpResidentLaunches();
await settle(() => gen3.spawns.length === 3);
const node3 = gen3.processes.get(gen3.spawns.find((spawn) => spawn.command === 'node server.js').pid);
assert.equal(node3.execId, 'j1', 'a second reset keeps it');
console.log('  [2] a reset re-drives node and python residents with their execId, and the next reset too');

console.log('exec-id-resident-reset OK');
