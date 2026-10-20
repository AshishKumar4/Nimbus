#!/usr/bin/env bun
// A terminal reattached shows the screen it left, and adds nothing to it
// (Kinu ask 57): its stored screen is replayed, and the shell paints a
// prompt only when the screen does not end at its line editor. Before, every
// reattach to an idle hosted shell printed another prompt, into the screen
// and the stored scrollback, after a line being typed too.
//   - N idle reattaches leave the stored screen byte for byte as the first;
//   - an unfinished line (`ech`) survives a reattach, with no prompt after it;
//   - output a background job wrote after the prompt is followed by one fresh
//     prompt (with the line being typed) once, then nothing more;
//   - `echo hi` between reattaches adds its line, its output and one prompt.
// Through composeHostedRuntime's attachTerminal and terminalFrame.
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
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A fresh prompt is marked (OSC 133;A); a redraw of the line being edited is not. PROMPT is its visible end.
const FRESH = '\x1b]133;A\x07';
const PROMPT = '\x1b[0m$ ';
const prompts = (text) => text.split(FRESH).length - 1;
const type = async (ws, data) => {
  await runtime.terminalFrame(ws, JSON.stringify({ type: 'input', data }));
  await settle(50);
  runtime.terminal.flushNow();
};
const reattach = async () => {
  const ws = socket();
  await runtime.attachTerminal(ws);
  runtime.terminal.flushNow();
  return ws;
};

let ws = socket();
await runtime.attachTerminal(ws);
runtime.terminal.flushNow();
const first = stored();
assert.equal(prompts(first), 1, 'the first screen holds one prompt');
for (let n = 1; n <= 3; n++) {
  ws = await reattach();
  assert.equal(shown(ws), first, `idle reattach ${n} shows the first screen`);
  assert.equal(stored(), first, `idle reattach ${n} adds nothing to the stored screen`);
}

await type(ws, 'ech');
const typing = stored();
assert.ok(typing.slice(first.length).includes('ech'), `the line being typed is on the screen: ${JSON.stringify(typing.slice(first.length))}`);
ws = await reattach();
assert.equal(stored(), typing, 'a reattach adds no prompt after the line being typed');
for (let k = 0; k < 3; k++) await type(ws, '\x7f');

const before = stored();
await type(ws, 'echo hi\r');
const added = stored().slice(before.length);
assert.equal(added.split('\r\nhi\r\n').length - 1, 1, `echo hi prints its line once: ${JSON.stringify(added)}`);
assert.equal(prompts(added), 1, `and one prompt: ${JSON.stringify(added)}`);
ws = await reattach();
assert.equal(stored(), before + added, 'a reattach after it adds nothing');

await type(ws, '{ sleep 0.2; echo late-output; } &\r');
await settle(600);
runtime.terminal.flushNow();
await type(ws, 'ec');
const late = stored();
assert.ok(late.lastIndexOf('late-output') > late.lastIndexOf(PROMPT), 'the job wrote after the prompt');
ws = await reattach();
const repainted = stored().slice(late.length);
assert.equal(prompts(repainted), 1, `one fresh prompt after the job's output: ${JSON.stringify(repainted)}`);
assert.ok(repainted.includes(`${PROMPT}ec`), `with the line being typed: ${JSON.stringify(repainted)}`);
const settled = stored();
ws = await reattach();
assert.equal(stored(), settled, 'and the next reattach adds nothing');
console.log('terminal-reattach-screen: ok');
