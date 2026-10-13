#!/usr/bin/env bun
// @tier slow: two cases wait out the 10 s park deadline.
/**
 * wasi-syscall-owner: an asynchronous WASI syscall has one owner, in the
 * worker's WASI preamble (the body every uploaded program and CPython runs
 * under), driven through its real import table, threads scheduler and
 * virtual socket kernel.
 *
 * - A socket's bytes are the socket's: a poll that gave up on a socket and a
 *   read that follows it never split one chunk between them.
 * - A syscall the park deadline already answered (EAGAIN) writes nothing
 *   into guest memory or the descriptor table when its input arrives later;
 *   the input waits for the next call.
 * - A threaded guest blocked on a pipe lets the peer that would answer it run.
 * - A descriptor number is handed out only when no descriptor holds it.
 */

import assert from 'node:assert/strict';
import { loadWasiPreamble, makeGuest, makeSession } from './lib/wasi-authority.mjs';
import { makeParkingImports } from './lib/wasi-imports.mjs';
import { VirtualSocketKernel } from '../../packages/core/src/runtime/virtual-socket-kernel.ts';

const ESUCCESS = 0, EAGAIN = 6, EINTR = 27;
const CLOCK = 0, FD_READ = 1;
const enc = new TextEncoder();
const dec = new TextDecoder();
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];
const check = async (what, body) => {
  try { await body(); console.log(`  ✓ ${what}`); }
  catch (error) { failures.push(`${what}: ${error.message}`); console.log(`  ✗ ${what}`); }
};

/** A guest that parks, as an uploaded program under JSPI does, over a fresh preamble. */
async function parkingGuest({ memory = new WebAssembly.Memory({ initial: 8 }), before } = {}) {
  const P = await loadWasiPreamble();
  P.__wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], pid: 4242 });
  const scheduler = before?.(P, memory);
  const bundle = makeParkingImports(P, { argv: ['prog'], env: {}, getMemory: () => memory });
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);
  let region = 0;
  const scratch = () => 65536 + ((region++ % 64) * 1024);
  return {
    P, scheduler, wasi: bundle.wasiImport, proc: bundle.procImport, view, bytes, scratch,
    /** A socket descriptor over a stream this test feeds. */
    socket(fd) {
      let feed;
      const readable = new ReadableStream({ start(controller) { feed = controller; } });
      const socket = { opened: Promise.resolve(), readable, writable: new WritableStream(), close() {} };
      P.fdTable.set(fd, {
        kind: 'socket', socket, reader: null, writer: null,
        readBuf: new Uint8Array(0), readBufOffset: 0, eof: false, closed: false, halfClosedWr: false, fdflags: 0,
      });
      return feed;
    },
    /** sock_recv of up to `max` bytes into a fresh buffer: { errno, text, at }. */
    async recv(fd, max = 64) {
      const at = scratch();
      view().setUint32(at, at + 64, true);
      view().setUint32(at + 4, max, true);
      const errno = await bundle.wasiImport.sock_recv(fd, at, 1, 0, at + 8, at + 12);
      const n = view().getUint32(at + 8, true);
      return { errno, text: errno === ESUCCESS ? dec.decode(bytes().subarray(at + 64, at + 64 + n)) : null, at };
    },
    /** poll_oneoff over `subs` ({ clockMs } or { read: fd }): the events, by userdata (the sub's index). */
    async poll(subs) {
      const at = scratch(), out = scratch(), count = scratch();
      subs.forEach((sub, i) => {
        const base = at + i * 48;
        view().setBigUint64(base, BigInt(i), true);
        view().setUint8(base + 8, 'clockMs' in sub ? CLOCK : FD_READ);
        if ('clockMs' in sub) {
          view().setUint32(base + 16, 1, true);
          view().setBigUint64(base + 24, BigInt(sub.clockMs) * 1_000_000n, true);
          view().setUint16(base + 40, 0, true);
        } else view().setUint32(base + 16, sub.read, true);
      });
      const errno = await bundle.wasiImport.poll_oneoff(at, out, subs.length, count);
      const events = [];
      for (let i = 0; i < view().getUint32(count, true); i++) {
        const e = out + i * 32;
        events.push({ sub: Number(view().getBigUint64(e, true)), type: view().getUint8(e + 10), error: view().getUint16(e + 8, true) });
      }
      return { errno, events };
    },
  };
}

// RTW-1: a poll that gave up on a socket left its read pending; a recv that follows reads the same socket.
await check('a chunk and then the end of a socket, split between a lapsed poll and a recv, reach the recv in order', async () => {
  const g = await parkingGuest();
  const feed = g.socket(50);
  const polled = await g.poll([{ clockMs: 10 }, { read: 50 }]);
  assert.deepEqual(polled, { errno: ESUCCESS, events: [{ sub: 0, type: CLOCK, error: ESUCCESS }] }, 'only the clock fired');
  const recv = g.recv(50);
  feed.enqueue(enc.encode('chunk'));
  feed.close();
  const got = await recv;
  assert.deepEqual({ errno: got.errno, text: got.text }, { errno: ESUCCESS, text: 'chunk' });
  assert.equal((await g.recv(50)).text, '', 'then the end');
});

// RTW-1: two receivers wait on one empty socket and share its one read; the one that finds the bytes taken waits on.
await check('two receivers of one socket: the second waits for its own chunk, or the end, rather than reading a false end', async () => {
  const g = await parkingGuest();
  const feed = g.socket(52);
  const first = g.recv(52);
  const second = g.recv(52);
  feed.enqueue(enc.encode('one'));
  assert.deepEqual({ errno: (await first).errno, text: (await first).text }, { errno: ESUCCESS, text: 'one' });
  const early = await Promise.race([second.then((r) => ({ errno: r.errno, text: r.text })), tick(200).then(() => 'waiting')]);
  assert.equal(early, 'waiting', 'the second has nothing yet, and the socket has not ended');
  feed.enqueue(enc.encode('two'));
  assert.deepEqual({ errno: (await second).errno, text: (await second).text }, { errno: ESUCCESS, text: 'two' });
  const third = g.recv(52);
  const fourth = g.recv(52);
  feed.enqueue(enc.encode('three'));
  feed.close();
  const answers = (await Promise.all([third, fourth])).map((r) => r.text).sort();
  assert.deepEqual(answers, ['', 'three'], 'one gets the chunk, the other the end');
});

// RTW-M8: the deadline answered; the guest reused the buffer; then the bytes came.
await check('a recv the deadline answered writes nothing when its bytes arrive later, and the next recv gets them', async () => {
  const g = await parkingGuest();
  const feed = g.socket(51);
  const started = Date.now();
  const first = await g.recv(51);
  assert.equal(first.errno, EAGAIN, 'the deadline answered');
  assert.ok(Date.now() - started >= 9000, 'after the deadline');
  const guestOwn = enc.encode('GUEST-OWN-DATA');
  g.bytes().set(guestOwn, first.at + 64);
  g.view().setUint32(first.at + 8, 0xdeadbeef, true);
  feed.enqueue(enc.encode('late!'));
  await tick();
  assert.equal(dec.decode(g.bytes().subarray(first.at + 64, first.at + 64 + guestOwn.length)), 'GUEST-OWN-DATA', 'the buffer is the guest\'s again');
  assert.equal(g.view().getUint32(first.at + 8, true), 0xdeadbeef, 'and so is the count');
  assert.equal((await g.recv(51)).text, 'late!', 'the bytes wait for the next recv');
});

// RTW-M8: the same for an accept; the connection is not adopted behind the guest's back.
await check('an accept the deadline answered adopts nothing when its connection arrives later, and the next accept gets it', async () => {
  const kernel = new VirtualSocketKernel({});
  const port = kernel.listen(7301);
  globalThis.__nimbusVirtualSockets = kernel;
  try {
    const g = await parkingGuest();
    g.P.fdTable.set(60, { kind: 'listener', port, fdflags: 0 });
    const out = g.scratch();
    g.view().setUint32(out, 0xfeedface, true);
    assert.equal(await g.wasi.sock_accept(60, 0, out), EAGAIN, 'the deadline answered');
    const held = [...g.P.fdTable.keys()].sort((a, b) => a - b);
    const request = kernel.handleHttpRequest(port, new Request('http://nimbus.local/late')).catch(() => {});
    await tick();
    assert.equal(g.view().getUint32(out, true), 0xfeedface, 'nothing was written');
    assert.deepEqual([...g.P.fdTable.keys()].sort((a, b) => a - b), held, 'no descriptor was adopted');
    const accepted = await Promise.race([g.wasi.sock_accept(60, 0, out), tick(2000).then(() => 'still waiting')]);
    assert.equal(accepted, ESUCCESS, 'the next accept takes the connection that came');
    assert.equal(g.P.fdTable.get(g.view().getUint32(out, true))?.kind, 'socket');
    void request;
  } finally { delete globalThis.__nimbusVirtualSockets; }
});

// RTW-M8: the connection a timed-out accept gives back is the listener's: a poll waiting on it hears of it.
await check('a connection a timed-out accept gave back wakes a poll of its listener', async () => {
  const kernel = new VirtualSocketKernel({});
  const port = kernel.listen(7302);
  globalThis.__nimbusVirtualSockets = kernel;
  try {
    const g = await parkingGuest();
    g.P.fdTable.set(61, { kind: 'listener', port, fdflags: 0 });
    assert.equal(await g.wasi.sock_accept(61, 0, g.scratch()), EAGAIN, 'the deadline answered');
    const polled = g.poll([{ read: 61 }]);
    await tick();
    const request = kernel.handleHttpRequest(port, new Request('http://nimbus.local/late')).catch(() => {});
    const woke = await Promise.race([polled, tick(2000).then(() => 'still waiting')]);
    assert.deepEqual(woke, { errno: ESUCCESS, events: [{ sub: 0, type: FD_READ, error: ESUCCESS }] }, 'the poll heard of the connection at once');
    void request;
  } finally { delete globalThis.__nimbusVirtualSockets; }
});

// RTW-M7: thread 1 reads an empty pipe; thread 2, queued behind it, is the writer.
await check('a threaded guest blocked on a pipe lets the thread that writes it run', async () => {
  const memory = new WebAssembly.Memory({ initial: 8, maximum: 8, shared: true });
  const bodies = new Map();
  const g = await parkingGuest({
    memory,
    before: (P, mem) => P.__wasiThreadsCreate({ memory: mem, startThread: (tid, arg) => () => bodies.get(arg)(tid) }),
  });
  const spawn = g.scheduler.hostImports().wasi['thread-spawn'];
  let result;
  const ended = await g.scheduler.runMain(async () => {
    const at = g.scratch();
    assert.equal(g.proc.pipe(at), ESUCCESS);
    const [r, w] = [g.view().getInt32(at, true), g.view().getInt32(at + 4, true)];
    bodies.set(1, async () => {
      const wat = g.scratch();
      g.bytes().set(enc.encode('hi'), wat + 64);
      g.view().setUint32(wat, wat + 64, true);
      g.view().setUint32(wat + 4, 2, true);
      await g.wasi.fd_write(w, wat, 1, wat + 8);
    });
    assert.ok(spawn(1) > 0, 'the writer is queued');
    const rat = g.scratch();
    g.view().setUint32(rat, rat + 64, true);
    g.view().setUint32(rat + 4, 64, true);
    const started = Date.now();
    const errno = await g.wasi.fd_read(r, rat, 1, rat + 8);
    result = { errno, text: dec.decode(g.bytes().slice(rat + 64, rat + 64 + g.view().getUint32(rat + 8, true))), waited: Date.now() - started };
  });
  assert.deepEqual(ended, { exitCode: 0 });
  assert.notEqual(result.errno, EINTR, 'the read did not wait out the process park');
  assert.deepEqual({ errno: result.errno, text: result.text }, { errno: ESUCCESS, text: 'hi' });
  assert.ok(result.waited < 2000, `the writer ran at once (${result.waited} ms)`);
});

// RTW-2: a renumbered descriptor's number is not handed out again while it is held.
await check('an open after fd_renumber takes a free number, not the renumbered descriptor\'s', async () => {
  const P = await loadWasiPreamble();
  const session = makeSession({ files: { 'home/user/a.txt': 'AAA', 'home/user/b.txt': 'BBB' } });
  try {
    const h = makeGuest(P, session, { root: 'home/user', preopens: [{ wasiPath: '/', vfsPath: 'home/user' }] });
    const a = h.open('a.txt');
    assert.equal(a.errno, ESUCCESS);
    assert.equal(h.wasi.fd_renumber(a.fd, a.fd + 1), ESUCCESS);
    const b = h.open('b.txt');
    assert.equal(b.errno, ESUCCESS);
    assert.notEqual(b.fd, a.fd + 1, 'the held number is not reissued');
    assert.equal(h.read(a.fd + 1).text, 'AAA', 'the renumbered descriptor still reads its file');
    assert.equal(h.read(b.fd).text, 'BBB');
  } finally { await session.dispose(); }
});

assert.deepEqual(failures, []);
console.log('wasi-syscall-owner: each async syscall has one owner');
