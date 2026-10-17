#!/usr/bin/env bun
// Paired launch preparation and admission, in one process with an A/A null arm.
// Only Worker execution is stood in for: maps, filesystem walks, supervisor
// credit, process lifecycle, and Dynamic Worker admissions use the real flow.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { beginLoaderFetch, DO_DYNAMIC_WORKER_LIMIT } from '../../packages/fabric/src/budgets.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { readSupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { createFacetCtx, createFacetWorld } from '../unit/lib/facet-host-harness.mjs';
import { launchSession } from '../unit/lib/facet-launch-harness.mjs';
import { processFiles } from '../unit/lib/process-bridge.mjs';
import { stagedAssets } from '../unit/lib/staged-assets.mjs';
import { cpuMs, pairedKind, shuffled } from './lib/paired-cpu.mjs';

const option = (name) => {
  const at = process.argv.indexOf(name);
  assert.ok(at >= 0 && process.argv[at + 1], `${name} is required`);
  return process.argv[at + 1];
};
const baseline = resolve(option('--baseline'));
const output = option('--out');
const source = new URL('../../packages/worker/src/', import.meta.url).pathname;
const fixtures = [];
const ITERATIONS = 32;
const PAIRS = 24;
const results = [];
let serial = 0;
adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });
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
  const load = async (from) => {
    const fixture = mkdtempSync(join(source, '.launch-cpu-'));
    fixtures.push(fixture);
    for (const entry of readdirSync(source)) {
      if (entry.startsWith('.launch-cpu-')) continue;
      if (entry !== 'facets') { symlinkSync(join(source, entry), join(fixture, entry)); continue; }
      mkdirSync(join(fixture, entry));
      for (const file of readdirSync(join(source, entry))) {
        const target = join(fixture, entry, file);
        if (file === 'manager.ts') writeFileSync(target, readFileSync(join(from, entry, file)));
        else symlinkSync(join(source, entry, file), target);
      }
    }
    return (await import(pathToFileURL(join(fixture, 'facets/manager.ts')).href)).FacetManager;
  };
  const makeSession = (Manager) => {
    const { vfs } = launchSession();
    const ctx = createFacetCtx(createFacetWorld(() => ({})), `launch-cpu-${serial++}`);
    const manager = new Manager(ctx, { LOADER: loader, ASSETS: stagedAssets }, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {});
    manager.setVfs(vfs, processFiles(vfs));
    return { ctx, manager };
  };
  const arms = {};
  for (const name of shuffled(['A', 'null', 'real'])) {
    const Manager = await load(name === 'real' ? source : baseline);
    arms[name] = { Manager, single: makeSession(Manager) };
  }
  const launch = async (manager, code = '2 + 2') => {
    const result = await manager.exec(code, { cwd: '/home/user', captureOutput: true });
    assert.equal(result.exitCode, 0, result.stderr);
  };
  const single = async (arm) => {
    for (let i = 0; i < ITERATIONS; i++) await launch(arm.single.manager);
  };
  const contended = async (arm) => {
    const sessions = Array.from({ length: 16 }, () => makeSession(arm.Manager));
    const holds = sessions.slice(0, 15).flatMap(({ ctx }) =>
      Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(ctx, `busy-${i}`)));
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
    assert.equal(readSupervisorAllocationBudget().current, 0, 'each sample releases all launch credit');
    assert.equal(readSupervisorAllocationBudget().queued, 0, 'each sample drains all builds');
  }
} finally {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
}
