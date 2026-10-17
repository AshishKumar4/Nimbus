#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';
import { CORE_CPU_SOURCES } from '../../tests/bench/lib/cpu-sources.mjs';

await remotePairedCpu({
  ...CORE_CPU_SOURCES,
  name: 'remote-process-list-cpu',
  receipts: 'remote-process-list-cpu',
  baselineDir: '.ci-process-list-baseline',
  command: ['bun', 'tests/bench/process-list-cpu.mjs'],
});
