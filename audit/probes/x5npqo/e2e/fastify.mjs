#!/usr/bin/env bun
// X.5-NPQO e2e P (fastify): real `npm install fastify` + require + create app.
//
// Pre-fix (verify-90993b3): ⚠ "Cannot find module '..' (from .../ajv/dist/compile/jtd)"
// Post-fix expectation: ✅ "keys: register,addHook,…" (full strict success).
// Charter pass: the "Cannot find module '..'" error is gone (deeper failure
// is acceptable but not desired).

import { runOnePkg } from './_x5npqo-driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const r = await runOnePkg({
  name: 'fastify',
  pkg: 'fastify',
  smoke: `const m=require('fastify');const a=m();console.log('keys:', Object.keys(a).slice(0,8).join(','));`,
  expectations: {
    success: 'keys:\\s*[a-zA-Z]',
    charterPass: '(?:Cannot find module|Cannot read properties|ENOENT)',
  },
  retries: 2,
});

console.log('FINAL_VERDICT:', r.verdict);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = fs.readFileSync(path.join(HERE, 'fastify.out.txt'), 'utf8');

if (/Cannot find module ['"]\.\.['"]/.test(out)) {
  console.log('P CHARTER FAIL: literal-".." module-not-found error still present');
  process.exit(1);
}
if (r.verdict.startsWith('✅')) {
  console.log('P STRICT PASS: fastify ✅');
  process.exit(0);
}
if (r.verdict.startsWith('⚠')) {
  console.log('P CHARTER PASS: literal-".." error eliminated, deeper-fail acceptable');
  process.exit(0);
}
process.exit(1);
