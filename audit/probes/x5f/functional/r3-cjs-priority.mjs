// X.5-F R3 regression-companion functional probe — when both `require`
// and `import` conditions exist, the runtime CJS resolver still picks
// `require`. The ESM-condition fallback must NOT shadow correct CJS
// resolution.
//
// Today this is GREEN by virtue of the CJS-only path. After the C-phase
// fix it must STAY GREEN — the fallback only triggers when CJS yields
// null.
//
// Output: audit/probes/x5f/functional/r3-cjs-priority.txt

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'r3-cjs-priority.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== X5F R3 CJS-priority regression probe ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const { resolvePackageEntry, DEFAULT_ESM_CONDITIONS, DEFAULT_CJS_CONDITIONS } = await import(
  new URL('../../../../src/_shared/exports-resolver.ts', import.meta.url).href
);

// Dual-export package: cjs at ./dist/index.js, esm at ./dist/index.mjs.
const pkg = {
  name: 'fake-dual',
  exports: {
    '.': {
      import: { types: './dist/index.d.mts', default: './dist/index.mjs' },
      require: { types: './dist/index.d.ts', default: './dist/index.js' },
    },
  },
};

const cjs = resolvePackageEntry(pkg, '.', DEFAULT_CJS_CONDITIONS);
const esm = resolvePackageEntry(pkg, '.', DEFAULT_ESM_CONDITIONS);

log('cjs path: ' + JSON.stringify(cjs));
log('esm path: ' + JSON.stringify(esm));

// In the FIXED node-shims runtime, the call sequence is:
//   1. Try CJS conds first → './dist/index.js'  (success, return)
//   2. Never falls through to ESM
//
// So the assertion: cjs MUST be './dist/index.js'. Even after the fix,
// we never see './dist/index.mjs' for this dual package via the runtime.
const t1 = cjs === './dist/index.js';
const t2 = esm === './dist/index.mjs';

log('t1 CJS picks .js (no fallback shadow): ' + (t1 ? 'PASS' : 'FAIL'));
log('t2 ESM picks .mjs (sanity):            ' + (t2 ? 'PASS' : 'FAIL'));

const ok = t1 && t2;
log('OVERALL: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
