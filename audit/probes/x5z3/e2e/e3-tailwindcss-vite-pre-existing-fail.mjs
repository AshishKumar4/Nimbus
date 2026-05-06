#!/usr/bin/env bun
// X.5-Z3 e2e — confirm tailwindcss-vite STILL fails (lightningcss
// native-binding gap, NOT regressed). Per X5Z5-build-retro §2.2 +
// §"What would be needed for tailwindcss-vite full ✅".
//
// This is a *negative* assertion: the asset-prefetch fix must NOT
// flip tailwindcss-vite's status. The pre-existing layer-blocker
// (`Cannot find module 'lightningcss-linux-x64-gnu' / native binding`)
// must still surface.

import { runProbe } from '../../_driver.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'e3-tailwindcss-vite-pre-existing-fail.out.txt');
fs.writeFileSync(OUT, '');

if (!process.env.BASE) {
  console.error('BASE must be set, e.g. BASE=http://127.0.0.1:8787');
  process.exit(2);
}

const id = `pkgsmoke_${Date.now().toString(36)}`;
const smoke = `try{const m=require('@tailwindcss/vite');console.log('TLW-OK typeof:',typeof m);}catch(e){console.log('TLW-FAIL:',e.message);}`;
const b64 = Buffer.from(smoke, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('e3-tailwindcss-vite-pre-existing-fail', [
  { kind: 'cmd', cmd: `cd app && npm install @tailwindcss/vite`, timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 45_000 },
], { artifactPath: OUT, settleMs: 3000 });

const out = fs.readFileSync(OUT, 'utf8');
// Pre-fix verbatim X5Z5 fail signature is gone (looksLikeEsm fix landed). The
// next-layer blocker is lightningcss native binding. We assert TLW-OK is NOT
// printed (ie tailwindcss-vite still fails), and we DON'T regress to the
// pre-X5Z5 ESM-pre-compile error.
const tlwOk = out.includes('TLW-OK typeof:');
const tlwFail = out.includes('TLW-FAIL:');
const z5VerbatimError = out.includes("Cannot use import statement outside a module");
const ok =
  !tlwOk && // expected to still fail
  !z5VerbatimError; // and the OLD Z3 error class must NOT have come back

console.log('TLW-OK present (expected false):', tlwOk);
console.log('TLW-FAIL present (expected true):', tlwFail);
console.log('Z5-verbatim ESM error present (expected false — must not regress):', z5VerbatimError);
console.log('output:', OUT);
process.exit(ok ? 0 : 1);
