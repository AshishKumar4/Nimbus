#!/usr/bin/env bun
// behavioral/run-all — run every behavioral probe sequentially, report
// pass/fail summary.
//
// Usage:
//   BASE=http://127.0.0.1:8792 bun tests/behavioral/run-all.mjs
//   BASE=https://nimbus.ashishkmr472.workers.dev bun tests/behavioral/run-all.mjs
//
// Optional env:
//   NIMBUS_PROBE_ONLY   — comma-separated probe names (e.g.
//                         "large-install,honest-install-message") to
//                         restrict the run; useful for quick re-checks.
//   NIMBUS_PROBE_SKIP   — comma-separated probe names to skip.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.BASE) {
  console.error('FATAL: BASE env required (e.g. BASE=http://127.0.0.1:8792)');
  process.exit(2);
}

const PROBES = readdirSync(__dirname)
  .filter((f) => f.endsWith('.mjs'))
  .filter((f) => f !== 'run-all.mjs' && f !== '_driver.mjs')
  .sort();

const only = (process.env.NIMBUS_PROBE_ONLY || '').split(',').filter(Boolean);
const skip = new Set((process.env.NIMBUS_PROBE_SKIP || '').split(',').filter(Boolean));

const targets = PROBES.filter((p) => {
  const name = p.replace(/\.mjs$/, '');
  if (only.length > 0 && !only.includes(name)) return false;
  if (skip.has(name)) return false;
  return true;
});

console.log(`behavioral/run-all — ${targets.length} probe${targets.length === 1 ? '' : 's'}`);
console.log(`BASE=${process.env.BASE}`);
console.log('');

const results = [];
const t0 = Date.now();

for (const probe of targets) {
  const probePath = join(__dirname, probe);
  process.stdout.write(`[${probe}] ... `);
  const subT0 = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [probePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (c) => {
      const elapsed = ((Date.now() - subT0) / 1000).toFixed(1);
      const ok = c === 0;
      console.log(`${ok ? 'PASS' : 'FAIL'} (${elapsed}s)`);
      if (!ok) {
        // Show failure detail
        const lines = stdout.split('\n').filter((l) => l.startsWith('  ✗') || l.includes('fail'));
        for (const l of lines.slice(-5)) console.log('    ' + l);
        if (stderr.trim()) console.log('    stderr: ' + stderr.split('\n').slice(-3).join(' | '));
      }
      results.push({ probe, ok, elapsed: Number(elapsed) });
      resolve(c);
    });
    child.on('error', (e) => {
      console.log(`ERROR ${e.message}`);
      results.push({ probe, ok: false, elapsed: 0 });
      resolve(1);
    });
  });
  void code;
}

const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;

console.log('');
console.log(`──── ${pass} pass / ${fail} fail (total ${totalElapsed}s)`);
process.exit(fail === 0 ? 0 : 1);
