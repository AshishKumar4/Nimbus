#!/usr/bin/env bun
// @tier slow — long; CI median 47 s wall, 34 s CPU, 0.6 GiB peak (6 runs, 2026-10-06)
// The wasm half of Nimbus, off Cloudflare.
//
// `nimbus-workspace-embedded.mjs` proves the JavaScript half runs over
// bun:sqlite: the filesystem, the shell, the coreutils. Everything compiled —
// bash, CPython, Ruby, clang, and any `\0asm` file the user made executable —
// stopped at the Worker Loader, because that is the only thing that could
// compile a module in workerd and every runner named it directly.
//
// It is now a port (core runtime/facet-host.ts) with two implementations, and
// this drives the non-Cloudflare one: `localFacetHost()`, which compiles in
// place because nothing outside workerd forbids it. Real GNU bash 5.2.37 and
// real BusyBox, from `@nimbus-sh/core` only, in a plain bun process.
//
// The runtime image is seeded off local disk the way `nimbus install bash`
// seeds it from R2 — same manifest, same layout, same digests — because what
// makes a runtime invokable is the tree in the filesystem, not the publisher
// that put it there.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { missingRuntimeFile, RUNTIMES, seedRuntime } from './lib/wasm-runtimes.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';
import { readText, writeText } from '../../packages/core/src/vfs/vfs.ts';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

const missing = missingRuntimeFile();
if (missing !== null) {
  console.log(`core-wasm-runtime-bun: SKIPPED (${missing} not built)`);
  process.exit(0);
}


const db = new Database(':memory:');
const harness = createSqliteVfsTestHarness(db);
const open = (options) => NimbusWorkspace.create({
  sql: harness.sql,
  transactions: harness.ctx,
  generation: 1,
  cwd: '/home/user',
  ...options,
});

// ── Absent facet host: nothing compiled is reachable, and nothing pretends ──
// This is the contract the option carries. A workspace with no facet host has
// no way to compile a module, so `bash` is not a degraded bash — it is a
// command that does not exist, reported the way the shell reports any other.
{
  const plain = await open({});
  const missing = await plain.exec('bash -c "echo hi"');
  assert.equal(missing.exitCode, 127, 'without a facet host bash is not a command');
  const runner = await plain.exec('wasm-runner --version');
  assert.equal(runner.exitCode, 127, 'and neither is wasm-runner');
  console.log('  ok  a workspace with no facet host has no wasm runtimes at all');

  for (const runtime of RUNTIMES) seedRuntime(plain.vfs, runtime);
}

// ── The same database, reopened with a facet host ───────────────────────────
// Reopened rather than re-created: the registration under test is the one a
// Durable Object performs after eviction, reading the runtimes off its own
// filesystem. Seeding then reopening is exactly that sequence.
const ws = await open({ facets: localFacetHost() });

{
  const version = await ws.exec('wasm-runner --version');
  assert.equal(version.exitCode, 0, `wasm-runner --version failed: ${version.stderr}`);
  assert.match(version.stdout, /^\d+\.\d+\.\d+$/m);
  console.log(`  ok  wasm-runner is registered (${version.stdout.trim()})`);
}

// ── Real bash ───────────────────────────────────────────────────────────────
{
  const hi = await ws.exec('bash -c "echo hi"');
  assert.equal(hi.exitCode, 0, `bash failed: ${hi.stderr}`);
  assert.equal(hi.stdout, 'hi\n');
  console.log('  ok  bash -c "echo hi" prints hi');

  // Not an echo builtin answering: bash's own version, its own arithmetic, and
  // a BusyBox binary exec'd as a child process.
  const real = await ws.exec('bash -c \'echo $BASH_VERSION; echo $((6*7)); printf "%s\\n" x y | sort -r\'');
  assert.equal(real.exitCode, 0, `bash failed: ${real.stderr}`);
  assert.match(real.stdout, /^5\.2\.37\(1\)-release\n42\ny\nx\n$/);
  console.log('  ok  it is GNU bash 5.2.37 running real BusyBox children');

  // fork/pipe/exec and $? — the scheduler, not a one-shot interpreter.
  const forked = await ws.exec('bash -c \'for i in 1 2 3; do echo "n=$i"; done | tr -d " "; false; echo rc=$?\'');
  assert.equal(forked.exitCode, 0, `bash failed: ${forked.stderr}`);
  assert.equal(forked.stdout, 'n=1\nn=2\nn=3\nrc=1\n');
  console.log('  ok  loops, pipelines and exit status behave');

  // N24: a pipeline of three or more stages delivers its last stage's output, to
  // bash's own stdout and to a command substitution alike. Each stage is a
  // real BusyBox child, using the local host's advertised parking capability.
  for (const [command, want] of [
    ["echo a | cat | cat", 'a\n'],
    ["seq 3 | cat | cat", '1\n2\n3\n'],
    ["printf 'c\\nb\\na\\n' | sort | uniq | cat", 'a\nb\nc\n'],
    ["x=$(echo a | cat | cat); echo \"[$x]\"", '[a]\n'],
    ["seq 5 | cat | cat | cat | wc -l", '5\n'],
    ["echo a | (cat | cat)", 'a\n'],
    ["echo a | cat | cat; echo \"${PIPESTATUS[*]}\"", 'a\n0 0 0\n'],
  ]) {
    const r = await ws.exec(`bash -c '${command.replaceAll("'", "'\\''")}'`);
    assert.equal(r.exitCode, 0, `${command}: ${r.stderr}`);
    assert.equal(r.stdout.replace(/^\s+/gm, ''), want, command);
  }
  console.log('  ok  a pipeline of three or more stages delivers its last stage');

  // Pipe behavior under the local host's advertised parking capability. A
  // writer whose readers are gone gets SIGPIPE, 141 as bash reports it; these
  // match real bash 5.2 with GNU coreutils.
  for (const [command, want] of [
    ["yes | head -2; echo \"${PIPESTATUS[*]}\"", 'y\ny\n141 0\n'],
    ["x=$(yes | head -c 5); echo \"[$x]\"", '[y\ny\ny]\n'],
    ["seq 1000 | head -1; echo \"${PIPESTATUS[*]}\"", '1\n0 0\n'],
    ["seq 200000 | cat | wc -l; echo \"${PIPESTATUS[*]}\"", '200000\n0 0 0\n'],
    ["seq 100000 | cat | while read x; do :; done; echo \"${PIPESTATUS[*]}\"", '0 0 0\n'],
    ["seq 20000 | uniq -c | wc -l; echo \"${PIPESTATUS[*]}\"", '20000\n0 0 0\n'],
    // A writer that exits with more than a pipe's capacity unread would still be
    // blocked on Linux: its status is held, and is 141 if the reader leaves first.
    ["seq 1000000 | head -2; echo \"${PIPESTATUS[*]}\"", '1\n2\n141 0\n'],
    ["seq 100000 | head -1; echo \"${PIPESTATUS[*]}\"", '1\n141 0\n'],
    ["seq 100000 | cat | wc -l; echo \"${PIPESTATUS[*]}\"", '100000\n0 0 0\n'],
    // The writer is done once its reader drains the pipe, as on Linux, even
    // though a background job still holds the read end: the pipeline ends
    // while the job is still waiting to be released, which it is only after.
    // (Whole seconds: this bash's sleep takes no fractions.)
    ["rm -f go out; seq 100000 | { cat >/dev/null; { while [ ! -e go ]; do sleep 1; done; echo bg-done > out; } >/dev/null 2>&1 & }; echo \"after ${PIPESTATUS[*]}\"; : > go; while [ ! -e out ]; do sleep 1; done; cat out", 'after 0 0\nbg-done\n'],
    // A bash process forking on every iteration, its output past a pipe's 64 KiB.
    ["i=0; while [ $i -lt 300 ]; do echo \"$(printf %0200d $i)\"; i=$((i+1)); done | wc -c", '60300\n'],
  ]) {
    const r = await Promise.race([
      ws.exec(`bash -c '${command.replaceAll("'", "'\\''")}'`),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${command}: still running after 30 s`)), 30_000)),
    ]);
    assert.equal(r.exitCode, 0, `${command}: ${r.stderr}`);
    assert.equal(r.stderr, '', `${command}: stderr`);
    assert.equal(r.stdout.replace(/^\s+/gm, ''), want, command);
  }
  // A pipeline whose middle stage must wait for a writer. On a host that can
  // park a guest (JSPI, which Bun has) every stage is real backpressure and the
  // statuses are GNU's; on one that cannot, a WASI child has no way to pause,
  // so the command fails and says why rather than report a false end of input
  // or lose output.
  const parks = localFacetHost().parking === 'jspi';
  for (const [command, want] of [
    ['yes | cat | head -1; echo "${PIPESTATUS[*]}"', 'y\n141 141 0\n'],
    ['yes | head -c 80000000 | wc -c; echo "${PIPESTATUS[*]}"', '80000000\n141 0 0\n'],
  ]) {
    const r = await Promise.race([
      ws.exec(`bash -c '${command}'`),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${command}: still running after 30 s`)), 30_000)),
    ]);
    if (parks) {
      assert.equal(r.exitCode, 0, `${command}: ${r.stderr}`);
      assert.equal(r.stdout, want, command);
    } else {
      assert.equal(r.exitCode, 1, command);
      assert.match(r.stderr, /^bash: pipe buffer limit \d+ MiB exceeded: this runtime cannot pause a WASI writer without JSPI\n$/, command);
    }
  }
  console.log(parks
    ? '  ok  a parking host: a waiting middle stage gets GNU\'s statuses'
    : '  ok  without JSPI, pipes match bash or fail saying why');
}

// ── bash and the durable filesystem are the same filesystem ─────────────────
// The point of running it here rather than in a harness: what bash writes is a
// row in the host's SQLite, readable through the embedder-facing `.fs`.
{
  await writeText(ws.fs, '/home/user/from-fs.txt', 'seeded\n');
  const roundTrip = await ws.exec('bash -c \'cat from-fs.txt; echo written > from-bash.txt\'');
  assert.equal(roundTrip.exitCode, 0, `bash failed: ${roundTrip.stderr}`);
  assert.equal(roundTrip.stdout, 'seeded\n');
  assert.equal(await readText(ws.fs, '/home/user/from-bash.txt'), 'written\n');
  console.log('  ok  bash reads and writes the workspace filesystem');
}

// ── A `\0asm` file on disk is executable, through wasm-runner ───────────────
// exec-dispatch.ts decides that on the magic bytes and hands the file to
// `wasm-runner`; the seam has been in core all along with nothing behind it.
{
  // (module (func (export "add") (param i32 i32) (result i32)
  //   local.get 0 local.get 1 i32.add))
  const addWasm = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
  ]);
  ws.vfs.as(USER).writeFile('home/user/add.wasm', addWasm, { mode: 0o755 });

  const direct = await ws.exec('wasm-runner ./add.wasm add 3 4');
  assert.equal(direct.exitCode, 0, `wasm-runner failed: ${direct.stderr}`);
  assert.equal(direct.stdout, '7\n');

  const dispatched = await ws.exec('./add.wasm add 20 22');
  assert.equal(dispatched.exitCode, 0, `exec dispatch failed: ${dispatched.stderr}`);
  assert.equal(dispatched.stdout, '42\n');
  console.log('  ok  a wasm binary on the PATH runs through exec-dispatch');
}

// ── Real CPython ────────────────────────────────────────────────────────────
// The interpreter is the same wasm32-wasi build production runs, on the same
// WASI layer. What differs is how it is PROVISIONED, and that is the host's
// choice: workerd can suspend a guest mid-syscall, so it seeds a manifest and
// the facet fetches what it opens; this host cannot, so the seed carries the
// bytes. Neither is a mode the runner knows about — it asks for a seed.
{
  const t0 = Date.now();
  const arithmetic = await ws.exec('python -c "print(6*7)"');
  assert.equal(arithmetic.exitCode, 0, `python failed: ${arithmetic.stderr}`);
  assert.equal(arithmetic.stdout, '42\n');
  console.log(`  ok  python -c "print(6*7)" prints 42 (${Date.now() - t0} ms cold)`);

  // The real stdlib, out of the real zip: json and sqlite3 are compiled
  // extensions plus Python halves, so neither answers without it.
  const stdlib = await ws.exec(
    'python -c \'import sys, json, sqlite3; '
    + 'c = sqlite3.connect(":memory:"); c.execute("create table t(a)"); '
    + 'c.execute("insert into t values(?)", ("live",)); '
    + 'print(json.dumps({"v": sys.version_info[:2], "row": c.execute("select a from t").fetchone()[0]}))\'');
  assert.equal(stdlib.exitCode, 0, `python failed: ${stdlib.stderr}`);
  assert.equal(stdlib.stdout.trim(), '{"v": [3, 13], "row": "live"}');
  console.log('  ok  json and sqlite3 come out of the real stdlib');

  // python3 is the same runtime under its other manifest entrypoint.
  const alias = await ws.exec('python3 -c "print(\'alias\')"');
  assert.equal(alias.exitCode, 0, `python3 failed: ${alias.stderr}`);
  assert.equal(alias.stdout, 'alias\n');
  console.log('  ok  python3 is the same runtime');

  // A program read from stdin is all of it, to its end, though its writer
  // writes it in pieces: `python3 -` used to run only the first read.
  const split = await ws.exec("{ printf 'x = 1\\n'; sleep 0.2; printf 'print(x)\\n'; } | python3 -");
  assert.equal(split.exitCode, 0, `python3 - failed: ${split.stderr}`);
  assert.equal(split.stdout, '1\n', 'python3 - runs the whole program its stdin carries');
  console.log('  ok  python3 - reads its program to the end of stdin');
}

// ── python and the durable filesystem are the same filesystem ───────────────
// The seed is by value, so a read proves the provisioning carried the bytes;
// the write proves the local supervisor carried them BACK, which is the half a
// sealed facet would silently lose.
{
  await writeText(ws.fs, '/home/user/note.txt', 'written by fs\n');
  const io = await ws.exec(
    'python -c \'print(open("/home/user/note.txt").read().strip()); '
    + 'open("/home/user/from-python.txt", "w").write("written by python\\n")\'');
  assert.equal(io.exitCode, 0, `python failed: ${io.stderr}`);
  assert.equal(io.stdout, 'written by fs\n');
  assert.equal(await readText(ws.fs, '/home/user/from-python.txt'), 'written by python\n');
  console.log('  ok  python reads a file .fs wrote and writes one .fs reads back');

  // And the shell sees it too — one filesystem, not a per-runtime copy.
  const shared = await ws.exec('bash -c "cat from-python.txt"');
  assert.equal(shared.exitCode, 0, `bash failed: ${shared.stderr}`);
  assert.equal(shared.stdout, 'written by python\n');
  console.log('  ok  bash sees what python wrote');
}

// ── A capability the host does not have is named, not faked ─────────────────
// A resident process outlives the call that started it, which needs an actor to
// keep it on. A workspace owns none, so `python script.py` is refused by name
// rather than quietly run as a one-shot that dies with the invocation.
{
  await writeText(ws.fs, '/home/user/server.py', 'print("never reached")\n');
  const resident = await ws.exec('python server.py');
  assert.equal(resident.exitCode, 1);
  assert.match(resident.stderr, /no process substrate/);
  console.log('  ok  a program that keeps running is refused, not degraded');
}

db.close();
console.log('core-wasm-runtime-bun: ok');
