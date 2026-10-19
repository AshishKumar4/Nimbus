#!/usr/bin/env bun
/**
 * The heap estimate's pre-bundle slice is the slices pre-bundles hold now:
 * its leased bytes while preparing, nothing once RPC has taken them,
 * however it ended. A build whose package was reinstalled under it (its
 * bundle served, not stored) ends like any other; before, it counted as an
 * attempt with no outcome, and the estimate kept a 28 MiB slice for the
 * life of the isolate.
 */

import assert from 'node:assert/strict';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { NpmInstaller } from '../../packages/worker/src/npm/installer.ts';
import { readDiagCounters } from '../../packages/platform/src/diag-counters.ts';
import { estimateSupervisorHeap } from '../../packages/platform/src/heap-estimate.ts';
import { readSupervisorAllocationBudget, registerAllocObserver } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { PrebundlePool } from '../../packages/worker/src/facets/prebundle-pool.ts';
import { namedFacetPlatform } from './lib/named-facet-platform.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const root = 'home/user/app';
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
const write = (path, content) => {
  const at = `${root}/${path}`;
  kernel.mkdir(at.slice(0, at.lastIndexOf('/')), { recursive: true, mode: 0o755 });
  kernel.writeFile(at, new TextEncoder().encode(content), { mode: 0o644 });
};
write('package.json', JSON.stringify({ name: 'app', dependencies: { pkg: '1.0.0' } }));
write('node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', version: '1.0.0', type: 'module', main: 'index.js' }));
write('node_modules/pkg/index.js', 'export const x = 1;\n');
write('src/main.js', "import { x } from 'pkg';\nconsole.log(x);\n");

const heap = () => estimateSupervisorHeap(readDiagCounters(), { cacheHotBytes: 0, inFlightWriteBytes: 0 });

// The build facet holds each bundle until the test lets it finish.
let entered;
const building = new Promise((resolve) => { entered = resolve; });
let finish;
const finished = new Promise((resolve) => { finish = resolve; });
class Bundler {
  async warm() {}
  async prebundle(spec) {
    entered(spec);
    await finished;
    return { specifier: spec.specifier, ok: true, esmCode: 'export const x = 1;\n', elapsed: 0, warnings: [] };
  }
}
const platform = namedFacetPlatform({ id: 'prebundle-heap', classFor: () => Bundler,
  invoke(_name, method, args, instance) { const copy = structuredClone(args); return instance.then((target) => target[method](...copy)); },
});
const pool = new PrebundlePool(platform.env, platform.ctx);
let preparing = 0;
const stop = registerAllocObserver({ onAcquire: () => {
  preparing = Math.max(preparing, readDiagCounters().preBundleSliceBytes);
} });
const installer = new NpmInstaller(new ProcessFiles(vfs), harness.sql, {
  esbuild: new EsbuildService(undefined, {}),
  bundlePool: pool,
});
const lines = [];
const phase = installer.prebundleUsedModules(root, new Map([['pkg', {}]]), kernel, (line) => lines.push(line));

await building;
const live = heap();
assert.equal(
  live.breakdown.preBundleSliceBytes, readSupervisorAllocationBudget().current,
  `a live pre-bundle's slice is what its lease holds (${JSON.stringify(live.breakdown)})`,
);
assert.ok(preparing > 0, 'preparing the slice is attributed to its actual budget lease');
assert.equal(live.breakdown.preBundleSliceBytes, 0, 'a pending RPC keeps no supervisor slice credit');
assert.equal(live.breakdown.unattributedReservationBytes, 0, 'so none of the reservation is unattributed');
console.log(`  a prepared pre-bundle held ${preparing} bytes, then dropped its credit at RPC handoff`);

// The package is reinstalled while it is bundled: the bundle is served, not stored.
write('node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', version: '2.0.0', type: 'module', main: 'index.js' }));
finish();
await phase;
stop();
assert.ok(lines.some((line) => /not cached: its package changed while it was bundled/.test(line)), `the build ended on a moved manifest:\n${lines.join('\n')}`);

const idle = heap();
assert.equal(readSupervisorAllocationBudget().current, 0, 'the lease is released');
assert.equal(idle.breakdown.preBundleSliceBytes, 0, `an ended pre-bundle holds no slice (${JSON.stringify(idle.breakdown)})`);
console.log('  ✓ a pre-bundle whose package moved under it holds no slice once it ended');

console.log('prebundle-heap-occupancy: ok');
