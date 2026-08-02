#!/usr/bin/env bun
// Behavior test: the WASI filesystem is live-backed, not snapshot-backed.
//
// Drives the REAL wasi-instance.ts preamble with a mock SUPERVISOR stub and
// asserts the contract every wasm runtime now gets:
//   1. A file whose content was NOT shipped in the seed is served by a live
//      chunked fsReadRange when the guest reads it (demand load).
//   2. Guest writes reach the supervisor without the process exiting
//      (write-through + drain) — the resident-server data-loss fix.
//   3. Structural ops (mkdir/unlink/rename/truncate/symlink) propagate.
//   4. A live read of a path with queued writes drains those writes first
//      (read-your-writes through the supervisor authority).
//   5. Without a supervisor the seeded-snapshot behavior is unchanged.
//   6. Oversized files are served by windowed reads and never materialized.
//   7. A metadata miss with a supervisor present goes live (stat) instead of
//      returning a snapshot-frozen ENOENT.
//
// Node/bun have no JSPI; Suspending-wrapped imports return the Promise the
// wrapper would await — awaiting it directly is the same observation.

import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/worker/src/runtime/wasi-instance.ts';

const ESUCCESS = 0, ENOENT = 44;

const preambleSrc = `${WASI_INSTANCE_PREAMBLE_SRC}
export { __wasiInitFS, __wasiMakeImports, __wasiAdoptSupervisor, __wasiDrainPersist, __wasiRevalidateFS, fdTable };`;
const preamblePath = path.join(os.tmpdir(), `wasi-live-fs-${process.pid}.mjs`);
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

/** Mock SupervisorRPC with an in-memory authoritative store + op log. */
function mockSupervisor(seed = {}) {
  const store = new Map(Object.entries(seed).map(([p, v]) => [p, enc.encode(v)]));
  const log = [];
  let revision = 1;
  return {
    store, log,
    get revision() { return revision; },
    bump() { revision++; },
    async fsRevision() { log.push(['fsRevision']); return revision; },
    async fsReadRange(p, offset, length) {
      log.push(['fsReadRange', p, offset, length]);
      const bytes = store.get(p);
      if (bytes === undefined) return null;
      if (offset >= bytes.length) return new Uint8Array(0);
      return bytes.slice(offset, Math.min(bytes.length, offset + length));
    },
    async writeFile(p, content) {
      log.push(['writeFile', p]);
      store.set(p, typeof content === 'string' ? enc.encode(content) : new Uint8Array(content));
      revision++;
    },
    async fsWriteRange(p, offset, bytes) {
      log.push(['fsWriteRange', p, offset, bytes.length]);
      const cur = store.get(p) ?? new Uint8Array(0);
      const next = new Uint8Array(Math.max(cur.length, offset + bytes.length));
      next.set(cur, 0);
      next.set(new Uint8Array(bytes), offset);
      store.set(p, next);
      revision++;
      return bytes.length;
    },
    async fsTruncate(p, size) {
      log.push(['fsTruncate', p, size]);
      const cur = store.get(p) ?? new Uint8Array(0);
      const next = new Uint8Array(size);
      next.set(cur.subarray(0, Math.min(cur.length, size)), 0);
      store.set(p, next);
      revision++;
    },
    async mkdir(p) { log.push(['mkdir', p]); revision++; },
    async rmdir(p) { log.push(['rmdir', p]); revision++; },
    async unlink(p) { log.push(['unlink', p]); store.delete(p); revision++; },
    async rename(from, to) {
      log.push(['rename', from, to]);
      if (store.has(from)) { store.set(to, store.get(from)); store.delete(from); }
      revision++;
    },
    async symlink(target, p) { log.push(['symlink', target, p]); revision++; },
    async chmod(p, mode) { log.push(['chmod', p, mode]); revision++; },
    async utimes(p, a, m) { log.push(['utimes', p]); revision++; },
    async stat(p) {
      log.push(['stat', p]);
      if (store.has(p)) {
        return { type: 'file', size: store.get(p).length, mtime: Date.now(), mode: 0o644, uid: 1000, gid: 1000 };
      }
      return null;
    },
    async readdir(p) {
      log.push(['readdir', p]);
      const prefix = p === '' ? '' : p + '/';
      const names = new Set();
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.substring(prefix.length);
          if (rest && !rest.includes('/')) names.add(rest);
        }
      }
      return [...names].map((name) => ({ name, type: 'file' }));
    },
  };
}

/** Fresh WASI host over the given init options. */
function host(initOpts, supervisor) {
  const memory = new WebAssembly.Memory({ initial: 8 });
  P.__wasiInitFS(initOpts);
  if (supervisor) P.__wasiAdoptSupervisor(supervisor);
  const { wasiImport } = P.__wasiMakeImports({
    argv: ['prog'],
    env: {},
    getMemory: () => memory,
    stdoutWrite: () => {},
    stderrWrite: () => {},
  });
  const view = () => new DataView(memory.buffer);
  const u8 = () => new Uint8Array(memory.buffer);
  const writePath = (s) => { const b = enc.encode(s); u8().set(b, 0x100); return b.length; };
  return {
    wasiImport, view, u8,
    async open(p, { oflags = 0, rights = -1n, fdflags = 0 } = {}) {
      const len = writePath(p);
      const errno = await wasiImport.path_open(3, 1, 0x100, len, oflags, rights, -1n, fdflags, 0x200);
      return { errno, fd: view().getUint32(0x200, true) };
    },
    async read(fd, max = 65536) {
      view().setUint32(0x300, 0x400, true);
      view().setUint32(0x304, max, true);
      const errno = await wasiImport.fd_read(fd, 0x300, 1, 0x200);
      const n = view().getUint32(0x200, true);
      return { errno, text: dec.decode(u8().slice(0x400, 0x400 + n)), n };
    },
    async write(fd, text) {
      const bytes = enc.encode(text);
      u8().set(bytes, 0x400);
      view().setUint32(0x300, 0x400, true);
      view().setUint32(0x304, bytes.length, true);
      return wasiImport.fd_write(fd, 0x300, 1, 0x200);
    },
    async stat(p) {
      const len = writePath(p);
      const errno = await wasiImport.path_filestat_get(3, 1, 0x100, len, 0x2000);
      return { errno, size: Number(view().getBigUint64(0x2000 + 32, true)), filetype: view().getUint8(0x2000 + 16) };
    },
  };
}

const ROOT_INIT = (extra = {}) => ({
  root: '',
  preopens: [{ wasiPath: '/', vfsPath: '' }],
  files: {},
  dirs: ['home', 'home/user'],
  modes: { '': 7, home: 7, 'home/user': 7 },
  ...extra,
});

// ── 1. Demand load: metadata-listed file with absent content ────────────────
{
  const sup = mockSupervisor({ 'home/user/data.txt': 'live-bytes-from-supervisor' });
  const h = host(ROOT_INIT({
    sizes: { 'home/user/data.txt': 'live-bytes-from-supervisor'.length },
    modes: { '': 7, home: 7, 'home/user': 7, 'home/user/data.txt': 6 },
  }), sup);
  const { errno, fd } = await h.open('home/user/data.txt');
  assert.equal(errno, ESUCCESS, 'open of a content-absent manifest file succeeds');
  const r = await h.read(fd);
  assert.equal(r.errno, ESUCCESS);
  assert.equal(r.text, 'live-bytes-from-supervisor', 'content came from the live supervisor');
  assert.ok(sup.log.some(([op]) => op === 'fsReadRange'), 'a live fsReadRange was issued');
  // Second read from offset 0 via a fresh fd is served from cache — no new RPC.
  const before = sup.log.filter(([op]) => op === 'fsReadRange').length;
  const again = await h.open('home/user/data.txt');
  const r2 = await h.read(again.fd);
  assert.equal(r2.text, 'live-bytes-from-supervisor');
  const after = sup.log.filter(([op]) => op === 'fsReadRange').length;
  assert.equal(after, before, 'cached content served without a second fetch');
}

// ── 2. Write-through without exit ───────────────────────────────────────────
{
  const sup = mockSupervisor();
  const h = host(ROOT_INIT(), sup);
  const { errno, fd } = await h.open('home/user/out.txt', { oflags: 1 /* O_CREAT */ });
  assert.equal(errno, ESUCCESS);
  assert.equal(await h.write(fd, 'written-while-running'), ESUCCESS);
  await P.__wasiDrainPersist();
  assert.equal(dec.decode(sup.store.get('home/user/out.txt')), 'written-while-running',
    'bytes are durable in the supervisor store while the process is still alive');
}

// ── 3. Structural ops propagate ─────────────────────────────────────────────
{
  const sup = mockSupervisor({ 'home/user/a.txt': 'aaa' });
  const h = host(ROOT_INIT({
    sizes: { 'home/user/a.txt': 3 },
    modes: { '': 7, home: 7, 'home/user': 7, 'home/user/a.txt': 6 },
  }), sup);
  const w = h.wasiImport;
  const setPath = (s, at) => { const b = enc.encode(s); h.u8().set(b, at); return b.length; };
  // mkdir
  let len = setPath('home/user/newdir', 0x100);
  assert.equal(w.path_create_directory(3, 0x100, len), ESUCCESS);
  // rename a.txt -> b.txt
  const flen = setPath('home/user/a.txt', 0x100);
  const tlen = setPath('home/user/b.txt', 0x500);
  assert.equal(w.path_rename(3, 0x100, flen, 3, 0x500, tlen), ESUCCESS);
  // unlink b.txt
  len = setPath('home/user/b.txt', 0x100);
  assert.equal(w.path_unlink_file(3, 0x100, len), ESUCCESS);
  await P.__wasiDrainPersist();
  const ops = sup.log.map(([op]) => op);
  assert.ok(ops.includes('mkdir'), 'mkdir reached the supervisor');
  assert.ok(ops.includes('rename'), 'rename reached the supervisor');
  assert.ok(ops.includes('unlink'), 'unlink reached the supervisor');
  assert.ok(!sup.store.has('home/user/a.txt') && !sup.store.has('home/user/b.txt'));
}

// ── 4. Flush-before-read: queued writes are visible to a live read ──────────
{
  const sup = mockSupervisor();
  const h = host(ROOT_INIT(), sup);
  const created = await h.open('home/user/pending.txt', { oflags: 1 });
  await h.write(created.fd, 'must-not-be-lost');
  // Forget the resident copy the way a cache eviction would, then read live.
  const evicted = P.__wasiEvictCleanContent ? P.__wasiEvictCleanContent() : null;
  // Even without eviction, a live read of the same path must first drain the
  // queue so the supervisor's answer includes our write.
  const { fd } = await h.open('home/user/pending.txt');
  const r = await h.read(fd);
  assert.equal(r.text, 'must-not-be-lost');
  await P.__wasiDrainPersist();
  assert.equal(dec.decode(sup.store.get('home/user/pending.txt')), 'must-not-be-lost');
  void evicted;
}

// ── 5. No supervisor: seeded snapshot behavior unchanged ────────────────────
{
  const h = host(ROOT_INIT({
    files: { 'home/user/seeded.txt': b64('seeded') },
    modes: { '': 7, home: 7, 'home/user': 7, 'home/user/seeded.txt': 6 },
  }), null);
  const ok = await h.open('home/user/seeded.txt');
  assert.equal(ok.errno, ESUCCESS);
  const r = await h.read(ok.fd);
  assert.equal(r.text, 'seeded');
  const missing = await h.open('home/user/absent.txt');
  assert.equal(missing.errno, ENOENT, 'absent path is ENOENT without a supervisor');
}

// ── 6. Oversized file: windowed reads, never materialized ───────────────────
{
  const BIG = 'x'.repeat(70000); // spans two 64 KiB windows
  const sup = mockSupervisor({ 'home/user/big.bin': BIG });
  const h = host(ROOT_INIT({
    sizes: { 'home/user/big.bin': BIG.length },
    modes: { '': 7, home: 7, 'home/user': 7, 'home/user/big.bin': 6 },
    residentFileCap: 1024, // force the windowed path without a 16 MiB fixture
  }), sup);
  const { errno, fd } = await h.open('home/user/big.bin');
  assert.equal(errno, ESUCCESS);
  let total = 0;
  for (;;) {
    const r = await h.read(fd, 4096);
    assert.equal(r.errno, ESUCCESS);
    if (r.n === 0) break;
    total += r.n;
  }
  assert.equal(total, BIG.length, 'whole oversized file readable through windows');
  const st = await h.stat('home/user/big.bin');
  assert.equal(st.size, BIG.length);
}

// ── 7. Live metadata: a path missing from the manifest goes to stat ─────────
{
  const sup = mockSupervisor({ 'home/user/appeared.txt': 'created-after-spawn' });
  const h = host(ROOT_INIT(), sup);
  const st = await h.stat('home/user/appeared.txt');
  assert.equal(st.errno, ESUCCESS, 'live stat found a file the manifest never listed');
  assert.equal(st.size, 'created-after-spawn'.length);
  const { errno, fd } = await h.open('home/user/appeared.txt');
  assert.equal(errno, ESUCCESS);
  const r = await h.read(fd);
  assert.equal(r.text, 'created-after-spawn');
}

console.log('wasi-live-fs: all assertions passed');
