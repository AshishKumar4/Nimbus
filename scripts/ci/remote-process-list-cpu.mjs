#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-process-list-cpu',
  receipts: 'remote-process-list-cpu',
  baselineDir: '.ci-process-list-baseline',
  engine: 'bun',
  bench: 'tests/bench/process-list-cpu.mjs',
});
