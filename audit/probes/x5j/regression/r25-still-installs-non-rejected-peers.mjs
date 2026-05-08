#!/usr/bin/env bun
// X5J regression: ensure the X.5-J carve-out only soft-skips REJECTED
// optional peers, NOT all optional peers. R2.5's framer-motion-style
// generous-include of optional peers (react, react-dom, …) MUST still
// fire for non-REJECT_INSTALL entries.
//
// Synth-fixture probe. Top-level pkg has [react (optional), sql.js
// (optional)]. Assertion:
//   - react IS in resolved tree (non-rejected optional peer enqueues OK)
//   - sql.js is NOT in resolved tree (rejected optional peer skipped)
//   - resolveTree did NOT throw

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'r25-still-installs-non-rejected-peers.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== X5J r25-still-installs-non-rejected-peers ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const { resolveTree } = await import(new URL('../../../../src/npm/resolver.ts', import.meta.url).href);

const MOCK_REGISTRY = {
  // synth-FM mimics framer-motion: optional peers are react + sql.js.
  // react MUST be enqueued (X.5-F R2.5 generous-include behaviour).
  // sql.js MUST NOT be enqueued (X.5-J carve-out).
  'synth-FM': {
    name: 'synth-FM', 'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': {
        name: 'synth-FM', version: '1.0.0',
        dependencies: {},
        peerDependencies: { react: '^18.0.0', 'sql.js': '^1.0.0' },
        peerDependenciesMeta: {
          react: { optional: true },
          'sql.js': { optional: true },
        },
        dist: { tarball: 'http://example.invalid/fm-1.0.0.tgz', integrity: 'sha512-FMFM' },
      },
    },
  },
  'react': {
    name: 'react', 'dist-tags': { latest: '18.3.1' },
    versions: {
      '18.3.1': {
        name: 'react', version: '18.3.1', dependencies: {},
        dist: { tarball: 'http://example.invalid/r-18.3.1.tgz', integrity: 'sha512-REAC' },
      },
    },
  },
  // sql.js NOT in registry — fix should soft-skip BEFORE any fetch.
};

async function fakeFetch(url) {
  const m = String(url).match(/registry\.npmjs\.org\/([^/?]+(?:\/[^/?]+)?)$/);
  if (!m) return new Response(JSON.stringify({ error: 'unmocked: ' + url }), { status: 404 });
  const name = decodeURIComponent(m[1]);
  const pkg = MOCK_REGISTRY[name];
  if (!pkg) return new Response(JSON.stringify({ error: 'no packument: ' + name }), { status: 404 });
  return new Response(JSON.stringify(pkg), { status: 200, headers: { 'content-type': 'application/json' } });
}

const fakeCache = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then' || prop === Symbol.toPrimitive) return undefined;
    return () => null;
  },
});

let threw = null;
let resolved;
try {
  resolved = await resolveTree(
    { 'synth-FM': '^1.0.0' },
    fakeCache,
    undefined,
    () => {},
    fakeFetch,
    {},
  );
} catch (e) {
  threw = e;
  log('!! resolveTree threw: ' + (e && e.message));
  resolved = new Map();
}

const names = [...resolved.keys()].sort();
log('resolved names: ' + JSON.stringify(names));

const t1 = !threw;                                  // must NOT throw
const t2 = names.includes('synth-FM');              // sanity
const t3 = names.includes('react');                 // CRITICAL: non-rejected optional peer still enqueued
const t4 = !names.includes('sql.js');               // CRITICAL: rejected optional peer skipped

log('t1 resolveTree did NOT throw:                ' + (t1 ? 'PASS' : 'FAIL'));
log('t2 synth-FM resolved:                        ' + (t2 ? 'PASS' : 'FAIL'));
log('t3 react (non-rejected optional) installed:  ' + (t3 ? 'PASS' : 'FAIL'));
log('t4 sql.js (rejected optional) NOT installed: ' + (t4 ? 'PASS' : 'FAIL'));

const allOK = t1 && t2 && t3 && t4;
log('');
log('OVERALL: ' + (allOK ? 'PASS' : 'FAIL'));
process.exit(allOK ? 0 : 1);
