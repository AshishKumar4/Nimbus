#!/usr/bin/env bun
// tests/bench/node-workspace-fs-cpu.mjs on armada, under node (V8, as workerd
// runs it): lifo's node end to end in a core-only workspace, the branch's
// built core against the baseline's.
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-node-workspace-fs-cpu',
  receipts: 'remote-node-workspace-fs-cpu',
  baselineDir: '.ci-node-workspace-fs-baseline',
  engine: 'node',
  bench: 'tests/bench/node-workspace-fs-cpu.mjs',
});
