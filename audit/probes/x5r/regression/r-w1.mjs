#!/usr/bin/env bun
// X.5-R regression — Wave 1 prod-style smoke unaffected.
//
// W1 contract: /preview/ on a fresh starter-app session has zero
// external hosts. Wave R cannot influence URL resolution; this is
// a sanity guard.
//
// BASE must point to a live wrangler dev or prod deploy. SKIPs cleanly
// if BASE is missing/unreachable.

import { spawnSync } from 'child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const BASE = process.env.BASE;

function unreachable(b) {
  try {
    const r = spawnSync('curl', ['-sf', '-o', '/dev/null', '-w', '%{http_code}', '-m', '3', b + '/'],
      { encoding: 'utf8' });
    return !(r.stdout && /^[23]\d\d/.test(r.stdout.trim()));
  } catch { return true; }
}

if (!BASE) {
  console.log('  SKIP  BASE not set — w1 harness skipped');
  console.log('# r-w1: 0 passed, 0 failed (1 skipped)');
  process.exit(0);
}
if (unreachable(BASE)) {
  console.log(`  SKIP  ${BASE} unreachable — w1 harness skipped`);
  console.log('# r-w1: 0 passed, 0 failed (1 skipped)');
  process.exit(0);
}

const r = spawnSync('bun',
  [path.join(ROOT, 'audit/probes/run-wave1-regression-w2.mjs')],
  { encoding: 'utf8', env: { ...process.env, BASE }, timeout: 240_000 });

console.log((r.stdout || '').slice(-3000));
if (r.stderr) console.error(r.stderr.slice(-1500));
const ok = r.status === 0;
console.log(`  ${ok ? 'ok' : 'NOT OK'}  W1 harness exits 0`);
console.log(`# r-w1: ${ok ? 1 : 0} passed, ${ok ? 0 : 1} failed`);
process.exit(ok ? 0 : 1);
