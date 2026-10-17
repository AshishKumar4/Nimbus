#!/usr/bin/env bun
// A package script run by npm (shellExecuteTracked) is a process of its own,
// and its bookkeeping ends with it however its output ends: when the last
// write its output takes (a character its last bytes left unfinished) is
// refused, the process is still marked exited, and nothing of it waits on.
//
// Red before: that final write's failure skipped the cleanup, and the
// script's process stayed running.
import assert from 'node:assert/strict';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { hostedLifecycle } from './lib/hosted-lifecycle.mjs';

const bundle = await importWorkerBundle({
  'packages/worker/src/workspace-host.ts': ['composeHostedRuntime'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/runtime/port-registry.ts': ['PortRegistry'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/core/src/runtime/process-table.ts': ['PID_GEN_STRIDE'],
  'packages/fabric/src/composition.ts': ['composeFabric'],
});
bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });
const world = createFacetWorld(() => ({ async startProcess() { return { ok: true }; }, async handleHttpRequest() { return new Response('ok'); } }), { resolveConfig: false });
const harness = createSqliteVfsTestHarness();
const facetCtx = createFacetCtx(world, 'embedder-do');
const ctx = { ...facetCtx, storage: { ...facetCtx.storage, sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync }, exports: { SupervisorRPC: ({ props }) => ({ props }) }, getWebSockets: () => [] };
const env = { WORKSPACES: { idFromName() {}, idFromString() {}, get() {} }, LOADER: world.loader, ASSETS: stagedAssets };
const processes = new bundle.SessionProcessSupervisor();
processes.setPidBase(bundle.PID_GEN_STRIDE);
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs: new bundle.SqliteVFS(harness.sql, harness.ctx), processes, generation: 1 });
const runtime = await bundle.composeHostedRuntime({ workspace, ctx, env, ports: new bundle.PortRegistry(), lifecycle: hostedLifecycle(ctx, () => runtime) });

const spawned = [];
const spawn = processes.spawn.bind(processes);
processes.spawn = (command, argv, cwd, opts) => {
  const entry = spawn(command, argv, cwd, opts);
  spawned.push(entry.pid);
  return entry;
};
// A command that runs npm with an output taking text alone, which refuses a
// write that is only a character's unfinished end (a replacement): the last.
let npmStatus;
workspace.registry.register('npm-into-text', async (commandCtx) => {
  const npm = await workspace.registry.resolve('npm');
  const refusing = { write: async (text) => { if (text.includes('\ufffd')) throw new Error('the terminal is gone'); } };
  try {
    npmStatus = await npm({ ...commandCtx, args: ['run', 'partial'], stdout: refusing });
  } catch (error) {
    npmStatus = `threw ${error.message}`;
  }
  return 0;
});
try {
  await workspace.fs.writeFile('/home/user/partial.bin', Uint8Array.of(0x6f, 0x6b, 0xc3));
  await workspace.fs.writeFile('/home/user/package.json', JSON.stringify({ name: 'p', scripts: { partial: 'cat partial.bin' } }));
  const before = spawned.length;
  await runtime.exec('npm-into-text', { cwd: '/home/user' });
  const scripts = spawned.slice(before).map((pid) => processes.get(pid)).filter((entry) => entry !== undefined && /cat partial/.test(entry.command));
  assert.ok(scripts.length > 0, `npm ran the script as a process (${npmStatus})`);
  assert.deepEqual(scripts.map((entry) => entry.state), scripts.map(() => 'exited'), `the script's process ended with its run (${npmStatus})`);
  console.log(`  ✓ a refused last write leaves no tracked process running (npm: ${npmStatus})`);
} finally {
  await runtime.close();
}
console.log('hosted-tracked-output-end: ok');
