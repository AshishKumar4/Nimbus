#!/usr/bin/env bun
// NIMBUS_DEBUG means one thing wherever it is read: a hosted runtime and the
// facet manager it composes agree about the same binding, as a Durable
// Object session and its manager do.
//
// Driven through composeHostedRuntime, once per spelling of the var. A
// resident is launched by the facet manager (whose debug trace of where it
// is hosted lands in the process's stderr) and reports a clean exit through the supervisor
// as a facet does; the runtime's terminal then shows the debug-only
// "[facet exited ...]" notice at the next prompt. Both appear exactly when
// the var is '1' or 'true', and neither otherwise.

import assert from 'node:assert/strict';

import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { hostedLifecycle } from './lib/hosted-lifecycle.mjs';
import { stripAnsi } from '../behavioral/_driver.mjs';

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

/** What a hosted runtime with NIMBUS_DEBUG set to `value` (absent when undefined) shows for one resident's clean exit. */
async function observe(value) {
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }), { resolveConfig: false });
  const harness = createSqliteVfsTestHarness();
  const facetCtx = createFacetCtx(world, `debug-${value}`);
  const ctx = {
    ...facetCtx,
    storage: { ...facetCtx.storage, sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync },
    exports: { SupervisorRPC: ({ props }) => ({ props }) },
    getWebSockets: () => [],
  };
  const env = {
    WORKSPACES: { idFromName() {}, idFromString() {}, get() {} },
    LOADER: world.loader,
    ASSETS: stagedAssets,
    ...(value === undefined ? {} : { NIMBUS_DEBUG: value }),
  };
  const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
  const processes = new bundle.SessionProcessSupervisor();
  processes.setPidBase(bundle.PID_GEN_STRIDE);
  const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 1 });
  const runtime = await bundle.composeHostedRuntime({
    workspace, ctx, env, ports: new bundle.PortRegistry(), lifecycle: hostedLifecycle(ctx, () => runtime),
  });
  let shown = '';
  const write = runtime.terminal.write.bind(runtime.terminal);
  runtime.terminal.write = (data) => { shown += data; return write(data); };
  try {
    const { pid } = await runtime.spawnWorker('export default { fetch() { return new Response("ok"); } }', 'node server.js', '/home/user', {});
    const launchTrace = /\[nimbus-debug\] process hosted on /.test((await runtime.processLogs(pid)).text);
    await runtime.supervisorOp({ op: 'reportExit', args: [0, ''], pid });
    workspace.shell.printPrompt();
    return { launchTrace, exitNotice: /\[facet exited: pid=\d+ code=0/.test(stripAnsi(shown)) };
  } finally {
    await runtime.close();
  }
}

const ON = ['1', 'true'];
for (const value of ['1', 'true', '0', 'false', '', undefined]) {
  const seen = await observe(value);
  const on = ON.includes(value);
  assert.deepEqual(seen, { launchTrace: on, exitNotice: on },
    `NIMBUS_DEBUG=${JSON.stringify(value)}: the manager's launch trace and the runtime's exit notice both ${on ? 'appear' : 'stay off'}`);
  console.log(`  ✓ NIMBUS_DEBUG=${JSON.stringify(value)}: ${on ? 'on' : 'off'} in the runtime and its manager`);
}

console.log('nimbus-debug-one-reading: ok');
