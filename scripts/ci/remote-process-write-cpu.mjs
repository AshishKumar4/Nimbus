#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';
import { CORE_CPU_SOURCES } from '../../tests/bench/lib/cpu-sources.mjs';

await remotePairedCpu({
  ...CORE_CPU_SOURCES,
  name: 'remote-process-write-cpu',
  receipts: 'remote-process-write-cpu',
  baselineDir: '.ci-process-write-baseline',
  command: ['bun', 'tests/bench/process-write-cpu.mjs'],
});
