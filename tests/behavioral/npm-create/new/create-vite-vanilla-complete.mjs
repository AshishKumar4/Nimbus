#!/usr/bin/env bun
// npm-create/new/create-vite-vanilla-complete — THE flagship fix probe.
//
// PRE-fix (prod 11df6ca, facets/manager.ts MAX_PKG_FILES = 200):
//   `npm create vite@latest test-vite -- --template vanilla --yes`
//   produced ONLY two files: `.gitignore` (253B) + `index.html` (359B).
//   `package.json`, `public/`, `src/` and the full template tree were
//   missing. Exit code was 0 (silent partial failure). The facet's
//   __vfsBundle was capped at 200 visited entries during
//   addBinTargetSiblings's BFS walk of the create-vite pkg root (242
//   files + 74 dirs = 316 entries); late-alphabetical templates'
//   deep files (template-vanilla/src/main.js etc.) threw ENOENT on
//   readFileSync from inside the facet.
//
// POST-fix (this wave, MAX_PKG_FILES = 1000): all 11 vite-vanilla
// template files materialize correctly in the user's session VFS.
//
// Probe contract: drive a fresh prod session, run the exact command
// users hit, assert each expected file exists with non-trivial size
// AND that `package.json` is valid JSON with the expected vite-bundle
// shape (name + scripts.dev + devDependencies.vite).

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('npm-create/new/create-vite-vanilla-complete');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

// Run the canonical user command. Use a unique target dir name so the
// probe is idempotent across runs in the same session (it's a fresh
// session per mintSession so collision risk is zero, but the name
// makes the intent explicit).
const rCreate = await t.run(
  'npm create vite@latest test-vite -- --template vanilla --yes 2>&1; echo CREATE_RC=$?',
  300_000,
);
const outC = stripAnsi(rCreate.output);
a.check('npm create exits 0', /CREATE_RC=0/.test(outC),
  JSON.stringify(outC.slice(-400)));
a.check('npm create does NOT leak ENOENT JSON to stdout (PRE-fix smoking gun)',
  !/"code":"ENOENT","errno":-2/.test(outC),
  JSON.stringify(outC.slice(-400)));

// Verify each expected file exists. Vite-vanilla v9 template ships:
//   .gitignore  (renamed from _gitignore via create-vite's pt[] map)
//   index.html
//   package.json
//   public/favicon.svg
//   public/icons.svg
//   src/main.js
//   src/counter.js
//   src/style.css
//   src/assets/hero.png
//   src/assets/javascript.svg
//   src/assets/vite.svg
const expectedFiles = [
  ['.gitignore',                  10],
  ['index.html',                  100],
  ['package.json',                50],
  ['public/favicon.svg',          50],
  ['public/icons.svg',            50],
  ['src/main.js',                 20],
  ['src/counter.js',              20],
  ['src/style.css',               20],
  ['src/assets/javascript.svg',   50],
  ['src/assets/vite.svg',         50],
];

for (const [rel, minSize] of expectedFiles) {
  const r = await t.run(`wc -c test-vite/${rel} 2>&1`, 15_000);
  const out = stripAnsi(r.output);
  const m = out.match(/(\d+)\s+test-vite\//);
  const size = m ? parseInt(m[1], 10) : 0;
  a.check(`test-vite/${rel} exists with size > ${minSize}B (size=${size})`,
    size > minSize,
    size > minSize ? '' : JSON.stringify(out.slice(-300)));
}

// Assert package.json is valid JSON with the expected vite-bundle shape.
const rPkg = await t.run('cat test-vite/package.json', 15_000);
const pkgRaw = stripAnsi(rPkg.output);
// Extract just the JSON body (drop the leading `cat ...` echo and trailing prompt).
const jsonStart = pkgRaw.indexOf('{');
const jsonEnd = pkgRaw.lastIndexOf('}');
let pkg = null;
if (jsonStart >= 0 && jsonEnd > jsonStart) {
  try { pkg = JSON.parse(pkgRaw.slice(jsonStart, jsonEnd + 1)); } catch { pkg = null; }
}
a.check('package.json is valid JSON', pkg !== null,
  pkg === null ? JSON.stringify(pkgRaw.slice(-400)) : '');
a.check('package.json has name field === "test-vite" (rewritten by create-vite)',
  pkg?.name === 'test-vite',
  pkg ? `name=${pkg.name}` : 'pkg=null');
a.check('package.json has scripts.dev (vite dev runner)',
  typeof pkg?.scripts?.dev === 'string' && /vite/.test(pkg.scripts.dev),
  pkg ? `scripts=${JSON.stringify(pkg.scripts)}` : 'pkg=null');
a.check('package.json has devDependencies.vite',
  pkg?.devDependencies && 'vite' in pkg.devDependencies,
  pkg ? `devDeps=${JSON.stringify(pkg.devDependencies)}` : 'pkg=null');

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
