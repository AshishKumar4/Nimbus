#!/usr/bin/env bun
// X.5-Z3 e2e — deeper jsdom smoke: instantiate JSDOM and parse a tiny
// HTML doc. Confirms the .css load isn't merely silenced by a try/catch
// somewhere; it's actually consumed.

import { runProbe } from '../../_driver.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'e2-jsdom-window.out.txt');
fs.writeFileSync(OUT, '');

if (!process.env.BASE) {
  console.error('BASE must be set, e.g. BASE=http://127.0.0.1:8787');
  process.exit(2);
}

const id = `pkgsmoke_${Date.now().toString(36)}`;
const smoke = `try{const {JSDOM}=require('jsdom');const dom=new JSDOM('<p id="x">hello</p>');const el=dom.window.document.getElementById('x');console.log('JSDOM-WINDOW-OK textContent:',el && el.textContent);}catch(e){console.log('JSDOM-WINDOW-FAIL:',e.message);}`;
const b64 = Buffer.from(smoke, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('e2-jsdom-window', [
  { kind: 'cmd', cmd: `cd app && npm install jsdom`, timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 45_000 },
], { artifactPath: OUT, settleMs: 3000 });

const out = fs.readFileSync(OUT, 'utf8');
const ok = out.includes('JSDOM-WINDOW-OK textContent: hello');
const fail = out.includes('JSDOM-WINDOW-FAIL:');
console.log('JSDOM-WINDOW-OK present:', ok);
console.log('JSDOM-WINDOW-FAIL present:', fail);
console.log('output:', OUT);
process.exit(ok && !fail ? 0 : 1);
