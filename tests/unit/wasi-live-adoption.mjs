#!/usr/bin/env bun
// wasi-live-adoption — the live filesystem is actually adopted, and a reused
// isolate never leaks one process's filesystem state into the next.
//
// The live layer landing in wasi-instance.ts does nothing on its own: a
// runner has to hand it the SUPERVISOR stub and drain before it returns.
// These are the wiring facts that make the difference between "a live
// filesystem exists" and "programs use it", plus the isolate-reuse invariant
// that adopting a per-process capability introduces.

import assert from 'node:assert';
import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/core/src/runtime/wasi-instance.ts';
import { buildRubySocketProcessWorker } from '../../packages/worker/src/runtime/ruby-runner.ts';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUBY_RUNNER_SRC = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..',
  'packages', 'worker', 'src', 'runtime', 'ruby-runner.ts',
);

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (s) => btoa(s);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const P = await new AsyncFunction(`${WASI_INSTANCE_PREAMBLE_SRC}
return { __wasiInitFS, __wasiMakeImports, __wasiAdoptSupervisor, __wasiDrainPersist };`)();

function mockSupervisor(seed = {}) {
  const store = new Map();
  for (const [k, v] of Object.entries(seed)) store.set(k, enc.encode(v));
  const log = [];
  return {
    store, log,
    async fsReadRange(p, offset, length) {
      log.push(['fsReadRange', p]);
      const bytes = store.get(p);
      if (!bytes) return null;
      return bytes.slice(offset, Math.min(bytes.length, offset + length));
    },
    async writeFile(p, content) {
      log.push(['writeFile', p]);
      store.set(p, new Uint8Array(content));
    },
    async unlink(p) { log.push(['unlink', p]); store.delete(p); },
    async mkdir(p) { log.push(['mkdir', p]); },
    async rmdir(p) { log.push(['rmdir', p]); },
    async rename(a, b) { log.push(['rename', a, b]); },
    async stat(p) {
      log.push(['stat', p]);
      const bytes = store.get(p);
      return bytes ? { type: 'file', size: bytes.length, mtime: Date.now() } : null;
    },
  };
}

function host() {
  const memory = new WebAssembly.Memory({ initial: 8 });
  const { wasiImport } = makeImportsWithoutJSPI(P, {
    argv: ['prog'], env: {}, getMemory: () => memory,
    stdoutWrite: () => {}, stderrWrite: () => {},
  });
  const view = () => new DataView(memory.buffer);
  const u8 = () => new Uint8Array(memory.buffer);
  const writePath = (s) => { const b = enc.encode(s); u8().set(b, 0x100); return b.length; };
  return {
    async open(p, oflags = 0) {
      const len = writePath(p);
      const errno = await wasiImport.path_open(3, 1, 0x100, len, oflags, -1n, -1n, 0, 0x200);
      return { errno, fd: view().getUint32(0x200, true) };
    },
    async write(fd, text) {
      const bytes = enc.encode(text);
      u8().set(bytes, 0x400);
      view().setUint32(0x300, 0x400, true);
      view().setUint32(0x304, bytes.length, true);
      return wasiImport.fd_write(fd, 0x300, 1, 0x200);
    },
    async read(fd) {
      view().setUint32(0x300, 0x400, true);
      view().setUint32(0x304, 65536, true);
      const errno = await wasiImport.fd_read(fd, 0x300, 1, 0x200);
      const n = view().getUint32(0x200, true);
      return { errno, text: dec.decode(u8().slice(0x400, 0x400 + n)) };
    },
  };
}

const INIT = (extra = {}) => ({
  root: '', preopens: [{ wasiPath: '/', vfsPath: '' }],
  files: {}, dirs: ['home', 'home/user'],
  modes: { '': 7, home: 7, 'home/user': 7 },
  ...extra,
});

// ── 1. A pool isolate is reused: process B must not inherit A's supervisor ──
{
  const supA = mockSupervisor();
  P.__wasiInitFS(INIT());
  P.__wasiAdoptSupervisor(supA);
  const a = host();
  const created = await a.open('home/user/a.txt', 1 /* O_CREAT */);
  await a.write(created.fd, 'from-process-a');
  await P.__wasiDrainPersist();
  assert.equal(dec.decode(supA.store.get('home/user/a.txt')), 'from-process-a');

  // Process B starts in the same isolate and adopts nothing.
  P.__wasiInitFS(INIT());
  const b = host();
  const bCreated = await b.open('home/user/b.txt', 1);
  await b.write(bCreated.fd, 'from-process-b');
  await P.__wasiDrainPersist();
  assert.ok(!supA.store.has('home/user/b.txt'),
    "process B's writes must not reach the previous process's supervisor");
  assert.ok(!supA.log.some(([op, p]) => p === 'home/user/b.txt'),
    "process B must not touch the previous process's capability at all");
}

// ── 2. Adopting never downgrades a live stub ────────────────────────────────
{
  const sup = mockSupervisor();
  P.__wasiInitFS(INIT());
  P.__wasiAdoptSupervisor(sup);
  // A routed fetch/handleHttpRequest hop resolves the entrypoint with no
  // SUPERVISOR in env. That must not strand the process.
  P.__wasiAdoptSupervisor(undefined);
  const h = host();
  const { fd } = await h.open('home/user/after-hop.txt', 1);
  await h.write(fd, 'still-durable');
  await P.__wasiDrainPersist();
  assert.equal(dec.decode(sup.store.get('home/user/after-hop.txt')), 'still-durable',
    'a supervisor-less re-entry must not drop the adopted stub');
}

// ── 3. A seed carrying metadata only still reads through ────────────────────
{
  const sup = mockSupervisor({ 'home/user/big.txt': 'demand-loaded' });
  P.__wasiInitFS(INIT({
    sizes: { 'home/user/big.txt': 'demand-loaded'.length },
    modes: { '': 7, home: 7, 'home/user': 7, 'home/user/big.txt': 6 },
  }));
  P.__wasiAdoptSupervisor(sup);
  const h = host();
  const { errno, fd } = await h.open('home/user/big.txt');
  assert.equal(errno, 0);
  assert.equal((await h.read(fd)).text, 'demand-loaded');
}

// ── 4. Ruby's resident process adopts the filesystem and drains at parks ────
{
  const src = buildRubySocketProcessWorker('/* preamble */');
  assert.ok(/__wasiAdoptSupervisor\(supervisor\)/.test(src),
    'ruby resident entry must hand the SUPERVISOR stub to the filesystem');
  // Either entry point drains: __wasiRevalidateFS drains before it checks the
  // subtree revision. What must not happen is parking without draining.
  assert.ok(/__wasiDrainPersist\(\)|__wasiRevalidateFS\(\)/.test(src),
    'ruby resident entry must drain queued writes when parking');
  // A server answers requests and never exits, so the drain has to be on the
  // request path — not only on startProcess.
  const httpBody = src.slice(src.indexOf('async handleHttpRequest'));
  assert.ok(/__nimbusParkRuby\(/.test(httpBody),
    'ruby must drain when parking after an HTTP request, not just at startup');
}

console.log('wasi-live-adoption: all assertions passed');

// ── 5. A park that never settles must yield an errno, never hang ────────────
// Measured ceiling: a cross-request suspension past ~15-18s idle leaves the
// promise permanently unsettled. Without a deadline the guest wedges silently.
{
  const sup = mockSupervisor();
  // A supervisor whose read never settles is exactly the wedge case.
  sup.fsReadRange = () => new Promise(() => {});
  P.__wasiInitFS(INIT({
    sizes: { 'home/user/wedge.txt': 10 },
    modes: { '': 7, home: 7, 'home/user': 7, 'home/user/wedge.txt': 6 },
  }));
  P.__wasiAdoptSupervisor(sup);
  const h = host();
  const { fd } = await h.open('home/user/wedge.txt');
  const started = Date.now();
  const settled = await Promise.race([
    h.read(fd).then(() => 'settled'),
    new Promise((r) => setTimeout(() => r('HUNG'), 30000)),
  ]);
  assert.equal(settled, 'settled',
    'a never-settling park must resolve to an errno rather than hang forever');
  assert.ok(Date.now() - started < 15000,
    'the park deadline must fire below the measured 15-18s suspension ceiling');
}

// ── 6. A live-backed filesystem with no supervisor must not lose data quietly ──
// This is what let the exit-time diff be deleted. Write-through is now the only
// mechanism, so the case where it silently does nothing — a seed built as a
// CACHE whose runner failed to hand over the stub — has to be an error at the
// next drain, not a write that evaporates. A SEALED seed (no revision: clang's
// sysroot, the render backend's empty root) keeps its writes in memory on
// purpose and must stay quiet.
{
  // Live-backed: manifestVfs stamps a revision, so the seed is a cache.
  P.__wasiInitFS(INIT({ revision: 7 }));
  const h = host();
  const created = await h.open('home/user/lost.txt', 1 /* O_CREAT */);
  await h.write(created.fd, 'this write has nowhere to go');
  await assert.rejects(
    () => P.__wasiDrainPersist(),
    /no supervisor adopted for a live-backed filesystem/,
    'a mutation with no supervisor on a live-backed seed must surface as data loss',
  );
}
{
  // Sealed: no revision, so the seed is the whole filesystem and nothing is lost.
  P.__wasiInitFS(INIT());
  const h = host();
  const created = await h.open('home/user/kept.txt', 1 /* O_CREAT */);
  await h.write(created.fd, 'held in memory on purpose');
  await P.__wasiDrainPersist();
  const reopened = await h.open('home/user/kept.txt');
  assert.equal(reopened.errno, 0);
  assert.equal((await h.read(reopened.fd)).text, 'held in memory on purpose');
}

console.log('wasi-live-adoption: watchdog assertions passed');
// ── 7. An unreachable manifest entry is an I/O error, never an empty file ────
// A manifest entry asserts "this file exists and has N bytes" while the bytes
// stay in the session VFS. With no supervisor there is no way to fetch them,
// and returning zero bytes is not a degraded read — it is a different file,
// handed over as a success. Ruby's require consumed exactly that, defined
// nothing, and died later on an undefined constant with nothing pointing back.
{
  P.__wasiInitFS(INIT({
    sizes: { 'home/user/seeded.rb': 24 },
    modes: { '': 7, home: 7, 'home/user': 7, 'home/user/seeded.rb': 6 },
    revision: 3,
  }));
  // Deliberately NOT adopting: this is the state __wasiInitFS leaves behind,
  // and the state a runner that adopts before mounting is left in.
  const h = host();
  const opened = await h.open('home/user/seeded.rb');
  assert.equal(opened.errno, 0, 'the manifest entry must open — it exists');
  const read = await h.read(opened.fd);
  assert.equal(read.errno, 29, `an unreachable manifest entry must read EIO, got errno ${read.errno}`);
  assert.notEqual(read.text, '', 'a zero-byte success is the failure this asserts against');
}

// ── 8. Ruby re-adopts AFTER mounting, because the mount drops the stub ───────
{
  const runner = readFileSync(RUBY_RUNNER_SRC, 'utf8');
  const mount = runner.indexOf('__nimbusInstallRubyFsSnapshot(args.fsSnapshot)');
  const readopt = runner.indexOf('__wasiAdoptSupervisor(globalThis.__nimbusRubySupervisor)');
  assert.ok(mount > 0 && readopt > mount,
    'ruby must adopt the supervisor AFTER __wasiInitFS, which clears it');
}

console.log('wasi-live-adoption: silent-write-loss assertions passed');
console.log('wasi-live-adoption: unreachable-content and adopt-order assertions passed');
