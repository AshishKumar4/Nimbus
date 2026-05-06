#!/usr/bin/env bun
// X5M v8: streaming chunked grep — avoid loading 32K-line file into V8 heap.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.BASE) { console.error('Set BASE=http://127.0.0.1:8788'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'vite-url-stack8.txt');
fs.writeFileSync(ARTIFACT, '');

// Workerd doesn't have createReadStream — use byte-range reads.
const PROBE_JS = `
const fs = require('fs');
const NODE = '/home/user/app/node_modules/vite/dist/node/chunks/node.js';

const stat = fs.statSync(NODE);
console.log('FILE_SIZE:', stat.size);

const fd = fs.openSync(NODE, 'r');
const CHUNK = 256 * 1024;
let pos = 0;
let lineNo = 1;
let lineBuf = '';
let totalMatches = 0;

while (pos < stat.size && totalMatches < 30) {
  const buf = Buffer.alloc(Math.min(CHUNK, stat.size - pos));
  const n = fs.readSync(fd, buf, 0, buf.length, pos);
  if (n <= 0) break;
  pos += n;
  const txt = buf.slice(0, n).toString('utf8');
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (c === '\\n') {
      if (lineBuf.includes('constants.ts') || lineBuf.includes('new URL(')) {
        console.log('L' + lineNo + ' (col0..200): ' + lineBuf.slice(0, 250));
        totalMatches++;
        if (totalMatches >= 30) break;
      }
      lineBuf = '';
      lineNo++;
    } else {
      lineBuf += c;
    }
  }
}
fs.closeSync(fd);
console.log('TOTAL_MATCHES:', totalMatches);
console.log('TOTAL_LINES_SCANNED:', lineNo);
`;

const id = 'vite_inv8_' + Date.now().toString(36);
const b64 = Buffer.from(PROBE_JS, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('vite-url-stack8', [
  { kind: 'cmd', cmd: 'cd app && npm install vite', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 60_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });
console.log('Wrote', ARTIFACT);
