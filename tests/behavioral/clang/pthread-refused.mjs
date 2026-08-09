#!/usr/bin/env bun
// clang/pthread-refused — asking the session compiler for threads fails loudly.
//
// Nimbus RUNS threaded wasm (tests/behavioral/wasm/pthread-parity.mjs proves
// every primitive), but the bundled toolchain cannot BUILD it: LLVM 8 over a
// wasi-sdk-19 sysroot whose only target directory is `lib/wasm32-wasi`.
//
// The failure this guards is the silent one. `-pthread` used to be swallowed by
// the argv parser along with every other unrecognised flag, so the program
// linked against the non-threads libc — whose `pthread_create` is a stub that
// fails at runtime — and the user got an exit code 0, a real .wasm file, and a
// binary that could never spawn a thread. An error the user can act on is the
// whole deliverable here, so the probe asserts the remedy is IN it, not merely
// that the build failed.

import { mintSession, Terminal, makeAsserter, stripAnsi, heredocCommand } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang/pthread-refused');
console.log(`clang/pthread-refused — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install clang', 180_000);

const threadedC = `#include <pthread.h>
static void *body(void *a) { (void)a; return 0; }
int main(void) {
  pthread_t th;
  pthread_create(&th, 0, body, 0);
  pthread_join(th, 0);
  return 0;
}`;
await t.run(heredocCommand('th.c', threadedC), 15_000);

{
  const { output } = await t.run('clang -pthread th.c -o th.wasm', 300_000);
  const stripped = stripAnsi(output);

  const refused = /cannot build threaded wasm/.test(stripped);
  a.check('clang -pthread is refused rather than silently dropped',
    refused, refused ? '' : JSON.stringify(stripped.slice(-500)));

  // A refusal that does not say where the working path is leaves the user
  // stuck; these four strings are what turn "no" into instructions.
  a.check('the refusal names the target triple that does work',
    /wasm32-wasip1-threads/.test(stripped));
  a.check('the refusal names the futex shim to link',
    /nimbus-threads\.c/.test(stripped));
  a.check('the refusal names the shared-memory link flags',
    /--shared-memory/.test(stripped));
  a.check('the refusal points at the design note',
    /docs\/wasi-threads\.md/.test(stripped));
}

// Refused means nothing was emitted: a leftover .wasm here would be exactly the
// binary that cannot thread, which is what the refusal exists to prevent.
{
  const { output } = await t.run('ls th.wasm 2>&1 || echo NO_OUTPUT_FILE', 15_000);
  const stripped = stripAnsi(output);
  const absent = /NO_OUTPUT_FILE|No such file/.test(stripped);
  a.check('no binary is left behind by the refused build',
    absent, absent ? '' : JSON.stringify(stripped.slice(-300)));
}

// The refusal must be narrow: the ordinary C path is the common case and must
// be untouched by it.
{
  await t.run(heredocCommand('ok.c', '#include <stdio.h>\nint main(void){printf("plain ok\\n");return 0;}'), 15_000);
  const { output } = await t.run('clang ok.c -o ok && ./ok', 300_000);
  const stripped = stripAnsi(output);
  const built = /plain ok/.test(stripped) && !/cannot build threaded wasm/.test(stripped);
  a.check('a non-threaded build still compiles and runs',
    built, built ? '' : JSON.stringify(stripped.slice(-400)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
