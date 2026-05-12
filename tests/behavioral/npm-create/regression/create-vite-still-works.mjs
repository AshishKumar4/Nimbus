#!/usr/bin/env bun
// npm-create/regression/create-vite-still-works — preserve npm-create-fix
// (MAX_PKG_FILES 200→1000 bump on 2026-05-12).
//
// Verifies the prior wave's fix that bumped the bundle-cap to 1000
// still applies and create-vite scaffolds end-to-end (every file
// readable, package.json present, src/main.js present).

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('npm-create/regression/create-vite-still-works');
console.log(`npm-create/regression/create-vite-still-works — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

function tail(s, n = 600) { return s.length > n ? '…' + s.slice(-n) : s; }

// Scaffold vite-vanilla.
const r1 = await t.run(
  'npm create vite@latest test-vite -- --template vanilla --yes 2>&1; echo RC=$?',
  240_000,
);
const out = stripAnsi(r1.output);
a.check('create-vite: no ENOENT in scaffold output',
  !/"code":"ENOENT"/.test(out),
  `tail=${JSON.stringify(tail(out))}`);

// Verify the expected file set landed.
const r2 = await t.run('ls test-vite 2>&1; echo RC=$?', 15_000);
const lsOut = stripAnsi(r2.output);
a.check('test-vite/ contains package.json',
  /package\.json/.test(lsOut),
  `ls=${JSON.stringify(tail(lsOut, 300))}`);
a.check('test-vite/ contains index.html',
  /index\.html/.test(lsOut),
  `ls=${JSON.stringify(tail(lsOut, 300))}`);

const r3 = await t.run('ls test-vite/src 2>&1; echo RC=$?', 15_000);
const srcOut = stripAnsi(r3.output);
a.check('test-vite/src/ contains main.js',
  /main\.js/.test(srcOut),
  `ls=${JSON.stringify(tail(srcOut, 300))}`);

// Verify package.json is non-trivially populated.
const r4 = await t.run('cat test-vite/package.json 2>&1; echo RC=$?', 15_000);
const pkgOut = stripAnsi(r4.output);
a.check('test-vite/package.json has scripts.dev',
  /"dev"\s*:/.test(pkgOut),
  `cat=${JSON.stringify(tail(pkgOut, 300))}`);

await t.close();

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
