#!/usr/bin/env bun
// preview/new/port-range-large-file — a 210 MiB file in the session VFS,
// served by an ordinary Node static server, comes back through the port
// route byte-exact: by ranges (206 + Content-Range), conditionally (304,
// If-Range) and whole, with the session alive throughout.
//
// This is the shape of an Emscripten game streaming 73-178 MiB map files
// with HTTP Range. Request headers (Range, If-Range, If-None-Match,
// If-Modified-Since, User-Agent) must reach the guest whole, its 206/304 and
// their headers (Content-Range, Content-Length, ETag) must come back
// unchanged, and the body must stream end to end: a hop that held the whole
// response would take the session past its 128 MiB isolate before the last
// byte, and the terminal socket would close with it.
//
// The file's content is a pure function of the offset, so every byte is
// checked without keeping a copy here either.
//
// NIMBUS_PROBE_STATIC_SERVER picks the file server (default: node-core):
//   node-core     node:http + fs.promises.stat + fs.createReadStream({start, end}),
//                 the fs path every Node static server takes
//   http-server   npx http-server   (on 631dc49a: events shim not callable)
//   serve         npx serve         (on 631dc49a: ESM entry in the npx cache)
//   serve-static  serve-static + finalhandler (on 631dc49a: depd `new Function`)
// Whichever it is, a second server on port 3001 echoes what reached it and
// answers a fixed 206 and 304, so passthrough is proven independently of
// which conditional semantics the file server implements.

import { deleteSession, heredocCommand, makeAsserter, mintSession, requestHeaders, Terminal } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'preview/new/port-range-large-file';
const a = makeAsserter(label);
const BASE = process.env.BASE;
console.log(`${label} — BASE=${BASE}`);

const PORT = 3000;
const ECHO_PORT = 3001;
const SIZE = 210 * 1024 * 1024;
const MiB = 1024 * 1024;

const nodeCoreServer = `
const http = require('http');
const fs = require('fs');
const path = require('path');
http.createServer(async (req, res) => {
  const file = path.join(__dirname, decodeURIComponent(new URL(req.url, 'http://file').pathname));
  let stat;
  try { stat = await fs.promises.stat(file); } catch { res.writeHead(404); res.end(); return; }
  // stat.mtime, as send (serve-static) and http-server read it.
  const modified = new Date(Math.floor(stat.mtime.getTime() / 1000) * 1000);
  const etag = '"' + stat.size.toString(16) + '-' + modified.getTime().toString(16) + '"';
  const headers = { 'Accept-Ranges': 'bytes', ETag: etag, 'Last-Modified': modified.toUTCString(), 'Content-Type': 'application/octet-stream' };
  const since = Date.parse(req.headers['if-modified-since'] ?? '');
  if (req.headers['if-none-match'] === etag || (req.headers['if-none-match'] === undefined && modified.getTime() <= since)) {
    res.writeHead(304, headers); res.end(); return;
  }
  const wanted = req.headers['if-range'] === undefined || req.headers['if-range'] === etag ? req.headers.range : undefined;
  const range = wanted && /^bytes=([0-9]*)-([0-9]*)$/.exec(wanted);
  if (range && (range[1] !== '' || range[2] !== '')) {
    const start = range[1] === '' ? Math.max(0, stat.size - Number(range[2])) : Number(range[1]);
    const end = range[1] === '' || range[2] === '' ? stat.size - 1 : Math.min(Number(range[2]), stat.size - 1);
    if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); res.end(); return; }
    res.writeHead(206, { ...headers, 'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(file).pipe(res);
}).listen(${PORT}, () => console.log('FILES ${PORT}'));
`.trim();

const echoServer = `
const http = require('http');
const ECHOED = ['range', 'if-range', 'if-none-match', 'if-match', 'if-modified-since', 'if-unmodified-since', 'user-agent'];
http.createServer((req, res) => {
  const path = new URL(req.url, 'http://echo').pathname;
  if (path === '/partial') {
    res.writeHead(206, { 'Content-Range': 'bytes 5-9/100', 'Accept-Ranges': 'bytes', ETag: '"v1"', 'Content-Length': 5 });
    res.end('56789');
  } else if (path === '/not-modified') {
    res.writeHead(304, { ETag: '"v1"', 'Cache-Control': 'max-age=60' });
    res.end();
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Object.fromEntries(ECHOED.map((name) => [name, req.headers[name] ?? null]))));
  }
}).listen(${ECHO_PORT}, () => console.log('ECHO ${ECHO_PORT}'));
`.trim();

const SERVERS = {
  'node-core': { files: { 'files.js': nodeCoreServer }, install: null, start: 'node --watch files.js', ifRange: true },
  'http-server': { files: {}, install: null, start: `npx --yes http-server -p ${PORT} -c-1 .`, ifRange: false },
  serve: { files: {}, install: null, start: `npx --yes serve -l ${PORT} .`, ifRange: false },
  'serve-static': {
    files: {
      'package.json': JSON.stringify({ name: 'big', version: '1.0.0', dependencies: { 'serve-static': '^1.16.2', finalhandler: '^1.3.1' } }),
      'files.js': [
        "const http = require('http');",
        "const serveStatic = require('serve-static');",
        "const finalhandler = require('finalhandler');",
        'const serve = serveStatic(__dirname);',
        `http.createServer((req, res) => serve(req, res, finalhandler(req, res))).listen(${PORT}, () => console.log('FILES ${PORT}'));`,
      ].join('\n'),
    },
    install: 'npm install',
    start: 'node --watch files.js',
    ifRange: true,
  },
};
const serverName = process.env.NIMBUS_PROBE_STATIC_SERVER || 'node-core';
const server = SERVERS[serverName];
if (!server) { console.error(`FATAL: unknown NIMBUS_PROBE_STATIC_SERVER ${serverName}`); process.exit(2); }

// Word i of the file is i itself, stored little-endian: every 4 bytes name
// their own offset, so a misplaced range cannot match, and the generator stays
// cheap enough for a process's CPU limit (a hashed word per 4 bytes of 210 MiB
// was measured to exceed it).
const byteAt = (offset) => (Math.floor(offset / 4) >>> ((offset % 4) * 8)) & 0xff;

const genJs = `
const fs = require('fs');
(async () => {
  const handle = await fs.promises.open('big.bin', 'w');
  const chunk = new Uint8Array(${MiB});
  const view = new DataView(chunk.buffer);
  for (let offset = 0; offset < ${SIZE}; offset += chunk.length) {
    for (let i = 0; i < chunk.length; i += 4) view.setUint32(i, (offset + i) / 4, true);
    await handle.write(chunk, 0, chunk.length, offset);
  }
  await handle.close();
  console.log('WROTE ' + (await fs.promises.stat('big.bin')).size);
})();
`.trim();

const url = (path, port = PORT) => `${BASE}/s/${sid}/port/${port}/${path}`;

/** Compare a body against the generator from `offset`, without holding it. */
async function verifyStream(body, offset) {
  const reader = body.getReader();
  let position = offset;
  let mismatch = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (mismatch === null) {
      for (let i = 0; i < value.length; i++) {
        if (value[i] !== byteAt(position + i)) { mismatch = position + i; break; }
      }
    }
    position += value.length;
  }
  return { length: position - offset, mismatch };
}

const sid = await mintSession();
const t = new Terminal(sid);
let pid = 0;
let echoPid = 0;
const measured = { from: new Date().toISOString(), to: null };

try {
  await t.connect();
  await t.waitForPrompt(30_000);
  await t.run('mkdir -p /home/user/big && cd /home/user/big', 15_000);
  for (const [name, content] of Object.entries(server.files)) await t.run(heredocCommand(name, content), 15_000);
  await t.run(heredocCommand('echo.js', echoServer), 15_000);
  await t.run(heredocCommand('gen.js', genJs), 15_000);
  const generated = await t.run('node gen.js', 900_000);
  a.check(`a ${SIZE / MiB} MiB file is written to the VFS`, generated.output.includes(`WROTE ${SIZE}`), generated.output.slice(-300));
  if (server.install) {
    const installed = await t.run(server.install, 300_000);
    a.check(`${server.install} completes`, /added \d+ packages|up to date/.test(installed.output), installed.output.slice(-300));
  }
  const started = await t.run(server.start, 180_000);
  pid = Number(started.output.match(/pid=(\d+)/)?.[1] || 0);
  const echoStarted = await t.run('node --watch echo.js', 60_000);
  echoPid = Number(echoStarted.output.match(/pid=(\d+)/)?.[1] || 0);

  // ── the hop itself: conditional request headers in, 206/304 out ──
  // Every value as a browser sends it: HTTP-dates and a Chrome User-Agent
  // carry commas inside one field value, and the guest must see them whole
  // (the edge has already joined any duplicate fields).
  const sent = {
    range: 'bytes=5-9',
    'if-range': '"v1"',
    'if-none-match': '"v0", "v1"',
    'if-match': '"v1"',
    'if-modified-since': 'Tue, 29 Sep 2026 00:00:00 GMT',
    'if-unmodified-since': 'Wed, 30 Sep 2026 00:00:00 GMT',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  };
  let echoed = null;
  const echoDeadline = Date.now() + 60_000;
  while (Date.now() < echoDeadline) {
    const response = await fetch(url('echo', ECHO_PORT), { headers: requestHeaders(sent) });
    if (response.status === 200) { echoed = await response.json(); break; }
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  a.check('the echo server answers', echoed !== null);
  for (const [name, value] of Object.entries(sent)) {
    a.check(`${name} reaches the guest unchanged`, echoed?.[name] === value, `sent ${JSON.stringify(value)} got ${JSON.stringify(echoed?.[name])}`);
  }
  const partial = await fetch(url('partial', ECHO_PORT), { headers: requestHeaders() });
  const partialBody = await partial.text();
  a.check(
    "a guest's 206 comes back with its Content-Range, Content-Length, Accept-Ranges and ETag",
    partial.status === 206 && partial.headers.get('content-range') === 'bytes 5-9/100'
      && partial.headers.get('content-length') === '5'
      && partial.headers.get('accept-ranges') === 'bytes' && partial.headers.get('etag') === '"v1"' && partialBody === '56789',
    `status=${partial.status} ${JSON.stringify(Object.fromEntries(partial.headers))} body=${partialBody}`,
  );
  const notModified = await fetch(url('not-modified', ECHO_PORT), { headers: requestHeaders() });
  await notModified.body?.cancel();
  a.check(
    "a guest's 304 comes back with its ETag",
    notModified.status === 304 && notModified.headers.get('etag') === '"v1"' && notModified.headers.get('cache-control') === 'max-age=60',
    `status=${notModified.status} ${JSON.stringify(Object.fromEntries(notModified.headers))}`,
  );

  let first = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    first = await fetch(url('big.bin'), { headers: requestHeaders({ Range: 'bytes=0-63' }) });
    if (first.status === 206) break;
    await first.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  a.check(`${serverName} answers a Range with 206`, first?.status === 206, `status=${first?.status}`);
  await first?.body?.cancel();

  // ── ranges: every edge the server computes, byte-exact ──
  const ranges = [
    { header: 'bytes=0-63', start: 0, end: 63 },
    { header: 'bytes=65530-65545', start: 65530, end: 65545 },
    { header: `bytes=${100 * MiB + 3}-${101 * MiB + 2}`, start: 100 * MiB + 3, end: 101 * MiB + 2 },
    { header: 'bytes=-1000', start: SIZE - 1000, end: SIZE - 1 },
    { header: `bytes=${SIZE - 100}-`, start: SIZE - 100, end: SIZE - 1 },
  ];
  let etag = null;
  for (const range of ranges) {
    const response = await fetch(url('big.bin'), { headers: requestHeaders({ Range: range.header }) });
    const expectedLength = range.end - range.start + 1;
    const contentRange = response.headers.get('content-range');
    etag ??= response.headers.get('etag');
    const checked = await verifyStream(response.body, range.start);
    a.check(
      `Range ${range.header} → 206, Content-Range bytes ${range.start}-${range.end}/${SIZE}, exact bytes`,
      response.status === 206
        && contentRange === `bytes ${range.start}-${range.end}/${SIZE}`
        && Number(response.headers.get('content-length')) === expectedLength
        && checked.length === expectedLength
        && checked.mismatch === null,
      `status=${response.status} content-range=${contentRange} length=${checked.length} mismatch=${checked.mismatch}`,
    );
  }

  // ── conditional requests reach the server and its answers come back ──
  a.check('the server’s ETag comes back', typeof etag === 'string' && etag.length > 0, `etag=${etag}`);
  const unchanged = await fetch(url('big.bin'), { headers: requestHeaders({ 'If-None-Match': etag }) });
  a.check(
    'If-None-Match with the current ETag → 304 carrying that ETag',
    unchanged.status === 304 && unchanged.headers.get('etag') === etag,
    `status=${unchanged.status} etag=${unchanged.headers.get('etag')}`,
  );
  await unchanged.body?.cancel();
  const lastModified = unchanged.headers.get('last-modified');
  const notModifiedSince = await fetch(url('big.bin'), { headers: requestHeaders({ 'If-Modified-Since': lastModified }) });
  await notModifiedSince.body?.cancel();
  a.check(
    'If-Modified-Since with the file\'s Last-Modified → 304',
    notModifiedSince.status === 304,
    `status=${notModifiedSince.status} last-modified=${lastModified}`,
  );
  if (server.ifRange) {
    const ifRange = await fetch(url('big.bin'), { headers: requestHeaders({ Range: 'bytes=10-19', 'If-Range': etag }) });
    const ifRangeChecked = await verifyStream(ifRange.body, 10);
    a.check(
      'If-Range with the current ETag → 206 of the range',
      ifRange.status === 206 && ifRangeChecked.length === 10 && ifRangeChecked.mismatch === null,
      `status=${ifRange.status} length=${ifRangeChecked.length}`,
    );
    const staleIfRange = await fetch(url('big.bin'), { headers: requestHeaders({ Range: 'bytes=10-19', 'If-Range': '"stale"' }) });
    a.check(
      'If-Range with a stale ETag → 200 of the whole file',
      staleIfRange.status === 200 && Number(staleIfRange.headers.get('content-length')) === SIZE,
      `status=${staleIfRange.status} content-length=${staleIfRange.headers.get('content-length')}`,
    );
    await staleIfRange.body?.cancel();
  }

  // ── the whole file, streamed ──
  const t0 = Date.now();
  const whole = await fetch(url('big.bin'), { headers: requestHeaders() });
  const wholeChecked = await verifyStream(whole.body, 0);
  const seconds = (Date.now() - t0) / 1000;
  console.log(`  full download: ${wholeChecked.length} bytes in ${seconds.toFixed(1)} s (${(wholeChecked.length / MiB / seconds).toFixed(1)} MiB/s)`);
  a.check(
    `a full GET streams all ${SIZE / MiB} MiB byte-exact, with its Content-Length`,
    whole.status === 200 && whole.headers.get('content-length') === String(SIZE)
      && wholeChecked.length === SIZE && wholeChecked.mismatch === null,
    `status=${whole.status} content-length=${whole.headers.get('content-length')} length=${wholeChecked.length} mismatch=${wholeChecked.mismatch}`,
  );

  // ── the session lived through it ──
  a.check('the terminal socket stayed open throughout', !t.closed, t.closeDetail ?? '');
  const alive = await t.run('echo session-alive-$((6*7))', 30_000);
  a.check('the same terminal still runs commands', alive.output.includes('session-alive-42'), alive.output.slice(-200));
  const again = await fetch(url('big.bin'), { headers: requestHeaders({ Range: 'bytes=0-3' }) });
  a.check('the server still answers afterwards', again.status === 206, `status=${again.status}`);
  await again.body?.cancel();
} catch (error) {
  a.check('probe completed', false, error instanceof Error ? error.stack : String(error));
} finally {
  measured.to = new Date().toISOString();
  console.log(`  window ${measured.from} → ${measured.to} sid=${sid}`);
  for (const owned of [pid, echoPid]) {
    if (owned > 0 && !t.closed) await t.run(`kill ${owned}`, 15_000).catch(() => {});
  }
  await t.close();
  await deleteSession(sid);
}

const summary = a.summary();
process.exit(summary.fail > 0 ? 1 : 0);
