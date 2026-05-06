#!/usr/bin/env bun
// X.5-drizzle e2e — after install, `require('drizzle-orm')` must
// load and report the expected key list (matches the verify-700420f
// + verify-90993b3 baseline transcript).
//
// PRE-FIX: install REJECT → require fails with "Cannot find module 'drizzle-orm'".
// POST-FIX: keys match ["ColumnAliasProxyHandler", "RelationTableAliasProxyHandler", ...]

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'drizzle-orm-smoke.out.txt');

if (!process.env.BASE) {
  console.error('FATAL: must set BASE=http://127.0.0.1:8789');
  process.exit(2);
}

fs.writeFileSync(ARTIFACT, '');
// Mirror verify-9d4b61d/run-packages-local.mjs pattern: write the smoke
// to /home/user/app/.<id>.js then `cd /home/user/app && node .<id>.js`
// so the require resolution lands on app/node_modules/drizzle-orm
// (NOT /tmp where nodeEvalBase64 lands).
const probeJs = `const m = require('drizzle-orm'); console.log('keys:', Object.keys(m).slice(0, 8));`;
const id = `pkgsmoke_${Date.now().toString(36)}`;
const b64 = Buffer.from(probeJs, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;
const r = await runProbe('x5-drizzle drizzle-orm-smoke', [
  { kind: 'cmd', cmd: 'cd app && npm install drizzle-orm', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: ARTIFACT, settleMs: 3000 });

const txt = fs.readFileSync(ARTIFACT, 'utf8');

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else      { failed++; console.log(`  NOT OK  ${label}` + (detail ? ` — ${detail}` : '')); }
}

ok('probe ran', r.ok);
ok('install succeeded ("added N packages")', /added \d+ packages?/.test(txt));
ok('NO "Cannot find module \'drizzle-orm\'"', !/Cannot find module 'drizzle-orm'/.test(txt));
ok('keys output present', /keys:\s*\[/.test(txt),
   `last 400 chars: ${txt.slice(-400)}`);
ok('keys list contains ColumnAliasProxyHandler', /ColumnAliasProxyHandler/.test(txt));
ok('keys list contains TableAliasProxyHandler', /TableAliasProxyHandler/.test(txt));

console.log('');
console.log(`# x5-drizzle drizzle-orm-smoke: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
