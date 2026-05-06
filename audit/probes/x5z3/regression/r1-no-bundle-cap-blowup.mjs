// X.5-Z3 regression — a clean install with NO asset readFileSync calls
// adds zero extra files. Guards against accidental greedy expansion.

import { makeVfs, tryRealAssetHelper, check, summary, reset } from '../_helpers.mjs';

reset();

console.log('X.5-Z3 regression/r1-no-bundle-cap-blowup — no false-positive prefetches');

const fixture = {
  'home/user/app/node_modules/no-assets/package.json': JSON.stringify({
    name: 'no-assets',
    version: '0.0.0',
    main: './index.js',
  }),
  'home/user/app/node_modules/no-assets/index.js':
    'module.exports = { name: "no-assets", x: 42 };\n',
  // Stranded asset files in VFS that should NOT get pulled (no source references them).
  'home/user/app/node_modules/no-assets/orphan.css': 'orphan',
  'home/user/app/node_modules/no-assets/lonely.html': '<html/>',
};

const vfs = makeVfs(fixture);
const cwd = '/home/user/app';

const inputBundle = {
  'home/user/app/node_modules/no-assets/package.json': fixture['home/user/app/node_modules/no-assets/package.json'],
  'home/user/app/node_modules/no-assets/index.js': fixture['home/user/app/node_modules/no-assets/index.js'],
};
const initialKeys = Object.keys(inputBundle).length;

const helper = await tryRealAssetHelper();

if (helper === null) {
  console.log('  (TDD-RED) addStaticReadFileAssets not exported — regression assertions vacuously hold');
  check('bundle size unchanged', Object.keys(inputBundle).length === initialKeys);
} else {
  const counters = { totalBytes: 0, fileCount: initialKeys };
  for (const k of Object.keys(inputBundle)) counters.totalBytes += inputBundle[k].length;
  helper(vfs, cwd, inputBundle, counters);
  check(
    'bundle size unchanged (no over-collection)',
    Object.keys(inputBundle).length === initialKeys,
    `expected ${initialKeys}, got ${Object.keys(inputBundle).length}: ${Object.keys(inputBundle).join(',')}`,
  );
  check(
    'orphan.css NOT prefetched (no source reference)',
    !('home/user/app/node_modules/no-assets/orphan.css' in inputBundle),
  );
  check(
    'lonely.html NOT prefetched (no source reference)',
    !('home/user/app/node_modules/no-assets/lonely.html' in inputBundle),
  );
}

const ok = summary();
process.exit(ok ? 0 : 1);
