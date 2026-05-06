#!/usr/bin/env bun
// X.5-R e2e — minimal reproducer of redis cache.js failure mode in isolation.
//
// Synthesises the smallest possible CJS module that triggers the
// `Class extends value undefined` error against `__streamMod.EventEmitter`:
//
//   const stream = require("stream");
//   class X extends stream.EventEmitter {}
//   module.exports = X;
//
// Does NOT install redis — exercises the shim surface directly so the
// probe is fast and deterministic. Useful as a Phase E build-flip
// canary independent of npm install dynamics.
//
// PRE-FIX (RED): exits 1, "Class extends value undefined".
// POST-FIX (GREEN): exits 0; stdout contains `ok:CSCP`.

import { runProbe, nodeEvalBase64 } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'r-cache-class-extends.txt');
fs.writeFileSync(ARTIFACT, '');

if (!process.env.BASE) {
  console.error('FATAL: BASE not set');
  process.exit(2);
}

const smoke =
  "const stream = require('stream');\n" +
  "class CSCP extends stream.EventEmitter {}\n" +
  "const inst = new CSCP();\n" +
  "let got = null;\n" +
  "inst.on('ping', (v) => { got = v; });\n" +
  "inst.emit('ping', 42);\n" +
  "console.log('ok:' + CSCP.name + ':' + got);\n";

await runProbe('r-cache-class-extends', [
  { kind: 'cmd', cmd: nodeEvalBase64(smoke), timeoutMs: 30_000 },
], { artifactPath: ARTIFACT });

const out = fs.readFileSync(ARTIFACT, 'utf8');
const sawOk = /ok:CSCP:42/.test(out);
const sawClassExtendsUndef = /Class extends value undefined|superclass is not a constructor/.test(out);
const exitedZero = /exited with code 0/.test(out);

console.log('');
console.log(`  ${sawOk ? 'ok' : 'NOT OK'}  saw "ok:CSCP:42" in stdout`);
console.log(`  ${!sawClassExtendsUndef ? 'ok' : 'NOT OK'}  no "Class extends value undefined" / "superclass is not a constructor"`);
console.log(`  ${exitedZero ? 'ok' : 'NOT OK'}  smoke exits 0`);
console.log('');
const passed = (sawOk ? 1 : 0) + (!sawClassExtendsUndef ? 1 : 0) + (exitedZero ? 1 : 0);
const failed = 3 - passed;
console.log(`# r-cache-class-extends: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
