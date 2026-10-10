#!/usr/bin/env bun
// A process's end is two facts. What it held (its ports, the work behind it)
// is released as soon as the end is decided; what observers are told of it
// (ps, the SDK's process listing, the processes API) is published with its
// output, once the session's output gate lets that through, as a parent's
// wait is. Until then every view still shows it running.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';

import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const bundle = await importWorkerBundle({
  'packages/worker/src/workspace-host.ts': ['composeHostedRuntime'],
  'packages/worker/src/runtime/process-logs-api.ts': ['handleProcessesListRequest'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/runtime/port-registry.ts': ['PortRegistry'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/fabric/src/composition.ts': ['composeFabric'],
});
bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}), { resolveConfig: false });
const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const facetCtx = createFacetCtx(world, 'embedder-do');
const ctx = {
  ...facetCtx,
  waitUntil() {},
  storage: { ...facetCtx.storage, sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync },
  exports: { SupervisorRPC: ({ props }) => ({ props }) },
  getWebSockets: () => [],
};
const processes = new bundle.SessionProcessSupervisor();
const ports = new bundle.PortRegistry();
const workspace = await bundle.NimbusWorkspace.create({
  sql: harness.sql, transactions: harness.ctx, vfs: new bundle.SqliteVFS(harness.sql, harness.ctx), processes, generation: 0,
});
const runtime = await bundle.composeHostedRuntime({
  workspace,
  ctx,
  env: { WORKSPACES: { idFromName() {}, idFromString() {}, get() {} }, LOADER: world.loader, ASSETS: stagedAssets },
  ports,
  lifecycle: { waitUntil() {}, async schedule() {}, async cancel() {} },
});
await runtime.ready();

// The gate holds the server's output, and with it its end.
let release;
const held = new Promise((resolve) => { release = resolve; });
let holding = 0;
processes.setOutputGate({ before: (pid) => (pid === holding ? held : null) });

const { pid } = processes.spawn('serve --port 8080', ['serve', '--port', '8080'], '/home/user', { longRunning: true });
ports.register(8080, pid);
let terminated = 0;
processes.setTerminator(pid, () => { terminated++; });
holding = pid;

const views = async () => {
  const listed = (await runtime.listProcesses()).find((p) => p.pid === pid);
  const api = (await bundle.handleProcessesListRequest(processes).json()).processes.find((p) => p.pid === pid);
  const ps = stripAnsi((await runtime.exec('ps')).stdout).split('\n').find((line) => line.trim().startsWith(`${pid} `));
  return { listed: [listed.state, listed.exitCode, listed.endTime], api: [api.state, api.exitCode], ps: ps?.trim().split(/\s+/)[1] };
};

assert.deepEqual(await runtime.killProcess(pid), { ok: true, pid });
await settle();
assert.equal(terminated, 1, 'the work behind it is stopped at the kill');
assert.equal(ports.get(8080), undefined, 'its port is freed at the kill');
assert.equal(processes.get(pid).state, 'killed', 'its lifecycle ended at the kill');
assert.deepEqual(await views(), { listed: ['running', null, null], api: ['running', null], ps: 'running' },
  'every view shows it running while its output is held');

release();
await settle();
const ended = await views();
assert.equal(ended.listed[0], 'killed');
assert.equal(ended.listed[1], 137);
assert.equal(typeof ended.listed[2], 'number');
assert.deepEqual(ended.api, ['killed', 137]);
assert.equal(ended.ps, 'killed(137)');

console.log('process-published-status: views show an end once it is published; what it held goes at the decision');
