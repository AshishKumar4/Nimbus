#!/usr/bin/env bun
//
// A staged npm bin (opencode) carries the exec id of the command that ran it.
//
// `opencode` and `opencode serve` do not go through the node runner: the bin
// resolver hands them to the facet manager's staged-artifact path, which
// spawns its own process-table entries (one, or a serve + attach pair). Each
// takes the exec id of the process whose command ran it, so `opencode serve`
// started by an exec named 'j1' listens under 'j1'. Bare `opencode` boots its
// serve first and starts the attach only once the serve answers, which can
// outlive the command (an exec that timed out, its pid reaped a minute
// later), so the attach takes the id from the live serve it pairs with.
// Driven through the FacetManager's staged-artifact entry points, with the
// facet stubbed and the clock reap() reads moved by hand.

import assert from 'node:assert/strict';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { processFiles } from './lib/process-bridge.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

// The clock the process table's reap reads; moved forward the way a minute passes.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

adoptCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async fetch() { return Response.json({ exitCode: 0, stdout: 'opencode 0.0.0\n', stderr: '' }); },
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
vfs.as(CRED_KERNEL).mkdir('home/user/app', { recursive: true, mode: 0o755 });

const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}));
const processes = new SessionProcessSupervisor();
processes.setPidBase(PID_GEN_STRIDE);
const env = {
  LOADER: world.loader,
  ASSETS: stagedAssets,
};
const manager = new FacetManager(createFacetCtx(world, 'exec-id-staged'), env, processes, new PortRegistry(), processHostFor, {
  requestLaunchTurn: () => { setTimeout(() => { void manager.pumpResidentLaunches(); }, 0); },
  notify: () => {},
});
const files = processFiles(vfs);
manager.setVfs(vfs, files);
// What a workspace composed over this table sets: a reap releases each pid's binding first.
processes.setRelease((pid) => files.releaseProcess(pid));

const exec = processes.spawn('opencode', ['opencode'], '/home/user/app', { execId: 'j1' });
const plain = processes.spawn('opencode', ['opencode'], '/home/user/app');
const base = { env: {}, cwd: '/home/user/app' };

const oneshot = await manager.execStagedArtifact('opencode', { ...base, argv: ['--version'], invokerPid: exec.pid });
assert.equal(oneshot.exitCode, 0, JSON.stringify(oneshot));
assert.equal(processes.get(oneshot.pid).execId, 'j1', 'a one-shot staged bin carries the exec id of the command that ran it');
const untagged = await manager.execStagedArtifact('opencode', { ...base, argv: ['--version'], invokerPid: plain.pid });
assert.equal(processes.get(untagged.pid).execId, undefined, 'one run by an untagged command carries none');
console.log('  [1] a one-shot staged bin carries its command\'s exec id');

const server = await manager.execStagedArtifactServer('opencode', { ...base, argv: ['serve'], port: 4096, invokerPid: exec.pid });
assert.equal(processes.get(server.pid).execId, 'j1', `opencode serve carries it: ${JSON.stringify(server)}`);
console.log('  [2] `opencode serve` carries it');

// ── [3] bare opencode: the attach takes the serve's id, not the command's ──
const job = processes.spawn('opencode', ['opencode'], '/home/user/app', { execId: 'j3' });
const readiness = Promise.withResolvers();
const awaitingReady = Promise.withResolvers();
// The serve's health gate, held open until the test says it answered.
manager._awaitOpencodeServerReady = async () => { awaitingReady.resolve(); await readiness.promise; };
const dual = manager.execStagedArtifactDual('opencode', { ...base, argv: [], invokerPid: job.pid });
await awaitingReady.promise;
const serve = processes.getAll().find((p) => p.state === 'running' && p.command.startsWith('opencode serve --port '));
assert.equal(serve?.execId, 'j3', `the serve carries the command's id: ${JSON.stringify(serve)}`);
// The exec that ran `opencode` times out while the serve boots, and a launch
// a minute later reaps its pid.
processes.exit(job.pid, 124);
skew += 61_000;
await manager.spawnWorker('export default {}', 'later launch', '/home/user/app', {});
assert.equal(processes.get(job.pid), undefined, 'the command\'s pid was reaped');
readiness.resolve();
const attach = await dual;
assert.equal(processes.get(attach.pid)?.command, 'opencode', 'the attach is the user-facing process');
assert.equal(processes.get(attach.pid)?.execId, 'j3', 'and carries the id its serve carries');
console.log('  [3] bare opencode\'s attach takes the exec id from its serve after the command is reaped');

console.log('exec-id-staged-bins OK');
