#!/usr/bin/env bun
// X5M investigation v4: trigger the exact failure path, then dump the
// loaded module file source around line 144 with column 95 marker.
// Use install retry to deal with chunks/node.js non-determinism.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.BASE) {
  console.error('Set BASE=http://127.0.0.1:8788');
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'vite-url-stack4.txt');
fs.writeFileSync(ARTIFACT, '');

const PROBE_JS = `
const fs = require('fs');
const NODE = '/home/user/app/node_modules/vite/dist/node/chunks/node.js';

let exists = false;
try { fs.statSync(NODE); exists = true; } catch {}
console.log('NODE_EXISTS:', exists);

if (!exists) {
  // Re-install vite to force inclusion. Then re-check.
  console.log('NEED_REINSTALL — exiting; rerun probe');
  process.exit(0);
}

const src = fs.readFileSync(NODE, 'utf8');
const lines = src.split('\\n');
console.log('NODE_TOTAL_LINES:', lines.length);

console.log('===== L130..L160 =====');
for (let i = 129; i <= 159 && i < lines.length; i++) {
  const ln = lines[i] || '';
  console.log((i+1).toString().padStart(4) + ' (len ' + ln.length + '): ' + ln.slice(0, 250));
}
console.log('===== /L130..L160 =====');

const L = lines[143] || '';
console.log('L144_RAW:', JSON.stringify(L));
console.log('L144_LEN:', L.length);
if (L.length >= 95) {
  console.log('L144[80..120]:', JSON.stringify(L.slice(80, 120)));
}

// Now actually trigger vite to confirm the failure stack matches.
console.log('TRY_REQUIRE');
try {
  const m = require('vite');
  console.log('UNEXPECTED_OK keys:', Object.keys(m).slice(0,8));
} catch (e) {
  console.log('FAIL:', e.message);
  console.log(e.stack);
}
`;

const id = 'vite_inv4_' + Date.now().toString(36);
const b64 = Buffer.from(PROBE_JS, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('vite-url-stack4', [
  { kind: 'cmd', cmd: 'cd app && npm install vite', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });
console.log('Wrote', ARTIFACT);
