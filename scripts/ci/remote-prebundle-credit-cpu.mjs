#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-prebundle-credit-cpu', receipts: 'remote-prebundle-credit-cpu',
  baselineDir: '.ci-prebundle-credit-baseline',
  engine: 'bun',
  bench: 'tests/bench/prebundle-credit-cpu.mjs',
});
