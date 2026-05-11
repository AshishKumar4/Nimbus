#!/usr/bin/env bun
// require-resolution/multiline-import — prefetch sees through multi-
// line `import` / `export-from` statements that contain comments.
//
// Root cause (esbuild-ast-rewrite wave, 2026-05-11):
//
//   require-resolver.ts:87 IMPORT_RE uses a lazy character class
//   `[\w*${}\s,]*?` for the bindings list between `{` and `from`.
//   Characters like `/` (in `//` or `/*`) are NOT in the class, so any
//   embedded comment breaks the match — the regex never reaches `from
//   "..."` and the import goes unrecorded. Prefetch then doesn't ship
//   the imported file. At runtime the facet's __require('./x') throws
//   "Cannot find module './x'".
//
//   Real-world bite: chalk@5's source/index.js (lines 3-6):
//
//     import { // eslint-disable-line import/order
//       stringReplaceAll,
//       stringEncaseCRLFWithFirstIndex,
//     } from './utilities.js';
//
//   The `// eslint-disable-line import/order` comment is right after
//   `{`. Regex misses. utilities.js doesn't ship. Bundle is broken.
//
// Fix: pre-strip `//` and `/* */` comments to whitespace (newline-
// preserved) before running the regex. Empirical correctness check:
// post-strip, the regex finds the same 4 specifiers that an esbuild-
// AST extractor finds. See `.seal-internal/2026-05-11-esbuild-ast-
// rewrite/correctness-result.txt` and `post-fix-correctness.txt`.
//
// Probe asserts:
//   1. synthetic-line-comment-after-brace: `import { // c\n a, b\n} from './x';`
//      ships ./x.js in the bundle
//   2. synthetic-block-comment-after-brace: `import { /* c */\n a, b\n} from './x';`
//      ships ./x.js
//   3. synthetic-export-from-with-comment: `export {\n a,\n // TODO\n b\n} from './y';`
//      ships ./y.js
//   4. synthetic-line-clean (regression): `import {\n a, b\n} from './c';` still works
//   5. wild-chalk: chalk@5 source/index.js loads — utilities.js + vendor/ansi-styles/index.js
//      both reachable

import { Terminal, mintSession, sleep, makeAsserter, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[require-resolution/multiline-import] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const A = makeAsserter('require-resolution/multiline-import');

async function writeFile(path, contents) {
  await t.run(`cat > ${path} << 'NIMBUS_HEREDOC_EOF'\n${contents}\nNIMBUS_HEREDOC_EOF`, 10_000);
}

function tail(s, n = 400) { return s.slice(Math.max(0, s.length - n)); }

// ── Check 1: synthetic line-comment-after-brace ─────────────────────
//
// `import { // c\n a, b\n} from './x';` — chalk shape. Without the
// comment-strip fix, prefetch IMPORT_RE misses the entry and ./x.js
// never enters the bundle. Consumer require throws.

await t.run('rm -rf /home/user/ml-line && mkdir -p /home/user/ml-line/node_modules/mypkg/lib', 5_000);
await writeFile('/home/user/ml-line/node_modules/mypkg/package.json', JSON.stringify({
  name: 'mypkg', type: 'module', main: './lib/index.js',
}));
await writeFile('/home/user/ml-line/node_modules/mypkg/lib/x.js',
  "module.exports = { hello: 'LINE_COMMENT_OK' };");
await writeFile('/home/user/ml-line/node_modules/mypkg/lib/index.js', `import { // ESLint disable comment after brace
  hello,
} from './x.js';
module.exports = { hello };`);
await writeFile('/home/user/ml-line/consume.js',
  "const m = require('mypkg'); console.log('RESULT_LINE=' + m.hello);");

{
  const r = await t.run('cd /home/user/ml-line && node consume.js', 60_000);
  const ok = /RESULT_LINE=LINE_COMMENT_OK/.test(r.output);
  A.check('Check 1: line-comment-after-brace — ./x.js prefetched and loadable',
    ok, tail(r.output));
}

// ── Check 2: synthetic block-comment-after-brace ────────────────────

await t.run('rm -rf /home/user/ml-block && mkdir -p /home/user/ml-block/node_modules/mypkg/lib', 5_000);
await writeFile('/home/user/ml-block/node_modules/mypkg/package.json', JSON.stringify({
  name: 'mypkg', type: 'module', main: './lib/index.js',
}));
await writeFile('/home/user/ml-block/node_modules/mypkg/lib/y.js',
  "module.exports = { hello: 'BLOCK_COMMENT_OK' };");
await writeFile('/home/user/ml-block/node_modules/mypkg/lib/index.js', `import { /* block c */
  hello,
} from './y.js';
module.exports = { hello };`);
await writeFile('/home/user/ml-block/consume.js',
  "const m = require('mypkg'); console.log('RESULT_BLOCK=' + m.hello);");

{
  const r = await t.run('cd /home/user/ml-block && node consume.js', 60_000);
  const ok = /RESULT_BLOCK=BLOCK_COMMENT_OK/.test(r.output);
  A.check('Check 2: block-comment-after-brace — ./y.js prefetched and loadable',
    ok, tail(r.output));
}

// ── Check 3: synthetic export-from-with-internal-comment ────────────
//
// Chalk also has multi-line `export {\n a,\n // TODO comment\n b,\n}
// from './vendor/ansi-styles/index.js'` (lines 196-209). Same bug
// class. Test the export-from variant.

await t.run('rm -rf /home/user/ml-exp && mkdir -p /home/user/ml-exp/node_modules/mypkg/lib', 5_000);
await writeFile('/home/user/ml-exp/node_modules/mypkg/package.json', JSON.stringify({
  name: 'mypkg', type: 'module', main: './lib/index.js',
}));
await writeFile('/home/user/ml-exp/node_modules/mypkg/lib/z.js',
  "module.exports = { greet: () => 'EXPORT_FROM_OK' };");
await writeFile('/home/user/ml-exp/node_modules/mypkg/lib/index.js', `export {
  greet,
  // TODO: remove this re-export in the next major
} from './z.js';`);
await writeFile('/home/user/ml-exp/consume.js',
  "const m = require('mypkg'); console.log('RESULT_EXPORT=' + m.greet());");

{
  const r = await t.run('cd /home/user/ml-exp && node consume.js', 60_000);
  const ok = /RESULT_EXPORT=EXPORT_FROM_OK/.test(r.output);
  A.check('Check 3: export-from with comment between bindings — ./z.js prefetched and loadable',
    ok, tail(r.output));
}

// ── Check 4: synthetic clean-multi-line (regression net) ────────────
//
// The clean multi-line case already matched IMPORT_RE pre-fix.
// Stripping comments must not break it.

await t.run('rm -rf /home/user/ml-clean && mkdir -p /home/user/ml-clean/node_modules/mypkg/lib', 5_000);
await writeFile('/home/user/ml-clean/node_modules/mypkg/package.json', JSON.stringify({
  name: 'mypkg', type: 'module', main: './lib/index.js',
}));
await writeFile('/home/user/ml-clean/node_modules/mypkg/lib/c.js',
  "module.exports = { hello: 'CLEAN_MULTI_OK' };");
await writeFile('/home/user/ml-clean/node_modules/mypkg/lib/index.js', `import {
  hello,
} from './c.js';
module.exports = { hello };`);
await writeFile('/home/user/ml-clean/consume.js',
  "const m = require('mypkg'); console.log('RESULT_CLEAN=' + m.hello);");

{
  const r = await t.run('cd /home/user/ml-clean && node consume.js', 60_000);
  const ok = /RESULT_CLEAN=CLEAN_MULTI_OK/.test(r.output);
  A.check('Check 4: regression — clean multi-line import still works',
    ok, tail(r.output));
}

// ── Check 5: wild-chalk ─────────────────────────────────────────────
//
// Real chalk@5 install. chalk/source/index.js has BOTH multi-line
// shapes that the regex used to miss (lines 3-6 import and lines
// 196-209 export). All four specifiers must reach the bundle:
//   - #ansi-styles, #supports-color (imports-field — chalk-imports-
//     field wave already handles these)
//   - ./utilities.js (this wave's bug case 1)
//   - ./vendor/ansi-styles/index.js (this wave's bug case 2)

await t.run('rm -rf /home/user/wild-chalk && mkdir -p /home/user/wild-chalk', 5_000);
await writeFile('/home/user/wild-chalk/package.json', JSON.stringify({
  name: 'wild-chalk', type: 'module',
}));
await t.run('cd /home/user/wild-chalk', 5_000);
{
  const r = await t.run('npm install chalk@5', 180_000);
  const installed = /added \d+ packages|up to date/i.test(r.output) && !/npm ERR!/i.test(r.output);
  A.check('Check 5a: npm install chalk@5 succeeded', installed, tail(r.output));
}
await writeFile('/home/user/wild-chalk/use.js',
  "const chalk = require('chalk'); console.log('CHALK_OK=' + (typeof chalk.green === 'function' || typeof chalk.default?.green === 'function'));");

{
  const r = await t.run('node use.js', 60_000);
  const ok = /CHALK_OK=true/.test(r.output);
  const errClass = /Cannot find module ['"]\.\/utilities\.js['"]/.test(r.output)
    ? 'utilities.js still missing (this wave\'s root cause unfixed)'
    : /Cannot find module ['"]#ansi-styles['"]/.test(r.output)
    ? 'imports-field path missing (chalk-imports-field regression)'
    : /Cannot find module/.test(r.output)
    ? 'next-layer Cannot find module'
    : null;
  A.check('Check 5b: real chalk@5 loads without "Cannot find module"',
    ok, errClass ? `error class: ${errClass} — ${tail(r.output)}` : tail(r.output));
}

await t.close();

const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
