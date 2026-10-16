#!/usr/bin/env bun
/**
 * The heap estimate's pre-bundle slice is the slices pre-bundles hold now:
 * a live build's leased bytes while it runs, nothing once it has ended,
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
import { readSupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';
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
const pool = {
  prebundle: async (spec) => {
    entered(spec);
    await finished;
    return { specifier: spec.specifier, ok: true, esmCode: 'export const x = 1;\n', elapsed: 0, warnings: [] };
  },
};
const installer = new NpmInstaller(new ProcessFiles(vfs), harness.sql, {
  esbuild: new EsbuildService(undefined, {}),
  bundlePool: { acquire: async () => pool },
});
const lines = [];
const phase = installer.prebundleUsedModules(root, new Map([['pkg', {}]]), kernel, (line) => lines.push(line));

await building;
const live = heap();
assert.equal(
  live.breakdown.preBundleSliceBytes, readSupervisorAllocationBudget().current,
  `a live pre-bundle's slice is what its lease holds (${JSON.stringify(live.breakdown)})`,
);
assert.ok(live.breakdown.preBundleSliceBytes > 0, 'and it holds something');
assert.equal(live.breakdown.unattributedReservationBytes, 0, 'so none of the reservation is unattributed');
console.log(`  ✓ a live pre-bundle's slice is its lease: ${live.breakdown.preBundleSliceBytes} bytes`);

// The package is reinstalled while it is bundled: the bundle is served, not stored.
write('node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', version: '2.0.0', type: 'module', main: 'index.js' }));
finish();
await phase;
assert.ok(lines.some((line) => /not cached: its package changed while it was bundled/.test(line)), `the build ended on a moved manifest:\n${lines.join('\n')}`);

const idle = heap();
assert.equal(readSupervisorAllocationBudget().current, 0, 'the lease is released');
assert.equal(idle.breakdown.preBundleSliceBytes, 0, `an ended pre-bundle holds no slice (${JSON.stringify(idle.breakdown)})`);
console.log('  ✓ a pre-bundle whose package moved under it holds no slice once it ended');

console.log('prebundle-heap-occupancy: ok');
