#!/usr/bin/env bun
// wasi-write-caps/fopen-write — user's verbatim Twitter repro.
//
// PRE-SWAP (binji-2020 default): RED — fopen("greet.txt", "w") returns NULL
// and errno=76 ENOTCAPABLE because binji's bundled libc.a has a custom
// __wasilibc_init_preopen rights gate that bails before reaching path_open.
//
// POST-SWAP (wasi-sdk-19 default): GREEN — upstream wasi-libc reaches
// our wasi-instance.ts shim's path_open with proper preopen rights.
// greet.txt materializes in the VFS with the expected contents.
//
// Probe also runs the readback to assert end-to-end fopen-write +
// fopen-read symmetry.

import {
  Terminal, mintSession, makeAsserter, stripAnsi, heredocCommand, BASE,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi-write-caps/fopen-write');
console.log(`wasi-write-caps/fopen-write — ${BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Install clang. Defaults to wasi-sdk-19 post-swap (additive R2 catalog
// already has it; default flip happens after P0 spike validates).
await t.run('nimbus install clang', 240_000);

// User's verbatim repro: write greet.txt then read it back.
const demoC = `#include <stdio.h>
#include <time.h>
int main(void) {
  FILE *f = fopen("greet.txt", "w");
  if (!f) { perror("fopen write"); return 1; }
  fprintf(f, "hello, world!\\n");
  fprintf(f, "written at unix time %ld\\n", (long)time(NULL));
  fclose(f);

  FILE *r = fopen("greet.txt", "r");
  if (!r) { perror("fopen read"); return 2; }
  char buf[256];
  while (fgets(buf, sizeof buf, r)) fputs(buf, stdout);
  fclose(r);
  return 0;
}`;
await t.run(heredocCommand('demo.c', demoC), 15_000);

// Compile + link.
{
  const { output, elapsed } = await t.run('clang demo.c -o demo', 300_000);
  const stripped = stripAnsi(output);
  const noErr = !/error:|fatal:/i.test(stripped);
  a.check('clang demo.c -o demo (no errors)',
    noErr, noErr ? `elapsed=${elapsed}ms` : `tail=${JSON.stringify(stripped.slice(-400))}`);
}

// Run the binary.
let runOutput = '';
{
  const { output, elapsed } = await t.run('./demo', 60_000);
  runOutput = stripAnsi(output);

  const notCmdNotFound = !/\.\/demo: command not found/.test(runOutput);
  a.check('./demo dispatches (not command-not-found)',
    notCmdNotFound, notCmdNotFound ? '' : JSON.stringify(runOutput.slice(-300)));

  // RED-baseline marker: binji-2020 prints "fopen write: Capabilities insufficient"
  // or similar errno=76 message.
  const enotcapable = /Capabilities insufficient|ENOTCAPABLE|errno=76|cannot.{0,40}fopen/i.test(runOutput);
  a.check('NO ENOTCAPABLE / errno=76 (RED-baseline marker absent)',
    !enotcapable, enotcapable ? `binji libc rights-gate hit. tail=${JSON.stringify(runOutput.slice(-400))}` : '');

  // GREEN markers — the expected stdout contents.
  const hello = /hello, world!/.test(runOutput);
  a.check('stdout contains "hello, world!" (fopen-write+read roundtrip)',
    hello && notCmdNotFound, hello ? `elapsed=${elapsed}ms` : `tail=${JSON.stringify(runOutput.slice(-400))}`);

  const unixTime = /written at unix time \d+/.test(runOutput);
  a.check('stdout contains "written at unix time NNN"',
    unixTime && notCmdNotFound, unixTime ? '' : `tail=${JSON.stringify(runOutput.slice(-400))}`);
}

// Sanity: confirm the file actually materialized in the VFS (separate
// from stdout — the readback in the C program could have buffered, but
// `ls` is independent).
{
  const { output } = await t.run('ls -la greet.txt', 15_000);
  const stripped = stripAnsi(output);
  const present = /greet\.txt/.test(stripped) && !/No such file/.test(stripped);
  a.check('greet.txt materialized in VFS', present,
    present ? '' : `ls output=${JSON.stringify(stripped.slice(-300))}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
