#!/usr/bin/env bun
// Transient credit may bounce a build, never trim its content. Both a
// successful tight try and its full-credit retry publish the same map/plan.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { acquireSupervisorAllocation, readSupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { launchManager, launchSession } from './lib/facet-launch-harness.mjs';
import { moduleMapBundle } from './lib/module-map-bundle.mjs';
import { runScenarios, until } from './lib/resident-body.mjs';

async function compare(free, expectBounce, observedOnly = false) {
  adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });
  const session = launchSession();
  const fs = session.vfs.as(CRED_KERNEL);
  for (const path of ['home/user/app', 'home/user/node_modules/pkg', 'home/user/node_modules/learned', 'opt']) {
    fs.mkdir(path, { recursive: true, mode: 0o755 });
  }
  fs.writeFile('home/user/app/entry.cjs', 'module.exports = require("pkg");', { mode: 0o644 });
  fs.writeFile('home/user/node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', main: 'index.cjs' }), { mode: 0o644 });
  fs.writeFile('home/user/node_modules/pkg/index.cjs', 'module.exports = () => import("./lazy.cjs");', { mode: 0o644 });
  fs.writeFile('home/user/node_modules/pkg/lazy.cjs', `module.exports = require("./deep.cjs");\n// ${'l'.repeat((observedOnly ? 1 : 32) * 1024)}\n`, { mode: 0o644 });
  fs.writeFile('home/user/node_modules/pkg/deep.cjs', `module.exports = 7;\n// ${'d'.repeat((observedOnly ? 1 : 96) * 1024)}\n`, { mode: 0o644 });
  fs.writeFile('home/user/node_modules/learned/package.json', JSON.stringify({ name: 'learned', main: 'index.cjs' }), { mode: 0o644 });
  fs.writeFile('home/user/node_modules/learned/index.cjs', `module.exports = "learned";\n// ${'e'.repeat(32 * 1024)}\n`, { mode: 0o644 });
  fs.writeFile('opt/observed.txt', `learned synchronous read\n${'o'.repeat(128 * 1024)}`, { mode: 0o644 });
  const expected = ['home/user/node_modules/pkg/lazy.cjs', 'home/user/node_modules/pkg/deep.cjs',
    'home/user/node_modules/learned/index.cjs', 'opt/observed.txt'];
  const { oxcTransforms } = await import('./lib/oxc-engine.mjs');
  const transform = new EsbuildService(undefined, oxcTransforms);
  const make = (name, report = {}) => {
    let captured;
    const fixture = launchManager(name, { session, env: { LOADER: {
      load(config) {
        const bundle = moduleMapBundle(config.modules);
        const paths = Object.keys(bundle).sort();
        captured = { modules: config.modules, bundle, paths, evicted: expected.filter((path) => !paths.includes(path)), dataPlan: null };
        return { getEntrypoint: () => ({ async run(request) {
          const body = await request.json();
          captured.dataPlan = body.dataPlan;
          return Response.json({ exitCode: 0, stdout: '', stderr: '', ...report });
        } }) };
      },
      get() { throw new Error('one-shots take the unkeyed loader'); },
    } } });
    fixture.manager.setEsbuildService(transform);
    return { ...fixture, capture: () => captured };
  };
  const launch = async ({ manager }) => {
    const result = await manager.exec('require("./entry.cjs");', { cwd: '/home/user/app', filename: '/home/user/app/run.cjs', captureOutput: true });
    assert.equal(result.exitCode, 0, result.stderr);
  };
  // Learn through the real result/report path, then use fresh managers over
  // the identical VFS/storage so neither comparison can be a cache hit.
  await launch(make('neutral-learn', { residencyMisses: ['opt/observed.txt'], moduleMisses: ['home/user/node_modules/learned/index.cjs'] }));
  const full = make('neutral-full');
  await launch(full);
  assert.deepEqual(full.capture().evicted, [], 'the full-bound build stages every learned and lazy file');
  const bounded = make('neutral-tight');
  const capacity = readSupervisorAllocationBudget().capacity;
  const held = await acquireSupervisorAllocation(capacity - free);
  let finished = false;
  let bounced = false;
  const running = launch(bounded).then(() => { finished = true; });
  try {
    if (expectBounce) {
      await until(() => readSupervisorAllocationBudget().queued === 1 || finished, 'the bounded first try returns its credit and queues its full ask', 20_000);
      bounced = !finished;
      if (bounced) assert.equal(readSupervisorAllocationBudget().current, held.bytes, 'the partial gather dropped its credit before the full FIFO ask');
    } else {
      await running;
      assert.equal(readSupervisorAllocationBudget().queued, 0, 'a fitting first try does not bounce');
    }
  } finally {
    held.release();
  }
  await running;
  const actual = bounded.capture();
  const baseline = full.capture();
  assert.deepEqual(actual.evicted, [], 'credit does not evict learned or lazy content');
  assert.deepEqual(actual.paths, baseline.paths, 'staged paths are content-bound only');
  assert.deepEqual(actual.bundle, baseline.bundle, 'bundle paths and bytes are identical');
  assert.deepEqual(actual.modules, baseline.modules, 'the complete generated module/code/ESM map is byte-identical');
  assert.deepEqual(actual.dataPlan, baseline.dataPlan, 'the data plan is identical');
  if (expectBounce) assert.ok(bounced, 'the crossing first try bounces instead of publishing a smaller map');
  const budget = readSupervisorAllocationBudget();
  assert.equal(budget.current, 0);
  assert.equal(budget.queued, 0);
  assert.ok(budget.peak <= budget.capacity, JSON.stringify(budget));
}

await runScenarios(fileURLToPath(import.meta.url), {
  bouncesWithoutChangingContent: () => compare(256 * 1024, true),
  observedReadsBounceWithoutChangingContent: () => compare(256 * 1024, true, true),
  fittingTryHasIdenticalContent: () => compare(6 * 1024 * 1024, false),
});
console.log('prefetch-credit-content-neutral: tight admission changes scheduling, never the map or plan');
