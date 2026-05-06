#!/usr/bin/env bun
// X5M v9: small targeted probe — try byte-range reads using readFileSync with options.
// Check what fs methods are actually available, then read the file in 256K slabs
// looking for "constants.ts".

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.BASE) { console.error('Set BASE=http://127.0.0.1:8788'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'vite-url-stack9.txt');
fs.writeFileSync(ARTIFACT, '');

const PROBE_JS = `
const fs = require('fs');
console.log('fs methods:', Object.keys(fs).slice(0,30).join(','));
console.log('has openSync:', typeof fs.openSync);
console.log('has readFileSync:', typeof fs.readFileSync);

// Read in chunks via toString, but only read a small slice by passing position.
// Workerd's fs shim may have a non-standard API. Try Buffer.from with limit.
const NODE = '/home/user/app/node_modules/vite/dist/node/chunks/node.js';

// Just read the whole thing but use Buffer (not string) to avoid V8 string heap issues.
let buf;
try {
  buf = fs.readFileSync(NODE);  // returns Buffer
  console.log('READ_OK type:', typeof buf, 'isBuffer:', Buffer.isBuffer(buf), 'length:', buf.length || buf.byteLength);
} catch (e) {
  console.log('READ_FAIL:', e.message);
  process.exit(0);
}

// Convert sections to string, look for matches.
const SLICE = 64 * 1024;
const total = buf.byteLength;
let line = 1;
let lineStart = 0;
let pos = 0;
let matches = 0;

while (pos < total && matches < 30) {
  const end = Math.min(pos + SLICE, total);
  const txt = buf.subarray(pos, end).toString('utf8');
  for (let i = 0; i < txt.length; i++) {
    if (txt.charCodeAt(i) === 10) {
      // line ended; we don't have the whole line buffered, so this is approximate.
      // Better approach: scan for 'constants.ts' substrings directly across the buffer.
      line++;
    }
  }
  pos = end;
}
console.log('TOTAL_LINES:', line);

// Now find substring positions directly.
const txt = buf.toString('utf8');
const NEEDLE_A = 'constants.ts';
const NEEDLE_B = 'new URL(';
const NEEDLE_C = 'import.meta.url';
function findAll(s, needle) {
  const out = [];
  let p = 0;
  while (out.length < 30) {
    const i = s.indexOf(needle, p);
    if (i < 0) break;
    // line number = count of \\n before i + 1
    let lineNo = 1;
    for (let j = 0; j < i; j++) if (s.charCodeAt(j) === 10) lineNo++;
    // grab this line
    const lineStart = s.lastIndexOf('\\n', i) + 1;
    const lineEnd = s.indexOf('\\n', i);
    const ln = s.slice(lineStart, lineEnd === -1 ? s.length : lineEnd);
    out.push({ line: lineNo, col: i - lineStart + 1, text: ln });
    p = i + needle.length;
  }
  return out;
}

console.log('===== constants.ts hits =====');
for (const h of findAll(txt, NEEDLE_A)) console.log('L' + h.line + ':' + h.col + ' ' + h.text.slice(0, 250));
console.log('===== new URL( hits (first 20) =====');
for (const h of findAll(txt, NEEDLE_B).slice(0, 20)) console.log('L' + h.line + ':' + h.col + ' ' + h.text.slice(0, 250));
console.log('===== import.meta.url hits =====');
for (const h of findAll(txt, NEEDLE_C).slice(0, 10)) console.log('L' + h.line + ':' + h.col + ' ' + h.text.slice(0, 250));
`;

const id = 'vite_inv9_' + Date.now().toString(36);
const b64 = Buffer.from(PROBE_JS, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('vite-url-stack9', [
  { kind: 'cmd', cmd: 'cd app && npm install vite', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 60_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });
console.log('Wrote', ARTIFACT);
