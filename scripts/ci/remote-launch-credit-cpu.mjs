#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-launch-credit-cpu',
  receipts: 'remote-launch-credit-cpu',
  source: 'packages/worker/src',
  baselineDir: '.ci-launch-baseline',
  files: ['facets/manager.ts'],
  engine: 'bun',
  bench: 'tests/bench/launch-credit-cpu.mjs',
});
