#!/usr/bin/env bun
// Phase A — reproduce jsdom failure verbatim against local wrangler dev,
// localize the failure to the bundle/transform/pre-compile boundary.
//
// Goal: confirm verbatim error matches VERIFY-700420F.md §4 #2 evidence:
//   "Cannot load module '...@csstools/css-tokenizer/dist/index.mjs':
//    pre-compile failed at facet startup: Unexpected token 'export'"

import { runProbe } from '../../_driver.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'i1-reproduce-jsdom.out.txt');
fs.writeFileSync(OUT, '');

const id = `pkgsmoke_${Date.now().toString(36)}`;
const smoke = `const m=require('jsdom');console.log('keys:',Object.keys(m).slice(0,8))`;
const b64 = Buffer.from(smoke, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('i1-reproduce-jsdom', [
  { kind: 'cmd', cmd: `cd app && npm install jsdom`, timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: OUT, settleMs: 3000 });

const out = fs.readFileSync(OUT, 'utf8');
const verbatim = "pre-compile failed at facet startup: Unexpected token 'export'";
const cssTokenizer = "@csstools/css-tokenizer/dist/index.mjs";
console.log('verbatim error present:', out.includes(verbatim));
console.log('css-tokenizer mentioned:', out.includes(cssTokenizer));
console.log('output written to:', OUT);
