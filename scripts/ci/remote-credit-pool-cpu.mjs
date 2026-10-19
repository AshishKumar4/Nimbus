#!/usr/bin/env bun
// tests/bench/credit-pool-cpu.mjs on armada, under node (V8, as workerd
// runs it): the branch's packages/platform/src against the baseline's.
import { remotePairedCpu } from './lib/paired-cpu.mjs';
import { PLATFORM_CPU_SOURCES } from '../../tests/bench/lib/cpu-sources.mjs';

await remotePairedCpu({
  ...PLATFORM_CPU_SOURCES,
  name: 'remote-credit-pool-cpu',
  receipts: 'remote-credit-pool-cpu',
  baselineDir: '.ci-credit-pool-baseline',
  engine: 'node',
  // Its arms are bundled on their own (esbuild): bun runs it too, for context.
  engines: ['node', 'bun'],
  bench: 'tests/bench/credit-pool-cpu.mjs',
});
