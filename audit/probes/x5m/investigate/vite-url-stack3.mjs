#!/usr/bin/env bun
// X5M investigation v3: dump full vite/dist/node/index.js (it's 84 lines)
// and vite/dist/node/chunks/node.js around line 144 with column ~95 highlighted.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.BASE) {
  console.error('Set BASE=http://127.0.0.1:8788');
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'vite-url-stack3.txt');
fs.writeFileSync(ARTIFACT, '');

const PROBE_JS = `
const fs = require('fs');
console.log('===== INDEX =====');
console.log(fs.readFileSync('/home/user/app/node_modules/vite/dist/node/index.js', 'utf8'));
console.log('===== /INDEX =====');

const NODE = '/home/user/app/node_modules/vite/dist/node/chunks/node.js';
const lines = fs.readFileSync(NODE, 'utf8').split('\\n');
console.log('===== node.js LINES 130..160 =====');
for (let i = 130; i <= 160 && i < lines.length; i++) {
  console.log((i+1).toString().padStart(4) + ': ' + lines[i]);
}
console.log('===== /LINES =====');
console.log('L144_LEN:', lines[143] ? lines[143].length : -1);
if (lines[143]) {
  // Print col-by-col around 90-105 for clarity
  const L = lines[143];
  console.log('L144_RAW:', JSON.stringify(L));
  console.log('L144[80..130]:', JSON.stringify(L.slice(80, 130)));
}
`;

const id = 'vite_inv3_' + Date.now().toString(36);
const b64 = Buffer.from(PROBE_JS, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('vite-url-stack3', [
  { kind: 'cmd', cmd: 'cd app && npm install vite', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });
console.log('Wrote', ARTIFACT);
