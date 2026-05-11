#!/usr/bin/env bun
// wasi-write-caps/helloworld-regression — confirm clang/hello-world's
// stdout-only path still works after the sysroot swap. This is the
// G4 proof gate in plan.md §5: "Existing clang smoke still works".
//
// Identical to tests/behavioral/clang/hello-world.mjs in shape, but
// lives in wasi-write-caps/ for cohort-locality. If the sysroot swap
// breaks anything, hello-world's printf path is the first to flip.

import {
  Terminal, mintSession, makeAsserter, stripAnsi, heredocCommand, BASE,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi-write-caps/helloworld-regression');
console.log(`wasi-write-caps/helloworld-regression — ${BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install clang', 240_000);

const helloC = `#include <stdio.h>
int main(void) { printf("hello, world\\n"); return 0; }`;
await t.run(heredocCommand('hello.c', helloC), 15_000);

{
  const { elapsed, output } = await t.run('clang hello.c -o hello', 300_000);
  const stripped = stripAnsi(output);
  const noErr = !/error:|fatal:/i.test(stripped);
  a.check('clang hello.c -o hello (no errors)',
    noErr, noErr ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-400)));
}

{
  const { output, elapsed } = await t.run('./hello', 60_000);
  const stripped = stripAnsi(output);
  const prints = /hello,\s*world/.test(stripped);
  a.check('./hello prints "hello, world"',
    prints, prints ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-300)));
  // No-op test: no error markers from the new libc.
  const noErr = !/error:|fatal:|errno=\d+/i.test(stripped);
  a.check('./hello stdout has NO error markers',
    noErr, noErr ? '' : JSON.stringify(stripped.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
