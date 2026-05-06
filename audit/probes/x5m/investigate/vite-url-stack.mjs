#!/usr/bin/env bun
// X5M investigation: localize the vite "Invalid URL string." failure.
//
// The verify probe stack was:
//   TypeError: Invalid URL string.
//     at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:144:95)
//     at __loadModule (runner.js:2584:7)
//     at __requireFrom (runner.js:2664:10)
//     at scopedRequire (runner.js:2569:33)
//     at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:84:21)  ← outer
//     at __loadModule
//     at __requireFrom
//     at __require
//     at eval (runner.js:11:22, <anonymous>:3:9)        ← top-level user smoke
//     at NodeProcess.run (runner.js:2702:7)
//
// Two frames are user/vite eval — outer chain at 84:21 means the vite root
// module imported a child at line 84 which threw at 144:95.
//
// Strategy:
//   1. Install vite.
//   2. Resolve `require.resolve('vite')` to find the entry file the resolver picked.
//   3. Try-require it with stack trace limit unrolled, plus capture
//      the resolved entry-file path and a chunk of source around L144.
//   4. Also enumerate all CJS files under node_modules/vite — the actual
//      failing line is in *one* of them (line 144). Find which.
//
// Output: audit/probes/x5m/investigate/vite-url-stack.txt

import { runProbe, nodeEvalBase64 } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.BASE) {
  console.error('Set BASE=http://127.0.0.1:8788');
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'vite-url-stack.txt');
fs.writeFileSync(ARTIFACT, '');

const PROBE_JS = `
Error.stackTraceLimit = Infinity;
const path = require('path');
const fs = require('fs');

let viteEntry;
try { viteEntry = require.resolve('vite'); } catch (e) { console.log('RESOLVE_FAIL:', e.message); process.exit(0); }
console.log('RESOLVED_ENTRY:', viteEntry);

// Print the entry file's first 5 lines.
try {
  const src = fs.readFileSync(viteEntry, 'utf8');
  console.log('ENTRY_SIZE:', src.length);
  console.log('ENTRY_HEAD:');
  console.log(src.split('\\n').slice(0,15).join('\\n'));
} catch (e) { console.log('ENTRY_READ_FAIL:', e.message); }

// Walk node_modules/vite, find every .js/.cjs/.mjs file with > 144 lines, dump line 144.
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

// Now actually try to require vite and capture the full unrolled stack.
console.log('ABOUT_TO_REQUIRE');
try {
  const m = require('vite');
  console.log('SUCCESS keys:', Object.keys(m).slice(0,8));
} catch (e) {
  console.log('FAIL_MESSAGE:', e.message);
  console.log('FAIL_NAME:', e.name);
  console.log('FAIL_STACK_BEGIN');
  console.log(e.stack || '<no stack>');
  console.log('FAIL_STACK_END');

  // Try to find the source line. Stack frames look like
  // "eval (eval at <anonymous> (runner.js:34:34), <anonymous>:144:95)".
  // Each module loaded gets compiled with the file path interpolated, so
  // the actual file name should be in moduleCache or accessible via the
  // require trace. Without an inverse mapping, scan all loaded vite files
  // for one whose 144th line column 95 contains "URL".
  const sus = [];
  for (const f of files) {
    let s;
    try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = s.split('\\n');
    if (lines.length < 144) continue;
    const L144 = lines[143];
    if (!L144) continue;
    // Heuristic: lines containing 'new URL(' or 'pathToFileURL' near col 95
    if (/new URL\\(/.test(L144) || /pathToFileURL/.test(L144) || /URL\\(/.test(L144)) {
      sus.push({ file: f.replace(VITE_ROOT, '<vite>'), L144, col95Around: L144.slice(85, 130) });
    }
  }
  console.log('SUSPICIOUS_FILES_COUNT:', sus.length);
  for (const s of sus.slice(0, 10)) {
    console.log('---');
    console.log('FILE:', s.file);
    console.log('L144:', s.L144);
    console.log('AROUND_COL95:', s.col95Around);
  }
}
`;

const id = 'vite_inv_' + Date.now().toString(36);
const b64 = Buffer.from(PROBE_JS, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('vite-url-stack-investigate', [
  { kind: 'cmd', cmd: 'cd app && npm install vite', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 60_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });

console.log('Wrote', ARTIFACT);
