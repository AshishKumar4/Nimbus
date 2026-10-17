#!/usr/bin/env bun
// clang reads and opens each toolchain image only when its phase runs, as a
// driver runs cc1 and then the linker: `clang -c` and a compile that fails
// never read or open wasm-ld (18.5 MiB), and a link of objects alone never
// reads or opens clang (31 MiB). An image that could not be read is read
// again by the next run. Driven through the runner (clang-runner-test-harness:
// an installed clang whose facets record what is opened, and a sysroot).
//
// Red before: every run read both images and opened both facets before its
// first source, so `clang -c` failed when wasm-ld could not be read, and a
// link of objects alone opened clang.

import assert from 'node:assert/strict';
import { commandContext, makeInvocationVfs } from './_clang-runner-test-harness.mjs';

const CLANG = 'clang-runner-clang';
const LINKER = 'clang-runner-wasm-ld';
const run = async (box, args) => {
  const invocation = commandContext(args);
  const code = await box.run(invocation.ctx);
  return { code, stderr: invocation.stderr() };
};

{
  const box = makeInvocationVfs();
  box.user.writeFile('home/user/main.c', 'int main(void) { return 0; }');
  assert.deepEqual(await run(box, ['-c', 'main.c', '-o', 'main.o']), { code: 0, stderr: '' });
  assert.deepEqual(box.opened, [CLANG], 'clang -c opens clang alone');
  assert.deepEqual(box.disposed, [CLANG], 'and disposes what it opened');
  console.log('  ✓ clang -c opens clang alone');
}

{
  const box = makeInvocationVfs();
  box.user.writeFile('home/user/bad.c', '#error no\n');
  const failed = await run(box, ['bad.c', '-o', 'bad.wasm']);
  assert.equal(failed.code, 1, failed.stderr);
  assert.deepEqual(box.opened, [CLANG], 'a compile that fails opens no linker');
  console.log('  ✓ a compile that fails never opens the linker');
}

{
  const box = makeInvocationVfs();
  box.user.writeFile('home/user/main.o', '\0asm');
  assert.deepEqual(await run(box, ['main.o', '-o', 'main.wasm']), { code: 0, stderr: '' });
  assert.deepEqual(box.opened, [LINKER], 'a link of objects opens the linker alone');
  console.log('  ✓ a link of objects alone opens the linker alone');
}

{
  const box = makeInvocationVfs();
  box.user.writeFile('home/user/main.c', 'int main(void) { return 0; }');
  assert.deepEqual(await run(box, ['main.c', '-o', 'main.wasm']), { code: 0, stderr: '' });
  assert.deepEqual(box.opened, [CLANG, LINKER], 'a build opens clang, then the linker');
  assert.deepEqual(box.disposed.toSorted(), [CLANG, LINKER].toSorted(), 'and disposes both');
  console.log('  ✓ a build opens clang, then the linker, and disposes both');
}

{
  // The linker's image cannot be read: a compile alone still works.
  const box = makeInvocationVfs();
  box.root.unlink('runtime/clang/bin/wasm-ld');
  box.user.writeFile('home/user/main.c', 'int main(void) { return 0; }');
  assert.deepEqual(await run(box, ['-c', 'main.c', '-o', 'main.o']), { code: 0, stderr: '' });
  const linked = await run(box, ['main.c', '-o', 'main.wasm']);
  assert.equal(linked.code, 1, 'a link needs the linker');
  assert.match(linked.stderr, /wasm-ld/, linked.stderr);
  // Once it is there, the next run reads it.
  box.root.writeFile('runtime/clang/bin/wasm-ld', new Uint8Array([0]), { mode: 0o600 });
  assert.deepEqual(await run(box, ['main.c', '-o', 'main.wasm']), { code: 0, stderr: '' });
  console.log('  ✓ clang -c needs no linker image, and a failed read is read again');
}

console.log('clang-runner-phases: ok');
