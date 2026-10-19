#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';
import { CORE_CPU_SOURCES } from '../../tests/bench/lib/cpu-sources.mjs';

await remotePairedCpu({
  ...CORE_CPU_SOURCES,
  name: 'remote-vfs-lookup-cpu',
  receipts: 'remote-vfs-cpu',
  baselineDir: '.ci-vfs-baseline',
  engine: 'bun',
  bench: 'tests/bench/vfs-lookup-cpu.mjs',
});
