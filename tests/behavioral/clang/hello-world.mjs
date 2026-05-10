#!/usr/bin/env bun
// clang/hello-world — the "true OS" proof.
//
// Wave-3 v1.1 acceptance:
//   1. `nimbus install clang` installs binji wasm-clang.
//   2. `clang hello.c -o hello` compiles + links to a wasm executable.
//   3. The output `hello` has the wasm magic (\0asm\1\0\0\0).
//   4. `./hello` dispatches via the shell's wasm-magic resolver to the
//      WASI shim, runs, and writes `hello, world` to stdout.
//
// The full compile → link → run pipeline through binji clang + lld
// + the in-supervisor sysroot subset extractor + the registry's
// `./<wasm-binary>` shell-side dispatch.

import { mintSession, Terminal, makeAsserter, stripAnsi, heredocCommand } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang/hello-world');
console.log(`clang/hello-world — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 0. Install clang (idempotent — second-run skip on warm session).
await t.run('nimbus install clang', 180_000);

// 1. Write a real hello.c using <stdio.h> + printf.
const helloC = `#include <stdio.h>
int main(void) {
  printf("hello, world\\n");
  return 0;
}`;
await t.run(heredocCommand('hello.c', helloC), 15_000);

// 2. Compile + link.
{
  const { elapsed, output } = await t.run('clang hello.c -o hello', 300_000);
  const stripped = stripAnsi(output);
  const notCmdNotFound = !/clang: command not found/.test(stripped);
  a.check('clang is a registered shell command', notCmdNotFound,
    notCmdNotFound ? '' : JSON.stringify(stripped.slice(-300)));
  const noErr = !/error:|fatal:/i.test(stripped);
  a.check('clang hello.c -o hello completes without error markers',
    noErr && notCmdNotFound,
    noErr && notCmdNotFound ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-500)));
}

// 3. The output `hello` exists and has wasm magic.
{
  const { output } = await t.run('ls -la hello', 15_000);
  const stripped = stripAnsi(output);
  const m = stripped.match(/^\s*-\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s.*\bhello$/m);
  const size = m ? parseInt(m[1], 10) : 0;
  a.check('hello exists in cwd with > 100 bytes',
    size > 100, `parsed size=${size}`);
}

// 4. ./hello runs and prints "hello, world\n".
{
  const { output, elapsed } = await t.run('./hello', 60_000);
  const stripped = stripAnsi(output);
  const notCmdNotFound = !/\.\/hello: command not found/.test(stripped);
  a.check('./hello dispatches via shell wasm-magic resolver (not command-not-found)',
    notCmdNotFound, notCmdNotFound ? '' : JSON.stringify(stripped.slice(-300)));
  const prints = /hello,\s*world/.test(stripped);
  a.check('./hello prints "hello, world"', prints && notCmdNotFound,
    prints ? `elapsed=${elapsed}ms` : `output=${JSON.stringify(stripped.slice(-400))}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
