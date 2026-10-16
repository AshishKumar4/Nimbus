#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-vfs-lookup-cpu',
  receipts: 'remote-vfs-cpu',
  source: 'packages/core/src',
  baselineDir: '.ci-vfs-baseline',
  files: ['vfs/sqlite-vfs.ts', 'vfs/path.ts', 'vfs/composite.ts', 'vfs/sqlite-files.ts', 'runtime/process-files.ts', 'runtime/sqlite-runtime-fs-bridge.ts'],
  command: ['bun', 'tests/bench/vfs-lookup-cpu.mjs'],
});
