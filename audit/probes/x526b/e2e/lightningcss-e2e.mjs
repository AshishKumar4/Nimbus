#!/usr/bin/env bun
// X.5-26b e2e — `npm install lightningcss` must surface a loud REJECT.
//
// PRE-FIX: install succeeds (22 files), runtime fails with detect-libc
// `out.split is not a function`.
// POST-FIX: install rejected with `❌ lightningcss` line.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'lightningcss-e2e.out.txt');

if (!process.env.BASE) {
  console.error('FATAL: must set BASE=http://127.0.0.1:8789');
  process.exit(2);
}

fs.writeFileSync(ARTIFACT, '');
const r = await runProbe('x526b lightningcss-e2e', [
  { kind: 'cmd', cmd: 'cd app && npm install lightningcss', timeoutMs: 120_000 },
], { artifactPath: ARTIFACT, settleMs: 3000 });

const txt = fs.readFileSync(ARTIFACT, 'utf8');

let passed = 0;
let failed = 0;
function ok(label, cond) {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else      { failed++; console.log(`  NOT OK  ${label}`); }
}

ok('probe ran (POST /new succeeded)', r.ok);
ok('install output contains "❌ lightningcss"', txt.includes('❌ lightningcss'));
ok('install output mentions npm install rejected', /npm install rejected/i.test(txt));
ok('NO runtime "out.split is not a function" message', !txt.includes('out.split is not a function'));

console.log('');
console.log(`# x526b lightningcss-e2e: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
