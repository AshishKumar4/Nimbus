#!/usr/bin/env bun
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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';

const WASM_DIR = new URL('../../packages/worker/wasm/', import.meta.url).pathname;
const BASH_FILES = [
  ['share/bash/bash.async.wasm', `${WASM_DIR}bash/bash.async.wasm`],
  ['share/bash/coreutils/busybox.wasm', `${WASM_DIR}bash/coreutils/busybox.wasm`],
  ['share/bash/coreutils/busybox.applets', `${WASM_DIR}bash/coreutils/busybox.applets`],
];

// The artifacts are committed, but a worktree mid-rebuild has neither.
if (BASH_FILES.some(([, disk]) => !existsSync(disk))) {
  console.log('core-wasm-runtime-bun: SKIPPED (bash.async.wasm not built)');
  process.exit(0);
}

const INSTALL_ROOT = 'home/user/.nimbus/runtimes/bash/5.2.37';

/**
 * Write the bash runtime into the workspace exactly as an install does: the
 * files under their manifest paths, and a manifest.json beside them naming the
 * runner each command dispatches to.
 */
function seedBashRuntime(vfs) {
  const fs = vfs.as({ uid: 0, gid: 0, groups: [0], umask: 0o022 });
  const files = [];
  for (const [path, disk] of BASH_FILES) {
    const bytes = readFileSync(disk);
    const target = `${INSTALL_ROOT}/${path}`;
    fs.mkdir(target.replace(/\/[^/]+$/, ''), { recursive: true });
    fs.writeFile(target, new Uint8Array(bytes));
    files.push({
      path,
      content: `blobs/bash-5.2.37/${path}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    });
  }
  fs.writeFile(`${INSTALL_ROOT}/manifest.json`, JSON.stringify({
    name: 'bash',
    version: '5.2.37',
    license: 'GPL-3.0-or-later',
    wasi_namespace: 'wasi_snapshot_preview1',
    files,
    entrypoints: [{ binName: 'bash', runner: 'bash-runner', args: [] }],
  }));
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

  seedBashRuntime(plain.vfs);
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
}

// ── bash and the durable filesystem are the same filesystem ─────────────────
// The point of running it here rather than in a harness: what bash writes is a
// row in the host's SQLite, readable through the embedder-facing `.fs`.
{
  await ws.fs.writeFile('/home/user/from-fs.txt', 'seeded\n');
  const roundTrip = await ws.exec('bash -c \'cat from-fs.txt; echo written > from-bash.txt\'');
  assert.equal(roundTrip.exitCode, 0, `bash failed: ${roundTrip.stderr}`);
  assert.equal(roundTrip.stdout, 'seeded\n');
  assert.equal(await ws.fs.readFile('/home/user/from-bash.txt'), 'written\n');
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
  ws.vfs.as({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 })
    .writeFile('home/user/add.wasm', addWasm, { mode: 0o755 });

  const direct = await ws.exec('wasm-runner ./add.wasm add 3 4');
  assert.equal(direct.exitCode, 0, `wasm-runner failed: ${direct.stderr}`);
  assert.equal(direct.stdout, '7\n');

  const dispatched = await ws.exec('./add.wasm add 20 22');
  assert.equal(dispatched.exitCode, 0, `exec dispatch failed: ${dispatched.stderr}`);
  assert.equal(dispatched.stdout, '42\n');
  console.log('  ok  a wasm binary on the PATH runs through exec-dispatch');
}

// ── The port refuses what it cannot honour ──────────────────────────────────
// A facet asking for a supervisor capability is asking for a write credential
// over the session. A host that cannot mint one must say so: handed the seed
// without it, a guest reads a filesystem it can never write to and reports
// success. That is the failure this refusal exists to make impossible.
{
  assert.throws(
    () => localFacetHost().open({ tag: 'probe', supervisorPid: 7 }),
    /supervisor capability/,
    'a local facet host must refuse a supervisor it cannot mint',
  );
  console.log('  ok  a capability the host cannot mint is refused, not faked');
}

db.close();
console.log('core-wasm-runtime-bun: ok');
