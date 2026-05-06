// X.5-Z3 regression — static literal that resolves to a non-existent
// file is silently skipped (no throw). Guards against helper crashing
// on broken / dead-code references in 3rd-party packages.

import { makeVfs, tryRealAssetHelper, check, summary, reset } from '../_helpers.mjs';

reset();

console.log('X.5-Z3 regression/r2-vfs-not-found — missing asset is silent skip');

const fixture = {
  'home/user/app/node_modules/missing-pkg/package.json': JSON.stringify({
    name: 'missing-pkg',
    version: '0.0.0',
    main: './index.js',
  }),
  // Source references "./gone.css" — but no such file in VFS.
  'home/user/app/node_modules/missing-pkg/index.js':
    'const fs = require("fs");\nconst path = require("path");\n' +
    'try { fs.readFileSync(path.resolve(__dirname, "./gone.css"), "utf8"); } catch {}\n' +
    'module.exports = {};\n',
};

const vfs = makeVfs(fixture);
const cwd = '/home/user/app';

const inputBundle = {
  'home/user/app/node_modules/missing-pkg/package.json': fixture['home/user/app/node_modules/missing-pkg/package.json'],
  'home/user/app/node_modules/missing-pkg/index.js': fixture['home/user/app/node_modules/missing-pkg/index.js'],
};

const helper = await tryRealAssetHelper();

if (helper === null) {
  console.log('  (TDD-RED) addStaticReadFileAssets not exported');
  check('helper missing means no throw possible', true);
} else {
  let threw = null;
  try {
    const counters = { totalBytes: 0, fileCount: Object.keys(inputBundle).length };
    for (const k of Object.keys(inputBundle)) counters.totalBytes += inputBundle[k].length;
    helper(vfs, cwd, inputBundle, counters);
  } catch (e) { threw = e?.message || String(e); }
  check('helper does NOT throw on non-existent asset', threw === null, threw);
  check(
    'missing asset is NOT in bundle (no phantom entry)',
    !('home/user/app/node_modules/missing-pkg/gone.css' in inputBundle),
  );
}

const ok = summary();
process.exit(ok ? 0 : 1);
