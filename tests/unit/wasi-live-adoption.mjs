import { memorySupervisor } from './lib/descriptor-supervisor.mjs';
// wasi-live-adoption — the authority filesystem is actually adopted, and a
// reused isolate never leaks one process's capability into the next.
//
// The codec in wasi/filesystem.ts does nothing on its own: a runner has to
// hand it the SUPERVISOR stub, and hand it over AFTER __wasiInitFS. These are
// the wiring facts that make the difference between "an authority exists" and
// "programs use it", plus the isolate-reuse invariant that adopting a
// per-process capability introduces. Ruby's entries are run as a facet runs
// them: its resident worker's, and the runner's own __rubyRun over the WASI
// host, the VM stood in for by a program that writes a file.

import assert from 'node:assert';
import { plugin } from 'bun';
import { buildRubySocketProcessWorker } from '../../packages/worker/src/runtime/ruby-resident.ts';
import { RUBY_RUNNER_PREAMBLE_TAIL } from '../../packages/core/src/runtime/ruby-runner.ts';
import { wasiOutputRelay } from '../../packages/core/src/runtime/wasi/stdio.ts';
import { outputControlReader } from '../../packages/core/src/runtime/wasi/output-control.ts';
import { makeImportsWithoutJSPI, makeParkingImports } from './lib/wasi-imports.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadWasiPreamble } from './lib/wasi-authority.mjs';

// The resident worker is a Durable Object class module, as a facet loads it.
plugin({
  name: 'cloudflare-shims',
  setup(build) {
    build.module('cloudflare:workers', () => ({
      loader: 'object',
      exports: { DurableObject: class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } },
    }));
  },
});

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
// A server never exits, and each request may come through a new instance of
// its worker with the session's current SUPERVISOR: the run takes the one its
// start had, a request the one it came with, and a routed hop that brings none
// keeps the last.
{
  const preamble = [
    'function __wasiAdoptSupervisor(supervisor) { globalThis.__adoptions.push(supervisor && supervisor.name); }',
    'globalThis.__nimbusRubyDrainOutput = async () => {};',
    'globalThis.__nimbusRubyWriteDiagnostic = () => {};',
    // The program binds a port and serves until the process ends.
    'globalThis.__rubyRun = () => { globalThis.__ranWith = globalThis.__nimbusRubySupervisor.name; globalThis.__nimbusVirtualSockets.listen(8127); return new Promise(() => {}); };',
    // Each step answers the request waiting, as the supervisor it holds then.
    'globalThis.__nimbusRubyStep = async () => {',
    '  const conn = globalThis.__nimbusVirtualSockets.acceptNow(8127);',
    '  if (conn) {',
    '    const by = globalThis.__nimbusRubySupervisor.name;',
    '    globalThis.__nimbusVirtualSockets.send(conn.id, `HTTP/1.1 200 OK\\r\\ncontent-length: ${by.length}\\r\\n\\r\\n${by}`);',
    '    globalThis.__nimbusVirtualSockets.close(conn.id);',
    '  }',
    '  return { resumed: true, alive: true, wakeAfter: null };',
    '};',
  ].join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'wasi-live-adoption-ruby-'));
  try {
    writeFileSync(join(dir, 'ruby+stdlib.wasm'), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    writeFileSync(join(dir, 'worker.mjs'), buildRubySocketProcessWorker(preamble));
    globalThis.__adoptions = [];
    const { NimbusProcess } = await import(pathToFileURL(join(dir, 'worker.mjs')).href);
    const supervisor = (name) => ({ name, stdout: async () => {}, stderr: async () => {}, registerPort: async () => {} });
    const started = await new NimbusProcess({ storage: {} }, { SUPERVISOR: supervisor('A') }).startProcess({ userCode: 'serve', rbArgv: [], userEnv: {}, progName: 'server.rb', cwd: '/home/user' });
    assert.deepEqual({ state: started.state, port: started.port, ranWith: globalThis.__ranWith, adoptions: globalThis.__adoptions }, { state: 'listening', port: 8127, ranWith: 'A', adoptions: ['A'] },
      'the start adopts its SUPERVISOR before the program runs');
    const request = () => new Request('http://process/', { headers: { 'X-Nimbus-Port': '8127' } });
    const answered = await new NimbusProcess({ storage: {} }, { SUPERVISOR: supervisor('B') }).handleHttpRequest(request());
    assert.deepEqual({ status: answered.status, by: await answered.text(), adoptions: globalThis.__adoptions }, { status: 200, by: 'B', adoptions: ['A', 'B'] },
      'a request adopts the SUPERVISOR it came with');
    const hop = await new NimbusProcess({ storage: {} }, {}).handleHttpRequest(request());
    assert.equal(await hop.text(), 'B', 'a routed hop with no SUPERVISOR keeps the last one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('wasi-live-adoption: all assertions passed');

// ── 5. A socket wait that never settles answers EAGAIN, never hangs ─────────
// A socket's or a poll's wait is bounded by the park deadline (preamble.ts
// withParkDeadline), and answered EAGAIN, which its caller retries: a peer
// that never answers must not wedge the guest. A filesystem call has no such
// answer and waits for the session's, however long (wasi-park-deadline-fs):
// a suspension resumes after 25 and 60 s, in a foreground run and in a
// long-running process's later request alike (throwaway tw-parkceil1,
// 2026-10-13), where the 15-18 s ceiling measured on 2026-08-02 had it wedge.
{
  P.__wasiInitFS(INIT());
  const memory = new WebAssembly.Memory({ initial: 1 });
  // The guarded table a parking guest gets, its imports callable from here.
  const { wasiImport } = makeParkingImports(P, { argv: ['prog'], env: {}, getMemory: () => memory, stdoutWrite: () => {}, stderrWrite: () => {} });
  // A socket whose peer never sends: its read never settles.
  P.fdTable.set(40, {
    kind: 'socket', socket: { opened: Promise.resolve(), readable: new ReadableStream({ start() {} }), writable: new WritableStream(), close() {} },
    reader: null, writer: null, readBuf: new Uint8Array(0), readBufOffset: 0, eof: false, closed: false, halfClosedWr: false, fdflags: 0,
  });
  const view = new DataView(memory.buffer);
  view.setUint32(0, 64, true); view.setUint32(4, 16, true);
  // The deadline is read off the timer the park arms, and that timer is run
  // at once: the case is about which delay is asked for and what the wait
  // answers when it fires, not about waiting ten seconds.
  const realSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, 0, ...rest); };
  let errno;
  try {
    errno = await wasiImport.sock_recv(40, 0, 1, 0, 8, 12);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(errno, 6, 'a socket wait that never settles answers EAGAIN');
  assert.ok(delays.length > 0 && Math.max(...delays) < 15000, `the park deadline fires at its own bound (armed ${delays.join(', ')} ms)`);
  P.fdTable.delete(40);
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
// The runner's own __rubyRun over this WASI host: its mount (__wasiInitFS)
// clears the adoption, so the supervisor the entry published has to be
// adopted after it, or the program's first file call answers EBADF. The VM
// is stood in for by a program that writes a file.
{
  const supervisor = memorySupervisor();
  Object.assign(globalThis, {
    __wasiSupervisorOutput: wasiOutputRelay,
    __wasiOutputControl: outputControlReader,
    __wasiSettled: async (result) => result,
    __nimbusRubyStep: async () => ({ resumed: false, alive: false }),
    __testEval: async () => {
      const h = host();
      const { errno, fd } = await h.open('home/user/from-ruby.txt', 1 /* O_CREAT */);
      if (errno === 0) await h.write(fd, 'written by the program');
      return { status: errno === 0 ? 0 : 1 };
    },
  });
  // A one-shot run's facet of its own: no module of the resident worker's above.
  delete globalThis.__NIMBUS_WASM;
  new Function('__wasiInitFS', '__wasiAdoptSupervisor', 'globalThis', `${RUBY_RUNNER_PREAMBLE_TAIL}
async function __nimbusRubyEval(boot, code) { return globalThis.__testEval(code); }`)(P.__wasiInitFS, P.__wasiAdoptSupervisor, globalThis);
  globalThis.__rubyBootstrap = Promise.resolve({ ok: true, rubyInitialized: true });
  globalThis.__nimbusRubySupervisor = supervisor;
  const result = await globalThis.__rubyRun({ userCode: 'File.write', requires: [], rbArgv: [], userEnv: {}, progName: 'ruby', binName: 'ruby', cwd: '/home/user', supervisorPid: 0 });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(dec.decode(supervisor.store.get('home/user/from-ruby.txt')), 'written by the program',
    'the program writes through the supervisor adopted after the mount');
}

console.log('wasi-live-adoption: adopt-order assertions passed');
