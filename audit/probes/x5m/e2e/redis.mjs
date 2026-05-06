#!/usr/bin/env bun
// X5M e2e M-2: redis install + require.
//
// Pre-fix probe (verify-eb316dc): ⚠ "Cannot find module 'dns/promises'"
// M-2 charter pass: that specific error is gone. redis may still fail
// deeper for OTHER reasons unrelated to M-2.
// Full success: ✅ "keys: createClient,...".

import { runOnePkg } from './_x5m-driver.mjs';

const r = await runOnePkg({
  name: 'redis',
  pkg: 'redis',
  smoke: `const m=require('redis');console.log('keys:', Object.keys(m).slice(0,8).join(','));`,
  expectations: {
    success: 'keys:\\s*[a-zA-Z]',
    charterPass: '(?:Cannot find module|Cannot read properties|ENOENT)',
  },
  retries: 2,
});

console.log('FINAL_VERDICT:', r.verdict);
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = fs.readFileSync(path.join(HERE, 'redis.out.txt'), 'utf8');
if (/Cannot find module 'dns\/promises'/.test(out)) {
  console.log('M-2 CHARTER FAIL: dns/promises error still present');
  process.exit(1);
}
if (r.verdict.startsWith('✅') || r.verdict.startsWith('⚠')) {
  console.log('M-2 CHARTER PASS: dns/promises error eliminated');
  process.exit(0);
}
process.exit(1);
