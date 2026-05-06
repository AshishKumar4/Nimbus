#!/usr/bin/env bun
// X5M investigation v2: dump every line 144 from every loaded vite-tree
// module — and also enumerate top-level requires of the entry to find
// what gets loaded at line 84 of vite's index.js (which then loads the
// L144 module).

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.BASE) {
  console.error('Set BASE=http://127.0.0.1:8788');
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'vite-url-stack2.txt');
fs.writeFileSync(ARTIFACT, '');

const PROBE_JS = `
Error.stackTraceLimit = Infinity;
const path = require('path');
const fs = require('fs');

// 1. Print vite's index.js entirely (it's only ~15 lines, but might be longer than we counted).
const VITE_ENTRY = '/home/user/app/node_modules/vite/dist/node/index.js';
console.log('===== VITE_ENTRY =====');
const entry = fs.readFileSync(VITE_ENTRY, 'utf8');
console.log(entry);
console.log('===== /VITE_ENTRY =====');

// 2. Enumerate all .js/.cjs/.mjs files under the vite tree.
const VITE_ROOT = '/home/user/app/node_modules/vite';
function walk(d, out) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const p = d + '/' + e.name;
    if (e.isDirectory()) walk(p, out);
    else if (/\\.(c?js|mjs)$/.test(e.name)) out.push(p);
  }
}
const files = [];
walk(VITE_ROOT, files);
console.log('VITE_FILE_COUNT:', files.length);
for (const f of files) console.log('FILE:', f);

// 3. For files with > 144 lines, dump line 84 (where outer require fires) and
//    line 144 (the inner failure).
console.log('===== LINE_DUMP =====');
for (const f of files) {
  let s; try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const lines = s.split('\\n');
  if (lines.length < 84) continue;
  const rel = f.replace('/home/user/app/node_modules/', '');
  console.log('--- ' + rel + ' (' + lines.length + ' lines) ---');
  console.log('  L84:', JSON.stringify(lines[83]).slice(0, 250));
  if (lines.length >= 144) {
    console.log('  L144:', JSON.stringify(lines[143]).slice(0, 300));
    // Char around col 95
    if (lines[143] && lines[143].length > 80) {
      console.log('  L144[80..130]:', JSON.stringify(lines[143].slice(80, 130)));
    }
  }
}
console.log('===== /LINE_DUMP =====');

// 4. Now actually trigger the failure to confirm.
console.log('TRY_REQUIRE');
try {
  const m = require('vite');
  console.log('UNEXPECTED_SUCCESS');
} catch (e) {
  console.log('CONFIRMED_FAIL:', e.message);
}
`;

const id = 'vite_inv2_' + Date.now().toString(36);
const b64 = Buffer.from(PROBE_JS, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('vite-url-stack2', [
  // Reuse already-installed vite from previous probe by doing nothing here.
  { kind: 'cmd', cmd: 'cd app && npm install vite', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 60_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });
console.log('Wrote', ARTIFACT);
