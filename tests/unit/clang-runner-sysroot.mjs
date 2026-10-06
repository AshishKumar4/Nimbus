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
import { W7_MAX_OWNED_PATH_BYTES, W7_MAX_PATHS_PER_BATCH } from '../../packages/platform/src/w7-frame.ts';

const SYSROOT = 'runtime/clang/share/clang/sysroot';

// A sysroot whose paths are long unpacks whole: its waves close on owned
// path bytes, not on a count alone. Red before: waves of W7_MAX_PATHS_PER_BATCH
// - 8 paths of ~290 bytes passed W7's 256 KiB owned-path bound, and the
// unpack failed "batch exceeds 262144 owned path bytes".
{
  const files = { ...SYSROOT_FILES };
  const deep = 'd'.repeat(140);
  for (let i = 0; i < W7_MAX_PATHS_PER_BATCH + 100; i++) files[`include/${deep}/${'h'.repeat(90)}-${i}.h`] = `#define X${i} ${i}\n`;
  const pathBytes = `${SYSROOT}/include/${deep}/${'h'.repeat(90)}-0.h`.length;
  assert.ok((W7_MAX_PATHS_PER_BATCH - 8) * pathBytes > W7_MAX_OWNED_PATH_BYTES, 'the fixture must pass the byte bound at the count bound');
  const { root, run, user } = makeInvocationVfs({ sysroot: files });
  user.writeFile('home/user/main.c', 'int main(void) { return 0; }');
  assert.equal(await run(commandContext(['main.c', '-o', 'main.wasm']).ctx), 0);
  const rel = `include/${deep}/${'h'.repeat(90)}-${W7_MAX_PATHS_PER_BATCH + 99}.h`;
  assert.equal(user.readFileString(`${SYSROOT}/${rel}`), `#define X${W7_MAX_PATHS_PER_BATCH + 99} ${W7_MAX_PATHS_PER_BATCH + 99}\n`);
  assert.equal(JSON.parse(root.readFileString(`${SYSROOT}/.nimbus-sysroot.json`)).files, Object.keys(files).length);
}

// The unpacked tree: every archive member, at its path, readable by the user.
{
  const { root, run, user, calls } = makeInvocationVfs();
  user.writeFile('home/user/main.c', 'int main(void) { return 0; }');
  assert.equal(await run(commandContext(['main.c', '-o', 'main.wasm']).ctx), 0);

  // The harness's writeStream transfers every chunk buffer it receives, as
  // workerd does across the supervisor hop; libc.a spans several chunks, so
  // chunks that were views into one buffer would arrive detached.
  assert.ok(Buffer.byteLength(SYSROOT_FILES['lib/wasm32-wasi/libc.a']) > 65536, 'the fixture must span chunks');
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
