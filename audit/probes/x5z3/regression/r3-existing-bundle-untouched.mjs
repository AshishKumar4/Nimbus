// X.5-Z3 regression — files already in `bundle` are not duplicated /
// overwritten. Idempotent.

import { makeVfs, tryRealAssetHelper, check, summary, reset } from '../_helpers.mjs';

reset();

console.log('X.5-Z3 regression/r3-existing-bundle-untouched — idempotent');

const fixture = {
  'home/user/app/node_modules/dup-pkg/package.json': JSON.stringify({
    name: 'dup-pkg',
    version: '0.0.0',
    main: './index.js',
  }),
  'home/user/app/node_modules/dup-pkg/index.js':
    'const fs = require("fs");\nconst path = require("path");\n' +
    'const a = fs.readFileSync(path.resolve(__dirname, "./style.css"), "utf8");\n' +
    'module.exports = { a };\n',
  'home/user/app/node_modules/dup-pkg/style.css': 'real-content',
};

const vfs = makeVfs(fixture);
const cwd = '/home/user/app';

const ASSET_KEY = 'home/user/app/node_modules/dup-pkg/style.css';
const INJECTED = 'pre-injected-content';

// Bundle pre-populated with the .css under a different value (e.g. an
// install-time write). Helper must NOT clobber.
const inputBundle = {
  'home/user/app/node_modules/dup-pkg/package.json': fixture['home/user/app/node_modules/dup-pkg/package.json'],
  'home/user/app/node_modules/dup-pkg/index.js': fixture['home/user/app/node_modules/dup-pkg/index.js'],
  [ASSET_KEY]: INJECTED,
};

const helper = await tryRealAssetHelper();

if (helper === null) {
  console.log('  (TDD-RED) helper not exported');
  check('asset present pre-helper', inputBundle[ASSET_KEY] === INJECTED);
} else {
  const counters = { totalBytes: 0, fileCount: Object.keys(inputBundle).length };
  for (const k of Object.keys(inputBundle)) counters.totalBytes += inputBundle[k].length;
  helper(vfs, cwd, inputBundle, counters);
  check(
    'pre-existing bundle entry untouched (idempotent)',
    inputBundle[ASSET_KEY] === INJECTED,
    `clobbered to: ${inputBundle[ASSET_KEY]}`,
  );
  check(
    'second invocation is also idempotent',
    (() => {
      helper(vfs, cwd, inputBundle, counters);
      return inputBundle[ASSET_KEY] === INJECTED;
    })(),
  );
}

const ok = summary();
process.exit(ok ? 0 : 1);
