#!/usr/bin/env bun
// clang/multi-translation-unit — compile two .c files separately, link
// them via wasm-ld; exercise the spawn-pool clang→lld dispatch.
//
// Asserts:
//   1. Two .c files compile to .o files.
//   2. wasm-ld linker produces a final .wasm.
//   3. The output runs and prints from both translation units.

import { mintSession, Terminal, makeAsserter, stripAnsi, heredocCommand } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang/multi-translation-unit');
console.log(`clang/multi-translation-unit — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Install clang (idempotent).
await t.run('nimbus install clang', 120_000);

// Two translation units sharing a header.
const greetH = `#ifndef GREET_H
#define GREET_H
void greet_a(void);
void greet_b(void);
#endif`;
const greetAC = `#include <stdio.h>
#include "greet.h"
void greet_a(void) { printf("greet_a\\n"); }`;
const greetBC = `#include <stdio.h>
#include "greet.h"
void greet_b(void) { printf("greet_b\\n"); }`;
const mainC = `#include "greet.h"
int main(void) { greet_a(); greet_b(); return 0; }`;

await t.run(heredocCommand('greet.h', greetH), 10_000);
await t.run(heredocCommand('greet_a.c', greetAC), 10_000);
await t.run(heredocCommand('greet_b.c', greetBC), 10_000);
await t.run(heredocCommand('main.c', mainC), 10_000);

// Multi-source compile + link.
{
  const { output } = await t.run('clang main.c greet_a.c greet_b.c -o multi', 240_000);
  const stripped = stripAnsi(output);
  const notCmdNotFound = !/clang: command not found/.test(stripped);
  const noErr = !/error:|fatal:|abort/i.test(stripped);
  a.check('clang is a registered shell command', notCmdNotFound,
    notCmdNotFound ? '' : JSON.stringify(stripped.slice(-200)));
  a.check('multi-TU compile + link completes without error', noErr && notCmdNotFound,
    noErr && notCmdNotFound ? '' : JSON.stringify(stripped.slice(-500)));
}

// Verify the linked output is wasm.
//
// PROBE-CLEANUP (2026-05-12): pre-fix this used `readFileSync('multi')`
// — a relative path. Inside the node facet, Node's cwd doesn't track
// the shell's cwd (separate facet realm), so the relative read ENOENTed
// even though `./multi` (the shell builtin runner) ran correctly. The
// link step worked; the probe just couldn't VERIFY the bytes.
//
// Use the home-dir absolute path (probe creates files in cwd which is
// /home/user — see heredocCommand calls above). xxd is a Nimbus shell
// builtin and reads via the VFS directly, bypassing node entirely.
{
  // xxd dumps the whole file; head -1 limits stdout to just the first
  // 16-byte line which contains the wasm magic + version. xxd is a
  // Nimbus shell builtin reading directly from the VFS (no node facet
  // cwd-resolution needed).
  //
  // Pre-fix the probe used readFileSync('multi') — a relative path
  // resolved against the node facet's cwd, which doesn't track the
  // shell's. The link step succeeded; the relative-path read just
  // ENOENTed. See /workspace/.seal-internal/2026-05-12-probe-cleanup/.
  const { output } = await t.run('xxd /home/user/multi | head -1', 15_000);
  const stripped = stripAnsi(output);
  // xxd first-line shape: "00000000: 00 61 73 6d 01 00 00 00 ..."
  // (each byte as a separate hex pair). Wasm magic = 00 61 73 6d.
  const isWasm = /\b00\s+61\s+73\s+6d\b/i.test(stripped);
  a.check('multi has wasm magic', isWasm,
    isWasm ? '' : JSON.stringify(stripped.slice(-200)));
}

// Run it; expect both greet_a and greet_b prints.
{
  const { output } = await t.run('./multi', 30_000);
  const stripped = stripAnsi(output);
  const notCmdNotFound = !/\.\/multi: command not found/.test(stripped);
  a.check('./multi dispatches', notCmdNotFound,
    notCmdNotFound ? '' : JSON.stringify(stripped.slice(-200)));
  a.check('./multi prints "greet_a"', notCmdNotFound && /greet_a/.test(stripped),
    JSON.stringify(stripped.slice(-200)));
  a.check('./multi prints "greet_b"', notCmdNotFound && /greet_b/.test(stripped),
    JSON.stringify(stripped.slice(-200)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
