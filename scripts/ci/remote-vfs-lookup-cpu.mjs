#!/usr/bin/env bun
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-vfs-lookup-cpu',
  receipts: 'remote-vfs-cpu',
  baselineDir: '.ci-vfs-baseline',
  engine: 'bun',
  bench: 'tests/bench/vfs-lookup-cpu.mjs',
});
