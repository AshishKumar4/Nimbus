#!/usr/bin/env bun
// A hosted runtime keeps its embedder's Durable Object in memory while a
// resident process runs, by the same rule the session DO follows.
//
// A resident lives in a facet, and a facet dies with its parent. The platform
// evicts an object after roughly ten seconds with no in-flight event, so a
// quiet resident needs an alarm to be the event. The session DO arms one
// through its own timer mux; a hosted runtime has only its embedder's
// `lifecycle.schedule`, so it asks for a `resident-keepalive` task there and
// the embedder's alarm hands it back through `onScheduled`.
//
// Asserted through composeHostedRuntime's public surface:
//   - nothing asks for the keep-alive before a resident runs;
//   - starting a resident schedules `resident-keepalive` one cadence out;
//   - `onScheduled('resident-keepalive')` schedules the next one while it runs;
//   - once it has exited, `onScheduled` schedules nothing more;
//   - the next resident starts the cycle again.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RESIDENT_KEEPALIVE_MS } from '../../packages/platform/src/limits.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';

const root = new URL('../../', import.meta.url).pathname;
const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-hosted-keepalive-'));
let bundle;
try {
  // One graph for the runtime and the workspace it is composed over, so the
  // filesystem authority the runtime checks for is the class it knows.
  const entryPath = join(outputDir, 'entry.ts');
  await writeFile(entryPath, [
    `export { composeHostedRuntime } from '${root}packages/worker/src/workspace-host.ts';`,
    `export { NimbusWorkspace } from '${root}packages/core/src/workspace/nimbus-workspace.ts';`,
    `export { SessionProcessSupervisor } from '${root}packages/core/src/runtime/session-process-supervisor.ts';`,
    `export { PortRegistry } from '${root}packages/core/src/runtime/port-registry.ts';`,
    `export { SqliteVFS } from '${root}packages/core/src/vfs/sqlite-vfs.ts';`,
    `export { PID_GEN_STRIDE } from '${root}packages/core/src/runtime/process-table.ts';`,
    `export { composeFabric } from '${root}packages/fabric/src/composition.ts';`,
    '',
  ].join('\n'));
  const build = await Bun.build({
    entrypoints: [entryPath],
    outdir: join(outputDir, 'out'),
    target: 'bun',
    format: 'esm',
    plugins: [{
      name: 'cloudflare-workers-test-stub',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare-workers', namespace: 'test' }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export class DurableObject {}; export class WorkerEntrypoint {}; export class RpcTarget {};',
          loader: 'js',
        }));
      },
    }],
  });
  assert.equal(build.success, true, build.logs.map(String).join('\n'));
  bundle = await import(pathToFileURL(build.outputs.find((o) => o.path.endsWith('/entry.js')).path).href);
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

const ASSETS = {
  async fetch(request) {
    const path = new URL(request.url).pathname.replace(/^\//, '');
    return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)), { status: 200 });
  },
};

const settle = async (predicate, tries = 400) => {
  for (let i = 0; i < tries && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
};

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
  ASSETS,
};

/** Every `lifecycle.schedule` the runtime asked of its embedder. */
const scheduled = [];
const keepalives = () => scheduled.filter(([task]) => task === 'resident-keepalive');

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
    waitUntil: (task) => { facetCtx.waitUntil(task); },
    async schedule(task, at) { scheduled.push([task, at]); },
    async cancel() {},
  },
});

try {
  assert.deepEqual(keepalives(), [], 'no keep-alive before a resident runs');

  // ── starting a resident schedules the keep-alive ────────────────────────
  const before = Date.now();
  const first = await runtime.spawnWorker('export default {}', 'embedder worker', '/home/user', {});
  await settle(() => keepalives().length > 0);
  assert.equal(keepalives().length, 1, `the resident start scheduled resident-keepalive once: ${JSON.stringify(scheduled)}`);
  const [, armedAt] = keepalives()[0];
  assert.ok(
    armedAt >= before + RESIDENT_KEEPALIVE_MS && armedAt <= Date.now() + RESIDENT_KEEPALIVE_MS,
    `one cadence out (got ${armedAt - before}ms, cadence ${RESIDENT_KEEPALIVE_MS}ms)`,
  );
  console.log('  [1] starting a resident schedules resident-keepalive one cadence out');

  // ── the alarm re-arms while it runs ─────────────────────────────────────
  const fired = Date.now();
  await runtime.onScheduled('resident-keepalive');
  assert.equal(keepalives().length, 2, 'the fire scheduled the next keep-alive');
  const [, rearmedAt] = keepalives()[1];
  assert.ok(
    rearmedAt >= fired + RESIDENT_KEEPALIVE_MS && rearmedAt <= Date.now() + RESIDENT_KEEPALIVE_MS,
    `re-armed one cadence out (got ${rearmedAt - fired}ms)`,
  );
  console.log('  [2] onScheduled re-arms while the resident runs');

  // ── no re-arm once it has exited ────────────────────────────────────────
  await runtime.killProcess(first.pid);
  await settle(() => processes.get(first.pid)?.state !== 'running');
  assert.notEqual(processes.get(first.pid)?.state, 'running', 'the resident exited');
  await runtime.onScheduled('resident-keepalive');
  assert.equal(keepalives().length, 2, 'with no resident, the fire schedules nothing');
  console.log('  [3] no re-arm after the resident exits');

  // ── the next resident starts the cycle again ────────────────────────────
  await runtime.spawnWorker('export default {}', 'second worker', '/home/user', {});
  await settle(() => keepalives().length > 2);
  assert.equal(keepalives().length, 3, 'a new resident re-arms the lapsed cycle');
  console.log('  [4] the next resident re-arms the cycle');
} finally {
  await runtime.close();
}

console.log('hosted-runtime-resident-keepalive OK');
