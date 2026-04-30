// W2.5 — bug-shape probes.
//
// For each candidate install scenario, captures:
//   1. npm install transcript (file count, packages, time)
//   2. fs.readdirSync(pkgDir) for the OBSERVED-EMPTY directories
//   3. fs.statSync stat for each missing-file path the resolver complained about
//   4. shasum/length of any present files in the same package
//   5. /api/stats snapshot (vfs.files, sql.batchWrites, sql.batchWriteRows)
//   6. The total "filesWritten" the install reported
//
// Goal: distinguish "files PRESENT-but-EMPTY (size 0)" from "files
// ABSENT entirely" (no inode), and correlate with package size / file count.
//
// Output: audit/probes/install-pipeline-shape.txt

import { runProbe, nodeEvalBase64 } from './_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'install-pipeline-shape.txt');
const BASE = process.env.BASE || 'https://nimbus.ashishkmr472.workers.dev';

const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };
fs.writeFileSync(ARTIFACT, '');

// Each scenario: pkg = npm install args, probes = [{pkg, dirs[]}, ...] dirs to introspect.
const SCENARIOS = [
  // CONTROL — pg works post-W2
  {
    label: 'control-pg',
    install: 'pg',
    introspect: [
      { pkg: 'pg', dirs: ['lib', '.', 'lib/native', 'lib/crypto'] },
    ],
  },
  // BROKEN — fastify→avvio empty
  {
    label: 'broken-fastify',
    install: 'fastify',
    introspect: [
      { pkg: 'fastify', dirs: ['.', 'lib'] },
      { pkg: 'avvio', dirs: ['.', 'lib'] },
      { pkg: 'fastq', dirs: ['.'] },
      { pkg: 'pino', dirs: ['.', 'lib'] },
      { pkg: 'semver', dirs: ['.', 'classes', 'functions', 'internal', 'ranges'] },
      { pkg: '@fastify/error', dirs: ['.'] },          // works — control
      { pkg: 'fast-json-stringify', dirs: ['.', 'lib'] }, // typically works
    ],
  },
  // BROKEN — ts-jest → typescript empty
  {
    label: 'broken-ts-jest',
    install: 'ts-jest jest typescript',
    introspect: [
      { pkg: 'typescript', dirs: ['.', 'lib', 'bin'] },
      { pkg: 'ts-jest', dirs: ['.', 'dist', 'dist/legacy'] },
      { pkg: 'jest', dirs: ['.'] },
    ],
  },
  // BROKEN — redis → @redis/client/dist empty
  {
    label: 'broken-redis',
    install: 'redis',
    introspect: [
      { pkg: 'redis', dirs: ['.', 'dist', 'dist/lib'] },
      { pkg: '@redis/client', dirs: ['.', 'dist', 'dist/lib', 'dist/lib/RESP'] },
      { pkg: '@redis/bloom', dirs: ['.'] },
      { pkg: 'cluster-key-slot', dirs: ['.'] },
    ],
  },
  // BROKEN — framer-motion + react@18.3.1 → react/cjs empty
  {
    label: 'broken-framer-react18',
    install: 'framer-motion react@18.3.1 react-dom@18.3.1',
    introspect: [
      { pkg: 'framer-motion', dirs: ['.', 'dist'] },
      { pkg: 'react', dirs: ['.', 'cjs'] },
      { pkg: 'react-dom', dirs: ['.', 'cjs'] },
      { pkg: 'scheduler', dirs: ['.', 'cjs'] },
    ],
  },
];

function buildIntrospectScript(introspect) {
  return `
const fs = require('fs');
const path = require('path');
const NM = '/home/user/app/node_modules';

function deepInfo(p) {
  let st;
  try { st = fs.statSync(p); } catch (e) { return { exists: false, error: e.message }; }
  if (st.isDirectory()) {
    let entries;
    try { entries = fs.readdirSync(p); } catch (e) { entries = '<readdir-fail:' + e.message + '>'; }
    return { exists: true, kind: 'dir', count: Array.isArray(entries) ? entries.length : -1, entries };
  }
  return { exists: true, kind: 'file', size: st.size };
}

const targets = ${JSON.stringify(introspect)};
for (const t of targets) {
  const pkgRoot = NM + '/' + t.pkg;
  console.log('=== pkg ' + t.pkg + ' ===');
  console.log('   pkg-root:', JSON.stringify(deepInfo(pkgRoot)));
  console.log('   pkg.json:', JSON.stringify(deepInfo(pkgRoot + '/package.json')));
  for (const d of t.dirs) {
    const full = d === '.' ? pkgRoot : pkgRoot + '/' + d;
    console.log('   ' + d + ':', JSON.stringify(deepInfo(full)));
  }
  // Sample-read package.json to confirm files are non-empty when present
  try {
    const pkgRaw = fs.readFileSync(pkgRoot + '/package.json', 'utf8');
    const pj = JSON.parse(pkgRaw);
    console.log('   pkg.json.name:', pj.name);
    console.log('   pkg.json.main:', pj.main);
    console.log('   pkg.json.version:', pj.version);
  } catch (e) {
    console.log('   pkg.json read FAIL:', e.message);
  }
}
`;
}

for (const sc of SCENARIOS) {
  log('');
  log('============================================================');
  log('SCENARIO: ' + sc.label);
  log('  install: npm install ' + sc.install);
  log('============================================================');

  const introspect = buildIntrospectScript(sc.introspect);
  const r = await runProbe('w25-bugshape-' + sc.label, [
    { kind: 'cmd', cmd: `cd app && npm install ${sc.install}`, timeoutMs: 180_000 },
    { kind: 'cmd', cmd: nodeEvalBase64(introspect), timeoutMs: 30_000 },
    { kind: 'cmd', cmd: `find /home/user/app/node_modules -maxdepth 3 -type d -empty 2>/dev/null | head -50`, timeoutMs: 15_000 },
  ], { artifactPath: ARTIFACT, settleMs: 3_000 });
  log('scenario ' + sc.label + ' ok=' + r.ok);
}

log('');
log('==== END W2.5 BUG-SHAPE PROBES ====');
