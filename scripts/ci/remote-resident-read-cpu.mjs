#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';
import { RESIDENT_CPU_SOURCES } from '../../tests/bench/lib/cpu-sources.mjs';

await remotePairedCpu({
  ...RESIDENT_CPU_SOURCES,
  name: 'remote-resident-read-cpu',
  receipts: 'remote-resident-read-cpu',
  baselineDir: '.ci-resident-read-baseline',
  command: ['bun', 'tests/bench/resident-read-cpu.mjs'],
});
