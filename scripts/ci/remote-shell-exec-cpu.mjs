#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';
import { LIFO_SHELL_CPU_SOURCES } from '../../tests/bench/lib/cpu-sources.mjs';

await remotePairedCpu({
  ...LIFO_SHELL_CPU_SOURCES,
  name: 'remote-shell-exec-cpu',
  receipts: 'remote-shell-exec-cpu',
  baselineDir: '.ci-shell-exec-baseline',
  command: ['bun', 'tests/bench/shell-exec-cpu.mjs'],
});
