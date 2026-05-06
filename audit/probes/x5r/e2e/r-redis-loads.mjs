#!/usr/bin/env bun
// X.5-R e2e — redis loads at the package layer.
//
// Mirrors the verify-700420f probe shape (npm install redis +
// `node -e "const m=require('redis'); console.log('keys:', Object.keys(m).slice(0,8))"`).
// Drives a live nimbus session via the WS driver.
//
// PRE-FIX (RED): exits 1 with `Class extends value undefined is not a constructor or null`.
// POST-FIX (GREEN): exits 0; stdout contains `keys:`.
//
// Requires BASE=http://127.0.0.1:8787 (or a live deploy).

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'r-redis-loads.txt');
fs.writeFileSync(ARTIFACT, '');

if (!process.env.BASE) {
  console.error('FATAL: BASE not set (e.g. BASE=http://127.0.0.1:8787)');
  process.exit(2);
}

const smoke = "const m=require('redis');console.log('keys:',Object.keys(m).slice(0,8))";
const id = `r_redis_${Date.now().toString(36)}`;
const b64 = Buffer.from(smoke, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('r-redis-loads', [
  { kind: 'cmd', cmd: 'cd app && npm install redis', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: ARTIFACT });

const out = fs.readFileSync(ARTIFACT, 'utf8');
const exitedZero = /Process \d+ \(node \/home\/user\/app\/\.r_redis_[a-z0-9]+\.js\) exited with code 0/.test(out);
const sawKeys = /keys:\s*\[/.test(out);
const sawClassExtendsUndef = /Class extends value undefined/.test(out);

console.log('');
console.log(`  ${exitedZero ? 'ok' : 'NOT OK'}  redis smoke exits 0`);
console.log(`  ${sawKeys ? 'ok' : 'NOT OK'}  redis smoke prints "keys: [...]"`);
console.log(`  ${!sawClassExtendsUndef ? 'ok' : 'NOT OK'}  no "Class extends value undefined" error in transcript`);
console.log('');
const passed = (exitedZero ? 1 : 0) + (sawKeys ? 1 : 0) + (!sawClassExtendsUndef ? 1 : 0);
const failed = 3 - passed;
console.log(`# r-redis-loads: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
