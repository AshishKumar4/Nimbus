#!/usr/bin/env bun
// @tier slow: each case waits out the 10 s park deadline.
/**
 * wasi-park-deadline-fs — the park deadline answers only the calls POSIX
 * lets end in EAGAIN.
 *
 * A syscall the session answers late is answered EAGAIN at the 10 s park
 * deadline (preamble.ts withParkDeadline), which a socket's, a pipe's or a
 * poll's caller retries. A filesystem call has no such answer: mkdir(2) and
 * read(2) on a file never return EAGAIN, and CPython's os.makedirs raised
 * BlockingIOError when the session took 11 s to grant the process its
 * first change (wasi-fs-load on fe0b2ea1f). Through the real WASI body, over
 * a session whose answers are held back past the deadline.
 */

import assert from 'node:assert/strict';
import { loadWasiPreamble, makeSession } from './lib/wasi-authority.mjs';
import { makeParkingImports } from './lib/wasi-imports.mjs';

const ESUCCESS = 0, EAGAIN = 6;
const LATE_MS = 11_000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];
const check = async (what, body) => {
  try { await body(); console.log(`  ✓ ${what}`); }
  catch (error) { failures.push(`${what}: ${error.message}`); console.log(`  ✗ ${what}`); }
};

/** `supervisor`, its calls `late` answered only after LATE_MS. */
function answeringLate(supervisor, late) {
  return new Proxy(supervisor, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (typeof value !== 'function') return value;
      if (!late.has(name)) return value.bind(target);
      return async (...args) => { await sleep(LATE_MS); return value.apply(target, args); };
    },
  });
}

/** A guest that parks, as an uploaded program does, over `session`, the supervisor calls `late` held back. */
async function guest(session, late) {
  const P = await loadWasiPreamble();
  P.__wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], pid: session.pid });
  P.__wasiAdoptSupervisor(answeringLate(session.supervisor, late));
  const memory = new WebAssembly.Memory({ initial: 8 });
  const { wasiImport } = makeParkingImports(P, { argv: ['prog'], env: {}, getMemory: () => memory });
  const view = () => new DataView(memory.buffer);
  const put = (text, at) => { const b = enc.encode(text); new Uint8Array(memory.buffer).set(b, at); return b.length; };
  return { P, wasi: wasiImport, view, memory, put };
}

await check('a mkdir the session answers after the deadline makes the directory, as mkdir(2) does', async () => {
  const session = makeSession();
  try {
    const g = await guest(session, new Set(['mkdir']));
    const n = g.put('home/user/many', 4096);
    const started = Date.now();
    const errno = await g.wasi.path_create_directory(3, 4096, n);
    assert.ok(Date.now() - started >= LATE_MS - 50, 'answered once the session answered');
    assert.equal(errno, ESUCCESS, 'not EAGAIN');
    assert.equal(session.root.isDirectory('home/user/many'), true);
  } finally { await session.dispose(); }
});

await check('an open and a read of a file the session answers after the deadline read its bytes', async () => {
  const session = makeSession({ files: { 'home/user/big.bin': 'payload' } });
  try {
    const g = await guest(session, new Set(['fsOpen', 'fsRead']));
    const n = g.put('home/user/big.bin', 4096);
    const RIGHT_READ = 2n, RIGHT_WRITE = 64n;
    // Write rights keep the open and its reads on the session, as a large file's do.
    assert.equal(await g.wasi.path_open(3, 1, 4096, n, 0, RIGHT_READ | RIGHT_WRITE, 0n, 0, 64), ESUCCESS, 'the open, not EAGAIN');
    const fd = g.view().getUint32(64, true);
    g.view().setUint32(128, 8192, true); g.view().setUint32(132, 64, true);
    assert.equal(await g.wasi.fd_read(fd, 128, 1, 136), ESUCCESS, 'the read, not EAGAIN');
    assert.equal(dec.decode(new Uint8Array(g.memory.buffer, 8192, g.view().getUint32(136, true))), 'payload');
  } finally { await session.dispose(); }
});

await check('a socket recv with nothing to read is still answered EAGAIN at the deadline', async () => {
  const session = makeSession();
  try {
    const g = await guest(session, new Set());
    const readable = new ReadableStream({ start() {} });
    g.P.fdTable.set(40, {
      kind: 'socket', socket: { opened: Promise.resolve(), readable, writable: new WritableStream(), close() {} },
      reader: null, writer: null, readBuf: new Uint8Array(0), readBufOffset: 0, eof: false, closed: false, halfClosedWr: false, fdflags: 0,
    });
    g.view().setUint32(256, 512, true); g.view().setUint32(260, 16, true);
    const started = Date.now();
    assert.equal(await g.wasi.sock_recv(40, 256, 1, 0, 264, 268), EAGAIN);
    assert.ok(Date.now() - started >= 9000, 'at the deadline');
  } finally { await session.dispose(); }
});

assert.deepEqual(failures, []);
console.log('wasi-park-deadline-fs: ok');
