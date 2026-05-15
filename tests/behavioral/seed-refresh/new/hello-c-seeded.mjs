#!/usr/bin/env bun
// seed-refresh/new/hello-c-seeded — a fresh session MUST contain
// `~/hello.c` (symmetric with the pre-existing `~/hello.js` Node demo).
// Pre-fix the seed pipeline only wrote hello.js; users following the
// repo README's `clang hello.c -o hello && ./hello` walkthrough had to
// hand-type the source first.
//
// Category: R (runtime-behavioral). End-to-end check: file is seeded
// AND `nimbus install clang && clang hello.c -o hello && ./hello`
// produces the expected output, exercising the full integration.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('seed-refresh/hello-c-seeded');
console.log(`seed-refresh/hello-c-seeded — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// EXACT-line matcher — terminal echoes the command line itself, so
// substring search would falsely match the echo.
function hasOutputLine(stripped, marker) {
  const lines = stripped.split(/\r?\n/).map((l) => l.trim());
  return lines.some((l) => l === marker);
}

// 1. ~/hello.c exists on a fresh session.
{
  const r = await t.run('ls /home/user/hello.c 2>&1', 10_000);
  const out = stripAnsi(r.output);
  const ok = /\/home\/user\/hello\.c/.test(out) && !/ENOENT|No such/.test(out);
  a.check('~/hello.c exists in fresh session', ok,
    ok ? '' : JSON.stringify(out.slice(-300)));
}

// 2. The seeded source contains the canonical `printf("Hello from Nimbus C!")` line.
{
  const r = await t.run('cat /home/user/hello.c', 10_000);
  const out = stripAnsi(r.output);
  const ok = /Hello from Nimbus C!/.test(out) && /#include\s*<stdio\.h>/.test(out);
  a.check('seeded hello.c has #include <stdio.h> and the printf marker', ok,
    ok ? '' : JSON.stringify(out.slice(-300)));
}

// 3. End-to-end: install clang, compile, run.
await t.run('nimbus install clang', 300_000);
{
  const r = await t.run('cd /home/user && clang hello.c -o hello && ./hello', 120_000);
  const out = stripAnsi(r.output);
  const ok = hasOutputLine(out, 'Hello from Nimbus C!');
  a.check('clang hello.c -o hello && ./hello prints "Hello from Nimbus C!"', ok,
    ok ? '' : JSON.stringify(out.slice(-400)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
