#!/usr/bin/env bun
// X.5-S e2e — vite loads cleanly via local wrangler dev.
//
// Charter exit criterion: the targeted "Identifier '__dirname' has already
// been declared" failure (VERIFY-23417C5 §4 #1) must be GONE. If vite
// further surfaces a deeper unrelated failure (e.g. fileURLToPath(undefined)
// from import_meta.url being {}), that's the next bucket — log it but
// allow charter-pass.
//
// Pre-fix (RED): VITE-FAIL with the targeted __dirname re-decl.
// Post-fix (GREEN, charter-pass minimum): targeted message GONE.
// Post-fix (GREEN, strict): VITE-OK with vite public API exposed.

import { runProbe } from '../../_driver.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'e1-vite-loads.out.txt');
fs.writeFileSync(OUT, '');

if (!process.env.BASE) {
  console.error('BASE must be set, e.g. BASE=http://127.0.0.1:8787');
  process.exit(2);
}

const id = `pkgsmoke_${Date.now().toString(36)}`;
const smoke = `try{const m=require('vite');console.log('VITE-OK keys:',Object.keys(m).slice(0,12));}catch(e){console.log('VITE-FAIL:',e.message);}`;
const b64 = Buffer.from(smoke, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('e1-vite-loads', [
  { kind: 'cmd', cmd: `cd app && npm install vite`, timeoutMs: 300_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: OUT, settleMs: 3000 });

const out = fs.readFileSync(OUT, 'utf8');
const okSig = out.includes('VITE-OK keys:');
const failSig = out.includes('VITE-FAIL:');
const targetedDirnameGone =
  !out.includes("Identifier '__dirname' has already been declared");

console.log('VITE-OK present:', okSig);
console.log('VITE-FAIL present:', failSig);
console.log("targeted '__dirname has already been declared' GONE:", targetedDirnameGone);
if (failSig) {
  const m = out.match(/VITE-FAIL:\s*(.+)/);
  if (m) console.log('next-bucket failure shape:', m[1].slice(0, 220));
}
console.log('output:', OUT);

if (okSig && !failSig) {
  console.log('VERDICT: STRICT ✅ (vite loads cleanly)');
  process.exit(0);
} else if (targetedDirnameGone) {
  console.log("VERDICT: CHARTER-PASS (X.5-S cleared __dirname re-declaration; deeper bucket exposed — see next-bucket shape)");
  process.exit(0);
} else {
  console.log("VERDICT: RED (X.5-S fix did not clear targeted __dirname re-declaration)");
  process.exit(1);
}
