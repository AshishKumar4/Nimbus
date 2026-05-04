#!/usr/bin/env bun
// W8 probe orchestrator. functional → regression → e2e.
// Each probe in its own bun process so a global-state leak doesn't taint.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = [
  // Functional: state-machine + IPC contract + shim shape
  ['functional', 'spawn-echo-stdout.mjs'],
  ['functional', 'spawn-exit-codes.mjs'],
  ['functional', 'stdin-pipe.mjs'],
  ['functional', 'kill-sigterm.mjs'],
  ['functional', 'split-streams.mjs'],
  ['functional', 'incremental-read.mjs'],
  ['functional', 'exit-idempotency.mjs'],
  ['functional', 'env-propagation.mjs'],
  ['functional', 'log-store-integration.mjs'],
  ['functional', 'cp-spawn-emitter.mjs'],
  ['functional', 'cp-exec-callback.mjs'],
  ['functional', 'cp-spawn-sync.mjs'],
  ['functional', 'cp-fork-ipc.mjs'],
  ['functional', 'cp-stdio-streams.mjs'],
  ['functional', 'cp-execfile.mjs'],
  // Regression: don't break anything else
  ['regression', 'install-pipeline-coverage.mjs'],
  ['regression', 'node-shims-builtins-shape.mjs'],
  // E2E: real-package shape replays
  ['e2e', 'postinstall-success-rate.mjs'],
  ['e2e', 'concurrently-two-echo.mjs'],
  ['e2e', 'cross-spawn-shape.mjs'],
  ['e2e', 'spawn-unawaited-exit.mjs'],
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
console.log(`# W8 probe summary`);
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
  '# W8 probe run @ ' + new Date().toISOString() + '\n' + lines.join('\n') + '\n' +
  (allOk ? '# all green\n' : '# not all green\n'),
);

process.exit(allOk ? 0 : 1);
