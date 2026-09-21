#!/usr/bin/env bun
// clang-runner-sysroot — the toolchain compiles against the session
// filesystem, not a copy of it.
//
// The sysroot ships as one archive and is unpacked once into the install
// root, where every session user can read it; the facet is opened with the
// caller's syscalls and told where everything is by absolute path; what it
// writes is in the session when it returns; and an archive that lacks what a
// C build needs is refused by name.

import assert from 'node:assert/strict';

import { SYSROOT_FILES, commandContext, makeInvocationVfs } from './clang-runner-test-harness.mjs';

const SYSROOT = 'runtime/clang/share/clang/sysroot';

// The unpacked tree: every archive member, at its path, readable by the user.
{
  const { root, run, user, calls } = makeInvocationVfs();
  user.writeFile('home/user/main.c', 'int main(void) { return 0; }');
  assert.equal(await run(commandContext(['main.c', '-o', 'main.wasm']).ctx), 0);

  for (const [rel, text] of Object.entries(SYSROOT_FILES)) {
    const path = `${SYSROOT}/${rel}`;
    assert.equal(user.readFileString(path), text, `${rel} must be unpacked byte for byte`);
    assert.equal(user.stat(path).mode & 0o777, 0o644, `${rel} must be world-readable`);
  }
  assert.equal(user.stat(`${SYSROOT}/include`).mode & 0o777, 0o755);
  assert.equal(user.stat(`${SYSROOT}/lib/clang/8.0.1/include`).mode & 0o777, 0o755);
  const stamp = JSON.parse(root.readFileString(`${SYSROOT}/.nimbus-sysroot.json`));
  assert.equal(stamp.tarSize, root.stat('runtime/clang/share/clang/sysroot.tar').size);
  assert.equal(stamp.files, Object.keys(SYSROOT_FILES).length);

  // Two facet calls, both opened with the caller's syscalls (the harness
  // refuses to open one without), and every path they were handed absolute.
  assert.deepEqual(calls.map((c) => c.tag), ['clang-runner-clang', 'clang-runner-wasm-ld']);
  const [compile, link] = calls;
  assert.ok(compile.argv.includes('/home/user/main.c'), 'the source is named by its session path');
  assert.ok(compile.argv.includes(`-isysroot`) && compile.argv.includes(`/${SYSROOT}`));
  assert.ok(compile.argv.includes(`/${SYSROOT}/include`));
  assert.ok(compile.argv.includes(`/${SYSROOT}/lib/clang/8.0.1/include`));
  assert.ok(compile.argv.includes('/home/user'), 'cwd is the quote-form include root');
  assert.ok(link.argv.includes(`/${SYSROOT}/lib/wasm32-wasi/crt1.o`));
  assert.ok(link.argv.includes(`-L/${SYSROOT}/lib/wasm32-wasi`));
  assert.ok(link.argv.includes('/home/user/main.wasm'), 'the output is named by its session path');
  for (const arg of [...compile.argv, ...link.argv]) {
    assert.ok(!/^[^-/].*\.(c|o|wasm)$/.test(arg), `${arg} must be absolute`);
  }

  // The object the compile step wrote went to scratch, and scratch is gone.
  const obj = compile.argv[compile.argv.indexOf('-o') + 1];
  assert.match(obj, /^\/tmp\/nimbus-clang-17-[0-9a-f]+\/home_user_main\.o$/);
  assert.equal(root.exists(obj.replace(/^\//, '')), false, 'intermediate objects do not outlive the build');
  assert.deepEqual(root.readdir('tmp').map((e) => e.name), []);

  // The linker's output is the session file, executable.
  assert.equal(user.stat('home/user/main.wasm').mode & 0o111, 0o111);
}

// Unpacked once: a second build in the same session finds the tree and does
// not rewrite it.
{
  const { root, run, user } = makeInvocationVfs();
  user.writeFile('home/user/main.c', 'int main(void) { return 0; }');
  assert.equal(await run(commandContext(['main.c', '-o', 'a.wasm']).ctx), 0);
  const before = root.stat(`${SYSROOT}/include/stdio.h`);
  root.writeFile(`${SYSROOT}/include/stdio.h`, 'marker');
  assert.equal(await run(commandContext(['main.c', '-o', 'b.wasm']).ctx), 0);
  assert.equal(root.readFileString(`${SYSROOT}/include/stdio.h`), 'marker', 'an unpacked tree is left alone');
  assert.equal(root.stat(`${SYSROOT}/include/stdio.h`).ino, before.ino);
}

// -c keeps the object where a driver puts it: the working directory, or -o.
{
  const { run, user } = makeInvocationVfs();
  user.mkdir('home/user/src', { recursive: true });
  user.writeFile('home/user/src/lib.c', 'int f(void) { return 1; }');
  assert.equal(await run(commandContext(['-c', 'src/lib.c']).ctx), 0);
  assert.equal(user.exists('home/user/lib.o'), true);
  assert.equal(await run(commandContext(['-c', 'src/lib.c', '-o', 'out/lib.o']).ctx), 1,
    'a directory that does not exist is not created behind the user');
  user.mkdir('home/user/out');
  assert.equal(await run(commandContext(['-c', 'src/lib.c', '-o', 'out/lib.o']).ctx), 0);
  assert.equal(user.exists('home/user/out/lib.o'), true);
}

// An archive without what a C build needs is refused before anything runs,
// and says which file is missing.
{
  const sysroot = { ...SYSROOT_FILES };
  delete sysroot['lib/wasm32-wasi/crt1.o'];
  const { root, run, user, calls } = makeInvocationVfs({ sysroot });
  user.writeFile('home/user/main.c', 'int main(void) { return 0; }');
  const invocation = commandContext(['main.c', '-o', 'main.wasm']);
  assert.equal(await run(invocation.ctx), 1);
  assert.match(invocation.stderr(), /sysroot\.tar is missing lib\/wasm32-wasi\/crt1\.o/);
  assert.equal(calls.length, 0, 'no facet is opened for a toolchain that cannot link');
  assert.equal(root.exists(SYSROOT), false, 'nothing half-unpacked is left behind');
  assert.equal(user.exists('home/user/main.wasm'), false);
}

console.log('clang-runner sysroot: ok');
