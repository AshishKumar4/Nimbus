#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';
import { HOLDER_CPU_SOURCES } from '../../tests/bench/lib/cpu-sources.mjs';

await remotePairedCpu({
  ...HOLDER_CPU_SOURCES,
  name: 'remote-holder-ops-cpu',
  receipts: 'remote-holder-ops-cpu',
  baselineDir: '.ci-holder-ops-baseline',
  command: ['bun', 'tests/bench/holder-ops-cpu.mjs'],
});
