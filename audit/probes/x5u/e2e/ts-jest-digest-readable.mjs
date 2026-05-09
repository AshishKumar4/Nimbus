#!/usr/bin/env bun
// X.5-U e2e — `npm install ts-jest` + require('ts-jest') against a real
// local wrangler dev. Verifies the runtime can fs.readFileSync the
// `.ts-jest-digest` and that ts-jest itself loads.
//
// PRE-FIX: smoke step throws ENOENT at runner.js readFileSync line 254
//          (X.5-T retro §3 evidence).
// POST-FIX: `typeof: object` printed; ts-jest module loaded.
//
// Usage:
//   BASE=http://127.0.0.1:8791 bun audit/probes/x5u/e2e/ts-jest-digest-readable.mjs

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'ts-jest-digest-readable.out.txt');

if (!process.env.BASE) {
  console.error('FATAL: must set BASE=http://127.0.0.1:8791 (or wherever wrangler dev is bound)');
  process.exit(2);
}
fs.writeFileSync(ARTIFACT, '');

// Same smoke shape as X.5-T's e2e but ALSO directly read the digest
// (so the failure surface — ENOENT — is unambiguous if the fix doesn't
// cover the dotfile).
const SMOKE = `
const fs = require('fs');
const path = require('path');
const digestPath = path.resolve('/home/user/app/node_modules/ts-jest/.ts-jest-digest');
let digest, requireOk;
try { digest = fs.readFileSync(digestPath, 'utf8').trim(); } catch (e) { digest = 'ERR:' + (e && e.code); }
try { const m = require('ts-jest'); requireOk = (typeof m); } catch (e) { requireOk = 'ERR:' + (e && e.message); }
console.log('X5U_DIGEST:', JSON.stringify(digest));
console.log('X5U_REQUIRE:', JSON.stringify(requireOk));
`.trim();
const b64 = Buffer.from(SMOKE, 'utf8').toString('base64');

const r = await runProbe('x5u ts-jest-digest-readable', [
  { kind: 'cmd', cmd: 'cd app && npm install ts-jest', timeoutMs: 180_000 },
  {
    kind: 'cmd',
    cmd: `node -e "require('fs').writeFileSync('/home/user/app/.x5u_e2e.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}' && cd /home/user/app && node .x5u_e2e.js`,
    timeoutMs: 30_000,
  },
], { artifactPath: ARTIFACT, settleMs: 3000 });

const txt = fs.readFileSync(ARTIFACT, 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`  NOT OK  ${label}` + (detail ? ` — ${detail}` : '')); }
}

ok('probe ran', r.ok);
ok('npm install completed', /added \d+ packages/.test(txt));
ok('NO `.native` regression (X.5-T sanity)',
  !txt.includes("Cannot read properties of undefined (reading 'native')"));
ok('NO ENOENT on .ts-jest-digest (X.5-U target)',
  !/ENOENT.*\.ts-jest-digest/.test(txt));
ok('digest read returns 40-char sha1 hex',
  /X5U_DIGEST:\s*"[0-9a-f]{40}"/.test(txt));
ok('require(\'ts-jest\') returns typeof object',
  /X5U_REQUIRE:\s*"object"/.test(txt));

console.log('');
console.log(`# x5u ts-jest-digest-readable: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
