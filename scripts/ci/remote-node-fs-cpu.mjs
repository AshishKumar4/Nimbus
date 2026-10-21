#!/usr/bin/env bun
// tests/bench/node-fs-cpu.mjs on armada, under node (V8, as workerd runs it):
// lifo's Node fs, the branch's against the baseline's.
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-node-fs-cpu',
  receipts: 'remote-node-fs-cpu',
  baselineDir: '.ci-node-fs-baseline',
  engine: 'node',
  // Its arms are bundled on their own (esbuild): bun runs it too, for context.
  engines: ['node', 'bun'],
  bench: 'tests/bench/node-fs-cpu.mjs',
});
