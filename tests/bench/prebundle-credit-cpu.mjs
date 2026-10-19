#!/usr/bin/env bun
// Real supervisor preparation/admission/handoff, with fixed-cost compiler
// answers. Each arm is its side's whole tree (isolated-core.mjs), so its
// budget and diag counters are its own and include owner-accounting cost.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { heapStats } from 'bun:jsc';
import { armTree, assertArmsInside, repository } from './lib/isolated-core.mjs';
import { cpuMs, pairedKind, shuffled } from './lib/paired-cpu.mjs';
import { median } from '../../scripts/lib/statistics.mjs';

const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const baseline = resolve(option('--baseline'));
const output = option('--out');
const disposals = [];
const live = () => { Bun.gc(true); const stats = heapStats(); return stats.heapSize + stats.extraMemorySize; };
const results = [];
const singleIterations = 32;
const bundleIterations = 4;
const pairs = process.argv.includes('--short') ? 2 : 24;
const warm = process.argv.includes('--short') ? 1 : 8;

try {
  /** An arm: its side's tree (`from`), every module this bench drives with taken from it, budget and diag copies included. */
  const load = async (from, label) => {
    const tree = armTree(from, (dispose) => disposals.push(dispose));
    const module = (path) => import(pathToFileURL(join(tree, path)).href);
    const [browser, poolModule, budget, diag, manager, contracts, esbuildService, supervisor, ports, composition, host, facets, launches, named, bridge, assets] = await Promise.all([
      'packages/worker/src/npm/browser-prebundle.ts', 'packages/worker/src/facets/prebundle-pool.ts',
      'packages/platform/src/heavy-alloc-coord.ts', 'packages/platform/src/diag-counters.ts', 'packages/worker/src/facets/manager.ts',
      'packages/core/src/runtime/os-contracts.ts', 'packages/core/src/runtime/esbuild-service.ts', 'packages/core/src/runtime/session-process-supervisor.ts',
      'packages/core/src/runtime/port-registry.ts', 'packages/fabric/src/composition.ts', 'packages/worker/src/loaders/process-host.ts',
      'tests/unit/lib/facet-host-harness.mjs', 'tests/unit/lib/facet-launch-harness.mjs', 'tests/unit/lib/named-facet-platform.mjs',
      'tests/unit/lib/process-bridge.mjs', 'tests/unit/lib/staged-assets.mjs',
    ].map(module));
    composition.adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });
    const { CRED_KERNEL } = contracts;
    const { EsbuildService } = esbuildService;
    const { SessionProcessSupervisor } = supervisor;
    const { PortRegistry } = ports;
    const { processHostFor } = host;
    const { createFacetCtx, createFacetWorld } = facets;
    const { launchSession } = launches;
    const { namedFacetPlatform } = named;
    const { processFiles } = bridge;
    const { stagedAssets } = assets;
    const session = launchSession();
    const fs = session.vfs.as(CRED_KERNEL);
    const root = 'home/user/bench';
    fs.mkdir(`${root}/node_modules/pkg`, { recursive: true, mode: 0o755 });
    fs.writeFile(`${root}/node_modules/pkg/package.json`, '{"name":"pkg","main":"index.js","type":"module"}', { mode: 0o644 });
    for (let i = 0; i < 32; i++) fs.writeFile(`${root}/node_modules/pkg/${i === 0 ? 'index' : 'part-' + i}.js`,
      `export const value${i}=${i};\n// ${'x'.repeat(16 * 1024)}\n`, { mode: 0o644 });
    fs.mkdir('home/user/one', { recursive: true, mode: 0o755 });
    const arm = { browser, budget, diag, hold: null };
    class Compiler {
      async warm() {}
      async prebundle(spec) {
        if (arm.hold) { arm.hold.entered.resolve(); await arm.hold.finished.promise; }
        return { specifier: spec.specifier, ok: true, esmCode: 'export const answer=42;', elapsed: 0, warnings: [] };
      }
    }
    const platform = namedFacetPlatform({ id: `prebundle-cpu-${label}`, classFor: () => Compiler,
      invoke(_name, method, args, instance) { const copy = structuredClone(args); args.length = 0; return instance.then((target) => target[method](...copy)); },
    });
    const provider = new poolModule.PrebundlePool(platform.env, platform.ctx);
    await provider.acquire();
    const context = { vfs: fs, root, cache: null, pool: provider, parse: async (_path, source) => source,
      esbuild: new EsbuildService(undefined, {}), serviceFallback: false };
    arm.bundle = async () => {
      const built = await browser.buildPrebundle(context, 'pkg', null, (code) => code);
      assert.equal(built.kind, 'built', JSON.stringify(built));
    };
    arm.stopObserver = budget.registerAllocObserver({ onAcquire: () => session.vfs.shrinkForInstall(), onRelease: () => session.vfs.restoreAfterInstall() });
    const ctx = createFacetCtx(createFacetWorld(() => ({})), `one-cpu-${label}`);
    const one = new manager.FacetManager(ctx, { ASSETS: stagedAssets, LOADER: {
      load() { return { getEntrypoint: () => ({ async run() { return Response.json({ exitCode: 0, stdout: '', stderr: '' }); } }) }; },
      get() { throw new Error('one-shot uses the unkeyed loader'); },
    } }, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {});
    one.setVfs(session.vfs, processFiles(session.vfs));
    arm.one = async () => {
      const result = await one.exec('2+2', { cwd: '/home/user/one', captureOutput: true });
      assert.equal(result.exitCode, 0, result.stderr);
    };
    return arm;
  };
  const arms = {};
  for (const label of shuffled(['A', 'null', 'real'])) arms[label] = await load(label === 'real' ? repository : baseline, label);
  assertArmsInside();
  const measure = async (kind) => {
    const isBundle = kind.startsWith('prebundle');
    const iterations = isBundle ? bundleIterations : singleIterations;
    const result = await pairedKind(kind, arms, async (arm) => {
      const work = async () => { for (let i = 0; i < iterations; i++) await (isBundle ? arm.bundle() : arm.one()); };
      if (kind.endsWith('cpu')) return cpuMs(work);
      const before = performance.now(); await work(); return performance.now() - before;
    }, { pairs, warm, iterations });
    results.push(result);
    writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
  };
  await measure('prebundle-wall'); await measure('prebundle-cpu');
  for (const arm of Object.values(arms)) assert.ok(arm.budget.readSupervisorAllocationBudget().peak > 0,
    'each arm owns a distinct budget actually used by its prebundle pipeline');
  const memory = {};
  for (const label of shuffled(['A', 'null', 'real'])) {
    const arm = arms[label];
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const before = live();
      const hold = { entered: Promise.withResolvers(), finished: Promise.withResolvers() };
      arm.hold = hold;
      const building = arm.bundle();
      await hold.entered.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const retained = live() - before;
      const stats = arm.budget.readSupervisorAllocationBudget();
      const slice = arm.diag.readDiagCounters().preBundleSliceBytes;
      hold.finished.resolve(); await building; arm.hold = null;
      samples.push({ retained, peakCredit: stats.peak, rpcCredit: stats.current, slice });
    }
    memory[label] = { liveRetainedBytes: median(samples.map((row) => row.retained)),
      peakCreditBytes: median(samples.map((row) => row.peakCredit)), rpcCreditBytes: median(samples.map((row) => row.rpcCredit)),
      rpcSliceBytes: median(samples.map((row) => row.slice)) };
  }
  results[0].memory = memory;
  writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`memory ${JSON.stringify(memory)}`);
  await measure('oneshot-wall'); await measure('oneshot-cpu');
  for (const arm of Object.values(arms)) {
    assert.equal(arm.budget.readSupervisorAllocationBudget().current, 0);
    arm.stopObserver();
  }
  assertArmsInside();
} finally { for (const dispose of disposals) dispose(); }
