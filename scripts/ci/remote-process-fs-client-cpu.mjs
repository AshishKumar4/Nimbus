#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';
import { HOLDER_CPU_SOURCES } from '../../tests/bench/lib/cpu-sources.mjs';

await remotePairedCpu({
  ...HOLDER_CPU_SOURCES,
  name: 'remote-process-fs-client-cpu',
  receipts: 'remote-process-fs-client-cpu',
  baselineDir: '.ci-process-fs-client-baseline',
  engine: 'bun',
  bench: 'tests/bench/process-fs-client-cpu.mjs',
});
