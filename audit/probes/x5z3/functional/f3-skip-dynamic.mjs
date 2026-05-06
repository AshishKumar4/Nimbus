// X.5-Z3 functional probe — dynamic / non-literal readFileSync forms
// are NOT picked up. Confirms the helper is bounded to static literals
// and does not over-collect.
//
// Pre-fix: RED (helper missing — probe asserts post-fix safety net).
// Post-fix: GREEN. Dynamic forms ignored; only static literals match.

import { makeVfs, tryRealAssetHelper, check, summary, reset } from '../_helpers.mjs';

reset();

console.log('X.5-Z3 functional/f3-skip-dynamic — dynamic forms safely skipped');

const fixture = {
  'home/user/app/node_modules/dyn-pkg/package.json': JSON.stringify({
    name: 'dyn-pkg',
    version: '0.0.0',
    main: './index.js',
  }),
  // ALL dynamic forms — none should match.
  'home/user/app/node_modules/dyn-pkg/index.js':
    'const fs = require("fs");\nconst path = require("path");\n' +
    // Template-literal interpolation
    'const a = fs.readFileSync(`${__dirname}/foo.css`, "utf8");\n' +
    // Variable
    'const NAME = "bar.css";\nconst b = fs.readFileSync(path.resolve(__dirname, NAME), "utf8");\n' +
    // Concatenation
    'const c = fs.readFileSync(__dirname + "/baz.css", "utf8");\n' +
    // Comment that mentions the pattern
    '// fs.readFileSync(path.resolve(__dirname, "comment.css"))\n' +
    // BUT one real static literal — should match
    'const d = fs.readFileSync(path.resolve(__dirname, "real.css"), "utf8");\n' +
    'module.exports = { a, b, c, d };\n',
  'home/user/app/node_modules/dyn-pkg/foo.css': 'foo',
  'home/user/app/node_modules/dyn-pkg/bar.css': 'bar',
  'home/user/app/node_modules/dyn-pkg/baz.css': 'baz',
  'home/user/app/node_modules/dyn-pkg/comment.css': 'comment',
  'home/user/app/node_modules/dyn-pkg/real.css': 'real',
};

const vfs = makeVfs(fixture);
const cwd = '/home/user/app';

const inputBundle = {
  'home/user/app/node_modules/dyn-pkg/package.json': fixture['home/user/app/node_modules/dyn-pkg/package.json'],
  'home/user/app/node_modules/dyn-pkg/index.js': fixture['home/user/app/node_modules/dyn-pkg/index.js'],
};

const helper = await tryRealAssetHelper();
const PRE = 'home/user/app/node_modules/dyn-pkg/';

if (helper === null) {
  console.log('  (TDD-RED) addStaticReadFileAssets not exported');
  // Pre-fix none are in bundle — but we want to assert the post-fix
  // contract; mark RED on real.css missing, GREEN on dynamic forms missing
  // (which they will be anyway).
  check('real.css prefetched (post-fix expectation)', PRE + 'real.css' in inputBundle, 'RED: helper missing');
  check('foo.css NOT prefetched (template-literal)', !(PRE + 'foo.css' in inputBundle));
  check('bar.css NOT prefetched (variable)', !(PRE + 'bar.css' in inputBundle));
  check('baz.css NOT prefetched (concat)', !(PRE + 'baz.css' in inputBundle));
  check('comment.css NOT prefetched (in comment)', !(PRE + 'comment.css' in inputBundle));
} else {
  const counters = { totalBytes: 0, fileCount: Object.keys(inputBundle).length };
  for (const k of Object.keys(inputBundle)) counters.totalBytes += inputBundle[k].length;
  helper(vfs, cwd, inputBundle, counters);
  check('real.css prefetched (static literal)', PRE + 'real.css' in inputBundle);
  check('foo.css NOT prefetched (template-literal)', !(PRE + 'foo.css' in inputBundle), 'still in bundle — over-collection');
  check('bar.css NOT prefetched (variable)', !(PRE + 'bar.css' in inputBundle));
  check('baz.css NOT prefetched (concat)', !(PRE + 'baz.css' in inputBundle));
  check('comment.css NOT prefetched (in comment)', !(PRE + 'comment.css' in inputBundle));
}

const ok = summary();
process.exit(ok ? 0 : 1);
