#!/usr/bin/env bun
//
// A staged npm bin (opencode) carries the exec id of the command that ran it.
//
// `opencode` and `opencode serve` do not go through the node runner: the bin
// resolver hands them to the facet manager's staged-artifact path, which
// spawns its own process-table entries (one, or a serve + attach pair). Each
// takes the exec id of the process whose command ran it, so `opencode serve`
// started by an exec named 'j1' listens under 'j1'. Driven through the
// FacetManager's staged-artifact entry points, with the facet stubbed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
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
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)), { status: 200 });
    },
  },
};
const manager = new FacetManager(createFacetCtx(world, 'exec-id-staged'), env, processes, new PortRegistry(), processHostFor, {
  requestLaunchTurn: () => { setTimeout(() => { void manager.pumpResidentLaunches(); }, 0); },
  notify: () => {},
});
manager.setVfs(vfs, processFiles(vfs));

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

console.log('exec-id-staged-bins OK');
