#!/usr/bin/env bun
// tests/bench/module-resolution-cpu.mjs on armada, under node (V8, as workerd
// runs it): the branch's ES module resolution against the baseline's.
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-module-resolution-cpu',
  receipts: 'remote-module-resolution-cpu',
  source: 'packages/core/src',
  baselineDir: 'packages/core/.ci-resolution-baseline',
  engine: 'node',
  // Its arms are bundled on their own (esbuild): bun runs it too, for context.
  engines: ['node', 'bun'],
  bench: 'tests/bench/module-resolution-cpu.mjs',
});
