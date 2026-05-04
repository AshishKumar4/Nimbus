#!/usr/bin/env bun
// W7 probe orchestrator. functional → regression → e2e.
// Each probe in its own bun process so a global-state leak doesn't taint.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = [
  ['functional', '01-frame-roundtrip.mjs'],
  ['functional', '02-large-payload.mjs'],
  ['functional', '03-backpressure.mjs'],
  ['functional', '04-cancel-mid-stream.mjs'],
  ['functional', '05-error-propagation.mjs'],
  ['functional', '06-empty-batches.mjs'],
  ['functional', '07-bytes-source-type.mjs'],
  ['functional', '08-writestream-on-vfs.mjs'],
  ['regression', 'install-pipeline-coverage.mjs'],
  ['regression', 'legacy-writeBatch-still-works.mjs'],
  ['regression', 'mossaic-shape.mjs'],
  ['regression', 'rpc-contracts-additive.mjs'],
  ['e2e', 'synthetic-50mb-tarball.mjs'],
  ['e2e', 'heap-peak-during-install.mjs'],
  ['e2e', 'install-batch-facet-streams.mjs'],
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
console.log(`# W7 probe summary`);
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
  '# W7 probe run @ ' + new Date().toISOString() + '\n' + lines.join('\n') + '\n' +
  (allOk ? '# all green\n' : '# not all green\n'),
);

process.exit(allOk ? 0 : 1);
