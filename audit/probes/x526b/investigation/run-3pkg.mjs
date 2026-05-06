#!/usr/bin/env bun
// X.5-26b investigation harness — reproduce ts-jest, tailwindcss-oxide,
// lightningcss with --stack-trace-limit=Infinity stacks, against local HEAD.
//
// Usage:
//   BASE=http://127.0.0.1:8787 bun audit/probes/x526b/investigation/run-3pkg.mjs

import { runProbe, runMany } from '../../_driver.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(HERE, { recursive: true });

if (!process.env.BASE) {
  console.error('FATAL: must set BASE=http://127.0.0.1:8787');
  process.exit(2);
}

// Each target: same install + smoke shape as VERIFY-23417C5 harness, but
// the smoke is wrapped in a try/catch that prints err.stack with full
// frames (Error.stackTraceLimit=Infinity) so we can pin the failure to
// a specific source line in the loaded module.
const TARGETS = [
  {
    name: 'ts-jest',
    pkg: 'ts-jest',
    smoke: `
Error.stackTraceLimit = Infinity;
try {
  const m = require('ts-jest');
  console.log('OK typeof:', typeof m);
} catch (e) {
  console.log('FAIL', e && e.constructor && e.constructor.name, e && e.message);
  console.log('---FULL STACK---');
  console.log((e && e.stack) || '(no stack)');
}
// Probe ts.sys availability separately to disambiguate "typescript fully
// loaded but realpathSync.native is undefined" from "typescript was
// evicted from bundle".
console.log('---TYPESCRIPT INTROSPECTION---');
try {
  const ts = require('typescript');
  console.log('typescript version:', ts.version);
  console.log('typescript.sys is:', typeof ts.sys);
} catch (e) {
  console.log('typescript require failed:', e && e.message);
}
`,
  },
  {
    name: 'tailwindcss-oxide',
    pkg: '@tailwindcss/oxide',
    smoke: `
Error.stackTraceLimit = Infinity;
try {
  const m = require('@tailwindcss/oxide');
  console.log('OK keys:', Object.keys(m).slice(0, 8));
} catch (e) {
  console.log('FAIL', e && e.constructor && e.constructor.name, e && e.message);
  console.log('---FULL STACK---');
  console.log((e && e.stack) || '(no stack)');
}
// Probe what's actually on disk inside @tailwindcss/oxide so we know
// whether it's a legit native binding gap (no JS surface) vs a cap-eviction
// of a JS file we'd otherwise have served.
console.log('---OXIDE DISK INTROSPECTION---');
const _fs = require('fs'), _path = require('path');
function walk(p, depth) {
  if (depth > 3) return;
  try {
    const st = _fs.statSync(p);
    if (st.isDirectory()) {
      const ents = _fs.readdirSync(p);
      for (const e of ents) walk(_path.join(p, e), depth + 1);
    } else {
      console.log(p, st.size);
    }
  } catch (e) {
    console.log('walk-err', p, e.message);
  }
}
walk('/home/user/app/node_modules/@tailwindcss/oxide', 0);
`,
  },
  {
    name: 'lightningcss',
    pkg: 'lightningcss',
    smoke: `
Error.stackTraceLimit = Infinity;
try {
  const m = require('lightningcss');
  console.log('OK keys:', Object.keys(m).slice(0, 8));
} catch (e) {
  console.log('FAIL', e && e.constructor && e.constructor.name, e && e.message);
  console.log('---FULL STACK---');
  console.log((e && e.stack) || '(no stack)');
}
// Same disk introspection.
console.log('---LIGHTNINGCSS DISK INTROSPECTION---');
const _fs = require('fs'), _path = require('path');
function walk(p, depth) {
  if (depth > 3) return;
  try {
    const st = _fs.statSync(p);
    if (st.isDirectory()) {
      const ents = _fs.readdirSync(p);
      for (const e of ents) walk(_path.join(p, e), depth + 1);
    } else {
      console.log(p, st.size);
    }
  } catch (e) {
    console.log('walk-err', p, e.message);
  }
}
walk('/home/user/app/node_modules/lightningcss', 0);
`,
  },
];

const onlyName = process.argv.find(a => a.startsWith('--only='))?.split('=')[1];
let targets = TARGETS;
if (onlyName) targets = TARGETS.filter(t => t.name === onlyName);

const jobs = targets.map(t => async () => {
  const artifactPath = path.join(HERE, `${t.name}.out.txt`);
  const probePath = path.join(HERE, `${t.name}.probe.js`);
  fs.writeFileSync(artifactPath, '');
  fs.writeFileSync(probePath, t.smoke);
  console.log(`[START] ${t.name}`);
  const id = `x526b_${Date.now().toString(36)}`;
  const b64 = Buffer.from(t.smoke, 'utf8').toString('base64');
  const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
  const runCmd = `cd /home/user/app && node .${id}.js`;
  const r = await runProbe(t.name, [
    { kind: 'cmd', cmd: `cd app && npm install ${t.pkg}`, timeoutMs: 240_000 },
    { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
  ], { artifactPath, settleMs: 3000 });
  console.log(`[DONE] ${t.name} ok=${r.ok}`);
  return { name: t.name, ok: r.ok };
});

console.log(`Running ${jobs.length} x526b investigation probe(s) → ${HERE}`);
const results = await runMany(jobs, 1);
const summaryPath = path.join(HERE, '_SUMMARY.json');
fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));
console.log('Done.');
