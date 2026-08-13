#!/usr/bin/env bun
// Ruby and clang, off Cloudflare, from `@nimbus-sh/core` only.
//
// `core-wasm-runtime-bun.mjs` proves bash and CPython run in a plain bun
// process. These two are the rest of the compiled half, and they are a
// separate file for one reason: their wasm is not in this repo. bash and
// CPython are built here and their artifacts are committed; Ruby comes from an
// upstream npm tarball and clang from binji/wasm-clang, and both are 20-60 MiB
// that nobody should be cloning. So this test runs against RUNTIME PACKAGES —
// the same directories `npm publish` takes — and skips when they are absent:
//
//   cd packages/worker
//   node scripts/bundle-runtime.mjs ruby 3.3.4       --npm-package /tmp/rt/ruby
//   node scripts/bundle-runtime.mjs clang binji-2020 --npm-package /tmp/rt/clang
//   NIMBUS_RUNTIME_PACKAGES=/tmp/rt bun tests/unit/core-ruby-clang-bun.mjs
//
// Which also makes it the honest end-to-end: nothing here hand-builds a
// manifest or reaches into a build tree. The workspace is handed two packages
// by the port an embedder uses, installs them digest-verified, and the shell
// answers `ruby` and `clang`.
//
// What the two runtimes prove is different, and both matter. Ruby has
// CPython's shape — a manifest-or-bytes seed and a supervisor to write back
// through — so it exercises provisioning. clang has neither: it carries its
// own filesystem by value, holds no session capability, and its facet is
// therefore reusable across tenants. One toolchain, two calls, and the result
// is a program the SAME workspace then runs.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';

const PACKAGES = process.env.NIMBUS_RUNTIME_PACKAGES;
const dirs = PACKAGES
  ? { ruby: join(PACKAGES, 'ruby'), clang: join(PACKAGES, 'clang') }
  : null;
if (!dirs || !existsSync(join(dirs.ruby, 'index.js')) || !existsSync(join(dirs.clang, 'index.js'))) {
  console.log('core-ruby-clang-bun: SKIPPED (set NIMBUS_RUNTIME_PACKAGES; see the header)');
  process.exit(0);
}

const ruby = (await import(join(dirs.ruby, 'index.js'))).default;
const clang = (await import(join(dirs.clang, 'index.js'))).default;

const db = new Database(':memory:');
const harness = createSqliteVfsTestHarness(db);
const ws = await NimbusWorkspace.create({
  sql: harness.sql,
  transactions: harness.ctx,
  generation: 1,
  cwd: '/home/user',
  facets: localFacetHost(),
  runtimes: [ruby, clang],
});

// ── Real Ruby ───────────────────────────────────────────────────────────────
{
  const t0 = Date.now();
  const arithmetic = await ws.exec('ruby -e "puts 6*7"');
  assert.equal(arithmetic.exitCode, 0, `ruby failed: ${arithmetic.stderr}`);
  assert.equal(arithmetic.stdout, '42\n');
  console.log(`  ok  ruby -e "puts 6*7" prints 42 (${Date.now() - t0} ms cold)`);

  // The interpreter's own identity, not the runner's --version string.
  const identity = await ws.exec("ruby -e 'puts RUBY_VERSION; puts RUBY_PLATFORM'");
  assert.equal(identity.exitCode, 0, `ruby failed: ${identity.stderr}`);
  assert.equal(identity.stdout, '3.3.3\nwasm32-wasi\n');
  console.log('  ok  it is Ruby 3.3.3 on wasm32-wasi');

  // The stdlib packed into the image: json is a C extension plus its Ruby
  // half, and digest is another, so neither answers without the real thing.
  const stdlib = await ws.exec(
    'ruby -e \'require "json"; require "digest"; '
    + 'puts JSON.generate({"v" => RUBY_VERSION.split(".").first(2), "sum" => (1..6).sum, '
    + '"sha" => Digest::SHA256.hexdigest("nimbus")[0, 16]})\'');
  assert.equal(stdlib.exitCode, 0, `ruby failed: ${stdlib.stderr}`);
  assert.equal(
    stdlib.stdout.trim(),
    '{"v":["3","3"],"sum":21,"sha":"7dc917b846794643"}',
  );
  console.log('  ok  json and digest come out of the packed stdlib');
}

// ── ruby and the durable filesystem are the same filesystem ─────────────────
// The read proves the seed carried the bytes; the write proves the local
// supervisor carried them BACK, which is the half a sealed facet would lose.
{
  await ws.fs.writeFile('/home/user/note.txt', 'written by fs\n');
  const io = await ws.exec(
    'ruby -e \'puts File.read("note.txt").strip; File.write("from-ruby.txt", "written by ruby\\n")\'');
  assert.equal(io.exitCode, 0, `ruby failed: ${io.stderr}`);
  assert.equal(io.stdout, 'written by fs\n');
  assert.equal(await ws.fs.readFile('/home/user/from-ruby.txt'), 'written by ruby\n');
  console.log('  ok  ruby reads a file .fs wrote and writes one .fs reads back');
}

// ── A capability the host does not have is named, not faked ─────────────────
// A Ruby script may bind a port and keep serving, which needs an actor to hold
// the process. A workspace owns none, so it is refused by name rather than run
// as a one-shot that dies with the invocation. Same contract as `python x.py`.
{
  await ws.fs.writeFile('/home/user/server.rb', 'puts "never reached"\n');
  const resident = await ws.exec('ruby server.rb');
  assert.equal(resident.exitCode, 1);
  assert.match(resident.stderr, /no process substrate/);
  console.log('  ok  a ruby program that keeps running is refused, not degraded');
}

// ── Real clang ──────────────────────────────────────────────────────────────
// Two facet calls — clang -cc1 to an object, wasm-ld to a wasm — over a
// filesystem built by value from the sysroot tar and the user's own sources.
{
  await ws.fs.writeFile('/home/user/greet.h', 'int total(int n);\n');
  await ws.fs.writeFile('/home/user/greet.c', 'int total(int n) { int s = 0; for (int i = 1; i <= n; i++) s += i; return s; }\n');
  await ws.fs.writeFile('/home/user/hello.c', `#include <stdio.h>
#include "greet.h"
int main(void) {
  printf("hello from clang, total=%d\\n", total(6));
  return 0;
}
`);

  const t0 = Date.now();
  const build = await ws.exec('clang hello.c greet.c -o hello.wasm');
  assert.equal(build.exitCode, 0, `clang failed: ${build.stderr}`);
  console.log(`  ok  clang compiled and linked two translation units (${Date.now() - t0} ms cold)`);

  // The output is a real wasm module the SAME workspace runs, dispatched off
  // its \0asm header by exec-dispatch.
  const ran = await ws.exec('./hello.wasm');
  assert.equal(ran.exitCode, 0, `the compiled program failed: ${ran.stderr}`);
  assert.equal(ran.stdout, 'hello from clang, total=21\n');
  console.log('  ok  the program it produced runs, and prints what it computed');

  // -c stops at the object file, which lands in the session filesystem.
  const objectOnly = await ws.exec('clang -c greet.c');
  assert.equal(objectOnly.exitCode, 0, `clang -c failed: ${objectOnly.stderr}`);
  const object = await ws.fs.readFile('/home/user/greet.o', null);
  assert.deepEqual(Array.from(object.slice(0, 4)), [0x00, 0x61, 0x73, 0x6d],
    'an object file is a wasm object');
  console.log('  ok  -c leaves an object file in the workspace filesystem');

  // A compile error is the compiler's, reported as the compiler reported it.
  await ws.fs.writeFile('/home/user/broken.c', 'int main(void) { return undefined_symbol; }\n');
  const broken = await ws.exec('clang broken.c -o broken.wasm');
  assert.notEqual(broken.exitCode, 0, 'a program that does not compile must not exit 0');
  assert.match(broken.stderr, /undefined_symbol/);
  console.log('  ok  a compile error comes back as the compiler wrote it');
}

// ── One filesystem, whichever runtime is holding it ─────────────────────────
// Ruby writes a C program, clang compiles it, and the workspace runs the
// result. Three runtimes' worth of syscalls over one set of SQLite rows.
{
  const write = await ws.exec(
    'ruby -e \'File.write("gen.c", "#include <stdio.h>\\nint main(void){printf(\\"%d\\\\n\\", 6*7);}\\n")\'');
  assert.equal(write.exitCode, 0, `ruby failed: ${write.stderr}`);
  const build = await ws.exec('clang gen.c -o gen.wasm');
  assert.equal(build.exitCode, 0, `clang failed: ${build.stderr}`);
  const ran = await ws.exec('./gen.wasm');
  assert.equal(ran.exitCode, 0, `the generated program failed: ${ran.stderr}`);
  assert.equal(ran.stdout, '42\n');
  console.log('  ok  ruby wrote a C program, clang built it, the workspace ran it');
}

db.close();
console.log('core-ruby-clang-bun: ok');
