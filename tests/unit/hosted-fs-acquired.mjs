#!/usr/bin/env bun
// A hosted runtime answers fsAcquired, and counts what it hands over once.
//
// A process's async read sends its barrier and the read together as
// fsAcquired; the session serves the read inside that answer through its own
// uncounted serving method (session/rpc.ts _rpcFsAcquired). The production
// owner an embedder composes (composeHostedRuntime) had only `supervisorOp`,
// so every fsAcquired answered "self.serveSupervisorOp is not a function" as
// the read's refusal. Through composeHostedRuntime's own supervisorOp:
//   [1] an fsAcquired stat and read answer the value, with the barrier;
//   [2] the read it carries is counted once, as the read alone is
//       (supervisorAnsweredBytes).

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
  'packages/core/src/runtime/os-contracts.ts': ['CRED_KERNEL', 'CRED_SESSION_USER'],
  'packages/fabric/src/composition.ts': ['composeFabric'],
  // The bundle's own copy of the counters: the one the runtime counts in.
  'packages/platform/src/diag-counters.ts': ['readDiagCounters'],
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
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 1 });
const runtime = await bundle.composeHostedRuntime({
  workspace,
  ctx,
  env,
  ports: new bundle.PortRegistry(),
  lifecycle: hostedLifecycle(ctx, () => runtime),
});

const SIZE = 100_000;
await runtime.files.as(bundle.CRED_KERNEL).writeFile('/home/user/data.bin', new Uint8Array(SIZE).fill(7), { mode: 0o644 });
const { pid } = processes.spawn('node', ['main.js'], '/home/user', { cred: bundle.CRED_SESSION_USER });
const acquire = () => ({ position: workspace.filesystem.bind({ pid, cred: bundle.CRED_SESSION_USER }).acquire(null).position });
const batch = [[{ path: '/home/user/data.bin', offset: 0, length: SIZE }]];

try {
  // ── [1] fsAcquired answers its read ────────────────────────────────────
  const stat = await runtime.supervisorOp({ op: 'fsAcquired', args: [acquire(), 'stat', ['/home/user/data.bin']], pid });
  assert.equal(stat.failure, undefined, `[1] the stat an fsAcquired carries is answered, not refused (${stat.failure?.message})`);
  assert.equal(stat.value.size, SIZE);
  assert.ok(stat.acquired, '[1] with the barrier');
  const read = await runtime.supervisorOp({ op: 'fsAcquired', args: [acquire(), 'fsReadBatch', batch], pid });
  assert.equal(read.failure, undefined, `[1] so is the read (${read.failure?.message})`);
  assert.equal(read.value[0].bytes.byteLength, SIZE);
  console.log('  [1] a hosted runtime answers fsAcquired\'s stat and read');

  // ── [2] counted once ──────────────────────────────────────────────────
  const counted = async (envelope) => {
    const before = bundle.readDiagCounters().supervisorAnsweredBytes;
    await runtime.supervisorOp({ pid, ...envelope });
    return bundle.readDiagCounters().supervisorAnsweredBytes - before;
  };
  const alone = await counted({ op: 'fsReadBatch', args: batch });
  const carried = await counted({ op: 'fsAcquired', args: [acquire(), 'fsReadBatch', batch] });
  assert.deepEqual([alone, carried], [SIZE, SIZE], '[2] a read is counted once, alone or carried by fsAcquired');
  console.log('  [2] what it hands over is counted once');

  // ── [3] journaled once ────────────────────────────────────────────────
  // A process that can stop is answered through its journal at one seam,
  // the canonical handler's logical answer: a hosted answer is journaled
  // once, so a run after a stop replays it, and an answer that changed
  // diverges.
  const { replay } = (await runtime.facets()).manager;
  const answer = (run) => Promise.all([
    runtime.supervisorOp({ op: 'fsAcquired', args: [acquire(), 'stat', ['/home/user/data.bin']], pid, run }),
    runtime.supervisorOp({ op: 'fsReadBatch', args: batch, pid, run }),
  ].map((pending) => pending.then(() => undefined)));
  /** A run answered, stopped, and the run after it answered (`between`: what changes in between); what diverged, if anything. */
  const stopAndReplay = async (between) => {
    let diverged = null;
    const { journal } = replay.open(pid, () => { diverged = journal.diverged; });
    try {
      journal.start('run-1');
      await answer('run-1');
      journal.stopped();
      const observations = journal.observations;
      await between();
      journal.start('run-2');
      await answer('run-2').catch(() => {});
      if (diverged === null) await replay.boundary(pid, 'run-2');
      return { observations, diverged };
    } finally {
      replay.close(pid);
    }
  };
  const same = await stopAndReplay(async () => {});
  assert.deepEqual(same.observations, { fsAcquired: 1, fsReadBatch: 1 }, '[3] each answer journaled once (the stat fsAcquired carries is its)');
  assert.equal(same.diverged, null, '[3] the run after the stop is answered the same, and passes its boundary');
  const changed = await stopAndReplay(() => runtime.files.as(bundle.CRED_KERNEL).writeFile('/home/user/data.bin', new Uint8Array(SIZE).fill(8), { mode: 0o644 }));
  assert.ok(typeof changed.diverged === 'string' && changed.diverged.length > 0, '[3] an answer that changed diverges');
  console.log('  [3] each answer is journaled once');
} finally {
  await runtime.close();
}
console.log('ok - hosted-fs-acquired (a hosted runtime answers fsAcquired, counts its read once and journals it once)');
