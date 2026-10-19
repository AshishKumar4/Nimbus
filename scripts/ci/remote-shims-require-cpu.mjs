#!/usr/bin/env bun
// The guest's CommonJS require through the node shims, on armada under V8.
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-shims-require-cpu',
  receipts: 'remote-shims-require-cpu',
  baselineDir: 'packages/worker/.ci-shims-require-baseline',
  engine: 'node',
  bench: 'tests/bench/shims-require-cpu.mjs',
});
