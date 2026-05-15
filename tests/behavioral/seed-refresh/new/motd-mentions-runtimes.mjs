#!/usr/bin/env bun
// seed-refresh/new/motd-mentions-runtimes — the etc/motd banner that
// prints on every shell boot MUST list clang/python/ruby in the
// runtime line, and MUST mention REPLs + `nimbus install` in the
// capability line. Pre-fix the banner advertised only
// `node · npm · esbuild · vite · wrangler dev` and
// `10 GB VFS · Dynamic Workers · HMR`.
//
// Category: H (structural assertion on file content — the banner is
// the literal first thing the user sees on connect).

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('seed-refresh/motd-mentions-runtimes');
console.log(`seed-refresh/motd-mentions-runtimes — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

const { output } = await t.run('cat /etc/motd', 10_000);
const out = stripAnsi(output);

a.check('motd lists clang', /\bclang\b/.test(out), out.slice(-500));
a.check('motd lists python', /\bpython\b/.test(out), out.slice(-500));
a.check('motd lists ruby',   /\bruby\b/.test(out),   out.slice(-500));
a.check('motd mentions REPLs',          /REPLs/.test(out),          out.slice(-500));
a.check('motd mentions `nimbus install`',/nimbus install/.test(out), out.slice(-500));

// Regression — still mentions the core JS toolchain.
a.check('motd still lists node', /\bnode\b/.test(out), out.slice(-500));
a.check('motd still lists npm',  /\bnpm\b/.test(out),  out.slice(-500));
a.check('motd still lists vite', /\bvite\b/.test(out), out.slice(-500));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
