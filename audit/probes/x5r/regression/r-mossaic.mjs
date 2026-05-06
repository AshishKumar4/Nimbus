#!/usr/bin/env bun
// X.5-R regression — Mossaic prod-style smoke unaffected.
//
// Mossaic exercises a real-app workflow: clone + npm install + npm run
// dev + GET /preview/ + asset URL audit. None of this touches stream
// or events. Re-running it confirms the X.5-R surface change has zero
// blast radius beyond the redis cache.js failure mode.
//
// BASE must point to a live wrangler dev or prod deploy. Use:
//   BASE=http://127.0.0.1:8787 bun audit/probes/x5r/regression/r-mossaic.mjs
//
// If BASE not set OR not reachable, this records a SKIP (not a failure)
// since wave R isn't gating on this — it's a sanity guard that runs when
// possible.

import { spawnSync } from 'child_process';
import fs from 'node:fs';
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
  console.log('  SKIP  BASE not set — mossaic harness skipped');
  console.log('# r-mossaic: 0 passed, 0 failed (1 skipped)');
  process.exit(0);
}
if (unreachable(BASE)) {
  console.log(`  SKIP  ${BASE} unreachable — mossaic harness skipped`);
  console.log('# r-mossaic: 0 passed, 0 failed (1 skipped)');
  process.exit(0);
}

const r = spawnSync('bun',
  [path.join(ROOT, 'audit/probes/run-mossaic-prod-w2.mjs')],
  { encoding: 'utf8', env: { ...process.env, BASE }, timeout: 240_000 });

console.log((r.stdout || '').slice(-3000));
if (r.stderr) console.error(r.stderr.slice(-1500));
const ok = r.status === 0;
console.log(`  ${ok ? 'ok' : 'NOT OK'}  Mossaic harness exits 0`);
console.log(`# r-mossaic: ${ok ? 1 : 0} passed, ${ok ? 0 : 1} failed`);
process.exit(ok ? 0 : 1);
