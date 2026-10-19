#!/usr/bin/env bun
// tests/bench/resident-read-cpu.mjs on armada, under node (V8, as workerd
// runs the guest): the branch's resident store reads against the baseline's.
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-resident-read-cpu',
  receipts: 'remote-resident-read-cpu',
  baselineDir: '.ci-resident-read-baseline',
  engine: 'node',
  bench: 'tests/bench/resident-read-cpu.mjs',
});
