#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-process-fs-client-cpu',
  receipts: 'remote-process-fs-client-cpu',
  baselineDir: '.ci-process-fs-client-baseline',
  engine: 'bun',
  bench: 'tests/bench/process-fs-client-cpu.mjs',
});
