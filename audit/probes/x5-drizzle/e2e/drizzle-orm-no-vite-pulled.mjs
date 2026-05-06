#!/usr/bin/env bun
// X.5-drizzle e2e — mechanism check.
//
// After `npm install drizzle-orm` in the starter, node_modules/vite
// must NOT exist. This locks in the *cause* of the fix: with
// frameworkAware=false (post-fix), the resolver's transitive walk
// hits `vite` in SKIP_PACKAGES and silent-skips it. If a future
// "fix" re-enables the cascade by another path, this probe trips.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'drizzle-orm-no-vite-pulled.out.txt');

if (!process.env.BASE) {
  console.error('FATAL: must set BASE=http://127.0.0.1:8789');
  process.exit(2);
}

fs.writeFileSync(ARTIFACT, '');
const checkJs = `const fs = require('fs');
const NM = '/home/user/app/node_modules';
const result = {
  vite: fs.existsSync(NM + '/vite'),
  lightningcss: fs.existsSync(NM + '/lightningcss'),
  drizzleOrm: fs.existsSync(NM + '/drizzle-orm'),
};
console.log('---NM-MAP---' + JSON.stringify(result) + '---END-NM-MAP---');`;
const id = `pkgsmoke_${Date.now().toString(36)}`;
const b64 = Buffer.from(checkJs, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

const r = await runProbe('x5-drizzle drizzle-orm-no-vite-pulled', [
  { kind: 'cmd', cmd: 'cd app && npm install drizzle-orm', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: ARTIFACT, settleMs: 3000 });

const txt = fs.readFileSync(ARTIFACT, 'utf8');
const m = txt.match(/---NM-MAP---(.+?)---END-NM-MAP---/);
let nmMap = null;
if (m) {
  try { nmMap = JSON.parse(m[1]); } catch {}
}

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else      { failed++; console.log(`  NOT OK  ${label}` + (detail ? ` — ${detail}` : '')); }
}

ok('probe ran', r.ok);
ok('install succeeded ("added N packages")', /added \d+ packages?/.test(txt));
ok('NM map captured', !!nmMap, `txt last 300 chars: ${txt.slice(-300)}`);
if (nmMap) {
  ok('node_modules/drizzle-orm exists', nmMap.drizzleOrm === true,
     'drizzle-orm itself must install — this is the user\\u2019s explicit request');
  ok('node_modules/vite does NOT exist (frameworkAware=false branch)',
     nmMap.vite === false,
     'vite materialized — the speculative pull-in is still firing.');
  ok('node_modules/lightningcss does NOT exist',
     nmMap.lightningcss === false,
     'lightningcss materialized — REJECT_INSTALL was bypassed?');
}

console.log('');
console.log(`# x5-drizzle drizzle-orm-no-vite-pulled: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
