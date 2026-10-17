#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-process-list-cpu',
  receipts: 'remote-process-list-cpu',
  source: 'packages/core/src',
  baselineDir: '.ci-process-list-baseline',
  files: ['vfs/sqlite-vfs.ts', 'vfs/path.ts', 'vfs/composite.ts', 'vfs/sqlite-files.ts', 'runtime/process-files.ts', 'runtime/sqlite-runtime-fs-bridge.ts'],
  command: ['bun', 'tests/bench/process-list-cpu.mjs'],
});
