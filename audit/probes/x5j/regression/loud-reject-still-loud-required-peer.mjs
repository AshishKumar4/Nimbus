#!/usr/bin/env bun
// X5J regression: a REQUIRED peer-dep in REJECT_INSTALL must STILL
// hard-fail. The X.5-J carve-out is for OPTIONAL peers only; required
// peers are fundamentally needed by the parent and a reject means the
// parent is genuinely incompatible.
//
// Synth-fixture probe. Constructs a packument where pkg P has REQUIRED
// peer 'sharp' (a W6 REJECT_INSTALL transitive='fail' entry, not marked
// optional). Asserts: resolveTree throws RegistryRejectError. (The X.5-J
// fix MUST NOT extend the soft-skip to required peers.)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'loud-reject-still-loud-required-peer.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== X5J loud-reject-still-loud-required-peer ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const { resolveTree } = await import(new URL('../../../../src/npm/resolver.ts', import.meta.url).href);

const MOCK_REGISTRY = {
  // P declares REQUIRED peer sharp (peerDependenciesMeta.sharp.optional = false / absent).
  'synth-Q': {
    name: 'synth-Q', 'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': {
        name: 'synth-Q', version: '1.0.0',
        dependencies: {},
        peerDependencies: { sharp: '^0.30.0' },
        // No peerDependenciesMeta — sharp is REQUIRED.
        dist: { tarball: 'http://example.invalid/q-1.0.0.tgz', integrity: 'sha512-QQQQ' },
      },
    },
  },
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
    { 'synth-Q': '^1.0.0' },
    fakeCache,
    undefined,
    () => {},
    fakeFetch,
    {},
  );
} catch (e) {
  threw = e;
}

const errorMessage = threw && (threw.message || String(threw));
const isRegistryReject =
  threw &&
  (errorMessage.includes('RegistryRejectError') ||
    errorMessage.includes('npm install rejected') ||
    /sharp/.test(errorMessage));

log('resolveTree threw: ' + (!!threw));
log('error message:     ' + errorMessage);

const t1 = !!threw;                                    // CRITICAL: must throw
const t2 = isRegistryReject;                           // CRITICAL: must be the reject error (not some other)
const t3 = !threw || /sharp/.test(errorMessage);       // error names sharp specifically

log('t1 resolveTree threw on required-peer reject:    ' + (t1 ? 'PASS' : 'FAIL'));
log('t2 error is RegistryRejectError-shaped:          ' + (t2 ? 'PASS' : 'FAIL'));
log('t3 error mentions "sharp":                       ' + (t3 ? 'PASS' : 'FAIL'));

const allOK = t1 && t2 && t3;
log('');
log('OVERALL: ' + (allOK ? 'PASS' : 'FAIL'));
process.exit(allOK ? 0 : 1);
