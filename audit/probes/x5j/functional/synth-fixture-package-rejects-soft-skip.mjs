#!/usr/bin/env bun
// X5J functional: end-to-end resolveTree behaviour with a synthetic
// packument. This is the operational probe — invokes the supervisor
// resolveTree with a fake registry where:
//
//   - synthetic top-level package P has:
//       peerDependencies:                { goodpeer: '*', badpeer: '*' }
//       peerDependenciesMeta.badpeer.optional = true   (badpeer is optional)
//       peerDependenciesMeta.goodpeer.optional = true  (goodpeer is optional)
//   - badpeer = 'sql.js' (real W6 REJECT_INSTALL transitive='fail' entry).
//   - goodpeer = a benign synthetic package.
//
// EXPECTED:
//   - resolveTree completes without throwing.
//   - resolved.has('synth-P') === true.
//   - resolved.has('goodpeer') === true (non-rejected optional peer).
//   - resolved.has('sql.js') === false  (rejected optional peer skipped).
//
// RED today: resolveTree throws RegistryRejectError on sql.js because
// R2.5 enqueues it without filtering through REJECT_INSTALL.
// GREEN after Phase C: R2.5 enqueue-time filter soft-skips sql.js.
//
// Output: synth-fixture-package-rejects-soft-skip.txt
// Exit nonzero if any assertion fails.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'synth-fixture-package-rejects-soft-skip.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== X5J synth-fixture optional-peer-rejects-soft-skip ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

let resolveTree;
try {
  ({ resolveTree } = await import(new URL('../../../../src/npm-resolver.ts', import.meta.url).href));
} catch (e) {
  log('!! could not import npm-resolver: ' + e.message);
  process.exit(2);
}

// MOCK_REGISTRY:
//  - synth-P (top-level): peerDependencies { goodpeer, sql.js };
//                          peerDependenciesMeta { goodpeer.optional=true,
//                                                  'sql.js'.optional=true }
//  - goodpeer: trivial leaf
//
// We do NOT include sql.js in the registry — the X.5-J fix should
// soft-skip it before any fetch attempt. If the fix is missing,
// resolveTree should throw RegistryRejectError (the W6 reject fires
// before fetch).
const MOCK_REGISTRY = {
  'synth-P': {
    name: 'synth-P', 'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': {
        name: 'synth-P', version: '1.0.0',
        dependencies: {},
        peerDependencies: { goodpeer: '^1.0.0', 'sql.js': '^1.0.0' },
        peerDependenciesMeta: {
          goodpeer: { optional: true },
          'sql.js': { optional: true },
        },
        dist: { tarball: 'http://example.invalid/p-1.0.0.tgz', integrity: 'sha512-PPPP' },
      },
    },
  },
  'goodpeer': {
    name: 'goodpeer', 'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': {
        name: 'goodpeer', version: '1.0.0', dependencies: {},
        dist: { tarball: 'http://example.invalid/g-1.0.0.tgz', integrity: 'sha512-GGGG' },
      },
    },
  },
};

async function fakeFetch(url) {
  const m = String(url).match(/registry\.npmjs\.org\/([^/?]+(?:\/[^/?]+)?)$/);
  if (!m) {
    return new Response(JSON.stringify({ error: 'unmocked URL: ' + url }), { status: 404 });
  }
  const name = decodeURIComponent(m[1]);
  const pkg = MOCK_REGISTRY[name];
  if (!pkg) {
    return new Response(JSON.stringify({ error: 'no packument: ' + name }), { status: 404 });
  }
  return new Response(JSON.stringify(pkg), { status: 200, headers: { 'content-type': 'application/json' } });
}

const fakeCache = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then' || prop === Symbol.toPrimitive) return undefined;
    return () => null;
  },
});

const captured = [];
const onProgress = (s) => captured.push(String(s));

let resolved;
let threw = null;
try {
  resolved = await resolveTree(
    { 'synth-P': '^1.0.0' },
    fakeCache,
    undefined,
    onProgress,
    fakeFetch,
    {},
  );
} catch (e) {
  threw = e;
  log('!! resolveTree threw: ' + (e && e.message));
  // Print full stack for diagnosis on failure (red phase will use this).
  log(String(e && e.stack || e));
  resolved = new Map();
}

const names = [...resolved.keys()].sort();
log('resolved names: ' + JSON.stringify(names));
log('progress lines (last 10): ' + JSON.stringify(captured.slice(-10)));

const t1 = !threw;                                 // CRITICAL: must NOT throw
const t2 = names.includes('synth-P');              // sanity: P resolved
const t3 = names.includes('goodpeer');             // non-rejected optional peer installed
const t4 = !names.includes('sql.js');              // CRITICAL: rejected optional peer NOT in tree

// Also confirm a [skip] / soft-skip event was emitted, indicating
// the carve-out actually fired (rather than the peer being silently
// dropped via a different code path). The progress channel surfaces
// the skip log line.
const skipEvidence = captured.some(s =>
  /\[skip\][\s\S]*sql\.js|optional peer in REJECT_INSTALL[\s\S]*sql\.js/.test(s));
const t5 = skipEvidence;

log('t1 resolveTree did NOT throw:                 ' + (t1 ? 'PASS' : 'FAIL'));
log('t2 synth-P resolved:                          ' + (t2 ? 'PASS' : 'FAIL'));
log('t3 goodpeer (non-rejected optional) resolved: ' + (t3 ? 'PASS' : 'FAIL'));
log('t4 sql.js (rejected optional) NOT in tree:    ' + (t4 ? 'PASS' : 'FAIL'));
log('t5 sql.js soft-skip log line surfaced:        ' + (t5 ? 'PASS' : 'FAIL'));

const allOK = t1 && t2 && t3 && t4 && t5;
log('');
log('OVERALL: ' + (allOK ? 'PASS' : 'FAIL'));
process.exit(allOK ? 0 : 1);
