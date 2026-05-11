#!/usr/bin/env bun
// require-resolution/dir-with-pkg-main — Node-spec directory resolution
// via <dir>/package.json#main for relative requires.
//
// Bug class C from /workspace/.seal-internal/2026-05-11-bug-class-audit/audit.md:
//
//   When CJS code does `require('./<dir>')` (or `require('./')` from
//   inside the dir's own files), Node spec is:
//     1. If the path resolves to a regular file → use it.
//     2. If it resolves to a directory:
//        a. Read <dir>/package.json; if it has `main`, resolve to that.
//        b. Else try <dir>/index.{js,json,node,mjs,cjs}.
//
//   Pre-fix, both Nimbus's runtime resolver (node-shims.ts:__resolveFile)
//   and prefetch resolver (require-resolver.ts:resolveFile) implemented
//   only step (2b). Step (2a) was missing, so any package whose entry
//   point is non-index (via `main`) is unreachable via directory require.
//
// Probe asserts (RED on pre-fix, GREEN post-fix):
//
//   1. Synthetic-flat: a directory with package.json#main='entry.js'
//      and an entry.js (no index.js) is loadable via `require('./mod')`.
//   2. Synthetic-nested: package.json#main='lib/api.js' (subdir, no
//      direct file at root) is loadable via `require('./mod')`. Tests
//      the recursive case where main itself points into a subdir.
//   3. Synthetic-self: a file inside the dir does `require('./')` to
//      self-load via its own package.json#main. This is the EXACT
//      shape of rimraf v3's bin.js (`require('./')` resolving to
//      rimraf.js via main). Bare-package `require('rimraf')` works
//      pre-fix because __resolveNodeModule's pkg-subpath path already
//      honours `main`; the bug is in the relative-require branch
//      that lands directly on __resolveFile.

import { Terminal, mintSession, sleep, makeAsserter, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[require-resolution/dir-with-pkg-main] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const A = makeAsserter('require-resolution/dir-with-pkg-main');

// ── Check 1: synthetic-flat ─────────────────────────────────────────
//
// Build:
//   /home/user/probe-flat/
//     consumer.js       — `require('./mod')` and prints sentinel
//     mod/package.json  — { "main": "./entry.js" }
//     mod/entry.js      — exports { SENTINEL: 'FLAT_OK' }
//
// Pre-fix expected: "Cannot find module './mod'" (resolveFile probes
//   /index.* and falls off the end).
// Post-fix expected: prints 'FLAT_OK'.

await t.run('rm -rf /home/user/probe-flat && mkdir -p /home/user/probe-flat/mod', 5_000);
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/probe-flat/mod/package.json', JSON.stringify({name:'mod',main:'./entry.js'}))"`,
  10_000,
);
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/probe-flat/mod/entry.js', 'module.exports = { SENTINEL: \\'FLAT_OK\\' };')"`,
  10_000,
);
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/probe-flat/consumer.js', 'const m = require(\\'./mod\\'); console.log(\\'RESULT=\\' + m.SENTINEL);')"`,
  10_000,
);
const flatResult = await t.run(
  'cd /home/user/probe-flat && node consumer.js',
  20_000,
);
A.check(
  'synthetic-flat: require("./mod") resolves via package.json#main → entry.js',
  /RESULT=FLAT_OK/.test(flatResult.output),
  flatResult.output.slice(-400),
);

// ── Check 2: synthetic-nested ───────────────────────────────────────
//
// Build:
//   /home/user/probe-nested/
//     consumer.js
//     mod/package.json    — { "main": "lib/api.js" }   (no leading ./)
//     mod/lib/api.js      — exports { SENTINEL: 'NESTED_OK' }
//
// Tests recursion: __resolveFile('mod/') → reads package.json#main →
//   recurses on 'mod/lib/api.js' → resolves to file.
// Also tests `main` without './' prefix (a common form).

await t.run('rm -rf /home/user/probe-nested && mkdir -p /home/user/probe-nested/mod/lib', 5_000);
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/probe-nested/mod/package.json', JSON.stringify({name:'mod',main:'lib/api.js'}))"`,
  10_000,
);
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/probe-nested/mod/lib/api.js', 'module.exports = { SENTINEL: \\'NESTED_OK\\' };')"`,
  10_000,
);
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/probe-nested/consumer.js', 'const m = require(\\'./mod\\'); console.log(\\'RESULT=\\' + m.SENTINEL);')"`,
  10_000,
);
const nestedResult = await t.run(
  'cd /home/user/probe-nested && node consumer.js',
  20_000,
);
A.check(
  'synthetic-nested: require("./mod") follows package.json#main into subdir lib/api.js',
  /RESULT=NESTED_OK/.test(nestedResult.output),
  nestedResult.output.slice(-400),
);

// ── Check 3: synthetic-self ─────────────────────────────────────────
//
// Mirrors rimraf v3's bin.js shape:
//   /home/user/probe-self/
//     consumer.js          — `const r = require('./pkg/bin.js')`
//     pkg/package.json     — { "main": "rimraf.js" }
//     pkg/rimraf.js        — module.exports = { SELF_SENTINEL: 'OK' }
//     pkg/bin.js           — `const r = require('./'); module.exports = r;`
//
// When consumer.js requires pkg/bin.js, bin.js runs and itself does
// `require('./')`. That bare './' must resolve to its own directory
// (pkg/) and follow package.json#main → rimraf.js. This is the
// EXACT bite of bug-class C in the wild.
//
// Pre-fix: bin.js throws "Cannot find module './'".
// Post-fix: bin.js returns the rimraf.js exports.

await t.run('rm -rf /home/user/probe-self && mkdir -p /home/user/probe-self/pkg', 5_000);
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/probe-self/pkg/package.json', JSON.stringify({name:'pkg',main:'rimraf.js'}))"`,
  10_000,
);
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/probe-self/pkg/rimraf.js', 'module.exports = { SELF_SENTINEL: \\'SELF_OK\\' };')"`,
  10_000,
);
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/probe-self/pkg/bin.js', 'const r = require(\\'./\\'); module.exports = r;')"`,
  10_000,
);
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/probe-self/consumer.js', 'const r = require(\\'./pkg/bin.js\\'); console.log(\\'RESULT=\\' + r.SELF_SENTINEL);')"`,
  10_000,
);
const selfResult = await t.run(
  'cd /home/user/probe-self && node consumer.js',
  20_000,
);
A.check(
  'synthetic-self: require("./") from inside a directory resolves via own package.json#main (rimraf-shape)',
  /RESULT=SELF_OK/.test(selfResult.output),
  selfResult.output.slice(-500),
);

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
