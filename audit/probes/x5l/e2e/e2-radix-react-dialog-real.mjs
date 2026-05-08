// X.5-L e2e — `@radix-ui/react-dialog` loads end-to-end against the
// REAL ON-DISK PACKAGE FILES.
//
// radix-react-dialog transitively depends on react-remove-scroll which
// transitively depends on react-remove-scroll-bar/constants. The same
// nested-pkg gap that breaks react-remove-scroll also breaks radix-dialog.
// Both flip ✅ from a single fix.
//
// Pre-fix: FAIL — same root cause as e1.
// Post-fix: PASS.

import { makeFacet, makeVfs, getOrInstallFixture, check, summary, reset } from '../_helpers.mjs';
import { prefetchForRequire } from '../../../../src/runtime/require-resolver.ts';
import { generateShimsCode } from '../../../../src/runtime/node-shims.ts';
import * as esbuildWasm from 'esbuild-wasm';

reset();

console.log('X.5-L e2e/e2-radix-react-dialog-real — package loads end-to-end (REAL files)');

const fixture = getOrInstallFixture('radix', [
  '@radix-ui/react-dialog',
  'react@^18',
  'react-dom@^18',
]);

fixture['home/user/app/package.json'] = JSON.stringify({
  name: 'app', version: '0.0.0',
  dependencies: { '@radix-ui/react-dialog': '*' },
});

console.log(`  fixture: ${Object.keys(fixture).length} files loaded`);

const vfs = makeVfs(fixture);

const entryCode = "const m = require('@radix-ui/react-dialog');\nconsole.log(typeof m);\n";
const prefetch = prefetchForRequire(vfs, entryCode, '/home/user/app');
let bundle = { ...prefetch.bundle };

console.log(`  prefetched ${Object.keys(bundle).length} files (truncated=${prefetch.truncated})`);

// ESM→CJS transform.
if (!globalThis.__esbInit) {
  await esbuildWasm.initialize({});
  globalThis.__esbInit = true;
}
const importStmt = /(^|\n)\s*import\s+(['"][^'"]+['"]|[\w*$]|\{)/;
const exportStmt = /(^|\n)\s*export\s+(default\b|\{|\*|let\b|const\b|var\b|function\b|class\b|async\b|type\b)/;
function looksLikeEsm(src) {
  const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return importStmt.test(stripped) || exportStmt.test(stripped);
}
let transformed = 0;
for (const p of Object.keys(bundle)) {
  if (!p.endsWith('.js') && !p.endsWith('.mjs')) continue;
  if (!looksLikeEsm(bundle[p])) continue;
  try {
    const r = await esbuildWasm.transform(bundle[p], { loader: 'js', format: 'cjs', target: 'esnext' });
    bundle[p] = r.code;
    transformed++;
  } catch { /* leave */ }
}
console.log(`  transformed ${transformed} ESM → CJS`);

const dirs = {};
for (const p of Object.keys(bundle)) {
  let d = p;
  while (d.includes('/')) {
    d = d.substring(0, d.lastIndexOf('/'));
    if (d) dirs[d] = true;
  }
}

bundle['home/user/app/script.js'] =
  "let m, err = null;\n" +
  "try { m = require('@radix-ui/react-dialog'); }\n" +
  "catch (e) { err = e && e.message ? e.message : String(e); }\n" +
  "module.exports = {\n" +
  "  err,\n" +
  "  type: typeof m,\n" +
  "  rootIsFn: !!(m && (typeof m.Root === 'function' || (m.Root && typeof m.Root.$$typeof !== 'undefined'))),\n" +
  "  hasContent: !!(m && m.Content),\n" +
  "  hasOverlay: !!(m && m.Overlay),\n" +
  "  hasTitle: !!(m && m.Title),\n" +
  "  keys: m ? Object.keys(m).slice(0, 12) : [],\n" +
  "};\n";

let result, hardErr = null;
try {
  const facet = makeFacet({ bundle, dirs, generateShimsCode });
  result = facet.__require('./script');
} catch (e) {
  hardErr = e && e.message ? e.message : String(e);
}

console.log(`  result: ${JSON.stringify(result)}`);
if (hardErr) console.log(`  hardErr: ${hardErr}`);

check('no hard exception during runtime require chain', hardErr === null, hardErr);
check('no soft error from require(\'@radix-ui/react-dialog\')', result?.err === null, result?.err);
check('@radix-ui/react-dialog loads to an object', result?.type === 'object', JSON.stringify(result));
check('Root export is present', result?.rootIsFn === true, JSON.stringify(result?.keys));
check('Content export is present', result?.hasContent === true, JSON.stringify(result?.keys));
check('Overlay export is present', result?.hasOverlay === true, JSON.stringify(result?.keys));

const ok = summary();
process.exit(ok ? 0 : 1);
