// X.5-F R2 functional probe — installer must enqueue required peerDeps.
//
// This probe exercises the SUPERVISOR-SIDE resolveTree() function with a
// FAKE registry (in-memory mock) and asserts that:
//
//   1. A package declaring peerDependencies has those peer names enqueued
//      into the resolution graph (today: NOT enqueued).
//   2. peerDependenciesMeta.<name>.optional === true causes the peer to
//      be SKIPPED (correct npm behaviour).
//   3. A peer name that is also in SKIP_PACKAGES (e.g. typescript)
//      becomes installable when listed as a peer dep (today: silently
//      dropped via shouldSkipPackage; after fix: must be installed).
//
// Strategy:
//   - Import resolveTree from src/npm-resolver.ts directly via bun's
//     ts-loader.
//   - Pass a synthetic NpmCache + a fake fetchFn that serves canned
//     packuments inline (NO network).
//   - Assert the returned Map contains the expected names.
//
// Output: audit/probes/x5f/functional/r2-peerdep-resolution.txt
// RED today (resolver doesn't read peerDependencies); GREEN after Phase C.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'r2-peerdep-resolution.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== X5F R2 peerdep-resolution functional probe ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

let resolveTree;
try {
  ({ resolveTree } = await import(new URL('../../../../src/npm-resolver.ts', import.meta.url).href));
} catch (e) {
  log('!! could not import npm-resolver: ' + e.message);
  process.exit(2);
}

// Synthetic packuments for an in-memory registry. Shape matches what
// resolvePackage expects on a successful packument fetch (subset).
const MOCK_REGISTRY = {
  'fake-radix-dialog': {
    name: 'fake-radix-dialog',
    'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': {
        name: 'fake-radix-dialog',
        version: '1.0.0',
        dependencies: { 'aria-hidden': '^1.0.0' },
        peerDependencies: { react: '^18.0.0', 'react-dom': '^18.0.0', '@types/react': '*' },
        peerDependenciesMeta: { '@types/react': { optional: true } },
        dist: { tarball: 'http://example.invalid/r-1.0.0.tgz', integrity: 'sha512-AAAA' },
      },
    },
  },
  'aria-hidden': {
    name: 'aria-hidden', 'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': {
        name: 'aria-hidden', version: '1.0.0', dependencies: {},
        dist: { tarball: 'http://example.invalid/a-1.0.0.tgz', integrity: 'sha512-BBBB' },
      },
    },
  },
  'react': {
    name: 'react', 'dist-tags': { latest: '18.3.1' },
    versions: {
      '18.3.1': {
        name: 'react', version: '18.3.1', dependencies: { 'loose-envify': '^1.4.0' },
        dist: { tarball: 'http://example.invalid/react-18.3.1.tgz', integrity: 'sha512-CCCC' },
      },
    },
  },
  'react-dom': {
    name: 'react-dom', 'dist-tags': { latest: '18.3.1' },
    versions: {
      '18.3.1': {
        name: 'react-dom', version: '18.3.1', dependencies: { scheduler: '^0.23.0' },
        dist: { tarball: 'http://example.invalid/rd-18.3.1.tgz', integrity: 'sha512-DDDD' },
      },
    },
  },
  'loose-envify': {
    name: 'loose-envify', 'dist-tags': { latest: '1.4.0' },
    versions: {
      '1.4.0': {
        name: 'loose-envify', version: '1.4.0', dependencies: {},
        dist: { tarball: 'http://example.invalid/le-1.4.0.tgz', integrity: 'sha512-EEEE' },
      },
    },
  },
  'scheduler': {
    name: 'scheduler', 'dist-tags': { latest: '0.23.0' },
    versions: {
      '0.23.0': {
        name: 'scheduler', version: '0.23.0', dependencies: {},
        dist: { tarball: 'http://example.invalid/s-0.23.0.tgz', integrity: 'sha512-FFFF' },
      },
    },
  },
  '@types/react': {
    name: '@types/react', 'dist-tags': { latest: '18.0.0' },
    versions: {
      '18.0.0': {
        name: '@types/react', version: '18.0.0', dependencies: {},
        dist: { tarball: 'http://example.invalid/tr-18.0.0.tgz', integrity: 'sha512-GGGG' },
      },
    },
  },
  'fake-ts-jest': {
    name: 'fake-ts-jest', 'dist-tags': { latest: '29.0.0' },
    versions: {
      '29.0.0': {
        name: 'fake-ts-jest', version: '29.0.0',
        dependencies: { 'jest-util': '^29.0.0' },
        peerDependencies: { typescript: '>=4.3', jest: '^29.0.0' },
        dist: { tarball: 'http://example.invalid/tj-29.0.0.tgz', integrity: 'sha512-HHHH' },
      },
    },
  },
  'jest-util': {
    name: 'jest-util', 'dist-tags': { latest: '29.0.0' },
    versions: {
      '29.0.0': {
        name: 'jest-util', version: '29.0.0', dependencies: {},
        dist: { tarball: 'http://example.invalid/ju-29.0.0.tgz', integrity: 'sha512-IIII' },
      },
    },
  },
  'typescript': {
    name: 'typescript', 'dist-tags': { latest: '5.4.0' },
    versions: {
      '5.4.0': {
        name: 'typescript', version: '5.4.0', dependencies: {},
        dist: { tarball: 'http://example.invalid/ts-5.4.0.tgz', integrity: 'sha512-JJJJ' },
      },
    },
  },
  'jest': {
    name: 'jest', 'dist-tags': { latest: '29.0.0' },
    versions: {
      '29.0.0': {
        name: 'jest', version: '29.0.0', dependencies: {},
        dist: { tarball: 'http://example.invalid/j-29.0.0.tgz', integrity: 'sha512-KKKK' },
      },
    },
  },
};

// Fake fetchFn — serves packuments from MOCK_REGISTRY.
async function fakeFetch(url, opts) {
  const m = String(url).match(/registry\.npmjs\.org\/([^/?]+(?:\/[^/?]+)?)$/);
  if (!m) {
    return new Response(JSON.stringify({ error: 'unmocked URL: ' + url }), { status: 404 });
  }
  let name = decodeURIComponent(m[1]);
  if (name.startsWith('@')) {
    // scoped packuments are at /@scope/name (already correct)
  }
  const pkg = MOCK_REGISTRY[name];
  if (!pkg) {
    return new Response(JSON.stringify({ error: 'no packument: ' + name }), { status: 404 });
  }
  return new Response(JSON.stringify(pkg), { status: 200, headers: { 'content-type': 'application/json' } });
}

// Minimal NpmCache stand-in. Catches all method calls — npm-resolver
// uses several cache methods (putRegistryEntry, getRegistryEntry, etc.)
// and we want them all to no-op without throwing.
const fakeCache = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then' || prop === Symbol.toPrimitive) return undefined;
    return () => null;
  },
});

const captured = [];
const onProgress = (s) => captured.push(String(s));

// Test 1 — fake-radix-dialog AS TOP-LEVEL: peers (react, react-dom)
//          must be enqueued. With R2.5, optional peers (@types/react)
//          ARE ALSO enqueued for top-level requests (mirrors npm CLI's
//          default --include=peer behaviour). Transitive optionals are
//          still filtered (covered by test 3 below).
log('');
log('--- test 1: fake-radix-dialog (top-level) ---');
let resolved1;
try {
  resolved1 = await resolveTree(
    { 'fake-radix-dialog': '^1.0.0' },
    fakeCache,
    undefined,
    onProgress,
    fakeFetch,
    {},
  );
} catch (e) {
  log('!! resolveTree threw: ' + e.message);
  resolved1 = new Map();
}
const names1 = [...resolved1.keys()].sort();
log('resolved names: ' + JSON.stringify(names1));
const has1 = (n) => names1.includes(n);
const t1a = has1('fake-radix-dialog');                              // sanity
const t1b = has1('react');                                          // CRITICAL: required peer must be installed
const t1c = has1('react-dom');                                      // CRITICAL: required peer must be installed
const t1d = has1('@types/react');                                   // R2.5: optional peer of TOP-LEVEL pkg must be installed
log('t1a fake-radix-dialog resolved:           ' + (t1a ? 'PASS' : 'FAIL'));
log('t1b react peer enqueued:                  ' + (t1b ? 'PASS' : 'FAIL'));
log('t1c react-dom peer enqueued:              ' + (t1c ? 'PASS' : 'FAIL'));
log('t1d @types/react (optional, top-level):   ' + (t1d ? 'PASS' : 'FAIL'));

// Test 2 — fake-ts-jest: peers (typescript, jest) must be enqueued
//          even though typescript is in SKIP_PACKAGES.
log('');
log('--- test 2: fake-ts-jest ---');
let resolved2;
try {
  resolved2 = await resolveTree(
    { 'fake-ts-jest': '^29.0.0' },
    fakeCache,
    undefined,
    onProgress,
    fakeFetch,
    {},
  );
} catch (e) {
  log('!! resolveTree threw: ' + e.message);
  resolved2 = new Map();
}
const names2 = [...resolved2.keys()].sort();
log('resolved names: ' + JSON.stringify(names2));
const has2 = (n) => names2.includes(n);
const t2a = has2('fake-ts-jest');
const t2b = has2('typescript');                                     // CRITICAL: peer must override SKIP_PACKAGES
const t2c = has2('jest');
log('t2a fake-ts-jest resolved:         ' + (t2a ? 'PASS' : 'FAIL'));
log('t2b typescript peer (over-skip):   ' + (t2b ? 'PASS' : 'FAIL'));
log('t2c jest peer enqueued:            ' + (t2c ? 'PASS' : 'FAIL'));

// Test 3 — transitive optional peer must STILL be skipped. Construct a
//          tree where fake-app depends on fake-radix-dialog. Then
//          @types/react (optional peer of fake-radix-dialog) MUST NOT
//          be in the tree even though we asked for fake-app.
log('');
log('--- test 3: fake-radix-dialog as transitive ---');
// Add a wrapper that depends on fake-radix-dialog
MOCK_REGISTRY['fake-app-wrapper'] = {
  name: 'fake-app-wrapper', 'dist-tags': { latest: '1.0.0' },
  versions: { '1.0.0': {
    name: 'fake-app-wrapper', version: '1.0.0',
    dependencies: { 'fake-radix-dialog': '^1.0.0' },
    dist: { tarball: 'http://example.invalid/faw-1.0.0.tgz', integrity: 'sha512-LLLL' },
  } },
};

let resolved3;
try {
  resolved3 = await resolveTree(
    { 'fake-app-wrapper': '^1.0.0' },
    fakeCache,
    undefined,
    onProgress,
    fakeFetch,
    {},
  );
} catch (e) {
  log('!! resolveTree threw: ' + e.message);
  resolved3 = new Map();
}
const names3 = [...resolved3.keys()].sort();
log('resolved names: ' + JSON.stringify(names3));
const has3 = (n) => names3.includes(n);
const t3a = has3('fake-app-wrapper');                  // sanity
const t3b = has3('fake-radix-dialog');                 // sanity (transitive dep)
const t3c = has3('react') && has3('react-dom');        // required peers of transitive must STILL install
const t3d = !has3('@types/react');                     // CRITICAL: optional peer of TRANSITIVE pkg must NOT install
log('t3a fake-app-wrapper resolved:               ' + (t3a ? 'PASS' : 'FAIL'));
log('t3b fake-radix-dialog transitive resolved:   ' + (t3b ? 'PASS' : 'FAIL'));
log('t3c react/react-dom (required peers) install:' + (t3c ? 'PASS' : 'FAIL'));
log('t3d @types/react (optional, transitive) skip:' + (t3d ? 'PASS' : 'FAIL'));

const allOK = t1a && t1b && t1c && t1d && t2a && t2b && t2c && t3a && t3b && t3c && t3d;
log('');
log('OVERALL: ' + (allOK ? 'PASS' : 'FAIL'));
process.exit(allOK ? 0 : 1);
