#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-shell-exec-cpu',
  receipts: 'remote-shell-exec-cpu',
  baselineDir: '.ci-shell-exec-baseline',
  engine: 'bun',
  bench: 'tests/bench/shell-exec-cpu.mjs',
});
