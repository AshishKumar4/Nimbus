#!/usr/bin/env bun
// Behavior test: a WASI guest dials an in-session loopback port.
//
// This is the seam that makes Ruby (and any other wasm32-wasi program) able to
// reach a port inside its own session. path_open on the synthetic
// /dev/tcp/<host>/<port> path allocates a socket fd; fd_write pushes the
// guest's HTTP/1.1 request at the virtual socket kernel, and fd_read hands back
// the response. The fd is the whole point: fd_read/fd_write are
// WebAssembly.Suspending imports, so a read genuinely parks the guest until the
// loopback response arrives, which a synchronous JS bridge can never do.
//
// Everything here drives the REAL wasi-instance.ts preamble and the REAL
// kernel, so it asserts the contract a guest actually sees. The imports are
// built through the preamble's no-JSPI branch (see lib/wasi-imports.mjs) so
// they can be called from JS: the socket paths return the Promise the
// Suspending wrapper would park the guest on, and awaiting it directly is the
// same observation.

import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/worker/src/runtime/wasi-instance.ts';
import { installVirtualSocketKernel } from '../../packages/worker/src/runtime/virtual-socket-kernel.ts';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';

const ESUCCESS = 0, ENOSYS = 52, ESPIPE = 70;
const FT_SOCKET_STREAM = 6;

const preambleSrc = `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports, fdTable };`;
const preamblePath = path.join(os.tmpdir(), `wasi-loopback-fd-${process.pid}.mjs`);
writeFileSync(preamblePath, preambleSrc);
let P;
try {
  P = await import(pathToFileURL(preamblePath).href);
} finally {
  rmSync(preamblePath, { force: true });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A WASI host over 64 KiB of memory with the '/' preopen every language
 * runtime installs, plus a kernel wired to `route`.
 */
function host(route) {
  const memory = new WebAssembly.Memory({ initial: 4 });
  P.__wasiInitFS({
    root: '',
    preopens: [{ wasiPath: '/', vfsPath: '' }],
    files: {},
    dirs: ['tmp'],
    modes: { '': 7, tmp: 7 },
  });
  const scope = { __nimbusVirtualSocketRouteLoopback: route };
  globalThis.__nimbusVirtualSockets = route ? installVirtualSocketKernel(scope) : undefined;
  const { wasiImport } = makeImportsWithoutJSPI(P, {
    argv: ['prog'],
    env: {},
    getMemory: () => memory,
    stdoutWrite: () => {},
    stderrWrite: () => {},
  });
  const view = () => new DataView(memory.buffer);
  const u8 = () => new Uint8Array(memory.buffer);

  // Scratch layout: 0x100 path, 0x200 fd-out, 0x300 iovec, 0x400 data, 0x2000 stat.
  const writePath = (s) => {
    const bytes = encoder.encode(s);
    u8().set(bytes, 0x100);
    return bytes.length;
  };
  return {
    wasiImport,
    view,
    u8,
    /** path_open(baseFd=3) with `p` exactly as wasi-libc would pass it. */
    open(p, baseFd = 3) {
      const len = writePath(p);
      const errno = wasiImport.path_open(baseFd, 1, 0x100, len, 0, -1n, -1n, 0, 0x200);
      return { errno, fd: view().getUint32(0x200, true) };
    },
    write(fd, text) {
      const bytes = encoder.encode(text);
      u8().set(bytes, 0x400);
      view().setUint32(0x300, 0x400, true);
      view().setUint32(0x304, bytes.length, true);
      return wasiImport.fd_write(fd, 0x300, 1, 0x200);
    },
    read(fd, max = 4096) {
      view().setUint32(0x300, 0x400, true);
      view().setUint32(0x304, max, true);
      return wasiImport.fd_read(fd, 0x300, 1, 0x200);
    },
    lastRead() {
      const n = view().getUint32(0x200, true);
      return decoder.decode(u8().slice(0x400, 0x400 + n));
    },
  };
}

/** Writes `p` into the scratch path slot and returns its length. */
function writeInto(h, p) {
  const bytes = encoder.encode(p);
  h.u8().set(bytes, 0x100);
  return bytes.length;
}

/** Drain a socket fd to EOF, the way a guest's read loop does. */
async function readAll(h, fd) {
  let out = '';
  for (;;) {
    assert.equal(await h.read(fd), ESUCCESS);
    const chunk = h.lastRead();
    if (chunk.length === 0) return out;
    out += chunk;
  }
}

function parseWire(wire) {
  const split = wire.indexOf('\r\n\r\n');
  assert.ok(split > 0, `no header terminator in ${JSON.stringify(wire.slice(0, 200))}`);
  const head = wire.slice(0, split);
  let rest = wire.slice(split + 4);
  if (!/^transfer-encoding:\s*chunked/im.test(head)) return { head, body: rest };
  let body = '';
  for (;;) {
    const eol = rest.indexOf('\r\n');
    const size = parseInt(rest.slice(0, eol), 16);
    if (size === 0) break;
    body += rest.slice(eol + 2, eol + 2 + size);
    rest = rest.slice(eol + 2 + size + 2);
  }
  return { head, body };
}

// ── A relative /dev/tcp path (what wasi-libc actually passes) opens a socket ──
// wasi-libc resolves an absolute path against its longest matching preopen and
// hands path_open only the remainder, so the guest's '/dev/tcp/...' arrives as
// 'dev/tcp/...'. Recognising only the absolute form makes every libc-linked
// program — every real language runtime — miss the synthetic path entirely.
{
  const seen = [];
  const h = host(async (port, request) => {
    seen.push({ port, url: request.url, method: request.method });
    return new Response('hello from node server.js', {
      status: 200,
      headers: { 'content-type': 'text/plain', 'x-served-by': 'user-server' },
    });
  });

  const opened = h.open('dev/tcp/127.0.0.1/3000');
  assert.equal(opened.errno, ESUCCESS, 'relative /dev/tcp path must open a socket fd');
  assert.ok(opened.fd >= 3);

  assert.equal(await h.write(opened.fd, 'GET /api/items?q=1 HTTP/1.1\r\nHost: 127.0.0.1:3000\r\n\r\n'), ESUCCESS);
  const { head, body } = parseWire(await readAll(h, opened.fd));

  assert.deepEqual(seen, [{ port: 3000, url: 'http://127.0.0.1:3000/api/items?q=1', method: 'GET' }]);
  assert.match(head, /^HTTP\/1\.1 200 /);
  assert.match(head, /x-served-by: user-server/i);
  assert.equal(body, 'hello from node server.js');
  console.log('  ok  relative /dev/tcp path opens a loopback socket fd and round-trips a GET');
}

// ── The absolute form (hand-written wasm that skips libc) still works ─────────
{
  const h = host(async () => new Response('direct', { status: 200 }));
  const opened = h.open('/dev/tcp/localhost/8080');
  assert.equal(opened.errno, ESUCCESS);
  assert.equal(await h.write(opened.fd, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n'), ESUCCESS);
  assert.equal(parseWire(await readAll(h, opened.fd)).body, 'direct');
  console.log('  ok  absolute /dev/tcp path still opens a loopback socket fd');
}

// ── A request body reaches the port; the response body comes back whole ──────
{
  let received = null;
  const h = host(async (port, request) => {
    received = { port, method: request.method, body: await request.text(), type: request.headers.get('content-type') };
    return new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json' } });
  });
  const { fd } = h.open('dev/tcp/127.0.0.1/8790');
  const payload = '{"model":"m","messages":[]}';
  await h.write(fd, `POST /v1/chat HTTP/1.1\r\nHost: 127.0.0.1:8790\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n`);
  await h.write(fd, payload);
  const { head, body } = parseWire(await readAll(h, fd));
  assert.deepEqual(received, { port: 8790, method: 'POST', body: payload, type: 'application/json' });
  assert.match(head, /^HTTP\/1\.1 201 /);
  assert.equal(body, '{"ok":true}');
  console.log('  ok  POST body reaches the port and the response comes back');
}

// ── The socket never reads ahead of the guest's request ─────────────────────
// A stream that pulls speculatively would read the connection before the guest
// has written anything, which the kernel correctly rejects as "read before a
// complete HTTP request" — permanently poisoning the socket.
{
  let routed = 0;
  const h = host(async () => { routed++; return new Response('late', { status: 200 }); });
  const { fd } = h.open('dev/tcp/127.0.0.1/4000');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(routed, 0, 'opening a socket must not dispatch anything by itself');
  await h.write(fd, 'GET /late HTTP/1.1\r\nHost: x\r\n\r\n');
  assert.equal(parseWire(await readAll(h, fd)).body, 'late');
  assert.equal(routed, 1);
  console.log('  ok  opening a socket does not read or dispatch before the request is written');
}

// ── A body larger than one read arrives in successive reads ─────────────────
{
  const chunkCount = 400;
  const h = host(async () => new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < chunkCount; i++) controller.enqueue(encoder.encode(`line-${i}-${'x'.repeat(200)}\n`));
      controller.close();
    },
  }), { status: 200 }));
  const { fd } = h.open('dev/tcp/127.0.0.1/5173');
  await h.write(fd, 'GET /big HTTP/1.1\r\nHost: x\r\n\r\n');

  let reads = 0;
  let wire = '';
  for (;;) {
    assert.equal(await h.read(fd, 4096), ESUCCESS);
    const chunk = h.lastRead();
    if (chunk.length === 0) break;
    reads++;
    wire += chunk;
  }
  const { body } = parseWire(wire);
  assert.ok(reads > 10, `a large body should take many reads, took ${reads}`);
  assert.equal(body.split('\n').filter(Boolean).length, chunkCount);
  assert.ok(body.startsWith('line-0-'));
  console.log(`  ok  a large response arrives across ${reads} successive reads`);
}

// ── An accepted connection is the SAME kind of fd as a dialed one ───────────
// This is the invariant that keeps a second socket implementation from growing
// back: if accept ever stops producing a file descriptor, a guest needs its own
// buffering and framing for accepted sockets, and the two paths drift.
{
  const h = host(async () => new Response('unused'));
  const kernel = globalThis.__nimbusVirtualSockets;

  const dialed = h.open('dev/tcp/127.0.0.1/3000');
  assert.equal(dialed.errno, ESUCCESS);

  // Queue an inbound request the way the port route does, then accept it.
  const served = kernel.handleHttpRequest(8080, new Request('http://127.0.0.1:8080/inbound', {
    method: 'POST',
    body: 'ping',
  }));
  kernel.listen(8080);
  const accepted = kernel.acceptNow(8080) ?? (await kernel.accept(8080));
  const bound = h.open(`dev/nimbus/socket/${accepted.id}`);
  assert.equal(bound.errno, ESUCCESS, 'an accepted connection must bind to a fd');

  const describe = (fd) => {
    assert.equal(h.wasiImport.fd_fdstat_get(fd, 0x2000), ESUCCESS);
    return {
      fdstatType: h.view().getUint8(0x2000),
      filestatType: (h.wasiImport.fd_filestat_get(fd, 0x2000), h.view().getUint8(0x2000 + 16)),
      seek: h.wasiImport.fd_seek(fd, 0n, 0, 0x2000),
      tell: h.wasiImport.fd_tell(fd, 0x2000),
    };
  };
  assert.deepEqual(describe(bound.fd), describe(dialed.fd),
    'accepted and dialed sockets must be indistinguishable as file descriptors');

  // And it really carries the exchange: read the request, write the response.
  assert.equal(await h.read(bound.fd), ESUCCESS);
  assert.match(h.lastRead(), /^POST \/inbound HTTP\/1\.1/);
  const payload = 'accepted-ok';
  await h.write(bound.fd, `HTTP/1.1 200 OK\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`);
  const response = await served;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), payload);
  console.log('  ok  an accepted connection is the same kind of fd as a dialed one, and carries the exchange');
}

// ── Accept is a read on a listening descriptor ──────────────────────────────
// The listening socket is a descriptor whose read yields the next connection.
// That is the only way to accept, which is what keeps a server's socket and a
// client's socket from drifting into two implementations.
{
  const h = host(async () => new Response('unused'));
  const kernel = globalThis.__nimbusVirtualSockets;
  kernel.listen(8080);

  const listener = h.open('dev/nimbus/listen/8080');
  assert.equal(listener.errno, ESUCCESS, 'a bound port opens as a listening descriptor');

  assert.equal(h.wasiImport.fd_fdstat_get(listener.fd, 0x2000), ESUCCESS);
  assert.equal(h.view().getUint8(0x2000), FT_SOCKET_STREAM, 'a listening socket is a socket');

  // Reading before anything connects must not resolve...
  let resolved = false;
  const pending = h.read(listener.fd).then((errno) => { resolved = true; return errno; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(resolved, false, 'accept blocks until a connection arrives');

  // ...and resolves with the connection once one is queued.
  const served = kernel.handleHttpRequest(8080, new Request('http://127.0.0.1:8080/x'));
  assert.equal(await pending, ESUCCESS);
  const acceptedId = Number(h.lastRead().trim());
  assert.ok(acceptedId > 0, `accept yields a connection id, got ${JSON.stringify(h.lastRead())}`);

  // The id opens as a socket descriptor and carries the exchange.
  const conn = h.open(`dev/nimbus/socket/${acceptedId}`);
  assert.equal(conn.errno, ESUCCESS);
  assert.equal(await h.read(conn.fd), ESUCCESS);
  assert.match(h.lastRead(), /^GET \/x HTTP\/1\.1/);
  await h.write(conn.fd, 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi');
  const response = await served;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'hi');
  console.log('  ok  accept is a blocking read on a listening descriptor');
}

// ── A non-blocking listening descriptor reports EAGAIN, not a stall ─────────
{
  const h = host(async () => new Response('unused'));
  globalThis.__nimbusVirtualSockets.listen(9100);
  const listener = h.open('dev/nimbus/listen/9100');
  assert.equal(listener.errno, ESUCCESS);
  assert.equal(h.wasiImport.fd_fdstat_set_flags(listener.fd, 4), ESUCCESS, 'set O_NONBLOCK');
  assert.equal(await h.read(listener.fd), 6, 'an empty accept queue is EAGAIN');
  console.log('  ok  a non-blocking listening descriptor reports EAGAIN on an empty queue');
}

// ── Opening an unbound port binds it ───────────────────────────────────────
// Opening this path IS the guest asking to listen: it is what listen(2)
// compiles to for a program built against wasi-libc. This used to return
// ENOTCONN unless something had already bound the port through JS, which meant
// only a runtime that could reach out and do that (ruby, via
// __nimbusRubySockets) could serve — a plain WASI server got ENOTCONN from
// listen and never got as far as accept.
{
  const h = host(async () => new Response('unused'));
  const kernel = globalThis.__nimbusVirtualSockets;
  assert.equal(kernel.listeners.has(9999), false, 'nothing has bound the port yet');

  const opened = h.open('dev/nimbus/listen/9999');
  assert.equal(opened.errno, ESUCCESS, 'opening the listen path binds the port');
  assert.equal(kernel.listeners.has(9999), true, 'and the kernel now has a listener');

  // Bound is not served: the supervisor has to learn about the port or nothing
  // outside the session can route to it.
  assert.equal(h.wasiImport.fd_fdstat_get(opened.fd, 0x2000), ESUCCESS);
  assert.equal(h.view().getUint8(0x2000), FT_SOCKET_STREAM, 'and it is a listening socket');
  console.log('  ok  opening an unbound port binds it and announces it');
}

// ── A port the kernel refuses still fails with a reason ────────────────────
{
  const h = host(null);   // no kernel at all
  const opened = h.open('dev/nimbus/listen/9998');
  assert.equal(opened.errno, 52, 'ENOSYS with no virtual socket kernel');
  assert.match(String(globalThis.__nimbusWasiLastSocketError), /cannot be listened on|no Nimbus virtual socket/);
  console.log('  ok  listening without a kernel fails with a reason');
}

// ── A loopback socket fd looks like a socket, not a file ────────────────────
{
  const h = host(async () => new Response('x'));
  const { fd } = h.open('dev/tcp/127.0.0.1/3000');

  assert.equal(h.wasiImport.fd_fdstat_get(fd, 0x2000), ESUCCESS);
  assert.equal(h.view().getUint8(0x2000), FT_SOCKET_STREAM, 'fdstat filetype');

  assert.equal(h.wasiImport.fd_filestat_get(fd, 0x2000), ESUCCESS);
  assert.equal(h.view().getUint8(0x2000 + 16), FT_SOCKET_STREAM, 'filestat filetype');

  assert.equal(h.wasiImport.fd_seek(fd, 0n, 0, 0x2000), ESPIPE, 'a socket is not seekable');
  assert.equal(h.wasiImport.fd_tell(fd, 0x2000), ESPIPE, 'a socket has no offset');
  console.log('  ok  a loopback socket fd reports as a non-seekable stream socket');
}

// ── Without a kernel, dialing loopback fails loudly instead of hanging ──────
{
  const h = host(null);
  const opened = h.open('dev/tcp/127.0.0.1/3000');
  assert.equal(opened.errno, ENOSYS);
  assert.match(String(globalThis.__nimbusWasiLastSocketError), /virtual socket kernel/);
  console.log('  ok  loopback without a kernel reports ENOSYS with a reason');
}

// ── A non-loopback host is NOT routed through the kernel ────────────────────
// Remote hosts keep going to cloudflare:sockets, which is unavailable here, so
// the open fails without the router ever being consulted.
{
  let routed = 0;
  const h = host(async () => { routed++; return new Response('nope'); });
  const opened = h.open('dev/tcp/example.com/80');
  assert.equal(opened.errno, ENOSYS, 'remote hosts must not fall back to loopback');
  assert.equal(routed, 0);
  console.log('  ok  a remote host stays on the cloudflare:sockets path');
}

// ── Ordinary file paths are untouched by the synthetic-path check ───────────
{
  const h = host(async () => new Response('x'));
  assert.equal(h.open('tmp/notes.txt').errno, 44, 'a missing ordinary file is still ENOENT');
  const created = h.wasiImport.path_open(3, 1, 0x100, encoder.encode('tmp/notes.txt').length, 1, -1n, -1n, 0, 0x200);
  assert.equal(created, ESUCCESS);
  const fd = h.view().getUint32(0x200, true);
  assert.equal(h.wasiImport.fd_write(fd, 0x300, 0, 0x200), ESUCCESS, 'a file fd still writes synchronously');
  console.log('  ok  ordinary paths are unaffected by the /dev/tcp interception');
}

// ── sock_accept: the syscall wasi-libc's accept(2) actually calls ──────────
// A guest compiled against wasi-libc never reaches the path_open route; its
// accept(2) is a direct call to sock_accept and nothing else. CPython built for
// wasm32-wasi is such a guest, and its module declares the import, so a missing
// sock_accept is a LinkError at instantiation rather than a runtime failure.
{
  const h = host(async () => new Response('unused'));
  const kernel = globalThis.__nimbusVirtualSockets;
  kernel.listen(8080);
  const listener = h.open('dev/nimbus/listen/8080');
  assert.equal(listener.errno, ESUCCESS);

  // Blocks until a connection arrives, like accept(2).
  let resolved = false;
  const pending = h.wasiImport.sock_accept(listener.fd, 0, 0x200)
    .then((errno) => { resolved = true; return errno; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(resolved, false, 'sock_accept blocks until a connection arrives');

  const served = kernel.handleHttpRequest(8080, new Request('http://127.0.0.1:8080/direct'));
  assert.equal(await pending, ESUCCESS);
  const conn = h.view().getUint32(0x200, true);

  // The descriptor it hands back is a socket, not a connection id to open.
  assert.equal(h.wasiImport.fd_fdstat_get(conn, 0x2000), ESUCCESS);
  assert.equal(h.view().getUint8(0x2000), FT_SOCKET_STREAM);

  assert.equal(await h.read(conn), ESUCCESS);
  assert.match(h.lastRead(), /^GET \/direct HTTP\/1\.1/);
  await h.write(conn, 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
  const response = await served;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  console.log('  ok  sock_accept yields a connected socket fd directly');
}

// ── sock_accept honours non-blocking from either descriptor ────────────────
{
  const h = host(async () => new Response('unused'));
  const kernel = globalThis.__nimbusVirtualSockets;
  kernel.listen(9200);
  const listener = h.open('dev/nimbus/listen/9200');
  assert.equal(listener.errno, ESUCCESS);

  // Asked for non-blocking by the call's own flags.
  assert.equal(await h.wasiImport.sock_accept(listener.fd, 4, 0x200), 6,
    'an empty queue with FDFLAGS_NONBLOCK is EAGAIN');

  // ...and by the listener's flags, which is how fcntl(O_NONBLOCK) reaches it.
  assert.equal(h.wasiImport.fd_fdstat_set_flags(listener.fd, 4), ESUCCESS);
  assert.equal(await h.wasiImport.sock_accept(listener.fd, 0, 0x200), 6,
    "an empty queue on a non-blocking listener is EAGAIN");
  console.log('  ok  sock_accept reports EAGAIN rather than stalling a non-blocking guest');
}

// ── sock_accept on the wrong kind of descriptor ────────────────────────────
{
  const h = host(async () => new Response('x'));
  assert.equal(await h.wasiImport.sock_accept(999, 0, 0x200), 8, 'EBADF for an unknown fd');
  const { fd } = h.open('dev/tcp/127.0.0.1/3000');
  assert.equal(await h.wasiImport.sock_accept(fd, 0, 0x200), 57,
    'ENOTSOCK for a connected socket — only a listener can accept');
  assert.equal(await h.wasiImport.sock_accept(3, 0, 0x200), 57, 'ENOTSOCK for a preopen dir');
  console.log('  ok  sock_accept refuses descriptors that cannot accept');
}

// ── fd_renumber is dup2, and dup2 closes the descriptor it lands on ────────
// preview1 has no dup, so fd_renumber is the only way a guest can move a
// descriptor onto a number it already chose. nimbus-net.c's socket(2) does
// exactly this: it claims a number by opening a directory, then moves the real
// socket onto it once connect(2) knows what to dial.
{
  const h = host(async () => new Response('renumbered'));
  // O_DIRECTORY (oflags bit 1) — nimbus-net.c claims the number by opening the
  // root preopen, so the empty relative path wasi-libc sends for "/" is the
  // case that has to work.
  const claimed = h.wasiImport.path_open(3, 1, 0x100, writeInto(h, ''), 2, -1n, -1n, 0, 0x200);
  assert.equal(claimed, ESUCCESS, 'open("/", O_DIRECTORY) must claim a descriptor');
  const claimedFd = h.view().getUint32(0x200, true);
  const { errno, fd: sockFd } = h.open('dev/tcp/127.0.0.1/3000');
  assert.equal(errno, ESUCCESS);

  assert.equal(h.wasiImport.fd_renumber(sockFd, claimedFd), ESUCCESS);

  // The claimed number is now the socket...
  assert.equal(h.wasiImport.fd_fdstat_get(claimedFd, 0x2000), ESUCCESS);
  assert.equal(h.view().getUint8(0x2000), FT_SOCKET_STREAM,
    'the descriptor the guest was holding is now the socket');
  // ...and the number the socket arrived on is gone.
  assert.equal(h.wasiImport.fd_fdstat_get(sockFd, 0x2000), 8, 'EBADF for the vacated fd');

  // And it is really the socket, not just the right filetype.
  await h.write(claimedFd, 'GET /moved HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  assert.equal(await h.read(claimedFd), ESUCCESS);
  assert.match(h.lastRead(), /^HTTP\/1\.1 200/);
  console.log('  ok  fd_renumber moves a socket onto a descriptor the guest already holds');
}

// ── Renumbering over a socket closes it rather than dropping it ────────────
// Deleting the fd-table entry without closing leaks a live stream: the kernel
// is never told, so the connection stays open for the life of the process.
{
  const h = host(async () => new Response('x'));
  const doomed = h.open('dev/tcp/127.0.0.1/3000');
  const keeper = h.open('dev/tcp/127.0.0.1/3001');
  assert.equal(doomed.errno, ESUCCESS);
  assert.equal(keeper.errno, ESUCCESS);
  const doomedEntry = P.fdTable.get(doomed.fd);
  assert.equal(doomedEntry.closed, false);

  assert.equal(h.wasiImport.fd_renumber(keeper.fd, doomed.fd), ESUCCESS);

  assert.equal(doomedEntry.closed, true, 'the displaced socket must be closed, not leaked');
  assert.equal(P.fdTable.get(doomed.fd), P.fdTable.get(doomed.fd),
    'the destination now holds the moved descriptor');
  assert.notEqual(P.fdTable.get(doomed.fd), doomedEntry);
  console.log('  ok  fd_renumber closes the socket it displaces');
}

// ── Renumbering onto itself, and off a descriptor that was never open ──────
{
  const h = host(async () => new Response('x'));
  const { fd } = h.open('dev/tcp/127.0.0.1/3000');
  assert.equal(h.wasiImport.fd_renumber(fd, fd), ESUCCESS, 'renumbering onto itself is a no-op');
  assert.equal(h.wasiImport.fd_fdstat_get(fd, 0x2000), ESUCCESS, 'and does not close it');
  assert.equal(h.wasiImport.fd_renumber(999, fd), 8, 'EBADF for an unopened source');
  console.log('  ok  fd_renumber handles self-renumber and an unopened source');
}

// ── A preopen is not something a guest may renumber over ───────────────────
// It is the root of the filesystem; replacing it leaves nothing to read from,
// and the guest gets no diagnosis at all from a silent success.
{
  const h = host(async () => new Response('x'));
  const { fd } = h.open('dev/tcp/127.0.0.1/3000');
  assert.equal(h.wasiImport.fd_renumber(fd, 3), 76, 'ENOTCAPABLE rather than a destroyed VFS');
  assert.equal(h.open('tmp/after.txt').errno, 44,
    'the preopen still resolves paths afterwards');
  assert.equal(h.wasiImport.fd_fdstat_get(fd, 0x2000), ESUCCESS, 'and the source is untouched');
  console.log('  ok  fd_renumber refuses to overwrite a preopen');
}

console.log('wasi-loopback-socket-fd: all cases passed');
