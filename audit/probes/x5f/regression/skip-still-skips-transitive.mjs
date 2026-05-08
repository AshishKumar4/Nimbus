// X.5-F regression — after the R1 top-level bypass lands, transitive
// SKIP_PACKAGES names must STILL be silent-skipped.
//
// Scenario: a synthetic top-level pkg `fake-app` declares
// `dependencies: { typescript: '*', other: '*' }`. Today and after the
// fix, `typescript` (in SKIP_PACKAGES) MUST be silent-skipped during the
// transitive walk, while `other` is resolved.
//
// The R1 fix (top-level bypass) MUST NOT widen to transitive deps —
// otherwise we'd start downloading typescript whenever ANY package
// depends on it (which is most of npm). That would be a serious
// regression of the W6 design.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'skip-still-skips-transitive.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== X5F skip-still-skips-transitive regression probe ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const { resolveTree } = await import(
  new URL('../../../../src/npm/resolver.ts', import.meta.url).href
);

const fakeCache = new Proxy({}, { get: () => () => null });

const REGISTRY = {
  'fake-app': {
    name: 'fake-app', 'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': {
      name: 'fake-app', version: '1.0.0',
      dependencies: { typescript: '*', other: '*' },
      dist: { tarball: 'http://example.invalid/fa-1.0.0.tgz', integrity: 'sha512-AAAA' },
    } },
  },
  'typescript': {
    name: 'typescript', 'dist-tags': { latest: '5.4.0' },
    versions: { '5.4.0': {
      name: 'typescript', version: '5.4.0', dependencies: {},
      dist: { tarball: 'http://example.invalid/ts-5.4.0.tgz', integrity: 'sha512-BBBB' },
    } },
  },
  'other': {
    name: 'other', 'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': {
      name: 'other', version: '1.0.0', dependencies: {},
      dist: { tarball: 'http://example.invalid/o-1.0.0.tgz', integrity: 'sha512-CCCC' },
    } },
  },
};

async function fakeFetch(url) {
  const m = String(url).match(/registry\.npmjs\.org\/([^/?]+(?:\/[^/?]+)?)$/);
  const name = m ? decodeURIComponent(m[1]) : null;
  const pkg = name && REGISTRY[name];
  return pkg
    ? new Response(JSON.stringify(pkg), { status: 200 })
    : new Response(JSON.stringify({ error: 'unmocked: ' + url }), { status: 404 });
}

const captured = [];
const onProgress = (s) => captured.push(String(s));

const resolved = await resolveTree(
  { 'fake-app': '*' },
  fakeCache,
  undefined,
  onProgress,
  fakeFetch,
  {},
);

const names = [...resolved.keys()].sort();
log('resolved names: ' + JSON.stringify(names));
const messages = captured.filter(m => /skipping|skip/.test(m));
log('skip messages: ' + JSON.stringify(messages));

const t1 = names.includes('fake-app');
const t2 = names.includes('other');
const t3 = !names.includes('typescript'); // CRITICAL: must NOT install transitive ts
const t4 = messages.some(m => /typescript/.test(m) && /skip/.test(m));

log('t1 fake-app resolved:                  ' + (t1 ? 'PASS' : 'FAIL'));
log('t2 other resolved:                     ' + (t2 ? 'PASS' : 'FAIL'));
log('t3 typescript NOT in resolved:         ' + (t3 ? 'PASS' : 'FAIL'));
log('t4 saw "skipping typescript" message:  ' + (t4 ? 'PASS' : 'FAIL'));

const ok = t1 && t2 && t3 && t4;
log('OVERALL: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
