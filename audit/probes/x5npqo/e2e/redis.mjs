#!/usr/bin/env bun
// X.5-NPQO e2e P (redis): real `npm install redis` + require + createClient.
//
// Pre-fix (verify-90993b3): ⚠ "Cannot find module '.' (from .../@redis/client/dist/lib/client)"
// Post-fix expectation: ✅ "typeof object" (createClient succeeds).
// Charter pass: the "Cannot find module '.'" error is gone.

import { runOnePkg } from './_x5npqo-driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const r = await runOnePkg({
  name: 'redis',
  pkg: 'redis',
  smoke: `const m=require('redis');const c=m.createClient({url:'redis://127.0.0.1:6379'});console.log('typeof', typeof c);`,
  expectations: {
    success: 'typeof\\s+object',
    charterPass: '(?:Cannot find module|Cannot read properties|ENOENT)',
  },
  retries: 2,
});

console.log('FINAL_VERDICT:', r.verdict);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = fs.readFileSync(path.join(HERE, 'redis.out.txt'), 'utf8');

if (/Cannot find module ['"]\.['"](?!\.)/.test(out)) {
  console.log('P CHARTER FAIL: literal-"." module-not-found error still present');
  process.exit(1);
}
if (r.verdict.startsWith('✅')) {
  console.log('P STRICT PASS: redis ✅');
  process.exit(0);
}
if (r.verdict.startsWith('⚠')) {
  console.log('P CHARTER PASS: literal-"." error eliminated, deeper-fail acceptable');
  process.exit(0);
}
process.exit(1);
