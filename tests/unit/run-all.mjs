#!/usr/bin/env bun
// tests/unit/run-all — sequential unit-test runner.
//
// Discovers every top-level tests/unit/*.mjs (no subdirectories — helpers
// live in tests/unit/lib/ and share the `_` convention), runs each with
// `bun <file>`, prints PASS/FAIL + elapsed per file, and exits non-zero if
// any file failed. There is no BASE and no retry: a unit test is hermetic,
// so a crash or an assertion is the same verdict — the file failed.
//
// Selection mirrors the behavioral runner:
//   NIMBUS_UNIT_ONLY  — comma-separated names (leaf or path) to run.
//   NIMBUS_UNIT_SKIP  — comma-separated names to skip.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function isUnitFile(leaf) {
  if (!leaf.endsWith('.mjs')) return false;
  if (leaf.startsWith('_')) return false;       // helpers
  if (leaf === 'run-all.mjs') return false;     // the runner itself
  return true;
}

const FILES = readdirSync(__dirname, { withFileTypes: true })
  .filter((ent) => ent.isFile() && isUnitFile(ent.name))
  .map((ent) => ent.name)
  .sort((a, b) => a.localeCompare(b));

const only = (process.env.NIMBUS_UNIT_ONLY || '').split(',').filter(Boolean);
const skip = new Set((process.env.NIMBUS_UNIT_SKIP || '').split(',').filter(Boolean));

function matchAny(collection, name) {
  const leaf = name.replace(/\.mjs$/, '');
  if (Array.isArray(collection)) return collection.includes(name) || collection.includes(leaf);
  return collection.has(name) || collection.has(leaf);
}

const targets = FILES.filter((name) => {
  if (only.length > 0 && !matchAny(only, name)) return false;
  if (skip.size > 0 && matchAny(skip, name)) return false;
  return true;
});

console.log(`unit/run-all — ${targets.length} file${targets.length === 1 ? '' : 's'} discovered`);

/** Spawn one test file; collect stdout/stderr/exit. Pure I/O. */
function runOnce(path) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr, elapsedMs: Date.now() - t0 }));
    child.on('error', (e) => resolve({ ok: false, stdout, stderr: String(e?.message || e), elapsedMs: Date.now() - t0 }));
  });
}

const results = [];
const t0 = Date.now();
for (const name of targets) {
  const path = join(__dirname, name);
  process.stdout.write(`[${name}] ... `);
  const r = await runOnce(path);
  const elapsedS = (r.elapsedMs / 1000).toFixed(1);
  console.log(`${r.ok ? 'PASS' : 'FAIL'} (${elapsedS}s)`);
  if (!r.ok) {
    const stderrLines = r.stderr
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() && !/^Bun v\d+\.\d+\.\d+ \([^)]+\)$/.test(l));
    for (const l of stderrLines.slice(-4)) console.log('    stderr: ' + l);
  }
  results.push({ name, ok: r.ok, elapsed: Number(elapsedS) });
}

const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log('');
console.log(`unit/run-all — ${pass} pass / ${fail} fail in ${totalElapsed}s`);
if (fail > 0) {
  for (const r of results.filter((r) => !r.ok)) console.log(`  FAIL ${r.name}`);
  process.exit(1);
}
