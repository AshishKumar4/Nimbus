#!/usr/bin/env bun
// W6.5 probe orchestrator. Mirrors W6's pattern.
//
// Each probe runs as a child `bun` process so global-state leaks
// don't taint others. Halts non-zero on any failure; finishes the
// full sweep first.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SUITE = [
  // Functional (pure-unit; no network)
  ['functional', 'registry-shape-w6.5.mjs'],
  ['functional', 'applySwaps-pure-no-emit.mjs'],
  ['functional', 'event-emit-shape.mjs'],
  ['functional', 'sink-injection.mjs'],
  ['functional', 'sink-isolation.mjs'],
  ['functional', 'reject-message-quality.mjs'],
  ['functional', 'preamble-parity-w6.5.mjs'],
  ['functional', 'sharp-wasm32-rejected.mjs'],
  ['functional', 'napi-rs-canvas-wasi-rejected.mjs'],

  // Regression
  ['regression', 'transitive-swap-decision-rule.mjs'],
  ['regression', 'resolver-paths-symmetric-w6.5.mjs'],
  ['regression', 'event-fires-on-swap-supervisor.mjs'],
  ['regression', 'event-fires-on-reject-supervisor.mjs'],
  ['regression', 'event-fires-on-bfs-resolver.mjs'],
  ['regression', 'event-fires-from-facet.mjs'],
  ['regression', 'summary-honesty.mjs'],

  // E2E
  ['e2e', 'default-sink-emits-jsonl.mjs'],
  // wrangler-import-each-new-swap.mjs is omitted: zero new SWAPs ship in W6.5
  // (per spike verdicts). When a future wave adds a swap, re-add this entry.
];

const results = [];
let allOk = true;

for (const [bucket, file] of SUITE) {
  const probe = path.join(HERE, bucket, file);
  console.log(`\n========================================`);
  console.log(`# Running ${bucket}/${file}`);
  console.log(`========================================`);
  const t0 = Date.now();
  const r = spawnSync('bun', [probe], {
    stdio: 'inherit',
    cwd: path.resolve(HERE, '..', '..', '..'),
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ bucket, file, ok, ms, code: r.status });
  if (!ok) allOk = false;
}

console.log('\n========================================');
console.log('# W6.5 probe summary');
console.log('========================================');
for (const r of results) {
  const tag = r.ok ? 'OK ' : 'FAIL';
  console.log(`  [${tag}] ${r.bucket}/${r.file}  (${r.ms}ms, exit=${r.code})`);
}
console.log('');
console.log(allOk ? '# ALL W6.5 PROBES PASS' : '# SOME W6.5 PROBES FAILED');
process.exit(allOk ? 0 : 1);
