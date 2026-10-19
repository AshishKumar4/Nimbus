#!/usr/bin/env bun
// tests/bench/resident-read-cpu.mjs on armada, under node (V8, as workerd
// runs the guest): the branch's resident store reads against the baseline's.
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-resident-read-cpu',
  receipts: 'remote-resident-read-cpu',
  source: 'packages/worker/src',
  directories: ['vfs/resident'],
  files: ['vfs/facet-resident-limits.ts'],
  baselineDir: 'packages/worker/.ci-resident-read-baseline',
  command: ['node', 'tests/bench/resident-read-cpu.mjs'],
});
