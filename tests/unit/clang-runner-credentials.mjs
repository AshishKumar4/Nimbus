#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { commandContext, makeInvocationVfs } from './clang-runner-test-harness.mjs';

async function expectEacces(run, args) {
  const invocation = commandContext(args);
  assert.equal(await run(invocation.ctx), 1);
  assert.match(invocation.stderr(), /EACCES:/);
}

// Installed runtime blobs are supervisor-owned assets and remain readable through the kernel view.
{
  const { run, user } = makeInvocationVfs();
  user.writeFile('home/user/main.c', 'int main(void) { return 0; }');
  assert.equal(await run(commandContext(['main.c', '-o', 'main.wasm']).ctx), 0);
  assert.equal(user.exists('home/user/main.wasm'), true);
}

// Source lookup must not use the kernel view to traverse a directory hidden from the caller.
{
  const { root, run } = makeInvocationVfs();
  root.mkdir('home/user/private', { mode: 0o700 });
  root.writeFile('home/user/private/main.c', 'int main(void) { return 0; }', { mode: 0o644 });
  await expectEacces(run, ['private/main.c']);
}

// Source reads must enforce the caller's read permission after a successful lookup.
{
  const { root, run } = makeInvocationVfs();
  root.writeFile('home/user/main.c', 'int main(void) { return 0; }', { mode: 0o600 });
  await expectEacces(run, ['main.c']);
}

// Compiler outputs must be authorized as the caller, not as the supervisor.
{
  const { root, run, user } = makeInvocationVfs();
  user.writeFile('home/user/main.c', 'int main(void) { return 0; }');
  root.mkdir('home/user/locked', { mode: 0o555 });
  await expectEacces(run, ['main.c', '-o', 'locked/main.wasm']);
  assert.equal(root.exists('home/user/locked/main.wasm'), false);
}

console.log('clang-runner credentials: ok');
