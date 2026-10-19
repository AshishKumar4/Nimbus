#!/usr/bin/env bun
// tests/bench/module-syntax-cpu.mjs on armada, under node (V8, as workerd
// runs it): the branch's syntax detection against the baseline's.
import { remotePairedCpu } from './lib/paired-cpu.mjs';

await remotePairedCpu({
  name: 'remote-module-syntax-cpu',
  receipts: 'remote-module-syntax-cpu',
  source: 'packages/core/src',
  baselineDir: 'packages/core/.ci-syntax-baseline',
  files: ['runtime/javascript-ast.ts'],
  engine: 'node',
  // Its arms are bundled on their own (esbuild): bun runs it too, for context.
  engines: ['node', 'bun'],
  bench: 'tests/bench/module-syntax-cpu.mjs',
});
