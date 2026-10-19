#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';
import { CORE_CPU_SOURCES } from '../../tests/bench/lib/cpu-sources.mjs';

await remotePairedCpu({
  ...CORE_CPU_SOURCES,
  name: 'remote-run-capture-cpu',
  receipts: 'remote-run-capture-cpu',
  baselineDir: '.ci-run-capture-baseline',
  engine: 'bun',
  bench: 'tests/bench/run-capture-cpu.mjs',
});
