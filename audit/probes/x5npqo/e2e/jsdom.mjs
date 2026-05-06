#!/usr/bin/env bun
// X.5-NPQO e2e Q (jsdom): real `npm install jsdom` + require + new JSDOM.
//
// Pre-fix (verify-90993b3): ⚠ "Cannot find module 'node:util/types' (from .../undici/lib/web/fetch)"
// Post-fix expectation: ✅ "<title>"-style DOM construction success.
// Charter pass: the "node:util/types" error is gone.

import { runOnePkg } from './_x5npqo-driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const r = await runOnePkg({
  name: 'jsdom',
  pkg: 'jsdom',
  smoke: `const { JSDOM } = require('jsdom');const d = new JSDOM('<!DOCTYPE html><p>Hello</p>');console.log('text:', d.window.document.querySelector('p').textContent);`,
  expectations: {
    success: 'text:\\s*Hello',
    // Q charter pass = the node:util/types signature is gone. Acceptable
    // deeper failures include Bucket Z3 pre-compile ESM
    // (`Cannot load module … pre-compile failed … Unexpected token 'export'`)
    // — out of charter for X.5-Q.
    charterPass: '(?:Cannot find module|Cannot read properties|Cannot load module|TypeError|ENOENT|Unexpected token)',
  },
  retries: 2,
});

console.log('FINAL_VERDICT:', r.verdict);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = fs.readFileSync(path.join(HERE, 'jsdom.out.txt'), 'utf8');

if (/Cannot find module ['"]node:util\/types['"]/.test(out)) {
  console.log('Q CHARTER FAIL: node:util/types module-not-found error still present');
  process.exit(1);
}
if (/isUint8Array is not a function|isArrayBuffer is not a function/.test(out)) {
  console.log('Q CHARTER FAIL: util.types.<X> dereference fails (polyfill incomplete)');
  process.exit(1);
}
if (r.verdict.startsWith('✅')) {
  console.log('Q STRICT PASS: jsdom ✅');
  process.exit(0);
}
if (r.verdict.startsWith('⚠')) {
  console.log('Q CHARTER PASS: node:util/types error eliminated, deeper-fail acceptable');
  process.exit(0);
}
process.exit(1);
