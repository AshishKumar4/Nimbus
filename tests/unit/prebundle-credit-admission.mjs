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

function bundleFixture(name, bytes = 128 * 1024, resets = 0) {
  const authority = createAuthority();
  const root = 'home/user/app';
  authority.kfs.mkdir(`${root}/node_modules/pkg`, { recursive: true });
  authority.kfs.writeFile(`${root}/node_modules/pkg/package.json`, '{"name":"pkg","main":"index.js","type":"module"}');
  authority.kfs.writeFile(`${root}/node_modules/pkg/index.js`, `export const x=1;\n// ${'x'.repeat(bytes)}\n`);
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let sliceRef;
  let calls = 0;
  const inputs = [];
  const rpcCredit = [];
  class Bundler {
    async warm() {}
    async prebundle(spec) {
      rpcCredit.push(readSupervisorAllocationBudget().current);
      if (calls++ < resets) {
        authority.kfs.writeFile(`${root}/node_modules/pkg/index.js`, 'export const x=2;');
        throw new Error('the build facet connection reset');
      }
      entered.resolve();
      await finish.promise;
      return { specifier: spec.specifier, ok: true, esmCode: 'export const x=1;', elapsed: 0, warnings: [] };
    }
  }
  const platform = namedFacetPlatform({ id: name, classFor: () => Bundler,
    invoke(_name, method, args, instance) {
      if (method === 'prebundle') sliceRef = new WeakRef(args[0].slice);
      const transferred = structuredClone(args);
      if (method === 'prebundle') inputs.push(transferred[0]);
      args.length = 0;
      return instance.then((target) => target[method](...transferred));
    },
  });
  const provider = new PrebundlePool(platform.env, platform.ctx);
  const context = { vfs: authority.kfs, root, cache: null, pool: provider,
    parse: async (_path, source) => source, esbuild: new EsbuildService(undefined, {}), serviceFallback: false };
  return { ...platform, provider, context, authority, inputs, rpcCredit, entered: entered.promise, finish: () => finish.resolve(), sliceRef: () => sliceRef,
    build: () => buildPrebundle(context, 'pkg', null, (code) => code) };
}

function nodeSession(bytes = 17 * 1024 * 1024) {
  adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }), NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; }, async handleHttpRequest() { return new Response('ok'); },
  }) });
  let h;
  h = launchManager('prebundle-co-tenant', { env: { LOADER: {
    load() { return { getEntrypoint: () => ({ async run() { return Response.json({ exitCode: 0, stdout: 'other', stderr: '' }); } }) }; },
    get: (...args) => h.world.loader.get(...args),
  } }, hooks: { requestLaunchTurn: () => { setTimeout(() => { void h.manager.pumpResidentLaunches(); }, 0); } } });
  const fs = h.vfs.as(CRED_KERNEL);
  fs.mkdir('home/user/other', { recursive: true, mode: 0o755 });
  fs.writeFile('home/user/other/cell.js', `module.exports=7;\n// ${'x'.repeat(bytes)}\n`, { mode: 0o644 });
  const code = 'require("./cell.js");';
  const options = { cwd: '/home/user/other', filename: '/home/user/other/run.js' };
  return { ...h, one: () => h.manager.exec(code, { ...options, captureOutput: true }),
    resident: () => h.manager.spawnNode(code, { ...options, command: 'node run.js --host' }) };
}

const otherSession = () => nodeSession().one;

function deferredDiscovery(name) {
  const h = bundleFixture(name);
  const root = h.context.root + '/node_modules/pkg';
  h.authority.kfs.writeFile(`${root}/index.js`, 'export { X } from "./component.tsx";');
  const parameter = 'T' + 'x'.repeat(600);
  h.authority.kfs.writeFile(`${root}/component.tsx`, `type Identity = <${parameter}>(value: ${parameter}) => ${parameter}; export const X: Identity = value => value;`);
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  h.context.parse = async () => { entered.resolve(); await finish.promise; return 'export const X = () => null;'; };
  return { h, entered: entered.promise, finish: () => { finish.resolve(); h.finish(); },
    build: () => buildPrebundle(h.context, 'pkg', { pkgName: 'pkg', fileCount: 1000, names: new Set(['X']), inputHash: 'x' }, (code) => code) };
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
    const discovery = deferredDiscovery('delegated-prebundle');
    const building = discovery.build();
    try {
      await Promise.race([discovery.entered, discovery.h.entered.then(() => { throw new Error('the fixture did not need delegated parsing'); }),
        building.then((result) => { throw new Error(`the fixture completed before delegated parsing: ${JSON.stringify(result)}`); })]);
      assert.equal(readSupervisorAllocationBudget().current, 0, 'delegated discovery holds no retained slice credit');
    } finally { discovery.finish(); await building; }
  },
  async residentAndOneShotProgressDuringDiscovery() {
    const discovery = deferredDiscovery('resident-prebundle-discovery');
    const building = discovery.build();
    await discovery.entered;
    const node = nodeSession(14 * 1024 * 1024);
    const resident = node.resident();
    const one = node.one();
    let timer;
    try {
      const settled = await Promise.race([Promise.all([resident, one]), new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 20_000);
      })]).finally(() => clearTimeout(timer));
      const ledger = loaderLedgerStats(node.ctx);
      assert.ok(settled, `resident launch and same-entry one-shot wait on the prebundle: ${JSON.stringify({
        budget: readSupervisorAllocationBudget(), launch: node.manager.launchState(), inFlight: ledger.inFlightWorkers, waiters: ledger.waiters,
      })}`);
      assert.equal(settled[1].exitCode, 0, settled[1].stderr);
      node.manager.kill(settled[0].pid);
    } finally {
      discovery.finish(); await building;
      const completed = await Promise.allSettled([resident, one]);
      if (completed[0].status === 'fulfilled') node.manager.kill(completed[0].value.pid);
    }
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
  async resetRegathersTheSlice() {
    const h = bundleFixture('reset-prebundle-slice', 128 * 1024, 1);
    h.finish();
    const result = await h.build();
    assert.equal(result.kind, 'built', JSON.stringify(result));
    assert.equal(h.inputs.length, 2, 'one reset retries exactly once with a freshly prepared input');
    const source = (spec) => new TextDecoder().decode(spec.slice.find((entry) => entry.path.endsWith('/pkg/index.js')).bytes);
    assert.ok(source(h.inputs[0]).includes('x=1'));
    assert.ok(source(h.inputs[1]).includes('x=2'), 'the retry reads the new package bytes, never the old RPC slice');
    assert.deepEqual(h.rpcCredit, [0, 0], 'neither pending RPC owns a supervisor slice lease');
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
  async unrelatedWriteDoesNotRequeueThePlan() {
    const h = bundleFixture('queued-prebundle-revision');
    const queued = Promise.withResolvers();
    let submissions = 0;
    h.context.pool = { acquire: async (signal) => {
      const pool = await h.provider.acquire(signal);
      return { prebundle: (task) => {
        const result = pool.prebundle(task);
        if (++submissions === 2) queued.resolve();
        return result;
      } };
    } };
    const first = h.build();
    await h.entered;
    const second = h.build();
    try {
      await queued.promise;
      h.authority.kfs.writeFile(h.context.root + '/unrelated.txt', 'a concurrent project edit');
    } finally { h.finish(); }
    const results = await Promise.all([first, second]);
    assert.ok(results.every((result) => result.kind === 'built'), JSON.stringify(results));
    assert.equal(submissions, 2, 'an unrelated project write neither changes the package plan nor loses its queue position');
  },
});
