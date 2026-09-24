import { descriptorSupervisor } from './lib/descriptor-supervisor.mjs';
// Behavior test: the WASI filesystem IS the authority, with nothing in between.
//
// Drives the REAL wasi-instance.ts preamble with a mock SUPERVISOR stub and
// asserts the contract every wasm runtime now gets:
//   1. A file's bytes come from the authority's descriptor reads, one RPC per
//      guest read — there is no copy in the facet to serve them from.
//   2. Guest writes are in the supervisor's store the moment fd_write returns,
//      with the process still running — the resident-server data-loss fix.
//   3. Structural ops (mkdir/unlink/rename/truncate/symlink) propagate.
//   4. A read after a write sees the write (read-your-writes through the
//      supervisor authority).
//   5. Without a supervisor there is no filesystem: a file open is EBADF.
//   6. Oversized files are served by windowed reads and never materialized.
//   7. Metadata is the authority's: a file created after the process started
//      is visible to stat and open.
//
// The imports are built through the preamble's no-JSPI branch (see
// lib/wasi-imports.mjs) so they can be called from JS: same bodies, and
// awaiting what one returns is the observation the guest makes.

import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/core/src/runtime/wasi-instance.ts';
import { installVirtualSocketKernel } from '../../packages/core/src/runtime/virtual-socket-kernel.ts';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';

const ESUCCESS = 0, EBADF = 8, EISDIR = 31;
const EVENTTYPE_FD_READ = 1;

const preambleSrc = `${WASI_INSTANCE_PREAMBLE_SRC}
export { __wasiInitFS, __wasiMakeImports, __wasiAdoptSupervisor, fdTable };`;
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

/** Mock SupervisorRPC with an in-memory authoritative store + op log. */
function mockSupervisor(seed = {}) {
  const store = new Map(Object.entries(seed).map(([p, v]) => [p, enc.encode(v)]));
  const log = [];
  let revision = 1;
  // The authority's invalidation log: each change records the path and its parent.
  const changes = [];
  const changed = (...paths) => {
    revision += 1;
    for (const p of paths) for (const q of [p, p.slice(0, Math.max(0, p.lastIndexOf('/')))]) changes.push({ rev: revision, path: q });
  };
  return descriptorSupervisor({
    store, log,
    get revision() { return revision; },
    async fsAcquire(epoch, cursor) {
      if (epoch !== 'mock') return { epoch: 'mock', rev: revision, paths: [], poison: true };
      return { epoch: 'mock', rev: revision, paths: changes.filter((c) => c.rev > cursor), poison: false };
    },
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
      changed(p);
    },
    async fsWriteRange(p, offset, bytes) {
      log.push(['fsWriteRange', p, offset, bytes.length]);
      const cur = store.get(p) ?? new Uint8Array(0);
      const next = new Uint8Array(Math.max(cur.length, offset + bytes.length));
      next.set(cur, 0);
      next.set(new Uint8Array(bytes), offset);
      store.set(p, next);
      changed(p);
      return bytes.length;
    },
    async fsTruncate(p, size) {
      log.push(['fsTruncate', p, size]);
      const cur = store.get(p) ?? new Uint8Array(0);
      const next = new Uint8Array(size);
      next.set(cur.subarray(0, Math.min(cur.length, size)), 0);
      store.set(p, next);
      changed(p);
    },
    async mkdir(p) { log.push(['mkdir', p]); changed(p); },
    async rmdir(p) { log.push(['rmdir', p]); changed(p); },
    async unlink(p) { log.push(['unlink', p]); store.delete(p); changed(p); },
    async rename(from, to) {
      log.push(['rename', from, to]);
      if (store.has(from)) { store.set(to, store.get(from)); store.delete(from); }
      changed(from, to);
    },
    async symlink(target, p) { log.push(['symlink', target, p]); changed(p); },
    async chmod(p, mode) { log.push(['chmod', p, mode]); changed(p); },
    async utimes(p, a, m) { log.push(['utimes', p]); changed(p); },
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
      const names = new Map();
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.substring(prefix.length);
          if (rest) names.set(rest.split('/')[0], rest.includes('/') ? 'directory' : 'file');
        }
      }
      return [...names].map(([name, type]) => ({ name, type }));
    },
  });
}

/** Fresh WASI host over the given init options. */
function host(initOpts, supervisor) {
  const memory = new WebAssembly.Memory({ initial: 8 });
  P.__wasiInitFS(initOpts);
  if (supervisor) P.__wasiAdoptSupervisor(supervisor);
  const { wasiImport } = makeImportsWithoutJSPI(P, {
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
      return (await wasiImport.fd_write(fd, 0x300, 1, 0x200));
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
  ...extra,
});

// ── 1. Content is the authority's: every read is a descriptor read ──────────
{
  const sup = mockSupervisor({ 'home/user/data.txt': 'live-bytes-from-supervisor' });
  const h = host(ROOT_INIT(), sup);
  const { errno, fd } = await h.open('home/user/data.txt');
  assert.equal(errno, ESUCCESS, 'open of a file the authority holds succeeds');
  const r = await h.read(fd);
  assert.equal(r.errno, ESUCCESS);
  assert.equal(r.text, 'live-bytes-from-supervisor', 'content came from the live supervisor');
  assert.ok(sup.log.some(([op]) => op === 'fsReadRange'), 'a live fsReadRange was issued');
  // A second read through a fresh fd is another descriptor read: nothing in
  // the facet remembers the bytes.
  const before = sup.log.filter(([op]) => op === 'fsReadRange').length;
  const again = await h.open('home/user/data.txt');
  const r2 = await h.read(again.fd);
  assert.equal(r2.text, 'live-bytes-from-supervisor');
  const after = sup.log.filter(([op]) => op === 'fsReadRange').length;
  assert.equal(after, before + 1, 'a descriptor read reaches the authority that owns its offset and lifetime');
}

// ── 2. Write-through without exit ───────────────────────────────────────────
{
  const sup = mockSupervisor();
  const h = host(ROOT_INIT(), sup);
  const { errno, fd } = await h.open('home/user/out.txt', { oflags: 1 /* O_CREAT */ });
  assert.equal(errno, ESUCCESS);
  assert.equal(await h.write(fd, 'written-while-running'), ESUCCESS);
  assert.equal(dec.decode(sup.store.get('home/user/out.txt')), 'written-while-running',
    'bytes are in the supervisor store the moment the write returns, with the process still alive');
}

// ── 3. Structural ops propagate ─────────────────────────────────────────────
{
  const sup = mockSupervisor({ 'home/user/a.txt': 'aaa' });
  const h = host(ROOT_INIT(), sup);
  const w = h.wasiImport;
  const setPath = (s, at) => { const b = enc.encode(s); h.u8().set(b, at); return b.length; };
  // mkdir
  let len = setPath('home/user/newdir', 0x100);
  assert.equal((await w.path_create_directory(3, 0x100, len)), ESUCCESS);
  // rename a.txt -> b.txt
  const flen = setPath('home/user/a.txt', 0x100);
  const tlen = setPath('home/user/b.txt', 0x500);
  assert.equal((await w.path_rename(3, 0x100, flen, 3, 0x500, tlen)), ESUCCESS);
  // unlink b.txt
  len = setPath('home/user/b.txt', 0x100);
  assert.equal((await w.path_unlink_file(3, 0x100, len)), ESUCCESS);
  const ops = sup.log.map(([op]) => op);
  assert.ok(ops.includes('mkdir'), 'mkdir reached the supervisor');
  assert.ok(ops.includes('rename'), 'rename reached the supervisor');
  assert.ok(ops.includes('unlink'), 'unlink reached the supervisor');
  assert.ok(!sup.store.has('home/user/a.txt') && !sup.store.has('home/user/b.txt'));
}

// ── 4. Read-your-writes: a write is visible to the next open ────────────────
{
  const sup = mockSupervisor();
  const h = host(ROOT_INIT(), sup);
  const created = await h.open('home/user/pending.txt', { oflags: 1 });
  await h.write(created.fd, 'must-not-be-lost');
  const { fd } = await h.open('home/user/pending.txt');
  const r = await h.read(fd);
  assert.equal(r.text, 'must-not-be-lost');
  assert.equal(dec.decode(sup.store.get('home/user/pending.txt')), 'must-not-be-lost');
}

// ── 5. No supervisor: no filesystem ─────────────────────────────────────────
// There is no copy of anything in the facet, so without an authority a file
// syscall has nothing to answer from. EBADF, not a silently empty tree: an
// absent path must not look like ENOENT when the real answer is "unknown".
{
  const h = host(ROOT_INIT(), null);
  const opened = await h.open('home/user/anything.txt');
  assert.equal(opened.errno, EBADF, 'a file open without a supervisor is EBADF');
  const created = await h.open('home/user/created.txt', { oflags: 1 /* O_CREAT */ });
  assert.equal(created.errno, EBADF, 'and so is a create: nothing is held in memory on purpose');
  const st = await h.stat('home/user/anything.txt');
  assert.equal(st.errno, EBADF, 'stat has no authority to ask either');
  assert.equal(P.fdTable.size, 4, 'stdio and the preopen are the whole descriptor table');
}

// ── 6. Oversized file: windowed reads, never materialized ───────────────────
{
  const BIG = 'x'.repeat(70000); // spans two 64 KiB windows
  const sup = mockSupervisor({ 'home/user/big.bin': BIG });
  const h = host(ROOT_INIT({
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

// ── 7. Live metadata: a file created after spawn is visible ─────────────────
{
  const sup = mockSupervisor();
  const h = host(ROOT_INIT(), sup);
  await sup.writeFile('home/user/appeared.txt', 'created-after-spawn');
  const st = await h.stat('home/user/appeared.txt');
  assert.equal(st.errno, ESUCCESS, 'live stat found a file created after the process started');
  assert.equal(st.size, 'created-after-spawn'.length);
  const { errno, fd } = await h.open('home/user/appeared.txt');
  assert.equal(errno, ESUCCESS);
  const r = await h.read(fd);
  assert.equal(r.text, 'created-after-spawn');
}

// ── 8. SEEK_END sizes a file that has not been demand-loaded yet ───────────
// Sizing a file by seeking to its end is how zipimport finds the end-of-central-
// directory record, and it is the FIRST thing it does — before any read has
// pulled the bytes in. A seek that measured the file by what happened to be
// in the facet called it empty, so the seek landed at 0, the following read
// returned the head of the archive, and a zip on sys.path was "not a Zip
// file" on first touch. The authority's stat is the only size there is.
{
  const BODY = 'HEAD'.padEnd(500, '.') + 'TAILMARK';
  const sup = mockSupervisor({ 'home/user/archive.zip': BODY });
  const h = host(ROOT_INIT(), sup);
  const { errno, fd } = await h.open('home/user/archive.zip');
  assert.equal(errno, ESUCCESS);

  assert.equal((await h.wasiImport.fd_seek(fd, 0n, 2 /* SEEK_END */, 0x600)), ESUCCESS);
  assert.equal(Number(h.view().getBigUint64(0x600, true)), BODY.length,
    'SEEK_END reports the authority\'s size before any content has been read');

  assert.equal((await h.wasiImport.fd_seek(fd, -8n, 2, 0x600)), ESUCCESS);
  const tail = await h.read(fd, 8);
  assert.equal(tail.text, 'TAILMARK', 'a read relative to the end returns the tail, not the head');
}

// ── 9. One allocator: a socket fd and a file fd never land on the same number ─
// The authority codec and the socket helpers used to advance two counters over
// one table, so whichever opened second silently overwrote the other's entry.
{
  const sup = mockSupervisor({ 'home/user/keep.txt': 'still-here' });
  globalThis.__nimbusVirtualSockets = installVirtualSocketKernel({
    __nimbusVirtualSocketRouteLoopback: async () => new Response('served', { status: 200 }),
  });
  const h = host(ROOT_INIT(), sup);

  const file = await h.open('home/user/keep.txt');
  assert.equal(file.errno, ESUCCESS);
  // A synthetic socket path is not a filesystem path: the codec has to hand it
  // back to the host body that dials, supervisor or no supervisor.
  const socket = await h.open('dev/tcp/127.0.0.1/3000');
  assert.equal(socket.errno, ESUCCESS, 'the codec must not swallow /dev/tcp');
  assert.notEqual(socket.fd, file.fd, 'a socket fd and a file fd must never collide');
  assert.equal(P.fdTable.get(file.fd).kind, 'authority');
  assert.equal(P.fdTable.get(socket.fd).kind, 'socket');

  // Both descriptors still resolve to what they were opened as.
  assert.equal((await h.read(file.fd)).text, 'still-here', 'the file fd survived the socket open');
  assert.equal(await h.write(socket.fd, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n'), ESUCCESS);
  assert.match((await h.read(socket.fd)).text, /^HTTP\/1\.1 200/, 'the socket fd carries the exchange');

  // Housekeeping on a non-authority fd stays with the host bodies, which
  // answer 0 for a stream rather than EBADF from the codec.
  assert.equal(await h.wasiImport.fd_sync(socket.fd), ESUCCESS);
  assert.equal(await h.wasiImport.fd_datasync(socket.fd), ESUCCESS);
  assert.equal(await h.wasiImport.fd_advise(socket.fd, 0n, 0n, 0), ESUCCESS);
  assert.equal(await h.wasiImport.fd_fdstat_set_flags(socket.fd, 0), ESUCCESS);

  // dup2 onto the socket closes the stream through the host body that owns it;
  // overwriting the entry would leave the kernel holding a live connection.
  const displaced = P.fdTable.get(socket.fd);
  assert.equal(await h.wasiImport.fd_renumber(file.fd, socket.fd), ESUCCESS);
  assert.equal(displaced.closed, true, 'the displaced socket was closed, not dropped');
  assert.equal(P.fdTable.get(socket.fd).kind, 'authority');
  assert.equal((await h.read(socket.fd)).errno, ESUCCESS, 'the moved file fd still reads');
  assert.equal(P.fdTable.get(file.fd), undefined, 'and the number it came from is free');

  // The preopen is the root every path resolves against, so it survives both.
  assert.equal(await h.wasiImport.fd_renumber(socket.fd, 3), 76 /* ENOTCAPABLE */);
  assert.equal(await h.wasiImport.fd_close(3), ESUCCESS);
  assert.equal((await h.open('home/user/keep.txt')).errno, ESUCCESS,
    'the preopen still resolves paths after a close');
}

// ── 10. poll_oneoff on an authority file fd reports ready ──────────────────
// A regular file never blocks, and one the authority owns is still a regular
// file. Answering EBADF told the guest its descriptor had gone away.
{
  const sup = mockSupervisor({ 'home/user/poll.txt': 'pollable' });
  const h = host(ROOT_INIT(), sup);
  const { errno, fd } = await h.open('home/user/poll.txt');
  assert.equal(errno, ESUCCESS);

  // subscription: userdata u64 @0, tag u8 @8, fd u32 @16, 48 bytes wide.
  const subs = 0x700, events = 0x800, nevents = 0x900;
  h.u8().fill(0, subs, subs + 48);
  h.view().setBigUint64(subs, 77n, true);
  h.view().setUint8(subs + 8, EVENTTYPE_FD_READ);
  h.view().setUint32(subs + 16, fd, true);

  assert.equal(await h.wasiImport.poll_oneoff(subs, events, 1, nevents), ESUCCESS);
  assert.equal(h.view().getUint32(nevents, true), 1, 'the subscription produced an event');
  assert.equal(h.view().getBigUint64(events, true), 77n, 'and it is the one subscribed');
  assert.equal(h.view().getUint16(events + 8, true), ESUCCESS,
    'an authority file fd polls ready, not EBADF');
}

// ── 11. fd_read on a directory fd is EISDIR ────────────────────────────────
{
  const sup = mockSupervisor({ 'home/user/inside.txt': 'x' });
  const h = host(ROOT_INIT(), sup);
  const dir = await h.open('home/user', { oflags: 2 /* O_DIRECTORY */ });
  assert.equal(dir.errno, ESUCCESS, 'a directory opens with O_DIRECTORY');
  assert.equal(P.fdTable.get(dir.fd).kind, 'authority');
  assert.equal((await h.read(dir.fd)).errno, EISDIR, 'a directory has no byte stream to read');
  assert.equal((await h.read(3)).errno, EISDIR, 'and neither has the preopen root');
}

// ── 12. Between resumptions an open is answered from memory, per barrier ────
// After a live answer the next answer from memory first takes the barrier;
// with nothing changed it keeps what it holds, so a second open costs that
// one call and the descriptor calls in between (fstat, seek, read, close)
// never reach the supervisor. A peer's rewrite the guest has not observed
// does not show until the guest resumes from outside; then the barrier names
// the file and the next open reads it again. A writable open never uses a copy.
{
  const RDONLY = 0x1fbffeben; // what wasi-libc requests for O_RDONLY
  const sup = mockSupervisor({ 'home/user/mod.py': 'first' });
  const revisions = new Map();
  const base = sup.stat;
  sup.stat = async (p) => { const st = await base(p); return st && { ...st, revision: revisions.get(typeof p === 'string' ? p : p.path) ?? 1 }; };
  sup.readFileBytes = async (p) => { sup.log.push(['readFileBytes']); return sup.store.get(typeof p === 'string' ? p : p.path) ?? null; };
  const acquire = sup.fsAcquire;
  sup.fsAcquire = async (...args) => { sup.log.push(['fsAcquire']); return acquire(...args); };
  const h = host(ROOT_INIT(), sup);
  const ops = () => sup.log.map(([op]) => op);
  const readAll = async (fd) => { const r = await h.read(fd); assert.equal(r.errno, ESUCCESS); await h.wasiImport.fd_close(fd); return r.text; };

  const first = await h.open('home/user/mod.py', { rights: RDONLY });
  assert.equal(first.errno, ESUCCESS);
  assert.equal(P.fdTable.get(first.fd).kind, 'resident', 'a read-only open of a small file is resident');
  assert.equal(await readAll(first.fd), 'first');
  let held = sup.log.length;
  const second = await h.open('home/user/mod.py', { rights: RDONLY });
  assert.equal(await readAll(second.fd), 'first');
  assert.deepEqual(ops().slice(held), ['fsAcquire'], 'a second open costs the barrier and nothing else');
  assert.equal(ops().filter((op) => op === 'readFileBytes').length, 1, 'two opens read the content once');
  assert.ok(!ops().some((op) => op === 'fsOpen' || op === 'fsRead' || op === 'fsClose'), 'no descriptor op crossed to the supervisor');

  await sup.writeFile('home/user/mod.py', 'second');
  revisions.set('home/user/mod.py', 2);
  held = sup.log.length;
  const unobserved = await h.open('home/user/mod.py', { rights: RDONLY });
  assert.equal(await readAll(unobserved.fd), 'first', 'with nothing observed since the barrier, the guest keeps its view');
  assert.deepEqual(ops().slice(held), [], 'and keeping it costs nothing');
  assert.equal(await h.wasiImport.fd_read(0, 0x300, 0, 0x200), ESUCCESS, 'the guest reads its stdin');
  const third = await h.open('home/user/mod.py', { rights: RDONLY });
  assert.equal(await readAll(third.fd), 'second', 'after input from outside, the barrier names the file and it is read again');

  const writable = await h.open('home/user/mod.py', { rights: RDONLY | (1n << 6n) });
  assert.equal(writable.errno, ESUCCESS);
  assert.equal(P.fdTable.get(writable.fd).kind, 'authority', 'a writable open holds a live descriptor');
  await h.wasiImport.fd_close(writable.fd);
}

// ── 13. A directory that keeps missing answers from its listing ─────────────
// An interpreter searching its load path misses in each directory far more
// often than it hits. The second miss in a directory takes its listing, and
// the misses after it cost one barrier between them. Whatever this process
// creates or removes is visible to its very next lookup, resumption or not.
{
  const sup = mockSupervisor({ 'home/user/lib/present.rb': 'x' });
  const h = host(ROOT_INIT(), sup);
  const ENOENT = 44;
  const stats = () => sup.log.filter(([op]) => op === 'stat').length;

  assert.equal((await h.stat('home/user/lib/a.rb')).errno, ENOENT);
  assert.equal((await h.stat('home/user/lib/b.rb')).errno, ENOENT);
  const listed = stats();
  for (const miss of ['home/user/lib/c.so', 'home/user/lib/d.rb', 'home/user/lib/e.bundle']) {
    assert.equal((await h.stat(miss)).errno, ENOENT, `${miss} is absent`);
  }
  assert.equal(stats(), listed, 'misses in a listed directory are answered without a stat');
  assert.equal((await h.stat('home/user/lib/present.rb')).errno, ESUCCESS, 'a name the listing holds is stat\'d for real');
  assert.equal(stats(), listed + 1);

  const created = await h.open('home/user/lib/b.rb', { oflags: 1 /* O_CREAT */ });
  assert.equal(created.errno, ESUCCESS);
  assert.equal((await h.stat('home/user/lib/b.rb')).errno, ESUCCESS, 'a file this process created is visible to its next lookup');
  assert.equal(await h.wasiImport.path_unlink_file(3, 0x100, (() => { const b = enc.encode('home/user/lib/present.rb'); h.u8().set(b, 0x100); return b.length; })()), ESUCCESS);
  assert.equal((await h.stat('home/user/lib/present.rb')).errno, ENOENT, 'a file this process removed is gone for its next lookup');
}

// ── 14. Each entry into the process revalidates ────────────────────────────
// A pooled interpreter runs one invocation after another in the same
// isolate, and a resident is re-entered per request. Every entry adopts the
// supervisor, and whatever happened outside since the last one — the shell
// creating a file between two `ruby -e` runs — is seen by the next lookup.
{
  const sup = mockSupervisor({ 'home/user/keep.txt': 'x' });
  const h = host(ROOT_INIT(), sup);
  const ENOENT = 44;
  assert.equal((await h.stat('home/user/made-by-shell.txt')).errno, ENOENT);
  await sup.writeFile('home/user/made-by-shell.txt', 'y');
  P.__wasiAdoptSupervisor(sup);
  assert.equal((await h.stat('home/user/made-by-shell.txt')).errno, ESUCCESS, 'the next entry sees what the shell wrote in between');
}

console.log('wasi-live-fs: all assertions passed');
