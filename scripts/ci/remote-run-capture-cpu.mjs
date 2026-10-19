#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-run-capture-cpu',
  receipts: 'remote-run-capture-cpu',
  baselineDir: '.ci-run-capture-baseline',
  engine: 'bun',
  bench: 'tests/bench/run-capture-cpu.mjs',
});
