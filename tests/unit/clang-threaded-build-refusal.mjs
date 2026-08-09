#!/usr/bin/env bun
// clang-threaded-build-refusal — asking the bundled clang for a threads build
// fails with instructions instead of with a riddle.
//
// Nimbus RUNS threaded wasm (runtime/wasi-threads.ts), but the bundled
// toolchain is LLVM 8 over a wasi-sdk-19 sysroot with only `lib/wasm32-wasi`
// in it. `-pthread` used to fall through the argv parser's catch-all for
// unrecognised flags. Measured live, that gave two bad outcomes and no good
// one: on a program without <pthread.h> the build succeeded with exit 0 and
// the flag silently ignored, and on a real threaded program it died at
// `'pthread.h' file not found` — which blames a header rather than a toolchain
// with no threads support, and offers no way forward.

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
