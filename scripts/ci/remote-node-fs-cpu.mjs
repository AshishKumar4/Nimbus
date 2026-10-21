#!/usr/bin/env bun
// tests/bench/node-fs-cpu.mjs on armada: lifo's Node fs, the branch's against the baseline's.
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-node-fs-cpu',
  receipts: 'remote-node-fs-cpu',
  baselineDir: '.ci-node-fs-baseline',
  engine: 'bun',
  bench: 'tests/bench/node-fs-cpu.mjs',
});
