#!/usr/bin/env bun
// X.5-R e2e — fastify still loads (regression guard for X.5-Z5's lazy-init).
//
// Per Phase A repro at HEAD a571079, fastify is already green; the
// X.5-Z5-build EE-shim mixin lazy-init merge healed avvio's
// Plugin.once('start', cb) path. We re-assert here so a future regression
// in stream/events shimming is caught at the bucket-R audit layer.
//
// Always GREEN (post-Z5).

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'r-fastify-still-loads.txt');
fs.writeFileSync(ARTIFACT, '');

if (!process.env.BASE) {
  console.error('FATAL: BASE not set');
  process.exit(2);
}

const smoke = "const m=require('fastify');const a=m();console.log('app title:',a.constructor && a.constructor.name)";
const id = `r_fastify_${Date.now().toString(36)}`;
const b64 = Buffer.from(smoke, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('r-fastify-still-loads', [
  { kind: 'cmd', cmd: 'cd app && npm install fastify', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: ARTIFACT });

const out = fs.readFileSync(ARTIFACT, 'utf8');
const exitedZero = /exited with code 0/.test(out);
const sawApp = /app title:/.test(out);
const sawCannotReadStart = /Cannot read properties of undefined \(reading 'start'\)/.test(out);

console.log('');
console.log(`  ${exitedZero ? 'ok' : 'NOT OK'}  fastify smoke exits 0`);
console.log(`  ${sawApp ? 'ok' : 'NOT OK'}  fastify smoke prints "app title:"`);
console.log(`  ${!sawCannotReadStart ? 'ok' : 'NOT OK'}  no avvio Plugin.on 'start' regression`);
console.log('');
const passed = (exitedZero ? 1 : 0) + (sawApp ? 1 : 0) + (!sawCannotReadStart ? 1 : 0);
const failed = 3 - passed;
console.log(`# r-fastify-still-loads: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
