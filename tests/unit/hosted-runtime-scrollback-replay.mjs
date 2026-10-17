#!/usr/bin/env bun
// A terminal that reconnects is shown the session's scrollback, and the
// scrollback is not recorded again (SES-5): however many times a user
// reconnects, each line of history is in it once, so the cap evicts real
// history and not copies of it.
//
// Through composeHostedRuntime's attachTerminal, which every reconnect of a
// hosted runtime takes. Red before: the replay went through the terminal's
// ordinary write, whose flush tees into the scrollback, so each reconnect
// stored another copy (and the next replayed both).
import assert from 'node:assert/strict';

import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

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

const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}), { resolveConfig: false });
const harness = createSqliteVfsTestHarness();
const facetCtx = createFacetCtx(world, 'embedder-do');
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
};
const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
const processes = new bundle.SessionProcessSupervisor();
processes.setPidBase(bundle.PID_GEN_STRIDE);
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 1 });
const runtime = await bundle.composeHostedRuntime({
  workspace,
  ctx,
  env,
  ports: new bundle.PortRegistry(),
  lifecycle: {
    waitUntil: (task) => facetCtx.waitUntil(task),
    async schedule() {},
    async cancel() {},
  },
});

const socket = () => ({ readyState: 1, frames: [], send(frame) { this.frames.push(JSON.parse(frame)); } });
const shown = (ws) => ws.frames.filter((f) => f.type === 'output').map((f) => f.data).join('');
const stored = () => [...harness.sql.exec('SELECT data FROM nimbus_terminal_scrollback ORDER BY seq ASC')].map((row) => String(row.data)).join('');
const count = (text, marker) => text.split(marker).length - 1;

const marker = 'scrollback-line-7f3a';
const first = socket();
await runtime.attachTerminal(first);
runtime.terminal.write(`${marker}\r\n`);
runtime.terminal.flushNow();
assert.equal(count(stored(), marker), 1, 'the line is recorded once as it is shown');

for (let reconnect = 1; reconnect <= 3; reconnect++) {
  const ws = socket();
  await runtime.attachTerminal(ws);
  assert.equal(count(shown(ws), marker), 1, `reconnect ${reconnect} shows the line once`);
  assert.equal(count(stored(), marker), 1, `after reconnect ${reconnect} the line is in the scrollback once`);
}
console.log('hosted-runtime-scrollback-replay: ok');
