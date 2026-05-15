#!/usr/bin/env bun
// seed-refresh/regression/hello-js-still-seeded — the pre-existing
// `~/hello.js` Node demo MUST remain seeded after we add `hello.c`
// alongside it. Also asserts welcome.txt still preserves the canonical
// node/npm/vite hint lines (the new content is additive).
//
// Category: R (runtime-behavioral).

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('seed-refresh/hello-js-still-seeded');
console.log(`seed-refresh/hello-js-still-seeded — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

function hasOutputLine(stripped, marker) {
  const lines = stripped.split(/\r?\n/).map((l) => l.trim());
  return lines.some((l) => l === marker);
}

// 1. hello.js exists.
{
  const r = await t.run('ls /home/user/hello.js 2>&1', 10_000);
  const out = stripAnsi(r.output);
  const ok = /\/home\/user\/hello\.js/.test(out) && !/ENOENT|No such/.test(out);
  a.check('~/hello.js still seeded', ok, ok ? '' : JSON.stringify(out.slice(-300)));
}

// 2. Its content still has the canonical markers.
{
  const r = await t.run('cat /home/user/hello.js', 10_000);
  const out = stripAnsi(r.output);
  const ok = /Hello from Nimbus!/.test(out) && /Dynamic Worker isolate/.test(out);
  a.check('hello.js content preserved (canonical markers)', ok,
    ok ? '' : JSON.stringify(out.slice(-400)));
}

// 3. Running it actually works (end-to-end Node).
{
  const r = await t.run('node /home/user/hello.js', 30_000);
  const out = stripAnsi(r.output);
  const ok = hasOutputLine(out, 'Hello from Nimbus!');
  a.check('node hello.js prints the canonical greeting', ok,
    ok ? '' : JSON.stringify(out.slice(-400)));
}

// 4. welcome.txt still includes the original `node hello.js` line.
{
  const r = await t.run('cat /home/user/welcome.txt', 10_000);
  const out = stripAnsi(r.output);
  a.check('welcome.txt still has `node hello.js` line', /node hello\.js/.test(out),
    out.slice(-400));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
