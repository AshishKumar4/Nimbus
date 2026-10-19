#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-holder-ops-cpu',
  receipts: 'remote-holder-ops-cpu',
  baselineDir: '.ci-holder-ops-baseline',
  engine: 'bun',
  bench: 'tests/bench/holder-ops-cpu.mjs',
});
