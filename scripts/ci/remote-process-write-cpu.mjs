#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-process-write-cpu',
  receipts: 'remote-process-write-cpu',
  baselineDir: '.ci-process-write-baseline',
  engine: 'bun',
  bench: 'tests/bench/process-write-cpu.mjs',
});
