#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-prebundle-credit-cpu', receipts: 'remote-prebundle-credit-cpu', source: 'packages',
  baselineDir: '.ci-prebundle-credit-baseline',
  files: ['worker/src/npm/browser-prebundle.ts', 'worker/src/npm/pre-bundle-facet.ts',
    'worker/src/runtime/barrel-synthesizer.ts', 'worker/src/facets/prebundle-pool.ts',
    'worker/src/facets/build-facet.ts', 'worker/src/facets/manager.ts',
    'platform/src/heavy-alloc-coord.ts', 'platform/src/diag-counters.ts', 'core/src/runtime/prebundle-slice.ts'],
  engine: 'bun',
  bench: 'tests/bench/prebundle-credit-cpu.mjs',
});
