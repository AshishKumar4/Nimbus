#!/usr/bin/env bun
// tests/bench/platform-write-cpu.mjs on armada, under node (V8, as workerd
// runs it): the branch's packages/platform/src against the baseline's.
import { remotePairedCpu } from './lib/paired-cpu.mjs';
import { PLATFORM_CPU_SOURCES } from '../../tests/bench/lib/cpu-sources.mjs';

await remotePairedCpu({
  ...PLATFORM_CPU_SOURCES,
  name: 'remote-platform-write-cpu',
  receipts: 'remote-platform-cpu',
  baselineDir: '.ci-platform-baseline',
  command: ['node', 'tests/bench/platform-write-cpu.mjs'],
});
