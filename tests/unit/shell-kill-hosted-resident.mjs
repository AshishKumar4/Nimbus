#!/usr/bin/env bun
// `kill <pid>` reaches a hosted session's resident processes.
//
// The shell's `kill` builtin resolves before the command registry, and it
// signals the shell's own process registry. A hosted session's residents
// live in the session's process table instead — their own pid space,
// generation-strided (1000002, …) — and their teardown (port unregister,
// writer revocation, the capability's retirement) is the host's. Before the
// builtin was handed that table, `kill 1000002` answered "No such process",
// the resident stayed up, and the next server on its port looked to the app
// layer like the original identity still starting.
//
// Driven through composeHostedRuntime — the real Shell with
// registerHostedCommands, the FacetManager and the SessionProcessSupervisor:
//   1. `kill A` exits 0 and A is no longer running, its port released,
//      before B binds the same port; A's reservation stays A's, stopped, and
//      its capability stays dead once B serves the port;
//   2. `kill -0` answers for a live resident without touching it;
//   3. a signal a resident cannot take (STOP) is refused and changes nothing;
//      an invalid signal spec is refused before any lookup;
//   4. an unknown pid is "No such process", status 1;
//   5. a child shell (`sh -c`) and a named programmatic shell reach residents
//      too, and `%job` in a subshell still names the subshell's own job.

import assert from 'node:assert/strict';

import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
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
  'packages/worker/src/session/port-capability.ts': ['readPortReservation'],
});

bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

const ASSETS = stagedAssets;

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
const env = { WORKSPACES: { idFromName() {}, idFromString() {}, get() {} }, LOADER: world.loader, ASSETS };

const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
const processes = new bundle.SessionProcessSupervisor();
processes.setPidBase(bundle.PID_GEN_STRIDE);
const ports = new bundle.PortRegistry();
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 1 });
const runtime = await bundle.composeHostedRuntime({
  workspace,
  ctx,
  env,
  ports,
  lifecycle: { waitUntil: (task) => facetCtx.waitUntil(task), async schedule() {}, async cancel() {} },
});

const PORT = 4300;
const running = (pid) => processes.get(pid)?.state === 'running';
const sh = async (command, options) => {
  const result = await runtime.exec(command, options);
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
};

try {
  const fm = runtime.facets().manager;
  /** A resident serving PORT, launched by the facet manager and bound as a listener; its identity is its cwd. */
  const serve = async (label, cwd) => {
    const spawned = await runtime.spawnWorker('export default { fetch() { return new Response("ok"); } }', label, cwd, {});
    await fm.registerPort(spawned.pid, PORT);
    return spawned.pid;
  };

  // ── 1. kill A, then B on the same port ─────────────────────────────────
  const a = await serve('node server.js', '/home/user/app');
  assert.ok(a > bundle.PID_GEN_STRIDE, `a resident pid is in the session table's pid space (${a})`);
  assert.equal(workspace.kernel.processRegistry.get(a), undefined, 'the shell registry does not hold the resident');
  const exposed = await runtime.exposeApp(PORT, { visibility: 'scoped' });
  assert.equal(exposed.pid, a);
  const OWNER = exposed.owner;
  const CAP1 = exposed.capability;
  assert.match(CAP1 ?? '', /^[a-f0-9]{24}$/);

  const killA = await sh(`kill ${a}`);
  assert.deepEqual(killA, { code: 0, out: '', err: '' }, 'kill of a resident succeeds silently');
  assert.equal(running(a), false, 'A is no longer running');
  assert.equal(ports.get(PORT), undefined, 'A released its port');

  const b = await serve('node other.js', '/home/user/other');
  assert.notEqual(b, a);
  assert.equal(ports.get(PORT)?.pid, b, 'B serves the port');
  const apps = await runtime.listApps();
  const held = apps.find((app) => app.owner === OWNER);
  assert.equal(held?.port, PORT, `the reservation stays with A: ${JSON.stringify(apps)}`);
  assert.equal(held?.status, 'stopped', `A is stopped, not starting: ${JSON.stringify(held)}`);
  assert.equal(held?.capability, null, "A's capability is retired");
  assert.equal(ports.hasCapability(PORT, CAP1), false, "A's capability does not reach B");
  assert.deepEqual(await bundle.readPortReservation(ctx, PORT).then((r) => r?.owner), OWNER, 'the port reservation is still A\'s');
  const other = apps.find((app) => app.pid === b);
  assert.ok(other && other.owner !== OWNER, `B keeps its own identity: ${JSON.stringify(other)}`);
  console.log('  [1] kill A ends it before B binds; A keeps its reservation, its capability stays dead');

  // ── 2. signal 0 is a liveness check ────────────────────────────────────
  assert.deepEqual(await sh(`kill -0 ${b}`), { code: 0, out: '', err: '' });
  assert.equal(running(b), true, 'kill -0 leaves B running');
  assert.equal(ports.get(PORT)?.pid, b, 'kill -0 leaves B on its port');
  assert.equal((await sh(`kill -0 ${a}`)).code, 1, 'kill -0 of an ended resident fails');
  console.log('  [2] kill -0 answers without touching the resident');

  // ── 3. refused signals change nothing ──────────────────────────────────
  const stop = await sh(`kill -STOP ${b}`);
  assert.equal(stop.code, 1);
  assert.match(stop.err, new RegExp(`kill: \\(${b}\\) - Operation not supported`));
  assert.equal(running(b), true, 'a refused signal leaves B running');
  const invalid = await sh(`kill -NOPE ${b}`);
  assert.deepEqual(invalid, { code: 1, out: '', err: 'kill: NOPE: invalid signal specification\n' });
  assert.equal(running(b), true);
  console.log('  [3] unsupported and invalid signals are refused');

  // ── 4. unknown pid ─────────────────────────────────────────────────────
  const unknown = bundle.PID_GEN_STRIDE + 999_999;
  assert.deepEqual(await sh(`kill ${unknown}`), { code: 1, out: '', err: `kill: (${unknown}) - No such process\n` });
  assert.deepEqual(await sh(`kill ${a}`), { code: 1, out: '', err: `kill: (${a}) - No such process\n` }, 'an ended resident is gone');
  console.log('  [4] an unknown pid is No such process');

  // ── 5. child shells ────────────────────────────────────────────────────
  assert.deepEqual(await sh(`sh -c 'kill -TERM ${b}; echo rc=$?'`), { code: 0, out: 'rc=0\n', err: '' });
  assert.equal(running(b), false, 'a child shell ended B');
  const c = await serve('node third.js', '/home/user/third');
  assert.deepEqual(await sh(`kill -s KILL ${c}; echo rc=$?`, { shellId: 'named' }), { code: 0, out: 'rc=0\n', err: '' });
  assert.equal(running(c), false, 'a named programmatic shell ended C');
  const job = await sh('( sleep 30 & kill %1; wait %1; echo "job=$?" )');
  assert.deepEqual(job, { code: 0, out: 'job=143\n', err: '' }, 'a subshell %job names its own job');
  console.log('  [5] sh -c, a named shell and a subshell %job all resolve');

  // ── 6. the exit status is the signal's ─────────────────────────────────
  // A resident ended by a signal exits 128+signo, as a shell reports it; the
  // exit record names the signal.
  const cases = [['', 'TERM', 143], ['-KILL', 'KILL', 137], ['-s INT', 'INT', 130], ['-1', 'HUP', 129], ['-n 15', 'TERM', 143]];
  for (const [flag, name, code] of cases) {
    const pid = await serve(`node sig-${name}-${code}.js`, `/home/user/sig-${flag.replace(/\W/g, '') || 'default'}`);
    assert.deepEqual(await sh(`kill ${flag} ${pid}`.replace(/ +/g, ' ')), { code: 0, out: '', err: '' }, `kill ${flag}`);
    assert.equal(running(pid), false, `kill ${flag} ended it`);
    assert.equal(processes.get(pid)?.exitCode, code, `kill ${flag}: exit status 128+SIG${name}`);
    assert.deepEqual(
      { code: processes.getExit(pid)?.code, reason: processes.getExit(pid)?.reason },
      { code, reason: `SIG${name}` },
      `kill ${flag}: the exit record`,
    );
  }
  console.log('  [6] TERM 143, KILL 137, INT 130, HUP 129 in the table and the exit record');
} finally {
  await runtime.close();
}

console.log('shell-kill-hosted-resident OK');
