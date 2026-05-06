#!/usr/bin/env bun
// X5M v6: find the line in chunks/node.js that calls new URL with constants.ts.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.BASE) {
  console.error('Set BASE=http://127.0.0.1:8788');
  process.exit(2);
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'vite-url-stack6.txt');
fs.writeFileSync(ARTIFACT, '');

const PROBE_JS = `
const fs = require('fs');
const NODE = '/home/user/app/node_modules/vite/dist/node/chunks/node.js';
if (!fs.statSync(NODE)) { console.log('REINSTALL'); process.exit(0); }
const src = fs.readFileSync(NODE, 'utf8');
const lines = src.split('\\n');

// Search for the URL call with constants.ts arg.
console.log('===== MATCHES =====');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('constants.ts') || lines[i].includes('new URL')) {
    console.log((i+1).toString().padStart(5) + ': ' + lines[i].slice(0, 300));
  }
}
console.log('===== /MATCHES =====');

// Specific to constants.ts
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('constants.ts')) {
    console.log('CONST_HIT line ' + (i+1) + ':');
    for (let j = Math.max(0, i-3); j <= Math.min(lines.length-1, i+3); j++) {
      console.log((j+1).toString().padStart(5) + ': ' + lines[j].slice(0, 300));
    }
  }
}

// Print the precise context around line 144 (function slash) — does it have a top-level URL near it?
console.log('===== context around 144 =====');
for (let i = 100; i < 200 && i < lines.length; i++) {
  console.log((i+1).toString().padStart(5) + ': ' + lines[i].slice(0, 200));
}
`;

const id = 'vite_inv6_' + Date.now().toString(36);
const b64 = Buffer.from(PROBE_JS, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('vite-url-stack6', [
  { kind: 'cmd', cmd: 'cd app && npm install vite', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });
console.log('Wrote', ARTIFACT);
