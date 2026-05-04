#!/usr/bin/env bun
// W5 probe orchestrator. Runs functional → regression → e2e in order;
// halts on first failure. Writes a results summary to results-build.txt
// (post-build). Each probe is run as a child bun process so a global-
// state leak in one doesn't taint another.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = [
  ['functional', 'lru-shrink-restore.mjs'],
  ['functional', 'sqlite-nomem-retry.mjs'],
  ['functional', 'diag-shape.mjs'],
  ['functional', 'ring-persistence.mjs'],
  ['regression', 'fnv-counter-integrity.mjs'],
  ['regression', 'install-pipeline-coverage.mjs'],
  ['e2e',        'oom-stress.mjs'],
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
console.log(`# W5 probe summary`);
console.log(`========================================`);
const lines = [];
for (const r of results) {
  const flag = r.ok ? '✓' : '✗';
  const line = `${flag} ${r.bucket}/${r.file} (${r.ms}ms, exit=${r.code})`;
  console.log(line);
  lines.push(line);
}
console.log(allOk ? '\n# ALL GREEN' : '\n# FAILED');

// Persist a build report alongside the suite.
const target = path.join(HERE, allOk ? 'results-build.txt' : 'results-pending.txt');
fs.writeFileSync(
  target,
  '# W5 probe run @ ' + new Date().toISOString() + '\n' + lines.join('\n') + '\n' +
  (allOk ? '# all green\n' : '# not all green\n'),
);

process.exit(allOk ? 0 : 1);
