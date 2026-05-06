#!/usr/bin/env bun
// X5M v7: streaming line-by-line search for the URL call site in node.js.
// Avoids reading the whole 32K-line file into memory.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.BASE) { console.error('Set BASE=http://127.0.0.1:8788'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'vite-url-stack7.txt');
fs.writeFileSync(ARTIFACT, '');

const PROBE_JS = `
const fs = require('fs');
const NODE = '/home/user/app/node_modules/vite/dist/node/chunks/node.js';
const { execSync } = require('child_process');

// Use grep -n. Don't readFileSync — too big for trivial parsing.
let out;
try {
  out = execSync('grep -nE "constants\\\\.ts|new URL\\\\(" ' + NODE + ' | head -50', { encoding: 'utf8' });
} catch (e) {
  console.log('GREP_FAIL:', e.message);
  out = '';
}
console.log('===== GREP RESULTS =====');
console.log(out);
console.log('===== /GREP =====');
`;

const id = 'vite_inv7_' + Date.now().toString(36);
const b64 = Buffer.from(PROBE_JS, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('vite-url-stack7', [
  { kind: 'cmd', cmd: 'cd app && npm install vite', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });
console.log('Wrote', ARTIFACT);
