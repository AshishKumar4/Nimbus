#!/usr/bin/env bun
// behavioral/run-all — run every behavioral probe sequentially, report
// pass/fail summary.
//
// Usage:
//   BASE=http://127.0.0.1:8792 bun tests/behavioral/run-all.mjs
//   BASE=https://nimbus.ashishkmr472.workers.dev bun tests/behavioral/run-all.mjs
//
// Flags:
//   --no-retry     Disable retry-on-banner (CI-strict mode). Default
//                  is retry-once when the spawn crashes with a known
//                  runtime-crash banner.
//
// Optional env:
//   NIMBUS_PROBE_ONLY   — comma-separated probe names (e.g.
//                         "large-install,honest-install-message") to
//                         restrict the run; useful for quick re-checks.
//                         Match is against the relative path (without
//                         the .mjs extension), so "frameworks/astro-real"
//                         and "astro-real" both work.
//   NIMBUS_PROBE_SKIP   — comma-separated probe names to skip.
//   NIMBUS_RUNNER_NO_RETRY=1  — equivalent of `--no-retry` (CI use).
//
// Discovery: walks `tests/behavioral/` recursively. Skips:
//   - any file whose leaf basename starts with `_` (helpers like
//     `_driver.mjs`, `_runtime-behavioral-template.mjs`, `_fixtures.mjs`,
//     `_keys.mjs`, `_recipe.mjs`, `_diag.mjs`)
//   - any file named `run-all.mjs` (the root runner and the
//     `keybindings/run-all.mjs` sub-runner)
//   - non-`.mjs` files
//
// Retry-on-banner:
//   When a probe spawn exits non-zero AND stderr contains a known
//   runtime-crash banner (currently only `Bun v\d+\.\d+\.\d+ \(...\)`),
//   the runner retries the probe ONCE. The retry verdict is the final
//   verdict; the first crash is logged but not counted as FAIL.
//
//   Rationale: the bun runtime occasionally crashes when running our
//   probes (e.g. heap-correctness/diag-reports-pending-writes is ~40%
//   flaky with this banner). The crash is OUTSIDE the probe's control
//   — it's a hazard at the runtime layer, exactly the class of failure
//   where runner-level retry is correct. The retry happens in the
//   RUNNER (system infrastructure), not in probe assertion logic, per
//   the cleanup-audit CLN-4 charter clarification (network-resilience
//   / concurrency-hazard retries in system infrastructure ARE
//   permitted; agent-controlled assertion paths must not retry).
//
//   `--no-retry` disables this for CI diagnostic runs where the
//   operator wants to see flakes directly.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.BASE) {
  console.error('FATAL: BASE env required (e.g. BASE=http://127.0.0.1:8792)');
  process.exit(2);
}

const NO_RETRY = process.argv.includes('--no-retry')
  || process.env.NIMBUS_RUNNER_NO_RETRY === '1';

/**
 * Recursively walk `root`, yielding absolute paths of files whose
 * leaf basename satisfies `predicate`. Directories are walked in
 * sorted order so probe ordering is deterministic across platforms.
 */
function walk(root, predicate, out = []) {
  const entries = readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    const abs = join(root, ent.name);
    if (ent.isDirectory()) {
      walk(abs, predicate, out);
    } else if (ent.isFile() && predicate(ent.name)) {
      out.push(abs);
    }
  }
  return out;
}

function isProbeFile(leaf) {
  if (!leaf.endsWith('.mjs')) return false;
  if (leaf.startsWith('_')) return false;        // helpers
  if (leaf === 'run-all.mjs') return false;      // root + sub-runners
  return true;
}

const PROBES = walk(__dirname, isProbeFile)
  .map((abs) => relative(__dirname, abs));

const only = (process.env.NIMBUS_PROBE_ONLY || '').split(',').filter(Boolean);
const skip = new Set((process.env.NIMBUS_PROBE_SKIP || '').split(',').filter(Boolean));

function probeName(relPath) {
  // Strip .mjs; keep subdirectory prefix so operator can correlate
  // failures with files. Both forms accepted by NIMBUS_PROBE_ONLY /
  // NIMBUS_PROBE_SKIP: full ("frameworks/astro-real") and leaf ("astro-real").
  return relPath.replace(/\.mjs$/, '');
}

function matchAny(collection, relPath) {
  // collection: Array<string> or Set<string>. Match against either
  // the full relative path ("frameworks/astro-real") or the leaf
  // ("astro-real") so legacy NIMBUS_PROBE_ONLY values keep working.
  const full = probeName(relPath);
  const leaf = basename(relPath).replace(/\.mjs$/, '');
  if (Array.isArray(collection)) {
    return collection.includes(full) || collection.includes(leaf);
  }
  return collection.has(full) || collection.has(leaf);
}

const targets = PROBES.filter((p) => {
  if (only.length > 0 && !matchAny(only, p)) return false;
  if (skip.size > 0 && matchAny(skip, p)) return false;
  return true;
});

console.log(`behavioral/run-all — ${targets.length} probe${targets.length === 1 ? '' : 's'} discovered (recursive)`);
console.log(`BASE=${process.env.BASE}${NO_RETRY ? '  [--no-retry]' : ''}`);
console.log('');

/**
 * Known runtime-crash banners (stderr) that indicate the probe spawn
 * itself died, not the probe's assertions. Match → retry once.
 *
 * Currently only the bun runtime crash banner. Add new entries here
 * if other runtime crashes surface.
 */
const RETRYABLE_STDERR_PATTERNS = [
  /Bun v\d+\.\d+\.\d+ \([^)]+\)/,
];

function isRetryableCrash(stderr, exitCode) {
  if (exitCode === 0) return false;
  for (const pat of RETRYABLE_STDERR_PATTERNS) {
    if (pat.test(stderr)) return true;
  }
  return false;
}

/**
 * Spawn one probe; collect stdout/stderr/exit. Returns {ok, code,
 * stdout, stderr, elapsedMs}. Pure I/O — no decision making.
 */
function runProbeOnce(probePath) {
  return new Promise((resolve) => {
    const subT0 = Date.now();
    const child = spawn(process.execPath, [probePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      const elapsedMs = Date.now() - subT0;
      resolve({ ok: code === 0, code, stdout, stderr, elapsedMs });
    });
    child.on('error', (e) => {
      const elapsedMs = Date.now() - subT0;
      resolve({ ok: false, code: 1, stdout: '', stderr: String(e?.message || e), elapsedMs });
    });
  });
}

const results = [];
const t0 = Date.now();

for (const probe of targets) {
  const probePath = join(__dirname, probe);
  process.stdout.write(`[${probe}] ... `);

  let r = await runProbeOnce(probePath);
  let retried = false;

  if (!r.ok && !NO_RETRY && isRetryableCrash(r.stderr, r.code)) {
    // First attempt crashed on a known runtime banner. Retry once.
    process.stdout.write(`FLAKE (${(r.elapsedMs/1000).toFixed(1)}s) → retry... `);
    retried = true;
    r = await runProbeOnce(probePath);
  }

  const elapsedS = (r.elapsedMs / 1000).toFixed(1);
  console.log(`${r.ok ? 'PASS' : 'FAIL'} (${elapsedS}s)${retried ? ' [retried]' : ''}`);

  if (!r.ok) {
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('  ✗') || l.includes('fail'));
    for (const l of lines.slice(-5)) console.log('    ' + l);
    if (r.stderr.trim()) console.log('    stderr: ' + r.stderr.split('\n').slice(-3).join(' | '));
  }

  results.push({ probe, ok: r.ok, elapsed: Number(elapsedS), retried });
}

const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
const retries = results.filter((r) => r.retried).length;

console.log('');
console.log(`──── ${pass} pass / ${fail} fail${retries > 0 ? ` (${retries} retried)` : ''} (total ${totalElapsed}s)`);
if (fail > 0) {
  console.log('FAIL probes:');
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`  - ${r.probe}`);
  }
}
process.exit(fail === 0 ? 0 : 1);
