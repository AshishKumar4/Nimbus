#!/usr/bin/env bun
// npm-create/regression/manifest-bundle-parity — defends the bump from
// regression. Builds a synthetic 250-file fake-pkg, then from INSIDE a
// facet at that pkgRoot asserts read-success === manifest-visible.
//
// PRE-fix (MAX_PKG_FILES=200) on a 250-file pkg: read-success ~140,
// manifest-visible ~250 → drift of ~110 missing files.
// POST-fix (MAX_PKG_FILES=1000): drift = 0; every file in the manifest
// is also in the bundle and reads successfully.
//
// This probe defends against future regressions of the cap (e.g.
// someone lowering it back to 200 thinking it's a "memory savings").

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('npm-create/regression/manifest-bundle-parity');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

// Build a synthetic pkg at /tmp/.npx-cache/node_modules/synthetic-pkg/
// with 250 small files spread across nested subdirs. We seed an
// `index.js` at the pkg root so a `node /tmp/.../synthetic-pkg/index.js`
// invocation triggers addBinTargetSiblings's BFS walk over the pkg.
//
// Layout:
//   synthetic-pkg/
//     index.js         (the bin entry — runs the parity check)
//     package.json     (mark as a node pkg)
//     dir-A/file-001..050  (50)
//     dir-B/file-001..050  (50)
//     dir-C/file-001..050  (50)
//     dir-D/file-001..050  (50)
//     dir-E/file-001..050  (50)
//   total: 252 files (250 leaves + index.js + package.json)
const seedScript = `
const fs = require('fs');
const root = '/tmp/.npx-cache/node_modules/synthetic-pkg';
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(root + '/package.json', JSON.stringify({ name: 'synthetic-pkg', version: '0.0.0' }));

// Seed the bin entry — when invoked later, it walks pkgRoot via
// node-shim fs.readdirSync + readFileSync to count manifest/bundle parity.
const binBody = \`
const fs = require('fs');
const root = __dirname;
function walk(dir, files) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const n of entries) {
    if (n === 'index.js') continue;
    const full = dir + '/' + n;
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, files);
    else files.push(full);
  }
}
const found = [];
walk(root, found);
let readSuccess = 0;
let readFail = 0;
for (const f of found) {
  try { fs.readFileSync(f); readSuccess++; }
  catch { readFail++; }
}
console.log('MANIFEST_VISIBLE=' + found.length);
console.log('READ_SUCCESS=' + readSuccess);
console.log('READ_FAIL=' + readFail);
console.log('PARITY=' + (found.length === readSuccess && readFail === 0 ? 'OK' : 'DRIFT'));
\`;
fs.writeFileSync(root + '/index.js', binBody);

const dirs = ['dir-A', 'dir-B', 'dir-C', 'dir-D', 'dir-E'];
for (const d of dirs) {
  fs.mkdirSync(root + '/' + d, { recursive: true });
  for (let i = 1; i <= 50; i++) {
    const num = String(i).padStart(3, '0');
    // Use distinct content per file so the bundle can't be tricked by
    // content-deduplication (which Nimbus doesn't do, but defense in
    // depth). 64 bytes each.
    const content = (d + '/file-' + num + ': lorem ipsum filler ' + '#'.repeat(20)).slice(0, 64);
    fs.writeFileSync(root + '/' + d + '/file-' + num + '.txt', content);
  }
}
console.log('SEEDED');
`;

// Write seed script to user dir + run it via node to materialize the
// synthetic pkg into the user VFS.
await t.run(heredocCommand('seed.js', seedScript), 15_000);
const rSeed = await t.run('node seed.js', 60_000);
const outSeed = stripAnsi(rSeed.output);
a.check('synthetic pkg seeded',
  /SEEDED/.test(outSeed),
  JSON.stringify(outSeed.slice(-400)));

// Sanity-check count via the shell (uses SqliteVFS directly).
const rShellCount = await t.run(
  'find /tmp/.npx-cache/node_modules/synthetic-pkg -type f | wc -l',
  15_000,
);
const outCount = stripAnsi(rShellCount.output);
const totalMatch = outCount.match(/(\d+)/);
const total = totalMatch ? parseInt(totalMatch[1], 10) : 0;
a.check(`synthetic pkg has 252 files via shell (got ${total})`,
  total === 252,
  JSON.stringify(outCount.slice(-200)));

// Now invoke the bin: `node /tmp/.../synthetic-pkg/index.js` triggers
// addBinTargetSiblings on the pkg root. Inside the facet, the bin
// script walks the pkg and counts manifest-visible vs read-success.
const rRun = await t.run(
  'node /tmp/.npx-cache/node_modules/synthetic-pkg/index.js 2>&1',
  60_000,
);
const outRun = stripAnsi(rRun.output);

const manifestVisible = parseInt(outRun.match(/MANIFEST_VISIBLE=(\d+)/)?.[1] || '0', 10);
const readSuccess = parseInt(outRun.match(/READ_SUCCESS=(\d+)/)?.[1] || '0', 10);
const readFail = parseInt(outRun.match(/READ_FAIL=(\d+)/)?.[1] || '0', 10);
const parityOk = /PARITY=OK/.test(outRun);

// Note: 251 = 250 leaves + package.json (index.js is filtered out
// inside the walker). Allow ±1 for the seed script's exact count.
a.check(`manifest visibility ≥ 250 (got ${manifestVisible})`,
  manifestVisible >= 250,
  JSON.stringify(outRun.slice(-400)));
a.check(`read-success === manifest-visible (POST-fix parity, got read=${readSuccess} manifest=${manifestVisible})`,
  readSuccess === manifestVisible,
  JSON.stringify(outRun.slice(-400)));
a.check(`read-fail === 0 (POST-fix has zero ENOENT for in-manifest files, got ${readFail})`,
  readFail === 0,
  JSON.stringify(outRun.slice(-400)));
a.check('PARITY=OK printed by bin script',
  parityOk,
  JSON.stringify(outRun.slice(-400)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
