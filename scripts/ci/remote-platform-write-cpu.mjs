#!/usr/bin/env bun
// tests/bench/platform-write-cpu.mjs on armada, under node (V8, as workerd
// runs it): the branch's packages/platform/src against the baseline's.
import { remotePairedCpu } from './lib/paired-cpu.mjs';
import { PLATFORM_CPU_SOURCES } from '../../tests/bench/lib/cpu-sources.mjs';

await remotePairedCpu({
  ...PLATFORM_CPU_SOURCES,
  name: 'remote-platform-write-cpu',
  receipts: 'remote-platform-cpu',
  baselineDir: '.ci-platform-baseline',
  engine: 'node',
  // Its arms are bundled on their own (esbuild): bun runs it too, for context.
  engines: ['node', 'bun'],
  bench: 'tests/bench/platform-write-cpu.mjs',
});
