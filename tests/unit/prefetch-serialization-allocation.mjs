#!/usr/bin/env bun
// Kinu #29: the real FacetManager.exec path keeps admission through source
// serialization, not just the filesystem gather. Observe the production cell
// serializer without replacing its work or changing the bytes it produces.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { heapStats } from 'bun:jsc';
import { readSupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { VFS_BUNDLE_MAX_BYTES } from '../../packages/core/src/constants.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';

adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }), NimbusLoadedEntrypoint: () => ({
  async startProcess() { return { ok: true }; }, async handleHttpRequest() { return new Response('ok'); },
}) });

const cellsPath = new URL('../../packages/core/src/_shared/commonjs-cell.ts', import.meta.url).pathname;
const cells = await import(cellsPath);
const wrap = cells.wrapCommonJsCell;
const reservations = [];
let peak = 0;
let failSerialization = false;
mock.module(cellsPath, () => ({ ...cells,
  wrapCommonJsCell(...args) {
    if (args[0].includes('PREFETCH_LEASE_EVIDENCE')) {
      reservations.push(readSupervisorAllocationBudget().current);
      peak = Math.max(peak, heapStats().heapSize);
      if (failSerialization) throw new Error('injected serializer failure');
    }
    return wrap(...args);
  },
}));
const { launchManager } = await import('./lib/facet-launch-harness.mjs');
const env = { LOADER: {
  load() { return { getEntrypoint: () => ({ async run() { return Response.json({ exitCode: 0, stdout: '', stderr: '' }); } }) }; },
  get() { throw new Error('one-shot fixture uses load, not named resident get'); },
} };
const { manager, vfs } = launchManager('prefetch-serialization-credit', { env });
const fs = vfs.as(CRED_KERNEL);
for (let i = 0; i < 3; i++) {
  fs.mkdir(`home/user/tree${i}`, { recursive: true, mode: 0o755 });
  fs.writeFile(`home/user/tree${i}/cell.js`, `// PREFETCH_LEASE_EVIDENCE\nmodule.exports = "${'x'.repeat(10 * 1024 * 1024)}";\n`, { mode: 0o644 });
}
Bun.gc(true);
const baseHeap = heapStats().heapSize;
peak = baseHeap;
const sampled = setInterval(() => { peak = Math.max(peak, heapStats().heapSize); }, 1);
const started = performance.now();
try {
  const results = await Promise.all(Array.from({ length: 3 }, (_, i) => manager.exec("require('./cell.js')", {
    filename: `/home/user/tree${i}/run.js`, cwd: `/home/user/tree${i}`, captureOutput: true,
  })));
  console.log('PREFETCH_SERIALIZATION ' + JSON.stringify({ callers: 3, elapsedMs: performance.now() - started,
    peakOverBase: peak - baseHeap, reservations, results: results.map(({ exitCode, stderr }) => ({ exitCode, stderr })) }));
  assert.ok(results.every(result => result.exitCode === 0), JSON.stringify(results));
  assert.ok(reservations.length >= 3, 'every distinct launch actually serialized its large cell');
  assert.ok(reservations.every(bytes => bytes >= VFS_BUNDLE_MAX_BYTES), 'no source serialization is outside supervisor admission');
  assert.equal(readSupervisorAllocationBudget().current, 0, 'completed builds release their allocation');
  fs.mkdir('home/user/shared', { recursive: true, mode: 0o755 });
  fs.writeFile('home/user/shared/cell.js', '// PREFETCH_LEASE_EVIDENCE\nmodule.exports=1;', { mode: 0o644 });
  const options = { filename: '/home/user/shared/run.js', cwd: '/home/user/shared', captureOutput: true };
  const count = reservations.length;
  const identical = await Promise.all(Array.from({ length: 3 }, () => manager.exec("require('./cell.js')", options)));
  assert.ok(identical.every(result => result.exitCode === 0));
  assert.equal(reservations.length - count, 1, 'same-key waiters use the published cache after admission instead of gathering again');
  fs.writeFile('home/user/shared/cell.js', '// PREFETCH_LEASE_EVIDENCE\nmodule.exports=2;', { mode: 0o644 });
  failSerialization = true;
  const failed = await manager.exec("require('./cell.js')", options);
  assert.notEqual(failed.exitCode, 0);
  assert.equal(readSupervisorAllocationBudget().current, 0, 'a serializer failure cannot leak its lease');
  failSerialization = false;
  assert.equal((await manager.exec("require('./cell.js')", options)).exitCode, 0, 'the next launch can be admitted after failure');
} finally { clearInterval(sampled); }
