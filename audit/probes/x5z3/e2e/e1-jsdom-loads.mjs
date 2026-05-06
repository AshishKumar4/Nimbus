#!/usr/bin/env bun
// X.5-Z3 e2e — jsdom loads cleanly via local wrangler dev.
//
// This is the prompt's done-criterion: jsdom ✅ at real-package install
// layer.
//
// Pre-fix: RED. ENOENT on default-stylesheet.css (post-X5Z5 goalpost).
// Post-fix: GREEN. Object.keys(require('jsdom')) returns non-empty list.

import { runProbe } from '../../_driver.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'e1-jsdom-loads.out.txt');
fs.writeFileSync(OUT, '');

if (!process.env.BASE) {
  console.error('BASE must be set, e.g. BASE=http://127.0.0.1:8787');
  process.exit(2);
}

const id = `pkgsmoke_${Date.now().toString(36)}`;
const smoke = `try{const m=require('jsdom');console.log('JSDOM-OK keys:',Object.keys(m).slice(0,8));}catch(e){console.log('JSDOM-FAIL:',e.message);}`;
const b64 = Buffer.from(smoke, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('e1-jsdom-loads', [
  { kind: 'cmd', cmd: `cd app && npm install jsdom`, timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: OUT, settleMs: 3000 });

const out = fs.readFileSync(OUT, 'utf8');
const ok = out.includes('JSDOM-OK keys:');
const fail = out.includes('JSDOM-FAIL:');

console.log('JSDOM-OK present:', ok);
console.log('JSDOM-FAIL present:', fail);
console.log('verbatim default-stylesheet ENOENT present:',
  out.includes("ENOENT: no such file or directory, open '/home/user/app/node_modules/jsdom/lib/jsdom/browser/default-stylesheet.css'"));
console.log('output:', OUT);
process.exit(ok && !fail ? 0 : 1);
