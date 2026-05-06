#!/usr/bin/env bun
// X.5-T e2e — real-package `npm install ts-jest` against local wrangler
// dev, then `require('ts-jest')` smoke. Mirrors the verify-90993b3
// packages-local probe shape that captured the original RED stack.
//
// PRE-FIX: smoke step throws `TypeError: Cannot read properties of undefined (reading 'native')`
// at TypeScript getNodeSystem (typescript.js:8291).
// POST-FIX: smoke prints `typeof: object` and exits cleanly.
//
// Usage:
//   BASE=http://127.0.0.1:8790 bun audit/probes/x5t/e2e/ts-jest-real-install.mjs

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'ts-jest-real-install.out.txt');

if (!process.env.BASE) {
  console.error('FATAL: must set BASE=http://127.0.0.1:8790 (or wherever wrangler dev is bound)');
  process.exit(2);
}

fs.writeFileSync(ARTIFACT, '');

// Same shape as audit/probes/verify-90993b3/packages-local/ts-jest.probe.js
//   const m = require('ts-jest');
//   console.log('typeof:', typeof m);
const SMOKE = "const m=require('ts-jest');console.log('typeof:',typeof m)";
const b64 = Buffer.from(SMOKE, 'utf8').toString('base64');

const r = await runProbe('x5t ts-jest-real-install', [
  { kind: 'cmd', cmd: 'cd app && npm install ts-jest', timeoutMs: 180_000 },
  {
    kind: 'cmd',
    cmd: `node -e "require('fs').writeFileSync('/home/user/app/.x5t_smoke.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}' && cd /home/user/app && node .x5t_smoke.js`,
    timeoutMs: 30_000,
  },
], { artifactPath: ARTIFACT, settleMs: 3000 });

const txt = fs.readFileSync(ARTIFACT, 'utf8');

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    passed++; console.log(`  ok  ${label}`);
  } else {
    failed++; console.log(`  NOT OK  ${label}` + (detail ? ` — ${detail}` : ''));
  }
}

ok('probe ran (POST /new succeeded)', r.ok);
ok('npm install completed (output mentions "added" packages)',
  /added \d+ packages/.test(txt));
ok('NO `Cannot read properties of undefined (reading \'native\')` error',
  !txt.includes("Cannot read properties of undefined (reading 'native')"),
  'PRE-FIX baseline failure surface — should be GONE post-fix');
ok('NO TypeError at getNodeSystem',
  !/TypeError.*getNodeSystem/.test(txt),
  'PRE-FIX getNodeSystem stack — should be GONE post-fix');
ok('smoke output contains "typeof: object" (ts-jest exports loaded)',
  /typeof:\s*object/.test(txt),
  'ts-jest module load + typeof check should print object');

console.log('');
console.log(`# x5t ts-jest-real-install: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
