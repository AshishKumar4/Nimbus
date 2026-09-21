import { descriptorSupervisor } from './lib/descriptor-supervisor.mjs';
// wasi-live-adoption — the authority filesystem is actually adopted, and a
// reused isolate never leaks one process's capability into the next.
//
// The codec in wasi/filesystem.ts does nothing on its own: a runner has to
// hand it the SUPERVISOR stub, and hand it over AFTER __wasiInitFS. These are
// the wiring facts that make the difference between "an authority exists" and
// "programs use it", plus the isolate-reuse invariant that adopting a
// per-process capability introduces.

import assert from 'node:assert';
import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/core/src/runtime/wasi-instance.ts';
import { buildRubySocketProcessWorker } from '../../packages/worker/src/runtime/ruby-resident.ts';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUBY_RUNNER_SRC = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..',
  'packages', 'core', 'src', 'runtime', 'ruby-runner.ts',
);

const enc = new TextEncoder();
const dec = new TextDecoder();

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const P = await new AsyncFunction(`${WASI_INSTANCE_PREAMBLE_SRC}
return { __wasiInitFS, __wasiMakeImports, __wasiAdoptSupervisor, fdTable };`)();

function mockSupervisor(seed = {}) {
  const store = new Map();
  for (const [k, v] of Object.entries(seed)) store.set(k, enc.encode(v));
  const log = [];
  return descriptorSupervisor({
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
    async fsWriteRange(p, offset, bytes) {
      const old = store.get(p) ?? new Uint8Array();
      const next = new Uint8Array(Math.max(old.length, offset + bytes.length));
      next.set(old); next.set(bytes, offset); store.set(p, next);
      log.push(['fsWriteRange', p]);
      return bytes.length;
    },
    async fsTruncate(p, size) {
      const next = new Uint8Array(size);
      next.set((store.get(p) ?? new Uint8Array()).subarray(0, size));
      store.set(p, next);
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
  });
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

const INIT = () => ({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }] });

// ── 1. A pool isolate is reused: process B must not inherit A's supervisor ──
{
  const supA = mockSupervisor();
  P.__wasiInitFS(INIT());
  P.__wasiAdoptSupervisor(supA);
  const a = host();
  const created = await a.open('home/user/a.txt', 1 /* O_CREAT */);
  await a.write(created.fd, 'from-process-a');
  assert.equal(dec.decode(supA.store.get('home/user/a.txt')), 'from-process-a');

  // Process B starts in the same isolate and adopts nothing: it has no
  // filesystem, rather than A's.
  P.__wasiInitFS(INIT());
  const b = host();
  const bCreated = await b.open('home/user/b.txt', 1);
  assert.equal(bCreated.errno, 8 /* EBADF */, 'process B has no authority to open on');
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
  assert.equal(dec.decode(sup.store.get('home/user/after-hop.txt')), 'still-durable',
    'a supervisor-less re-entry must not drop the adopted stub');
}

// ── 3. Whatever the authority holds is readable, with nothing seeded ────────
{
  const sup = mockSupervisor({ 'home/user/big.txt': 'demand-loaded' });
  P.__wasiInitFS(INIT());
  P.__wasiAdoptSupervisor(sup);
  const h = host();
  const { errno, fd } = await h.open('home/user/big.txt');
  assert.equal(errno, 0);
  assert.equal((await h.read(fd)).text, 'demand-loaded');
}

// ── 4. Ruby's resident process adopts the filesystem on every entry ─────────
{
  const src = buildRubySocketProcessWorker('/* preamble */');
  assert.ok(/__wasiAdoptSupervisor\(supervisor\)/.test(src),
    'ruby resident entry must hand the SUPERVISOR stub to the filesystem');
  // A server answers requests and never exits, so the adoption has to be on
  // the request path — not only on startProcess.
  const httpBody = src.slice(src.indexOf('async handleHttpRequest'));
  assert.ok(/__nimbusAdoptRubySupervisor\(this\.env\)/.test(httpBody),
    'ruby must adopt on an HTTP request, not just at startup');
  // There is nothing to flush: a write is in the session when the syscall
  // returns, so a park helper that "drains" would be draining nothing.
  assert.ok(!/DrainPersist|RevalidateFS|__nimbusParkRuby/.test(src),
    'ruby resident entry must not carry a persist queue');
}

console.log('wasi-live-adoption: all assertions passed');

// ── 5. A park that never settles must yield an errno, never hang ────────────
// Measured ceiling: a cross-request suspension past ~15-18s idle leaves the
// promise permanently unsettled. Without a deadline the guest wedges silently.
{
  const sup = mockSupervisor({ 'home/user/wedge.txt': 'ten bytes!' });
  // A supervisor whose read never settles is exactly the wedge case.
  sup.fsReadRange = () => new Promise(() => {});
  P.__wasiInitFS(INIT());
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

// ── 6. No supervisor means no filesystem, never a write that evaporates ─────
// Write-through is the only mechanism. The case where a runner failed to hand
// over the stub has to be an error at the write, not a write held in memory
// that is lost when the process exits.
{
  P.__wasiInitFS(INIT());
  const h = host();
  const created = await h.open('home/user/lost.txt', 1 /* O_CREAT */);
  assert.equal(created.errno, 8 /* EBADF */,
    'a create with no supervisor is refused; nothing is held in memory to lose');
  assert.equal(P.fdTable.size, 4, 'no descriptor was handed out');
}

console.log('wasi-live-adoption: silent-write-loss assertions passed');
// ── 7. Ruby re-adopts AFTER mounting, because the mount drops the stub ───────
{
  const runner = readFileSync(RUBY_RUNNER_SRC, 'utf8');
  const mount = runner.indexOf('__nimbusInstallRubyFs();');
  const readopt = runner.indexOf('__wasiAdoptSupervisor(globalThis.__nimbusRubySupervisor)');
  assert.ok(mount > 0 && readopt > mount,
    'ruby must adopt the supervisor AFTER __wasiInitFS, which clears it');
}

console.log('wasi-live-adoption: adopt-order assertions passed');
