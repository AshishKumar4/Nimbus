#!/usr/bin/env bun
// The 64 MiB dynamic-worker code ceiling, refused with names instead of a number.
//
// The platform's own refusal — "Dynamic Worker code size (N bytes) exceeds the
// maximum allowed size of 67108864 bytes" — names no member, and the budget is
// shared across every member of the map: a ruby process is 34.3 MiB down
// before its disk is counted. The fabric checks where maps are assembled, and
// an over-ceiling map must fail listing the largest members by size so the
// operator sees WHAT to shrink. Under the ceiling the check must cost nothing
// beyond a length read per member.

import assert from 'node:assert/strict';
import {
  DYNAMIC_WORKER_CODE_LIMIT_BYTES,
  assertModuleMapWithinCodeLimit,
} from '../../packages/fabric/src/workerd-facet-host.ts';
import { LoaderPool } from '../../packages/fabric/src/loader-pool.ts';
import { ProcessFabric } from '../../packages/fabric/src/process-fabric.ts';
import { setCtxExports } from '../../packages/fabric/src/ctx-exports.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import {
  createCtxExports,
  createFacetCtx,
  createFacetWorld,
} from './facet-host-harness.mjs';

const MIB = 1024 * 1024;

// ── the helper: over-ceiling lists the top members, sorted, with bytes ──────
{
  const modules = {
    'worker.js': 'export default {}',
    'snapshot.js': 'x'.repeat(30 * MIB),
    'ruby+stdlib.wasm': { wasm: new ArrayBuffer(34 * MIB) },
    'shims.js': { js: 'y'.repeat(5 * MIB) },
  };
  assert.throws(
    () => assertModuleMapWithinCodeLimit(modules),
    (error) => {
      assert.match(error.message, /67,108,864|67108864/, 'the ceiling is named');
      const wasmAt = error.message.indexOf("'ruby+stdlib.wasm' (35,651,584 bytes)");
      const snapshotAt = error.message.indexOf("'snapshot.js' (31,457,280 bytes)");
      const shimsAt = error.message.indexOf("'shims.js' (5,242,880 bytes)");
      assert.ok(wasmAt >= 0 && snapshotAt >= 0 && shimsAt >= 0, `members with sizes: ${error.message}`);
      assert.ok(wasmAt < snapshotAt && snapshotAt < shimsAt, 'largest first');
      return true;
    },
  );
}

// ── under the ceiling, nothing happens ──────────────────────────────────────
assertModuleMapWithinCodeLimit({
  'worker.js': 'export default {}',
  'big-but-fine.wasm': { wasm: new ArrayBuffer(40 * MIB) },
});

// ── the resident seam: an over-ceiling boot spec fails at assembly ──────────
setCtxExports(createCtxExports(() => { throw new Error('no disk'); }));
{
  const world = createFacetWorld(() => ({
    startProcess: () => Promise.resolve({ ok: true }),
    handleHttpRequest: () => Promise.resolve(new Response('ok')),
  }));
  const ctx = createFacetCtx(world, 'ceiling-do');
  const host = processHostFor(ctx, { LOADER: world.loader }, () => ({
    readFile() { throw new Error('no disk'); },
  }));
  const fabric = new ProcessFabric(host);
  const handle = await fabric.startResidentProcess({
    startContract: 'boot',
    pid: 1,
    workerKey: 'nimbus-process:ceiling-do:1',
    boot: {
      kind: 'code',
      code: {
        compatibilityDate: '2025-01-01',
        compatibilityFlags: [],
        mainModule: 'worker.js',
        modules: {
          'worker.js': 'export default {}',
          'oversized.js': 'z'.repeat(DYNAMIC_WORKER_CODE_LIMIT_BYTES),
        },
      },
    },
    onWriterActivated() {},
    onWriterRetired() {},
  });
  await assert.rejects(
    handle.booted(),
    (error) => {
      assert.match(error.message, /'oversized\.js'/, 'the member to shrink is named');
      return true;
    },
    'a resident boot over the ceiling must fail at assembly, naming the member',
  );
  handle.kill();
  await handle.done.catch(() => {});

  // The one-shot seam shares the check.
  await assert.rejects(
    host.runOnce({
      pid: 2,
      writerId: crypto.randomUUID(),
      code: async () => ({
        compatibilityDate: '2025-01-01',
        compatibilityFlags: [],
        mainModule: 'worker.js',
        modules: {
          'worker.js': 'export default {}',
          'huge-one-shot.js': 'z'.repeat(DYNAMIC_WORKER_CODE_LIMIT_BYTES),
        },
      }),
      request: new Request('https://run/'),
      onWriterActivated() {},
    }, async (response) => response.text()),
    /'huge-one-shot\.js'/,
    'a one-shot map over the ceiling must fail before the loader sees it',
  );
}

// ── the pool seam: an over-ceiling wasm payload fails naming the module ─────
{
  const pool = new LoaderPool(
    { LOADER: { get: () => ({ getEntrypoint: () => ({ async execute() { return 'ran'; } }) }) } },
    { id: { toString: () => 'pool-ceiling-id' } },
    { omitSupervisor: true, wasmModules: { 'giant.wasm': new ArrayBuffer(DYNAMIC_WORKER_CODE_LIMIT_BYTES) } },
  );
  await assert.rejects(
    pool.submit((value) => value, 'payload'),
    /'giant\.wasm'/,
    "the pool's assembled map is under the same ceiling check",
  );
  pool.dispose();
}

console.log('ok - module-map-code-limit (ceiling named, members listed largest-first, all assembly seams checked)');
