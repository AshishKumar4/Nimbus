#!/usr/bin/env bun
// Stage-0 WASI shim correctness probes (WASI-PLAN §2.4). Drives the REAL
// wasi-instance.ts preamble source — the same string injected into
// wasm-runner / ruby-runner / opentui — proving preview1 semantics for the
// six correctness bugs found by inspection:
//   1. O_NOFOLLOW defeated  — path_open / path_filestat_get on a symlink
//   2. O_APPEND ignored     — fd_write must append at EOF regardless of seek
//   3. read(2)/write(2) on a socket fd  — route to sock_recv/sock_send
//   4. path_rename drops symlinks       — a renamed symlink stays a symlink
//   5. fd_seek/fd_tell on stdio         — ESPIPE, not success/0
//   6. fd_read on a directory fd        — EISDIR, not EBADF
//
// The preamble is module-shaped (top-level await for cloudflare:sockets),
// so it is evaluated as an ES module from a temp file, exactly like
// opentui-wasm-smoke.mjs.

import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/core/src/runtime/wasi-instance.ts';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';

// ── WASI errno / flag constants (preview1) ───────────────────────────────────
const ESUCCESS = 0, EBADF = 8, EISDIR = 31, ELOOP = 32;
const EINVAL = 28, ESPIPE = 70;
const FT_REGULAR_FILE = 4, FT_SYMBOLIC_LINK = 7;
const O_DIRECTORY = 2;
const FDFLAGS_APPEND = 1;
const LOOKUP_FOLLOW = 1;

// ── Load the real preamble as a module ───────────────────────────────────────
// The socket probe needs to inject a fake socket fd, so the test exports
// fdTable alongside the two public helpers.
const preambleSrc = `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports, fdTable };`;
const preamblePath = path.join(os.tmpdir(), `wasi-s0-preamble-${process.pid}.mjs`);
writeFileSync(preamblePath, preambleSrc);
let P;
try {
  P = await import(pathToFileURL(preamblePath).href);
} finally {
  rmSync(preamblePath, { force: true });
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (s) => btoa(s);

// A fresh WASI host over a controlled VFS. Preopen fd 3 = the session root.
function host(fs) {
  const paths = new Set([
    'home/user',
    ...Object.keys(fs.files || {}),
    ...(fs.dirs || []),
    ...Object.keys(fs.symlinks || {}),
  ]);
  P.__wasiInitFS({
    root: 'home/user',
    preopens: [{ wasiPath: '/', vfsPath: 'home/user' }],
    files: fs.files || {},
    dirs: fs.dirs || [],
    modes: Object.fromEntries([...paths].map((path) => [path, 0o7])),
    symlinks: fs.symlinks || {},
  });
  const mem = new WebAssembly.Memory({ initial: 8 });
  const wasi = makeImportsWithoutJSPI(P, { argv: ['prog'], env: {}, getMemory: () => mem });
  const u8 = () => new Uint8Array(mem.buffer);
  const dv = () => new DataView(mem.buffer);
  // Bump allocator over the raw linear memory (well past page 0).
  let bump = 4096;
  const alloc = (n) => { const p = bump; bump += (n + 7) & ~7; return p; };
  const putStr = (s) => { const b = enc.encode(s); const p = alloc(b.length); u8().set(b, p); return [p, b.length]; };
  // Build a single-iovec array pointing at a scratch buffer of `len` bytes.
  const iovec = (len) => {
    const buf = alloc(len);
    const iov = alloc(8);
    dv().setUint32(iov, buf, true);
    dv().setUint32(iov + 4, len, true);
    return { iov, buf, len };
  };
  return { wasi: wasi.wasiImport, mem, u8, dv, alloc, putStr, iovec };
}

let passed = 0;
function ok(name) { passed++; console.log(`  ok  ${name}`); }

// ═══════════════════════════════════════════════════════════════════════════
// Bug 1 — O_NOFOLLOW defeated (path_open + path_filestat_get on a symlink)
// ═══════════════════════════════════════════════════════════════════════════
{
  // 1a. path_open with O_NOFOLLOW (dirflags=0) on a trailing symlink → ELOOP.
  const h = host({
    files: { 'home/user/real.txt': b64('hi') },
    symlinks: { 'home/user/link.txt': 'real.txt' },
  });
  const [pp, pl] = h.putStr('link.txt');
  const fdOut = h.alloc(4);
  const rc = h.wasi.path_open(3, /*dirflags*/0, pp, pl, /*oflags*/0, 0n, 0n, /*fdflags*/0, fdOut);
  assert.equal(rc, ELOOP, 'path_open O_NOFOLLOW on symlink must return ELOOP');
  ok('1a path_open O_NOFOLLOW on symlink → ELOOP');

  // 1b. path_open WITH follow (dirflags=1) on the same symlink → opens target.
  const h2 = host({
    files: { 'home/user/real.txt': b64('hi') },
    symlinks: { 'home/user/link.txt': 'real.txt' },
  });
  const [pp2, pl2] = h2.putStr('link.txt');
  const fdOut2 = h2.alloc(4);
  const rc2 = h2.wasi.path_open(3, LOOKUP_FOLLOW, pp2, pl2, 0, 0n, 0n, 0, fdOut2);
  assert.equal(rc2, ESUCCESS, 'follow open of symlink should succeed');
  const fd2 = h2.dv().getUint32(fdOut2, true);
  const { iov, buf } = h2.iovec(16);
  const nread = h2.alloc(4);
  assert.equal(h2.wasi.fd_read(fd2, iov, 1, nread), ESUCCESS);
  const n = h2.dv().getUint32(nread, true);
  assert.equal(dec.decode(h2.u8().subarray(buf, buf + n)), 'hi', 'followed symlink reads target contents');
  ok('1b path_open follow on symlink → reads target');

  // 1c. path_filestat_get with lookupflags=0 (lstat) on a symlink → SYMLINK type.
  const h3 = host({
    files: { 'home/user/real.txt': b64('hi') },
    symlinks: { 'home/user/link.txt': 'real.txt' },
  });
  const [pp3, pl3] = h3.putStr('link.txt');
  const stat = h3.alloc(64);
  assert.equal(h3.wasi.path_filestat_get(3, /*lookupflags*/0, pp3, pl3, stat), ESUCCESS);
  assert.equal(h3.dv().getUint8(stat + 16), FT_SYMBOLIC_LINK, 'lstat must report the symlink itself');
  ok('1c path_filestat_get lstat (flags=0) on symlink → SYMBOLIC_LINK');

  // 1d. path_filestat_get WITH follow on the symlink → target type (regression guard).
  const h4 = host({
    files: { 'home/user/real.txt': b64('hi') },
    symlinks: { 'home/user/link.txt': 'real.txt' },
  });
  const [pp4, pl4] = h4.putStr('link.txt');
  const stat4 = h4.alloc(64);
  assert.equal(h4.wasi.path_filestat_get(3, LOOKUP_FOLLOW, pp4, pl4, stat4), ESUCCESS);
  assert.equal(h4.dv().getUint8(stat4 + 16), FT_REGULAR_FILE, 'follow stat resolves to target');
  ok('1d path_filestat_get follow on symlink → REGULAR_FILE');
}

// ═══════════════════════════════════════════════════════════════════════════
// Bug 2 — O_APPEND ignored by fd_write
// ═══════════════════════════════════════════════════════════════════════════
{
  const h = host({ files: { 'home/user/log.txt': b64('AAA') } });
  const [pp, pl] = h.putStr('log.txt');
  const fdOut = h.alloc(4);
  // open with APPEND fdflag set.
  assert.equal(h.wasi.path_open(3, 0, pp, pl, 0, 0n, 0n, FDFLAGS_APPEND, fdOut), ESUCCESS);
  const fd = h.dv().getUint32(fdOut, true);
  // Seek to the very start — an append write must ignore this.
  const off = h.alloc(8);
  h.wasi.fd_seek(fd, 0n, 0, off);
  // Write 'BB'.
  const data = enc.encode('BB');
  const buf = h.alloc(data.length);
  h.u8().set(data, buf);
  const iov = h.alloc(8);
  h.dv().setUint32(iov, buf, true);
  h.dv().setUint32(iov + 4, data.length, true);
  const nw = h.alloc(4);
  assert.equal(h.wasi.fd_write(fd, iov, 1, nw), ESUCCESS);
  assert.equal(h.dv().getUint32(nw, true), 2);
  // Read the file back via a fresh fd.
  const [rp, rl] = h.putStr('log.txt');
  const fdOut2 = h.alloc(4);
  assert.equal(h.wasi.path_open(3, 0, rp, rl, 0, 0n, 0n, 0, fdOut2), ESUCCESS);
  const rfd = h.dv().getUint32(fdOut2, true);
  const rd = h.iovec(32);
  const nread = h.alloc(4);
  h.wasi.fd_read(rfd, rd.iov, 1, nread);
  const got = dec.decode(h.u8().subarray(rd.buf, rd.buf + h.dv().getUint32(nread, true)));
  assert.equal(got, 'AAABB', 'O_APPEND write must land at EOF, not the seeked offset');
  ok('2 O_APPEND write appends at EOF regardless of seek');
}

// ═══════════════════════════════════════════════════════════════════════════
// Bug 3 — read(2)/write(2) on a socket fd
// ═══════════════════════════════════════════════════════════════════════════
{
  const h = host({});
  const written = [];
  const readChunks = [enc.encode('hello')];
  let ri = 0;
  const fakeSocket = {
    opened: Promise.resolve(),
    readable: { getReader() { return {
      read: async () => (ri < readChunks.length ? { value: readChunks[ri++], done: false } : { value: undefined, done: true }),
      cancel: async () => {}, releaseLock() {},
    }; } },
    writable: { getWriter() { return {
      write: async (c) => { written.push(new Uint8Array(c)); }, close: async () => {}, releaseLock() {},
    }; } },
    close() {},
  };
  const SFD = 50;
  P.fdTable.set(SFD, {
    kind: 'socket', socket: fakeSocket, reader: null, writer: null,
    readBuf: new Uint8Array(0), readBufOffset: 0, eof: false, closed: false,
    halfClosedWr: false, fdflags: 0,
  });

  // fd_read on the socket routes to sock_recv (async → Promise).
  const rd = h.iovec(16);
  const nread = h.alloc(4);
  const r1 = await h.wasi.fd_read(SFD, rd.iov, 1, nread);
  assert.equal(r1, ESUCCESS, 'fd_read on a socket must not EBADF');
  const gotN = h.dv().getUint32(nread, true);
  assert.equal(dec.decode(h.u8().subarray(rd.buf, rd.buf + gotN)), 'hello', 'fd_read drains socket data');
  ok('3a fd_read on a connected socket returns data');

  // fd_write on the socket routes to sock_send.
  const data = enc.encode('world');
  const buf = h.alloc(data.length);
  h.u8().set(data, buf);
  const iov = h.alloc(8);
  h.dv().setUint32(iov, buf, true);
  h.dv().setUint32(iov + 4, data.length, true);
  const nw = h.alloc(4);
  const w1 = await h.wasi.fd_write(SFD, iov, 1, nw);
  assert.equal(w1, ESUCCESS, 'fd_write on a socket must not EBADF');
  assert.equal(h.dv().getUint32(nw, true), 5);
  assert.equal(dec.decode(written[0]), 'world', 'fd_write forwards bytes to the socket');
  ok('3b fd_write on a connected socket sends data');
}

// ═══════════════════════════════════════════════════════════════════════════
// Bug 4 — path_rename must preserve a symlink as a symlink
// ═══════════════════════════════════════════════════════════════════════════
{
  const h = host({ symlinks: { 'home/user/a.link': 'some/target' } });
  const [sp, sl] = h.putStr('a.link');
  const [dp, dl] = h.putStr('b.link');
  const rc = h.wasi.path_rename(3, sp, sl, 3, dp, dl);
  assert.equal(rc, ESUCCESS, 'renaming a symlink must succeed');
  // b.link is now a symlink pointing at the original target.
  const [bp, bl] = h.putStr('b.link');
  const rlbuf = h.alloc(64);
  const rlused = h.alloc(4);
  const rr = h.wasi.path_readlink(3, bp, bl, rlbuf, 64, rlused);
  assert.equal(rr, ESUCCESS, 'renamed target must still be a readable symlink');
  const tgt = dec.decode(h.u8().subarray(rlbuf, rlbuf + h.dv().getUint32(rlused, true)));
  assert.equal(tgt, 'some/target', 'symlink target preserved across rename');
  // a.link is gone as a symlink.
  const [ap, al] = h.putStr('a.link');
  const rlbuf2 = h.alloc(64);
  const rlused2 = h.alloc(4);
  assert.equal(h.wasi.path_readlink(3, ap, al, rlbuf2, 64, rlused2), EINVAL, 'old symlink name no longer resolves');
  ok('4 path_rename preserves a symlink as a symlink');
}

// ═══════════════════════════════════════════════════════════════════════════
// Bug 5 — fd_seek / fd_tell on stdio → ESPIPE
// ═══════════════════════════════════════════════════════════════════════════
{
  const h = host({});
  const off = h.alloc(8);
  assert.equal(h.wasi.fd_seek(1, 0n, 0, off), ESPIPE, 'fd_seek(stdout) must be ESPIPE');
  assert.equal(h.wasi.fd_seek(0, 0n, 1, off), ESPIPE, 'fd_seek(stdin) must be ESPIPE');
  assert.equal(h.wasi.fd_tell(2, off), ESPIPE, 'fd_tell(stderr) must be ESPIPE');
  ok('5 fd_seek / fd_tell on stdio → ESPIPE');
}

// ═══════════════════════════════════════════════════════════════════════════
// Bug 6 — fd_read on a directory fd → EISDIR
// ═══════════════════════════════════════════════════════════════════════════
{
  const h = host({ dirs: ['home/user/sub'] });
  const [pp, pl] = h.putStr('sub');
  const fdOut = h.alloc(4);
  assert.equal(h.wasi.path_open(3, LOOKUP_FOLLOW, pp, pl, O_DIRECTORY, 0n, 0n, 0, fdOut), ESUCCESS);
  const dfd = h.dv().getUint32(fdOut, true);
  const rd = h.iovec(16);
  const nread = h.alloc(4);
  assert.equal(h.wasi.fd_read(dfd, rd.iov, 1, nread), EISDIR, 'fd_read on a dir fd must be EISDIR');
  // The preopen fd itself is also a directory.
  assert.equal(h.wasi.fd_read(3, rd.iov, 1, nread), EISDIR, 'fd_read on a preopen must be EISDIR');
  ok('6 fd_read on a directory fd → EISDIR');
}

console.log(`\nwasi-stage0-correctness: ${passed} checks passed`);
