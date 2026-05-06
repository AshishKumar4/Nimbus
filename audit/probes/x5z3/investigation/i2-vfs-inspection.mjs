#!/usr/bin/env bun
// Phase A — inspect VFS state after `npm install jsdom`.

import { runProbe } from '../../_driver.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'i2-vfs-inspection.out.txt');
fs.writeFileSync(OUT, '');

// Helper: write a node script via base64 then run it, like the harness pattern.
function nodeScript(label, src) {
  const id = `inv_${label}_${Date.now().toString(36)}`;
  const b64 = Buffer.from(src, 'utf8').toString('base64');
  const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
  const runCmd = `cd /home/user/app && node .${id}.js`;
  return `${writeCmd} && ${runCmd}`;
}

await runProbe('i2-vfs-inspection', [
  { kind: 'cmd', cmd: `cd app && npm install jsdom`, timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `ls node_modules/jsdom/lib/jsdom/browser/`, timeoutMs: 8000 },
  { kind: 'cmd', cmd: `ls node_modules/@csstools/css-tokenizer/dist/`, timeoutMs: 8000 },
  // Test css-tokenizer directly
  { kind: 'cmd', cmd: nodeScript('a', `try{const m=require('@csstools/css-tokenizer');console.log('CT-OK keys:',Object.keys(m).slice(0,5));}catch(e){console.log('CT-FAIL:',e.message);}`), timeoutMs: 15000 },
  // Test reading the .css file directly
  { kind: 'cmd', cmd: nodeScript('b', `try{const c=require('fs').readFileSync('/home/user/app/node_modules/jsdom/lib/jsdom/browser/default-stylesheet.css','utf8');console.log('CSS-OK len:',c.length);}catch(e){console.log('CSS-FAIL:',e.message);}`), timeoutMs: 15000 },
  // Test reading via relative path resolved from jsdom dir
  { kind: 'cmd', cmd: nodeScript('c', `try{const c=require('fs').readFileSync('node_modules/jsdom/lib/jsdom/browser/default-stylesheet.css','utf8');console.log('CSS2-OK len:',c.length);}catch(e){console.log('CSS2-FAIL:',e.message);}`), timeoutMs: 15000 },
  // List install batched files via fs.readdirSync
  { kind: 'cmd', cmd: nodeScript('d', `try{const ls=require('fs').readdirSync('/home/user/app/node_modules/jsdom/lib/jsdom/browser');console.log('JSDOM-DIR:',ls.join('|'));}catch(e){console.log('JSDOM-DIR-FAIL:',e.message);}`), timeoutMs: 15000 },
], { artifactPath: OUT, settleMs: 3000 });

console.log('out:', OUT);
