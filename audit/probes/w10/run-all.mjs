#!/usr/bin/env bun
// W10 probe orchestrator. functional → regression → e2e.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = [
  // Functional: KV
  ['functional', 'kv-put-get.mjs'],
  ['functional', 'kv-list-prefix.mjs'],
  ['functional', 'kv-delete.mjs'],
  ['functional', 'kv-ttl-expiration.mjs'],
  ['functional', 'kv-metadata-roundtrip.mjs'],
  ['functional', 'kv-cachettl-accepted-ignored.mjs'],
  // Functional: D1
  ['functional', 'd1-prepare-bind-run.mjs'],
  ['functional', 'd1-prepare-all.mjs'],
  ['functional', 'd1-batch.mjs'],
  ['functional', 'd1-exec.mjs'],
  ['functional', 'd1-table-prefix-isolation.mjs'],
  ['functional', 'd1-cte-and-trigger.mjs'],
  // Functional: R2
  ['functional', 'r2-put-get.mjs'],
  ['functional', 'r2-head.mjs'],
  ['functional', 'r2-list-prefix.mjs'],
  ['functional', 'r2-delete-single-and-array.mjs'],
  ['functional', 'r2-conditionals.mjs'],
  ['functional', 'r2-range-read.mjs'],
  ['functional', 'r2-etag-content-addressed.mjs'],
  ['functional', 'r2-multipart-throws.mjs'],
  // Functional: synthesis + detection
  ['functional', 'env-bindings-injection.mjs'],
  ['functional', 'project-type-detection.mjs'],
  // Regression
  ['regression', 'install-pipeline-coverage.mjs'],
  ['regression', 'nimbus-wrangler-existing-bindings-still-work.mjs'],
  ['regression', 'nimbus-paths-not-watched.mjs'],
  ['regression', 'hot-reload-latency.mjs'],
  // E2E (locally-runnable + prod-gated stubs)
  ['e2e', 'kv-roundtrip-e2e.mjs'],
  ['e2e', 'unsupported-fields-list-shrinks.mjs'],
  ['e2e', 'starter-worker-router.mjs'],
  ['e2e', 'starter-d1.mjs'],
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

console.log(`\n========================================`);
console.log(`# W10 probe summary`);
console.log(`========================================`);
const lines = [];
for (const r of results) {
  const flag = r.ok ? '✓' : '✗';
  const line = `${flag} ${r.bucket}/${r.file} (${r.ms}ms, exit=${r.code})`;
  console.log(line);
  lines.push(line);
}
console.log(allOk ? '\n# ALL GREEN' : '\n# FAILED');

const target = path.join(HERE, allOk ? 'results-build.txt' : 'results-pending.txt');
fs.writeFileSync(
  target,
  '# W10 probe run @ ' + new Date().toISOString() + '\n' + lines.join('\n') + '\n' +
  (allOk ? '# all green\n' : '# not all green\n'),
);

process.exit(allOk ? 0 : 1);
