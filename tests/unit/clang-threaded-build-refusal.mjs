#!/usr/bin/env bun
// clang-threaded-build-refusal — asking the bundled clang for a threads build
// fails loudly instead of producing a binary that cannot thread.
//
// Nimbus RUNS threaded wasm (runtime/wasi-threads.ts), but the bundled
// toolchain is LLVM 8 over a wasi-sdk-19 sysroot with only `lib/wasm32-wasi`
// in it. The failure mode this guards is the silent one: `-pthread` used to be
// swallowed by the argv parser along with every other unrecognised flag, so
// the program linked against the non-threads libc — whose `pthread_create` is
// a stub that fails at runtime — and the user got a clean-looking build of a
// binary that could never spawn a thread.

import assert from 'node:assert/strict';

import { commandContext, makeInvocationVfs } from './clang-runner-test-harness.mjs';

const THREADED_INVOCATIONS = [
  ['-pthread', 'main.c', '-o', 'main.wasm'],
  ['main.c', '-pthread', '-o', 'main.wasm'],
  ['--target=wasm32-wasip1-threads', 'main.c', '-o', 'main.wasm'],
  ['--target', 'wasm32-wasip1-threads', 'main.c', '-o', 'main.wasm'],
  ['-target', 'wasm32-wasi-threads', 'main.c', '-o', 'main.wasm'],
];

for (const args of THREADED_INVOCATIONS) {
  const { run, user } = makeInvocationVfs();
  user.writeFile('home/user/main.c', 'int main(void) { return 0; }');
  const invocation = commandContext(args);

  assert.equal(await run(invocation.ctx), 1, `${args.join(' ')} must fail`);

  const stderr = invocation.stderr();
  assert.match(stderr, /cannot build threaded wasm/, `${args.join(' ')} must say why`);
  // An error that does not name the working path is a dead end, not a diagnostic.
  assert.match(stderr, /wasm32-wasip1-threads/, `${args.join(' ')} must name the target`);
  assert.match(stderr, /nimbus-threads\.c/, `${args.join(' ')} must name the shim`);
  assert.match(stderr, /--shared-memory/, `${args.join(' ')} must name the link flags`);
  assert.match(stderr, /docs\/wasi-threads\.md/, `${args.join(' ')} must name the design note`);

  // Refused means refused: no output file, so nothing downstream can run a
  // binary that silently cannot thread.
  assert.equal(user.exists('home/user/main.wasm'), false, `${args.join(' ')} must emit nothing`);
}

// The refusal must be narrow. A non-threaded build is the common path and must
// stay untouched, including flags that merely contain the word.
for (const args of [
  ['main.c', '-o', 'main.wasm'],
  ['-O2', 'main.c', '-o', 'main.wasm'],
  ['--target', 'wasm32-wasi', 'main.c', '-o', 'main.wasm'],
  ['-DUSE_THREADS=0', 'main.c', '-o', 'main.wasm'],
]) {
  const { run, user } = makeInvocationVfs();
  user.writeFile('home/user/main.c', 'int main(void) { return 0; }');
  assert.equal(await run(commandContext(args).ctx), 0, `${args.join(' ')} must still build`);
  assert.equal(user.exists('home/user/main.wasm'), true, `${args.join(' ')} must emit a binary`);
}

console.log('clang threaded build refusal: ok');
