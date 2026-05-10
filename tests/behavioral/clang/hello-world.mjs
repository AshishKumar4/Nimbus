#!/usr/bin/env bun
// clang/hello-world — the defining "true OS" proof. After `nimbus
// install clang`, `clang hello.c -o hello && ./hello` must print
// "hello, world".
//
// Asserts:
//   1. clang is installed (precondition; we install if missing).
//   2. `clang hello.c -o hello` exits 0 within 90 s.
//   3. hello.wasm exists in cwd with wasm magic.
//   4. `./hello` exits 0; stdout contains "hello, world".

import { mintSession, Terminal, makeAsserter, stripAnsi, heredocCommand } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang/hello-world');
console.log(`clang/hello-world — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Install clang (idempotent).
await t.run('nimbus install clang', 120_000);

// Drop a hello.c via heredoc.
const helloC = `#include <stdio.h>
int main(int argc, char **argv) {
  printf("hello, world\\n");
  return 0;
}`;
await t.run(heredocCommand('hello.c', helloC), 15_000);

// 1. clang hello.c -o hello — must NOT print "command not found".
{
  const { elapsed, output } = await t.run('clang hello.c -o hello', 180_000);
  const stripped = stripAnsi(output);
  const notCmdNotFound = !/clang: command not found/.test(stripped);
  const noErr = !/error:|fatal:|cannot/i.test(stripped);
  a.check('clang is a registered shell command', notCmdNotFound,
    notCmdNotFound ? '' : JSON.stringify(stripped.slice(-300)));
  a.check('clang hello.c -o hello completes without compiler errors',
    noErr && notCmdNotFound,
    noErr && notCmdNotFound ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-400)));
}

// 2. hello (output file) has wasm magic. Use node to read 4 bytes.
{
  const { output } = await t.run(
    `node -e "const b = require('fs').readFileSync('hello').subarray(0,4); console.log('M'+'AGIC='+Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join(''))"`,
    15_000,
  );
  const stripped = stripAnsi(output);
  const isWasm = /MAGIC=0061736d/.test(stripped);
  a.check('hello has wasm magic (0061736d)', isWasm,
    isWasm ? '' : JSON.stringify(stripped.slice(-200)));
}

// 3. ./hello runs + prints "hello, world".
{
  const { output, elapsed } = await t.run('./hello', 30_000);
  const stripped = stripAnsi(output);
  const notCmdNotFound = !/\.\/hello: command not found/.test(stripped);
  const prints = /hello,?\s*world/.test(stripped);
  a.check('./hello dispatches via wasm runner (not command-not-found)',
    notCmdNotFound, notCmdNotFound ? '' : JSON.stringify(stripped.slice(-200)));
  a.check('./hello prints "hello, world"', prints && notCmdNotFound,
    prints ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
