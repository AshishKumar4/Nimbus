#!/usr/bin/env bun
// wasi-lookup-coherence — a parked WASI guest's lookups, held between
// resumptions, never let it see a file older than one it has already seen.
//
// A real session filesystem with a real invalidation log, a peer writing
// through the kernel, and a guest whose every supervisor call is an awaited
// round trip, counted. The coherence protocol's promise for wasm guests is a
// transparent POSIX filesystem: once the guest has observed a peer's write,
// every later lookup reflects it.

import assert from 'node:assert/strict';

import { loadWasiPreamble, makeGuest, makeSession } from './lib/wasi-authority.mjs';
import { installVirtualSocketKernel } from '../../packages/core/src/runtime/virtual-socket-kernel.ts';

const ESUCCESS = 0, EAGAIN = 6, ENOENT = 44;
const O_DIRECTORY = 2;
const RDONLY = 0x1fbffeben; // what wasi-libc requests for O_RDONLY
const WRITE = RDONLY | (1n << 6n);

const P = await loadWasiPreamble();
const dec = new TextDecoder();

/** A guest over a session whose supervisor answers asynchronously, as an RPC stub does. */
function world({ dirs = [], files = {} } = {}) {
  const session = makeSession({ dirs, files });
  const calls = [];
  const remote = {};
  for (const [name, fn] of Object.entries(session.supervisor)) {
    if (typeof fn !== 'function') continue;
    remote[name] = async (...args) => { calls.push(name); return fn.apply(session.supervisor, args); };
  }
  session.supervisor = remote;
  const g = makeGuest(P, session, { root: 'home/user', preopens: [{ wasiPath: '/', vfsPath: 'home/user' }] }, { parking: 'jspi' });
  const put = (s) => g.putStr(s);
  const guest = {
    async stat(path) {
      const [p, n] = put(path); const at = g.alloc(64);
      const errno = await g.wasi.path_filestat_get(3, 1, p, n, at);
      return { errno, size: Number(g.dv().getBigUint64(at + 32, true)) };
    },
    async open(path, rights = RDONLY, oflags = 0) {
      const [p, n] = put(path); const out = g.alloc(4);
      const errno = await g.wasi.path_open(3, 1, p, n, oflags, rights, rights, 0, out);
      return { errno, fd: g.dv().getUint32(out, true) };
    },
    async read(fd) {
      const { iov, buf } = g.iovec(4096); const nread = g.alloc(4);
      const errno = await g.wasi.fd_read(fd, iov, 1, nread);
      return { errno, text: dec.decode(g.u8().subarray(buf, buf + g.dv().getUint32(nread, true))) };
    },
    async write(fd, text) {
      const bytes = new TextEncoder().encode(text); const buf = g.alloc(bytes.length); g.u8().set(bytes, buf);
      const iov = g.alloc(8); g.dv().setUint32(iov, buf, true); g.dv().setUint32(iov + 4, bytes.length, true);
      return g.wasi.fd_write(fd, iov, 1, g.alloc(4));
    },
    async fstatSize(fd) {
      const at = g.alloc(64);
      assert.equal(await g.wasi.fd_filestat_get(fd, at), ESUCCESS);
      return Number(g.dv().getBigUint64(at + 32, true));
    },
    async names(fd) {
      const buf = g.alloc(4096); const used = g.alloc(4);
      assert.equal(await g.wasi.fd_readdir(fd, buf, 4096, 0n, used), ESUCCESS);
      const names = []; let off = buf; const end = buf + g.dv().getUint32(used, true);
      while (off + 24 <= end) {
        const len = g.dv().getUint32(off + 16, true);
        names.push(dec.decode(g.u8().subarray(off + 24, off + 24 + len)));
        off += 24 + len;
      }
      return names;
    },
    close: (fd) => g.wasi.fd_close(fd),
  };
  return { session, guest, calls, peer: session.root };
}

const sessions = [];

// A peer's write the guest has read about is visible to its next lookup:
// no resumption in between, only a live read of the file that reports it.
{
  const w = world({ dirs: ['home/user/out'], files: { 'home/user/status.txt': 'idle' } });
  sessions.push(w.session);
  for (let i = 0; i < 3; i++) assert.equal((await w.guest.stat('out/a.txt')).errno, ENOENT);
  w.peer.writeFile('home/user/out/a.txt', 'A');
  w.peer.writeFile('home/user/status.txt', 'a.txt written');
  const status = await w.guest.open('status.txt');
  assert.equal(status.errno, ESUCCESS);
  assert.equal((await w.guest.read(status.fd)).text, 'a.txt written');
  assert.equal((await w.guest.stat('out/a.txt')).errno, ESUCCESS,
    'a file the guest has read news of is there for its next stat');
}

// A name a live listing shows is a name stat finds.
{
  const w = world({ dirs: ['home/user/out'] });
  sessions.push(w.session);
  for (let i = 0; i < 3; i++) assert.equal((await w.guest.stat('out/b.txt')).errno, ENOENT);
  w.peer.writeFile('home/user/out/b.txt', 'B');
  const dir = await w.guest.open('out', RDONLY, O_DIRECTORY);
  assert.equal(dir.errno, ESUCCESS);
  assert.ok((await w.guest.names(dir.fd)).includes('b.txt'), 'the listing is live');
  assert.equal((await w.guest.stat('out/b.txt')).errno, ESUCCESS, 'and stat agrees with it');
}

// A descriptor is one version of the file: its size and its bytes agree.
{
  const w = world({ files: { 'home/user/g.txt': 'v1' } });
  sessions.push(w.session);
  for (let i = 0; i < 3; i++) assert.equal((await w.guest.stat('g.txt')).size, 2);
  w.peer.writeFile('home/user/g.txt', 'version-two');
  const g = await w.guest.open('g.txt');
  assert.equal(g.errno, ESUCCESS);
  const text = (await w.guest.read(g.fd)).text;
  assert.equal(await w.guest.fstatSize(g.fd), new TextEncoder().encode(text).length,
    `fstat and read describe the same bytes (read ${JSON.stringify(text)})`);
}

// Writing a file's bytes changes no names: the directories already listed
// keep answering, and a stat afterwards is one lookup, not a rebuilt chain.
{
  const w = world({ dirs: ['home/user/proj/lib'], files: { 'home/user/proj/log.txt': '', 'home/user/proj/lib/x.rb': 'x' } });
  sessions.push(w.session);
  for (let i = 0; i < 3; i++) {
    assert.equal((await w.guest.stat('proj/lib/x.rb')).errno, ESUCCESS);
    assert.equal((await w.guest.stat('proj/lib/missing.rb')).errno, ENOENT);
  }
  const log = await w.guest.open('proj/log.txt', WRITE);
  assert.equal(log.errno, ESUCCESS);
  assert.equal(await w.guest.write(log.fd, 'line\n'), ESUCCESS);
  const before = w.calls.length;
  assert.equal((await w.guest.stat('proj/lib/x.rb')).errno, ESUCCESS);
  const cost = w.calls.slice(before);
  assert.ok(cost.length <= 2, `a stat after a write costs at most a barrier and the stat itself: ${cost.join(', ')}`);
}

// A wait the park watchdog cuts short is still a wait: whatever happened
// outside during it is there for the next lookup.
{
  const w = world();
  sessions.push(w.session);
  globalThis.__nimbusVirtualSockets = installVirtualSocketKernel({});
  const listener = await w.guest.open('dev/nimbus/listen/8080');
  assert.equal(listener.errno, ESUCCESS);
  for (let i = 0; i < 3; i++) assert.equal((await w.guest.stat('late.txt')).errno, ENOENT);
  w.peer.writeFile('home/user/late.txt', 'L');
  const realSetTimeout = globalThis.setTimeout;
  // Only the watchdog's deadline is that long: it fires at once, the accept never does.
  globalThis.setTimeout = (fn, ms, ...args) => (ms >= 10_000 ? realSetTimeout(fn, 0, ...args) : realSetTimeout(fn, ms, ...args));
  try {
    assert.equal(await w.guest.read(listener.fd).then((r) => r.errno), EAGAIN, 'the accept is cut short by the watchdog');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal((await w.guest.stat('late.txt')).errno, ESUCCESS, 'a file created during the wait is there after it');
  globalThis.__nimbusVirtualSockets = undefined;
}

for (const session of sessions) await session.dispose();
console.log('wasi-lookup-coherence: ok');
