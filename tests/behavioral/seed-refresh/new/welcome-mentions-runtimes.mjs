#!/usr/bin/env bun
// seed-refresh/new/welcome-mentions-runtimes — `~/welcome.txt` MUST
// document clang/python/ruby + `nimbus install` so new users can
// discover the multi-runtime story without leaving the terminal.
//
// Pre-fix the welcome only mentioned node/npm/esbuild/vite/wrangler/df —
// the entire package-manager + multi-language story (shipped in the
// pyodide-v2, ruby-v1, clang-state-fix waves) was invisible.
//
// Category: H (hybrid — structural file-content checks; the user-
// visible bug is "I can't tell from `cat welcome.txt` that nimbus
// supports more than JS", which is exactly what the regex asserts).

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('seed-refresh/welcome-mentions-runtimes');
console.log(`seed-refresh/welcome-mentions-runtimes — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

const { output } = await t.run('cat /home/user/welcome.txt', 10_000);
const out = stripAnsi(output);

a.check('welcome.txt mentions `nimbus install clang`', /nimbus install clang/.test(out),
  out.slice(-400));
a.check('welcome.txt mentions `nimbus install python`', /nimbus install python/.test(out),
  out.slice(-400));
a.check('welcome.txt mentions `nimbus install ruby`', /nimbus install ruby/.test(out),
  out.slice(-400));
a.check('welcome.txt shows the clang hello.c demo line', /clang hello\.c -o hello/.test(out),
  out.slice(-400));
a.check('welcome.txt mentions REPLs (Pyodide / ruby.wasm)', /Pyodide/.test(out) && /ruby\.wasm/.test(out),
  out.slice(-400));
a.check('welcome.txt mentions `nimbus install --list` discovery flag', /nimbus install --list/.test(out),
  out.slice(-400));

// Regression — pre-existing entries preserved.
a.check('welcome.txt still mentions `node hello.js`', /node hello\.js/.test(out),
  out.slice(-400));
a.check('welcome.txt still mentions `npm install`', /npm install <pkg>/.test(out),
  out.slice(-400));
a.check('welcome.txt still mentions `vite`', /\bvite\b/.test(out),
  out.slice(-400));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
