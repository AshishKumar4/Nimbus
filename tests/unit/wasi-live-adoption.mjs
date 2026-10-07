import { memorySupervisor } from './lib/descriptor-supervisor.mjs';
// wasi-live-adoption — the authority filesystem is actually adopted, and a
// reused isolate never leaks one process's capability into the next.
//
// The codec in wasi/filesystem.ts does nothing on its own: a runner has to
// hand it the SUPERVISOR stub, and hand it over AFTER __wasiInitFS. These are
// the wiring facts that make the difference between "an authority exists" and
// "programs use it", plus the isolate-reuse invariant that adopting a
// per-process capability introduces.

import assert from 'node:assert';
import { buildRubySocketProcessWorker } from '../../packages/worker/src/runtime/ruby-resident.ts';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWasiPreamble } from './lib/wasi-authority.mjs';

const RUBY_RUNNER_SRC = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..',
  'packages', 'core', 'src', 'runtime', 'ruby-runner.ts',
);

const enc = new TextEncoder();
const dec = new TextDecoder();

const P = await loadWasiPreamble();


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
  const supA = memorySupervisor();
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
  const sup = memorySupervisor();
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
  const sup = memorySupervisor({ 'home/user/big.txt': 'demand-loaded' });
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
  const sup = memorySupervisor({ 'home/user/wedge.txt': 'ten bytes!' });
  // A supervisor whose read never settles is exactly the wedge case.
  sup.fsReadRange = () => new Promise(() => {});
  P.__wasiInitFS(INIT());
  P.__wasiAdoptSupervisor(sup);
  const h = host();
  const { fd } = await h.open('home/user/wedge.txt');
  // The deadline is read off the timer the park arms, and that timer is run
  // at once: the case is about which delay is asked for and what the read
  // answers when it fires, not about waiting ten seconds.
  const realSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, 0, ...rest); };
  let settled;
  try {
    settled = await h.read(fd).then(() => 'settled');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(settled, 'settled',
    'a never-settling park must resolve to an errno rather than hang forever');
  assert.ok(delays.length > 0 && Math.max(...delays) < 15000,
    `the park deadline must fire below the measured 15-18s suspension ceiling (armed ${delays.join(', ')} ms)`);
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
  const mount = runner.indexOf('__nimbusInstallRubyFs(args.supervisorPid || 0);');
  const readopt = runner.indexOf('__wasiAdoptSupervisor(globalThis.__nimbusRubySupervisor)');
  assert.ok(mount > 0 && readopt > mount,
    'ruby must adopt the supervisor AFTER __wasiInitFS, which clears it');
}

console.log('wasi-live-adoption: adopt-order assertions passed');
