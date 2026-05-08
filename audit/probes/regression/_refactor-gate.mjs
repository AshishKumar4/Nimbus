#!/usr/bin/env bun
// audit/probes/regression/_refactor-gate.mjs
//
// One-stop gate runner for every static-analysis refactor probe.
// Run after every refactor step before committing.
//
// Includes:
//   1. tsc --noEmit check (must produce exactly the 2 baseline errors)
//   2. rpc-method-set.mjs (every NimbusSession method survives)
//   3. init-cmd-set.mjs (every shell cmd registered)
//   4. exports-set.mjs (every named export from nimbus-session.ts present)
//
// Exit 0 = all gates green. Exit 1 = any gate red.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

let allGreen = true;

function run(label, cmd, args, opts = {}) {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'pipe', ...opts });
  const stdout = r.stdout?.toString() ?? '';
  const stderr = r.stderr?.toString() ?? '';
  if (stdout) console.log(stdout.trim());
  if (stderr) console.error(stderr.trim());
  if (r.status !== 0) {
    console.error(`!! ${label} FAIL (exit ${r.status})`);
    allGreen = false;
  } else {
    console.log(`✓ ${label}`);
  }
  return { status: r.status, stdout, stderr };
}

// 1. tsc --noEmit — tsc returns non-zero with errors; we INSPECT the
// errors instead of using exit code as the pass/fail signal.
console.log(`\n=== tsc --noEmit ===`);
const tscR = spawnSync('bun', ['x', 'tsc', '--noEmit'], { cwd: ROOT, stdio: 'pipe' });
const tscOut = (tscR.stdout?.toString() ?? '') + (tscR.stderr?.toString() ?? '');
const tscErrors = tscOut.split('\n').filter((l) => /error TS\d+:/.test(l));
const BASELINE_TSC_COUNT = 2;
if (tscErrors.length !== BASELINE_TSC_COUNT) {
  console.error(`!! tsc baseline drift: expected ${BASELINE_TSC_COUNT} errors, got ${tscErrors.length}`);
  console.error(tscErrors.join('\n'));
  allGreen = false;
} else {
  // Post-cleanup paths: esbuild-service.ts → src/runtime/,
  // nimbus-session-init.ts → src/session/init.ts. Match on basename
  // not directory so future moves don't churn this gate.
  const hasEsbuild = tscErrors.some((e) => e.includes('esbuild-service.ts') && e.includes('TS2307'));
  const hasSqliteVfs = tscErrors.some((e) =>
    /(nimbus-session(-init)?|session\/init)\.ts/.test(e) && e.includes('TS2345')
  );
  if (!hasEsbuild || !hasSqliteVfs) {
    console.error(`!! tsc errors changed shape (NOT the baseline pair)`);
    console.error(tscErrors.join('\n'));
    allGreen = false;
  } else {
    console.log(`✓ tsc baseline preserved (${tscErrors.length} known errors)`);
  }
}

// 2. rpc-method-set
run('rpc-method-set', 'bun', [path.join(HERE, 'rpc-method-set.mjs')]);

// 3. init-cmd-set
run('init-cmd-set', 'bun', [path.join(HERE, 'init-cmd-set.mjs')]);

// 4. exports-set
run('exports-set', 'bun', [path.join(HERE, 'exports-set.mjs')]);

console.log('');
if (allGreen) {
  console.log('=== REFACTOR GATE: ALL GREEN ===');
  process.exit(0);
} else {
  console.error('=== REFACTOR GATE: RED ===');
  process.exit(1);
}
