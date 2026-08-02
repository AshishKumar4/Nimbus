#!/usr/bin/env bun
// behavioral/preview/node-post-request-body — a resident node server reads a
// real POST body, through the public /s/<sid>/port/<n>/ route.
//
// RED before the fix: every POST failed with "Method
// %TypedArray%.prototype.subarray called on incompatible receiver", because
// the facet's http dispatch decoded the body with request.text() and emitted
// that String where Node emits a Buffer. The server is written the way real
// servers are written — collect chunks, Buffer.concat, parse — so the probe
// fails exactly when a user's POST handler would.

import {
  fetchPort,
  heredocCommand,
  makeAsserter,
  mintSession,
  Terminal,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('preview/node-post-request-body');
console.log(`behavioral/preview/node-post-request-body — BASE=${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(20_000);

await t.run('mkdir -p /home/user/app && cd /home/user/app', 15_000);

const serverJs = `
const http = require('http');
const crypto = require('crypto');

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.url === '/echo-json') {
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('PARSE_FAIL ' + err.message);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, got: parsed, bytes: body.length }));
      return;
    }
    if (req.url === '/digest') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('bytes=' + body.length + ' sha256=' + crypto.createHash('sha256').update(body).digest('hex'));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('no route');
  });
});

server.listen(3000, '0.0.0.0', () => console.log('LISTENING 3000'));
`.trim();

await t.run(heredocCommand('server.js', serverJs), 15_000);

const started = await t.run('node server.js', 30_000);
const pid = Number(started.output.match(/pid=(\d+)/)?.[1] || 0);
a.check('node server.js returns a long-running pid', pid > 0, started.output.slice(-400));

async function pollPost(path, init, accept) {
  let last = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    last = await fetchPort(sid, 3000, path, init);
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return last;
}

// ── a small JSON POST, the single most common server shape ────────────────
{
  const payload = { name: 'nimbus', nested: { list: [1, 2, 3] }, unicode: 'héllo — ✅' };
  const raw = JSON.stringify(payload);
  const result = await pollPost('echo-json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw,
  }, (r) => r.status === 200 || r.status === 400);

  a.check(
    'POST /echo-json returns 200',
    result?.status === 200,
    `status=${result?.status} body=${String(result?.body).slice(0, 400)}`,
  );

  let decoded = null;
  try { decoded = JSON.parse(result.body); } catch { /* asserted below */ }
  a.check(
    'the handler parsed the exact JSON body it was posted',
    decoded?.ok === true && JSON.stringify(decoded.got) === JSON.stringify(payload),
    String(result?.body).slice(0, 400),
  );
  a.check(
    'Buffer.concat produced the byte length the client sent',
    decoded?.bytes === Buffer.byteLength(raw, 'utf8'),
    `server=${decoded?.bytes} client=${Buffer.byteLength(raw, 'utf8')}`,
  );
}

// ── a 64 KiB binary body: every byte value, no UTF-8 round trip ───────────
{
  const payload = new Uint8Array(64 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  const expected = new Bun.CryptoHasher('sha256').update(payload).digest('hex');

  const result = await pollPost('digest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: payload,
  }, (r) => r.status === 200);

  a.check(
    'POST of a 64 KiB binary body returns 200',
    result?.status === 200,
    `status=${result?.status} body=${String(result?.body).slice(0, 400)}`,
  );
  a.check(
    'the server received all 65536 bytes',
    /bytes=65536\b/.test(String(result?.body)),
    String(result?.body).slice(0, 200),
  );
  a.check(
    'the bytes arrived unmodified (sha256 matches the client payload)',
    String(result?.body).includes(`sha256=${expected}`),
    `expected sha256=${expected} got ${String(result?.body).slice(0, 200)}`,
  );
}

// ── a 16-byte body: the smallest case the original report reproduced ──────
{
  const payload = new Uint8Array(16);
  for (let i = 0; i < 16; i++) payload[i] = 0x80 + i;
  const expected = new Bun.CryptoHasher('sha256').update(payload).digest('hex');
  const result = await pollPost('digest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: payload,
  }, (r) => r.status === 200);
  a.check(
    'a 16-byte high-bit body round trips byte for byte',
    result?.status === 200 && String(result.body).includes(`bytes=16 sha256=${expected}`),
    `status=${result?.status} body=${String(result?.body).slice(0, 200)}`,
  );
}

if (pid > 0) {
  await t.run(`kill ${pid}`, 15_000);
}
await t.close();

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
