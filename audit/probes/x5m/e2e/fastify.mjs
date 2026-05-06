#!/usr/bin/env bun
// X5M e2e M-1: fastify install + require + create app.
//
// Pre-fix probe (verify-eb316dc): ⚠ "server.setTimeout is not a function"
// M-1 charter pass: that specific error is gone. fastify may still fail
// deeper for OTHER reasons unrelated to M-1 — those are out-of-charter
// resolver gaps (e.g. ajv's require("..") parent-dir resolution).
// Full success: ✅ "keys: register,addHook,...".

import { runOnePkg } from './_x5m-driver.mjs';

const r = await runOnePkg({
  name: 'fastify',
  pkg: 'fastify',
  smoke: `const m=require('fastify');const a=m();console.log('keys:', Object.keys(a).slice(0,8).join(','));`,
  expectations: {
    success: 'keys:\\s*[a-zA-Z]',
    // Charter pass = setTimeout is gone, fastify progresses to a different error.
    charterPass: '(?:Cannot find module|Cannot read properties|ENOENT)',
  },
  retries: 2,
});

console.log('FINAL_VERDICT:', r.verdict);
// M-1 done if the setTimeout error is gone — anything else acceptable for charter
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = fs.readFileSync(path.join(HERE, 'fastify.out.txt'), 'utf8');
if (/server\.setTimeout is not a function/.test(out)) {
  console.log('M-1 CHARTER FAIL: setTimeout error still present');
  process.exit(1);
}
if (r.verdict.startsWith('✅') || r.verdict.startsWith('⚠')) {
  console.log('M-1 CHARTER PASS: setTimeout error eliminated');
  process.exit(0);
}
process.exit(1);
