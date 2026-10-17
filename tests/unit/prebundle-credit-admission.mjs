#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { beginLoaderFetch, claimAdmission, DO_DYNAMIC_WORKER_LIMIT, loaderLedgerStats, withLaunchAdmission } from '../../packages/fabric/src/budgets.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { acquireSupervisorAllocation, acquireSupervisorRunningAllocation, readSupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { buildPrebundle } from '../../packages/worker/src/npm/browser-prebundle.ts';
import { PrebundlePool } from '../../packages/worker/src/facets/prebundle-pool.ts';
import { launchManager } from './lib/facet-launch-harness.mjs';
import { namedFacetPlatform } from './lib/named-facet-platform.mjs';
import { createAuthority, runScenarios, until } from './lib/resident-body.mjs';

function bundleFixture(name, bytes = 128 * 1024) {
  const authority = createAuthority();
  const root = 'home/user/app';
  authority.kfs.mkdir(`${root}/node_modules/pkg`, { recursive: true });
  authority.kfs.writeFile(`${root}/node_modules/pkg/package.json`, '{"name":"pkg","main":"index.js","type":"module"}');
  authority.kfs.writeFile(`${root}/node_modules/pkg/index.js`, `export const x=1;\n// ${'x'.repeat(bytes)}\n`);
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let sliceRef;
  class Bundler {
    async warm() {}
    async prebundle(spec) {
      entered.resolve();
      await finish.promise;
      return { specifier: spec.specifier, ok: true, esmCode: 'export const x=1;', elapsed: 0, warnings: [] };
    }
  }
  const platform = namedFacetPlatform({ id: name, classFor: () => Bundler,
    invoke(_name, method, args, instance) {
      if (method === 'prebundle') sliceRef = new WeakRef(args[0].slice);
      const transferred = structuredClone(args);
      args.length = 0;
      return instance.then((target) => target[method](...transferred));
    },
  });
  const provider = new PrebundlePool(platform.env, platform.ctx);
  const context = { vfs: authority.kfs, root, cache: null, pool: provider,
    parse: async (_path, source) => source, esbuild: new EsbuildService(undefined, {}), serviceFallback: false };
  return { ...platform, provider, context, authority, entered: entered.promise, finish: () => finish.resolve(), sliceRef: () => sliceRef,
    build: () => buildPrebundle(context, 'pkg', null, (code) => code) };
}

function otherSession() {
  adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });
  const h = launchManager('prebundle-co-tenant', { env: { LOADER: {
    load() { return { getEntrypoint: () => ({ async run() { return Response.json({ exitCode: 0, stdout: 'other', stderr: '' }); } }) }; },
    get() { throw new Error('one-shots use the unkeyed loader'); },
  } } });
  const fs = h.vfs.as(CRED_KERNEL);
  fs.mkdir('home/user/other', { recursive: true, mode: 0o755 });
  fs.writeFile('home/user/other/cell.js', `module.exports=7;\n// ${'x'.repeat(17 * 1024 * 1024)}\n`, { mode: 0o644 });
  return () => h.manager.exec('require("./cell.js");', { cwd: '/home/user/other', filename: '/home/user/other/run.js', captureOutput: true });
}

async function coTenantRuns(mode) {
  const h = bundleFixture(`prebundle-${mode}`);
  await h.provider.acquire();
  const holds = mode === 'worker' ? Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(h.ctx, `busy-${i}`)) : [];
  const bundles = [h.build()];
  let other;
  try {
    if (mode === 'worker') await until(() => loaderLedgerStats(h.ctx).waiting === 1, 'the prebundle waits for its session worker');
    else await h.entered;
    if (mode === 'slot') bundles.push(h.build());
    other = otherSession()();
    let timer;
    const result = await Promise.race([other, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 20_000); })])
      .finally(() => clearTimeout(timer));
    assert.ok(result, `the other session's unmeasured build is not held by prebundle ${mode}: ${JSON.stringify(readSupervisorAllocationBudget())}`);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'other');
  } finally {
    for (const release of holds) release();
    h.finish();
    for (const result of await Promise.all(bundles)) assert.equal(result.kind, 'built', JSON.stringify(result));
    if (other) await other;
  }
  assert.equal(readSupervisorAllocationBudget().current, 0);
}

await runScenarios(fileURLToPath(import.meta.url), {
  slowRpc: () => coTenantRuns('rpc'),
  busyPoolSlot: () => coTenantRuns('slot'),
  busyWorkers: () => coTenantRuns('worker'),
  async runningWorkReclaims() {
    const h = bundleFixture('prebundle-running-reclaim');
    await h.provider.acquire();
    const capacity = readSupervisorAllocationBudget().capacity;
    const held = await acquireSupervisorAllocation(capacity);
    const building = h.build();
    await until(() => readSupervisorAllocationBudget().queued > 0, 'prebundle waits for credit without owning a worker');
    const holds = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(h.ctx, `busy-${i}`));
    held.release();
    try {
      await until(() => loaderLedgerStats(h.ctx).waiting > 0 && readSupervisorAllocationBudget().current > 0, 'the fallback slice parks for a worker');
      let timer;
      const running = await Promise.race([acquireSupervisorRunningAllocation(capacity), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('running work could not reclaim a parked prebundle')), 5000);
      })]).finally(() => clearTimeout(timer));
      running.release();
    } finally {
      for (const release of holds) release();
      h.finish();
      assert.equal((await building).kind, 'built');
    }
    assert.equal(readSupervisorAllocationBudget().current, 0);
  },
  async runningCallerOvertakesOrdinaryAsks() {
    const parked = bundleFixture('parked-prebundle', 20 * 1024 * 1024);
    const caller = bundleFixture('running-prebundle', 20 * 1024 * 1024);
    await parked.provider.acquire();
    await caller.provider.acquire();
    const capacity = readSupervisorAllocationBudget().capacity;
    const held = await acquireSupervisorAllocation(capacity);
    const first = parked.build();
    await until(() => readSupervisorAllocationBudget().queued > 0, 'the first prebundle falls back to a credit-first retry');
    const holds = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(parked.ctx, `busy-${i}`));
    held.release();
    await until(() => loaderLedgerStats(parked.ctx).waiting > 0 && readSupervisorAllocationBudget().current > 0,
      'the fallback payload parks for its worker');
    const abortOrdinary = new AbortController();
    let ordinaryLease;
    const ordinary = acquireSupervisorAllocation(capacity, abortOrdinary.signal, { owner: 'ordinary full-budget build' })
      .then((lease) => { ordinaryLease = lease; return lease; });
    ordinary.catch(() => {});
    const second = withLaunchAdmission(caller.ctx, { pid: 71 }, undefined, async () => {
      const end = claimAdmission(caller.ctx, 71);
      try { return await caller.build(); } finally { end(); }
    });
    let timer;
    try {
      await Promise.race([caller.entered, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('running prebundle did not overtake the ordinary ask and reclaim the parked payload')), 15_000);
      })]).finally(() => clearTimeout(timer));
      const released = await ordinary;
      released.release();
      caller.finish();
      assert.equal((await second).kind, 'built');
    } finally {
      abortOrdinary.abort(new Error('test complete'));
      ordinaryLease?.release();
      for (const release of holds) release();
      caller.finish(); parked.finish();
      await Promise.allSettled([first, second]);
    }
    assert.equal(readSupervisorAllocationBudget().current, 0);
  },
  async delegatedDiscoveryHoldsNoSlice() {
    const h = bundleFixture('delegated-prebundle');
    const root = h.context.root + '/node_modules/pkg';
    h.authority.kfs.writeFile(`${root}/index.js`, 'export { X } from "./component.tsx";');
    const parameter = 'T' + 'x'.repeat(600);
    h.authority.kfs.writeFile(`${root}/component.tsx`, `type Identity = <${parameter}>(value: ${parameter}) => ${parameter}; export const X: Identity = value => value;`);
    const entered = Promise.withResolvers();
    const finish = Promise.withResolvers();
    h.context.parse = async () => { entered.resolve(); await finish.promise; return 'export const X = () => null;'; };
    const building = buildPrebundle(h.context, 'pkg', { pkgName: 'pkg', fileCount: 1000, names: new Set(['X']), inputHash: 'x' }, (code) => code);
    try {
      await Promise.race([entered.promise, h.entered.then(() => { throw new Error('the fixture did not need delegated parsing'); }),
        building.then((result) => { throw new Error(`the fixture completed before delegated parsing: ${JSON.stringify(result)}`); })]);
      assert.equal(readSupervisorAllocationBudget().current, 0, 'delegated discovery holds no retained slice credit');
    } finally { finish.resolve(); h.finish(); await building; }
  },
  async abortWorkerWait() {
    const h = bundleFixture('abort-prebundle-worker');
    await h.provider.acquire();
    const holds = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(h.ctx, `busy-${i}`));
    const abort = new AbortController();
    h.context.signal = abort.signal;
    const building = h.build();
    try {
      await until(() => loaderLedgerStats(h.ctx).waiting === 1, 'the prebundle waits for a helper worker');
      const reason = new Error('cancel prebundle');
      abort.abort(reason);
      await assert.rejects(building, (error) => error === reason);
      assert.equal(loaderLedgerStats(h.ctx).waiting, 0);
      assert.equal(readSupervisorAllocationBudget().current, 0);
    } finally { for (const release of holds) release(); h.finish(); }
  },
  async handoffDropsSupervisorSlice() {
    const h = bundleFixture('drop-prebundle-slice');
    const building = h.build();
    try {
      await h.entered;
      let live = true;
      for (let i = 0; i < 12 && live; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        Bun.gc(true);
        live = h.sliceRef().deref() !== undefined;
      }
      assert.equal(live, false, 'the supervisor keeps no slice vector while the RPC answer is pending');
      assert.equal(readSupervisorAllocationBudget().current, 0, 'the transferred slice keeps no supervisor credit');
    } finally { h.finish(); await building; }
  },
  async abortPoolSlot() {
    const h = bundleFixture('abort-prebundle-slot');
    const first = h.build();
    await h.entered;
    const abort = new AbortController();
    const queued = Promise.withResolvers();
    const context = { ...h.context, signal: abort.signal, pool: { acquire: async (signal) => {
      const pool = await h.provider.acquire(signal);
      return { prebundle: (task) => { const call = pool.prebundle(task); queued.resolve(); return call; } };
    } } };
    const second = buildPrebundle(context, 'pkg', null, (code) => code);
    try {
      await queued.promise;
      const reason = new Error('cancel queued prebundle');
      abort.abort(reason);
      await assert.rejects(second, (error) => error === reason);
      assert.equal(readSupervisorAllocationBudget().current, 0);
    } finally { h.finish(); await first; }
    assert.equal((await h.build()).kind, 'built', 'cancelling a queued slot leaves the next submission runnable');
  },
});
