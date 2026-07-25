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
// kernel, so it asserts the contract a guest actually sees. Node has no JSPI,
// so the socket paths return the Promise the Suspending wrapper would await —
// awaiting it directly is the same observation.

import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/worker/src/runtime/wasi-instance.ts';
import { installVirtualSocketKernel } from '../../packages/worker/src/runtime/virtual-socket-kernel.ts';

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
  const { wasiImport } = P.__wasiMakeImports({
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

console.log('wasi-loopback-socket-fd: all cases passed');
