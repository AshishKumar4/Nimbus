#!/usr/bin/env bun
// Paired launch preparation and admission, in one process with an A/A null arm.
// Only Worker execution is stood in for: maps, filesystem walks, supervisor
// credit, process lifecycle, and Dynamic Worker admissions use the real flow.
// Each arm is its side's whole tree (isolated-core.mjs): its facet manager,
// and every module and test harness it is driven with.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { armImports, armTree, assertArmsInside, repository } from './lib/isolated-core.mjs';
import { cpuMs, pairedKind, shuffled } from './lib/paired-cpu.mjs';

const option = (name) => {
  const at = process.argv.indexOf(name);
  assert.ok(at >= 0 && process.argv[at + 1], `${name} is required`);
  return process.argv[at + 1];
};
const baseline = resolve(option('--baseline'));
const output = option('--out');
const disposals = [];
const ITERATIONS = 32;
const PAIRS = 24;
const results = [];
let serial = 0;
const loader = {
  load(config) {
    assert.ok(config.modules[config.mainModule], 'the generated map reaches the loader');
    return { getEntrypoint: () => ({ async run() { return Response.json({ exitCode: 0, stdout: '', stderr: '' }); } }) };
  },
  get() { throw new Error('a one-shot takes the unkeyed loader path'); },
};
const until = async (ready) => {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, 'the first busy launch reached worker admission');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};
try {
  /** An arm: its side's tree (`from`), every module this bench drives a launch with taken from it. */
  const load = async (from) => {
    const tree = armTree(from, (dispose) => disposals.push(dispose));
    const [manager, supervisor, ports, budgets, composition, credit, host, facets, launches, bridge, assets] = await armImports(tree, [
      'packages/worker/src/facets/manager.ts', 'packages/core/src/runtime/session-process-supervisor.ts', 'packages/core/src/runtime/port-registry.ts',
      'packages/fabric/src/budgets.ts', 'packages/fabric/src/composition.ts', 'packages/platform/src/heavy-alloc-coord.ts',
      'packages/worker/src/loaders/process-host.ts', 'tests/unit/lib/facet-host-harness.mjs', 'tests/unit/lib/facet-launch-harness.mjs',
      'tests/unit/lib/process-bridge.mjs', 'tests/unit/lib/staged-assets.mjs',
    ]);
    composition.adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });
    return {
      Manager: manager.FacetManager, supervisor, ports, budgets, credit, host, facets, launches, bridge, assets,
    };
  };
  const makeSession = (arm) => {
    const { vfs } = arm.launches.launchSession();
    const ctx = arm.facets.createFacetCtx(arm.facets.createFacetWorld(() => ({})), `launch-cpu-${serial++}`);
    const manager = new arm.Manager(ctx, { LOADER: loader, ASSETS: arm.assets.stagedAssets }, new arm.supervisor.SessionProcessSupervisor(),
      new arm.ports.PortRegistry(), arm.host.processHostFor, {});
    manager.setVfs(vfs, arm.bridge.processFiles(vfs));
    return { ctx, manager };
  };
  const arms = {};
  for (const name of shuffled(['A', 'null', 'real'])) {
    const loaded = await load(name === 'real' ? repository : baseline);
    arms[name] = { ...loaded, single: makeSession(loaded) };
  }
  assertArmsInside();
  const launch = async (manager, code = '2 + 2') => {
    const result = await manager.exec(code, { cwd: '/home/user', captureOutput: true });
    assert.equal(result.exitCode, 0, result.stderr);
  };
  const single = async (arm) => {
    for (let i = 0; i < ITERATIONS; i++) await launch(arm.single.manager);
  };
  const contended = async (arm) => {
    const sessions = Array.from({ length: 16 }, () => makeSession(arm));
    const holds = sessions.slice(0, 15).flatMap(({ ctx }) =>
      Array.from({ length: arm.budgets.DO_DYNAMIC_WORKER_LIMIT }, (_, i) => arm.budgets.beginLoaderFetch(ctx, `busy-${i}`)));
    const parked = [launch(sessions[0].manager)];
    let timer;
    try {
      await until(() => sessions[0].manager.launchState().launches[0]?.stage === 'admission');
      timer = setTimeout(() => { for (const release of holds.splice(0)) release(); }, 40);
      const beforeCpu = process.cpuUsage();
      const beforeWall = performance.now();
      // A new entry in the non-busy session has never learned a closure size.
      await launch(sessions[15].manager, '3 + 3');
      const wall = performance.now() - beforeWall;
      const used = process.cpuUsage(beforeCpu);
      return { wall, cpu: (used.user + used.system) / 1000 };
    } finally {
      clearTimeout(timer);
      for (const release of holds) release();
      await Promise.all(parked);
    }
  };
  for (const kind of ['single-wall', 'single-cpu', 'contended-wall', 'contended-cpu']) {
    const sample = async (arm) => {
      if (kind.startsWith('contended')) return (await contended(arm))[kind.endsWith('wall') ? 'wall' : 'cpu'];
      if (kind.endsWith('cpu')) return cpuMs(() => single(arm));
      const before = performance.now();
      await single(arm);
      return performance.now() - before;
    };
    const result = await pairedKind(kind, arms, sample, { pairs: PAIRS, warm: 8, iterations: kind.startsWith('single') ? ITERATIONS : 1 });
    results.push(result);
    writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
    const { samples, ...summary } = result;
    console.log(JSON.stringify(summary));
    for (const arm of Object.values(arms)) {
      assert.equal(arm.credit.readSupervisorAllocationBudget().current, 0, 'each sample releases all launch credit');
      assert.equal(arm.credit.readSupervisorAllocationBudget().queued, 0, 'each sample drains all builds');
    }
  }
  assertArmsInside();
} finally {
  for (const dispose of disposals) dispose();
}
