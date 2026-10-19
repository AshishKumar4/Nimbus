#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-launch-credit-cpu',
  receipts: 'remote-launch-credit-cpu',
  baselineDir: '.ci-launch-baseline',
  engine: 'bun',
  bench: 'tests/bench/launch-credit-cpu.mjs',
});
