#!/usr/bin/env bun
// A session's terminals by name (Kinu asks 64 and 56), through the hosted
// runtime an embedder composes: `attachTerminal(ws, { terminal })`.
//   - two names are two shells: `cd` in one is not the other's, each
//     reattach replays its own screen, Up recalls its own history;
//   - no name is the session's own terminal, as before;
//   - `listTerminals` names each with its cwd; `closeTerminal` hangs up what
//     it runs (a job behind a `sh -c` too) and forgets its screen, state and
//     history; the other runs on;
//   - a name's shell outlives `kill $$`, as the session's own does;
//   - names follow the rule (1 to 64 of A-Z a-z 0-9 . _ -), at most 16.
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

const socket = () => ({ readyState: 1, frames: [], send(frame) { this.frames.push(JSON.parse(frame)); }, close() { this.readyState = 3; } });
const shown = (ws) => ws.frames.filter((f) => f.type === 'output').map((f) => f.data).join('');
const stored = (name) => [...harness.sql.exec('SELECT data FROM nimbus_terminal_scrollback WHERE terminal = ? ORDER BY seq ASC', name)].map((row) => String(row.data)).join('');
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FRESH = '\x1b]133;A\x07';
const until = async (name, done, label) => {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await settle(10)) {
    if (done(stored(name))) return stored(name);
  }
  throw new Error(`timed out waiting for ${label} on ${name}: ${JSON.stringify(stored(name).slice(-400))}`);
};
/** A line run in terminal `name` on `ws`: what it added to that terminal's screen up to its next prompt. */
const run = async (name, ws, line) => {
  const before = stored(name).length;
  await runtime.terminalFrame(ws, JSON.stringify({ type: 'input', data: `${line}\r` }), { terminal: name });
  const after = await until(name, (text) => text.slice(before).includes(FRESH), JSON.stringify(line));
  return after.slice(before);
};
const attach = async (name) => {
  const ws = socket();
  await runtime.attachTerminal(ws, { terminal: name });
  return ws;
};

const a = await attach('a');
assert.ok(a.frames.some((f) => f.type === 'ready'), 'a named terminal attaches and is ready');
await run('a', a, 'cd /tmp');
await run('a', a, 'echo from-a');
const b = await attach('b');
await run('b', b, 'mkdir -p /srv/b && cd /srv/b');
await run('b', b, 'echo from-b');
assert.match(await run('a', a, 'pwd'), /\/tmp\r\n/, 'a is where a went');
assert.match(await run('b', b, 'pwd'), /\/srv\/b\r\n/, 'b is where b went');

// Reattached, each shows its own screen.
const a2 = await attach('a');
assert.equal(shown(a2), stored('a'), 'a reattach replays a\'s own screen');
assert.ok(!shown(a2).includes('from-b'), 'and nothing of b\'s');
// Up recalls the terminal's own last line.
const before = stored('a').length;
await runtime.terminalFrame(a2, JSON.stringify({ type: 'input', data: '\x1b[A' }), { terminal: 'a' });
const recalled = await until('a', (text) => text.length > before, 'Up');
assert.ok(recalled.slice(before).includes('pwd') && !recalled.slice(before).includes('from-b'), `Up recalls a's own history: ${JSON.stringify(recalled.slice(before))}`);
await runtime.terminalFrame(a2, JSON.stringify({ type: 'input', data: '\x15' }), { terminal: 'a' });

// The session's own terminal is as it was.
const own = socket();
await runtime.attachTerminal(own);
assert.ok(own.frames.some((f) => f.type === 'ready'), 'no name is the session\'s own terminal');

// A terminal's shell outlives `kill $$`.
assert.match(await run('a', a2, 'kill $$; echo "kill=$?"'), /kill=1/, 'kill $$ is refused in a named terminal');
assert.match(await run('a', a2, 'echo alive'), /alive\r\n/, 'and its shell runs on');

const listed = await runtime.listTerminals();
assert.deepEqual(listed.map((t) => [t.name, t.live, t.cwd]), [[null, true, '/home/user'], ['a', true, '/tmp'], ['b', true, '/srv/b']]);
assert.equal(listed.find((t) => t.name === 'a').attached, true);

// Close a: what it runs is hung up, b's runs on, and a is forgotten.
await run('a', a2, "sh -c 'sleep 600 &'");
await run('b', b, 'sleep 601 &');
const running = async (command) => (await runtime.listProcesses()).some((p) => p.command.includes(command) && p.state === 'running');
assert.equal(await running('sleep 600'), true, 'a\'s job runs, its sh -c gone');
assert.deepEqual(await runtime.closeTerminal('a'), { closed: true });
assert.equal(a2.readyState, 3, 'a\'s socket is closed');
assert.equal(await running('sleep 600'), false, 'a\'s job is hung up');
assert.equal(await running('sleep 601'), true, 'b\'s job runs on');
assert.deepEqual((await runtime.listTerminals()).map((t) => t.name), [null, 'b']);
assert.equal(stored('a'), '', 'a\'s screen is forgotten');
assert.equal(workspace.terminalState('a'), null, 'and its shell state');
assert.equal(await workspace.fs.exists('/home/user/.local/state/nimbus/terminals/a.history'), false, 'and its history');
assert.deepEqual(await runtime.closeTerminal('a'), { closed: false }, 'a second close finds none');
assert.match(await run('b', b, 'pwd'), /\/srv\/b\r\n/, 'b is as it was');

// Names follow the rule, and a session keeps at most 16.
await assert.rejects(runtime.attachTerminal(socket(), { terminal: 'no/slash' }));
await assert.rejects(runtime.closeTerminal('x'.repeat(65)), TypeError);
for (let n = 1; n <= 15; n++) await attach(`t${n}`);
await assert.rejects(attach('one-too-many'), /at most 16 named terminals/);
console.log('named-terminals: ok');
