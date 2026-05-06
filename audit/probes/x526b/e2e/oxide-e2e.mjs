#!/usr/bin/env bun
// X.5-26b e2e — `npm install @tailwindcss/oxide` against local wrangler
// must surface a loud REJECT (`❌ @tailwindcss/oxide`) at install time.
//
// PRE-FIX: install succeeds (4 files), runtime fails with npm-4828.
// POST-FIX: install rejected with `❌ @tailwindcss/oxide` line; no
// runtime step needed.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'oxide-e2e.out.txt');

if (!process.env.BASE) {
  console.error('FATAL: must set BASE=http://127.0.0.1:8789 (or wherever wrangler is)');
  process.exit(2);
}

fs.writeFileSync(ARTIFACT, '');
const r = await runProbe('x526b oxide-e2e', [
  { kind: 'cmd', cmd: 'cd app && npm install @tailwindcss/oxide', timeoutMs: 120_000 },
], { artifactPath: ARTIFACT, settleMs: 3000 });

const txt = fs.readFileSync(ARTIFACT, 'utf8');

// Assertions:
let passed = 0;
let failed = 0;
function ok(label, cond) {
  if (cond) {
    passed++; console.log(`  ok  ${label}`);
  } else {
    failed++; console.log(`  NOT OK  ${label}`);
  }
}

ok('probe ran (POST /new succeeded)', r.ok);
ok('install output contains "❌ @tailwindcss/oxide"',
  txt.includes('❌ @tailwindcss/oxide'));
ok('install output mentions npm install rejected',
  /npm install rejected/i.test(txt));
ok('NO runtime "Cannot find native binding" message (since install rejected)',
  !txt.includes('Cannot find native binding'));

console.log('');
console.log(`# x526b oxide-e2e: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
