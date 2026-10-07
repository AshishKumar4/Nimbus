// @serial
// A node program in a session whose workspace goes out through an egress
// (apps/probe's TestEgress, NIMBUS_TEST_EGRESS=1): every common HTTPS client
// reaches the egress, which alone answers egress-test.invalid: https.get,
// http.get, global fetch, axios (its http adapter, and its fetch adapter),
// node-fetch 3, undici (fetch and request), the `ws` package and the global
// WebSocket over wss, and the shell's curl. A TLS socket (tls.connect) is
// refused by name. (node-fetch 3's body reads empty in a child with or
// without an egress: its request is checked by its status, from a host only
// the egress answers.)
//
// And, against host Node (the same programs, the same package versions):
//   - the child's process is tagged as Node's: Object.prototype.toString
//     gives "[object process]" and the Symbol.toStringTag descriptor is
//     Node's (axios picks its http adapter by it);
//   - axios against an HTTP server in another process (in the session a
//     resident; on the host, a server of host Node's): GET with params, POST
//     JSON, a 404 and the fetch adapter give the same results; and against
//     gzip, br and deflate bodies (which axios decompresses through
//     stream.pipeline), from the egress in the session (an in-session hop
//     asks its target for identity, port-registry.ts) and from that server
//     on the host;
//   - the ws package against an echo server (in the session the egress's
//     /ws-echo; on the host its twin, a ws server answering alike): the
//     subprotocol, text, binary and a 70000-byte message echoed, the
//     upgrade's own headers, a ping's pong, a server close and a client
//     close, and a refused upgrade, give the same transcript;
//   - and at its edges: a refusal whose body is held open (short, or exactly
//     64 KiB) is reported at once, its body read as it comes; a text frame
//     or a close reason that is not UTF-8 closes the socket with 1007; an
//     upgrade request aborted before or while it handshakes (its signal, as
//     ws's own option too) fails with Node's AbortError, and a refusal that
//     arrives after the abort, its body held open, keeps nothing alive: the
//     process exits by itself, promptly.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change. Needs the npm registry
// (the session installs the clients, through the egress, which passes it on;
// the host installs the same versions for its side).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

/** The clients, at the same versions on both sides of the differentials. */
const PACKAGES = ['axios@1.20.0', 'node-fetch@3.3.2', 'undici@6.29.0', 'ws@8.22.0'];

const PROCESS_TAG = String.raw`
console.log('TAG ' + JSON.stringify([Object.prototype.toString.call(process), Object.getOwnPropertyDescriptor(process, Symbol.toStringTag)]));
`;

/** An HTTP server answering with what it was asked, on `port`: its own process, as a session's servers are. */
const ECHO_SERVER = (port) => String.raw`
const zlib = require('zlib');
require('http').createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const encoded = { '/encoded-gzip': ['gzip', zlib.gzipSync], '/encoded-br': ['br', zlib.brotliCompressSync], '/encoded-deflate': ['deflate', zlib.deflateSync] }[req.url];
    if (encoded) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoded[0] });
      res.end(encoded[1](JSON.stringify({ encoding: encoded[0], accepted: req.headers['accept-encoding'] || null })));
      return;
    }
    if (req.url.startsWith('/missing')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ missing: true }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-echo': 'yes' });
    res.end(JSON.stringify({ method: req.method, url: req.url, type: req.headers['content-type'] || null, body }));
  });
}).listen(${port}, () => console.log('LISTENING'));
`;

/** axios against the echo server at `base`, and encoded bodies from `encodedBase`. */
const AXIOS = String.raw`
const axios = require('axios');
const base = process.argv[2];
const encodedBase = process.argv[3];
(async () => {
  const out = {};
  try {
    const got = await axios.get(base + '/get', { params: { a: 1, b: 'x y' } });
    out.get = [got.status, got.headers['x-echo'], got.data];
    const posted = await axios.post(base + '/post', { hello: 'world' });
    out.post = [posted.status, posted.data];
    try { await axios.get(base + '/missing'); out.missing = 'resolved'; }
    catch (error) { out.missing = [error.response && error.response.status, error.response && error.response.data, error.message]; }
    const fetched = await axios.get(base + '/fetch-adapter', { adapter: 'fetch' });
    out.fetchAdapter = [fetched.status, fetched.data];
    for (const encoding of ['gzip', 'br', 'deflate']) out[encoding] = (await axios.get(encodedBase + '/encoded-' + encoding)).data;
  } catch (error) {
    out.failed = String(error && error.message);
  }
  console.log('AXIOS ' + JSON.stringify(out));
})();
`;

/** The upgrade's edges against the server at `base`, as a transcript; each case is bounded, a hang recorded. */
const WS_EDGES = String.raw`
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const base = process.argv[2];
const transcript = [];
const say = (line) => transcript.push(line);
/** A case: it calls done(), or 'timeout' is recorded after 6 s. */
const step = (name, run) => new Promise((resolve) => {
  const timer = setTimeout(() => { say(name + ' timeout'); resolve(); }, 6000);
  run(() => { clearTimeout(timer); resolve(); });
});
const UPGRADE = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' };
(async () => {
  await step('refused-open', (done) => {
    const ws = new WebSocket(base + '/ws-refused-open');
    ws.on('error', (e) => say('refused-open error ' + e.message));
    ws.on('close', (code) => { say('refused-open close ' + code); done(); });
  });
  await step('global-refused', (done) => {
    const ws = new globalThis.WebSocket(base + '/ws-refused-open');
    ws.onerror = () => { say('global-refused error'); done(); };
  });
  for (const path of ['/ws-refused-open', '/ws-refused-64k']) {
    await step('body ' + path, (done) => {
      const ws = new WebSocket(base + path);
      ws.on('unexpected-response', (req, res) => {
        let bytes = 0;
        say('body ' + path + ' status ' + res.statusCode);
        res.on('data', (d) => { bytes += d.length; });
        setTimeout(() => { say('body ' + path + ' read ' + bytes); req.destroy(); done(); }, 3000);
      });
      ws.on('error', () => {});
    });
  }
  await step('invalid-text', (done) => {
    const ws = new WebSocket(base + '/ws-echo');
    ws.on('open', () => ws.send(Buffer.from([0xff]), { binary: false }));
    ws.on('message', (data) => say('invalid-text echoed ' + JSON.stringify(String(data))));
    ws.on('close', (code, reason) => { say('invalid-text close ' + code + ' ' + JSON.stringify(String(reason))); done(); });
    ws.on('error', (e) => say('invalid-text error ' + e.message));
  });
  await step('invalid-reason', (done) => {
    const ws = new WebSocket(base + '/ws-echo');
    ws.on('open', () => ws.close(4000, Buffer.from([0xff])));
    ws.on('close', (code, reason) => { say('invalid-reason close ' + code + ' ' + JSON.stringify([...reason])); done(); });
    ws.on('error', (e) => say('invalid-reason error ' + e.message));
  });
  for (const when of ['before', 'during']) {
    await step('request ' + when, (done) => {
      const controller = new AbortController();
      if (when === 'before') controller.abort();
      const secure = base.startsWith('wss:');
      const req = (secure ? https : http).request(base.replace(/^ws/, 'http') + '/ws-slow', { headers: UPGRADE, signal: controller.signal });
      req.on('error', (e) => say('request ' + when + ' error ' + e.name + ' ' + e.code + ' ' + e.message));
      req.on('upgrade', () => say('request ' + when + ' upgrade'));
      req.on('close', () => { say('request ' + when + ' close'); done(); });
      req.end();
      if (when === 'during') setTimeout(() => controller.abort(), 200);
    });
    await step('ws ' + when, (done) => {
      const controller = new AbortController();
      if (when === 'before') controller.abort();
      const ws = new WebSocket(base + '/ws-slow', { signal: controller.signal });
      ws.on('open', () => say('ws ' + when + ' open'));
      ws.on('error', (e) => say('ws ' + when + ' error ' + e.name + ' ' + e.code + ' ' + e.message));
      ws.on('close', (code) => { say('ws ' + when + ' close ' + code); done(); });
      if (when === 'during') setTimeout(() => controller.abort(), 200);
    });
  }
  console.log('EDGES ' + JSON.stringify(transcript));
  process.exit(0);
})();
`;

/**
 * Requests aborted before a slow refusal arrives, its body then held open:
 * nothing of them holds the process, which exits by itself (no
 * process.exit), saying what it saw and how long it lived.
 */
const WS_ABORT_EXIT = String.raw`
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const base = process.argv[2];
const started = Date.now();
const transcript = [];
process.on('exit', () => {
  console.log('ELAPSED ' + (Date.now() - started));
  console.log('ABORTEXIT ' + JSON.stringify({ transcript, exitedWithin10s: Date.now() - started < 10000 }));
});
const controller = new AbortController();
const req = (base.startsWith('wss:') ? https : http).request(base.replace(/^ws/, 'http') + '/ws-refused-slow', {
  headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' },
  signal: controller.signal,
});
req.on('error', (e) => transcript.push('request error ' + e.name));
req.on('response', (res) => transcript.push('request response ' + res.statusCode));
req.on('close', () => transcript.push('request close'));
req.end();
const wsController = new AbortController();
const ws = new WebSocket(base + '/ws-refused-slow', { signal: wsController.signal });
ws.on('error', (e) => transcript.push('ws error ' + e.name));
ws.on('close', (code) => transcript.push('ws close ' + code));
setTimeout(() => { controller.abort(); wsController.abort(); }, 200);
`;

/** The ws package against the echo server at `base` (ws: or wss:), as a transcript. */
const WS = String.raw`
const WebSocket = require('ws');
const base = process.argv[2];
const transcript = [];
const say = (line) => transcript.push(line);
const echo = () => new Promise((resolve) => {
  const ws = new WebSocket(base + '/ws-echo', ['chat', 'superchat'], { headers: { Authorization: 'Bearer t' }, origin: 'https://app.example' });
  let step = 0;
  ws.on('open', () => { say('open ' + ws.protocol); ws.send('hello'); });
  ws.on('message', (data, isBinary) => {
    say(isBinary ? 'binary ' + [...data].join(',') : (data.length > 100 ? 'text length ' + data.length : 'text ' + String(data)));
    step++;
    if (step === 1) ws.send(Buffer.from([1, 2, 3]));
    else if (step === 2) ws.send('x'.repeat(70000));
    else if (step === 3) ws.send('headers');
    else if (step === 4) ws.ping('p');
  });
  ws.on('pong', (data) => { say('pong ' + String(data)); ws.send('close'); });
  ws.on('close', (code, reason) => { say('close ' + code + ' ' + String(reason)); resolve(); });
  ws.on('error', (error) => say('error ' + error.message));
});
const clientClose = () => new Promise((resolve) => {
  const ws = new WebSocket(base + '/ws-echo');
  ws.on('open', () => ws.close(4000, 'done'));
  ws.on('close', (code, reason) => { say('client close ' + code + ' ' + String(reason)); resolve(); });
  ws.on('error', (error) => say('error ' + error.message));
});
const refused = () => new Promise((resolve) => {
  const ws = new WebSocket(base + '/ws-refused');
  ws.on('error', (error) => say('refused ' + error.message));
  ws.on('close', (code) => { say('refused close ' + code); resolve(); });
});
(async () => {
  await echo();
  await clientClose();
  await refused();
  console.log('WS ' + JSON.stringify(transcript));
})();
`;

const CLIENTS = String.raw`
const results = {};
const t = async (name, run) => {
  try { results[name] = String(await run()).trim().slice(0, 120); }
  catch (error) { results[name] = 'FAILED ' + (error && (error.code || '')) + ' ' + String(error && error.message).slice(0, 160); }
};
const host = 'egress-test.invalid';
const get = (mod, url) => new Promise((resolve, reject) => {
  mod.get(url, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve(body)); }).on('error', reject);
});
(async () => {
  await t('https.get', () => get(require('https'), 'https://' + host + '/https-get'));
  await t('http.get', () => get(require('http'), 'http://' + host + '/http-get'));
  await t('fetch', async () => (await fetch('https://' + host + '/fetch')).text());
  await t('axios', async () => (await require('axios').get('https://' + host + '/axios')).data);
  await t('axios.fetch', async () => (await require('axios').get('https://' + host + '/axios-fetch', { adapter: 'fetch' })).data);
  await t('node-fetch', async () => {
    const res = await (await import('node-fetch')).default('https://' + host + '/node-fetch');
    return res.status + ' ' + res.headers.get('x-nimbus-test-egress');
  });
  await t('ws', () => new Promise((resolve, reject) => {
    const ws = new (require('ws'))('wss://' + host + '/ws-package');
    ws.on('open', () => ws.send('hi'));
    ws.on('message', (data) => { resolve(String(data)); ws.close(); });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws timeout')), 20000);
  }));
  await t('undici.fetch', async () => (await require('undici').fetch('https://' + host + '/undici-fetch')).text());
  await t('undici.request', async () => (await require('undici').request('https://' + host + '/undici-request')).body.text());
  await t('WebSocket', () => new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://' + host + '/ws');
    ws.addEventListener('open', () => ws.send('hi'));
    ws.addEventListener('message', (event) => { resolve(String(event.data)); ws.close(); });
    ws.addEventListener('error', () => reject(new Error('websocket error')));
    setTimeout(() => reject(new Error('websocket timeout')), 20000);
  }));
  await t('tls.connect', () => new Promise((resolve, reject) => {
    const socket = require('tls').connect(443, host, { servername: host }, () => { resolve('connected'); socket.destroy(); });
    socket.on('error', reject);
    setTimeout(() => reject(new Error('tls timeout')), 20000);
  }));
  console.log('RESULTS ' + JSON.stringify(results));
})();
`;

/** Host Node's side: the clients installed at PACKAGES, and an echo server answering as the egress's /ws-echo does. */
/** The echo server the egress's /ws-* routes answer as, for host Node: a ws server in a Node process of its own, on `port`. */
const WS_TWIN = (port) => String.raw`
const http = require('http');
const { WebSocketServer } = require('ws');
const CRLF = '\r\n';
const server = http.createServer();
const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => [...protocols][0] ?? false });
const echo = (req) => (ws) => {
  // A frame that is not UTF-8 fails the connection (1007); ws reports it here too.
  ws.on('error', () => {});
  ws.on('message', (data, isBinary) => {
    if (!isBinary && String(data) === 'headers') ws.send(JSON.stringify({ authorization: req.headers.authorization ?? null, origin: req.headers.origin ?? null }));
    else if (!isBinary && String(data) === 'close') ws.close(4001, 'bye');
    else ws.send(data, { binary: isBinary });
  });
};
server.on('upgrade', (req, socket, head) => {
  // A client that gives up on a refusal resets its connection.
  socket.on('error', () => {});
  // A refusal whose body is sent and then held open, as the egress's (after 2 s at /ws-refused-slow).
  if (req.url === '/ws-refused-open' || req.url === '/ws-refused-64k' || req.url === '/ws-refused-slow') {
    setTimeout(() => {
      if (socket.destroyed) return;
      socket.write(['HTTP/1.1 401 Unauthorized', 'content-type: text/plain', '', ''].join(CRLF));
      socket.write(req.url === '/ws-refused-64k' ? Buffer.alloc(65536, 97) : 'partial');
    }, req.url === '/ws-refused-slow' ? 2000 : 0);
    return;
  }
  if (req.url === '/ws-refused') {
    const body = JSON.stringify({ error: 'unauthorized' });
    socket.end(['HTTP/1.1 401 Unauthorized', 'content-type: application/json', 'www-authenticate: Bearer',
      'content-length: ' + body.length, 'connection: close', '', body].join(CRLF));
    return;
  }
  const delay = req.url === '/ws-slow' ? 2000 : 0;
  setTimeout(() => wss.handleUpgrade(req, socket, head, echo(req)), delay);
});
server.listen(${port}, '127.0.0.1', () => console.log('LISTENING'));
`;

/** Host Node's side: the clients installed at PACKAGES, and an echo server answering as the egress's /ws-* routes do. */
async function hostSide() {
  const dir = mkdtempSync(join(tmpdir(), 'node-clients-'));
  const installed = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--prefix', dir, ...PACKAGES], { encoding: 'utf8', timeout: 300_000 });
  assert.equal(installed.status, 0, 'host npm install:\n' + installed.stderr.slice(-1200));
  /** `source` under host Node, from the clients' directory, with `args`. */
  const children = [];
  const run = (name, source, args = []) => {
    writeFileSync(join(dir, name), source);
    return new Promise((resolve, reject) => {
      const child = spawn('node', [join(dir, name), ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => child.kill(), 60_000);
      child.on('error', reject);
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
  };
  /** `source` under host Node as a server: resolved once it prints LISTENING. */
  const serve = (name, source) => {
    writeFileSync(join(dir, name), source);
    const child = spawn('node', [join(dir, name)], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    return new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => { if (String(d).includes('LISTENING')) resolve(); });
      child.on('exit', (code) => reject(new Error(`${name} exited ${code} before it listened`)));
    });
  };
  const wsPort = await freePort();
  await serve('ws-twin.js', WS_TWIN(wsPort));
  return {
    run,
    serve,
    echoBase: `ws://127.0.0.1:${wsPort}`,
    close: () => {
      for (const child of children) child.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A port free on this host now. */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

/** The line of `output` that starts with `label `, parsed. */
function labelled(output, label) {
  const line = output.split('\n').find((l) => l.startsWith(label + ' '));
  assert.ok(line, `no ${label} line:\n${output.slice(-1500)}`);
  return JSON.parse(line.slice(label.length + 1));
}

const egressed = process.env.NIMBUS_TEST_EGRESS ?? '1';
console.log(`workspace-egress-node-clients-workerd: starting local workerd (NIMBUS_TEST_EGRESS=${egressed})`);
const probe = await startLocalProbe({ runtimes: [], vars: { NIMBUS_TEST_EGRESS: egressed } });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const setup = await terminal.run(`mkdir -p /home/user/clients && cd /home/user/clients && npm init -y >/dev/null && npm install ${PACKAGES.join(' ')}`, 600_000);
    assert.equal(setup.status, 0, 'npm install through the egress:\n' + setup.stdout.slice(-1200));

    const curl = await terminal.run('curl -s https://egress-test.invalid/curl');
    assert.match(curl.stdout, /via-egress GET \/curl/, 'curl did not reach the egress:\n' + curl.stdout);

    const b64 = Buffer.from(CLIENTS).toString('base64');
    const w = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/clients/clients.js', Buffer.from('${b64}', 'base64'))"`);
    assert.equal(w.status, 0, w.stdout);
    const run = await terminal.run('cd /home/user/clients && node clients.js', 180_000);
    const line = run.stdout.split('\n').find((l) => l.startsWith('RESULTS '));
    assert.ok(line, 'no results:\n' + run.stdout.slice(-1500));
    const results = JSON.parse(line.slice('RESULTS '.length));
    for (const [name, value] of Object.entries(results)) console.log(`  ${name}: ${value}`);

    const expected = {
      'https.get': /^via-egress GET \/https-get$/,
      'http.get': /^via-egress GET \/http-get$/,
      fetch: /^via-egress GET \/fetch$/,
      axios: /^via-egress GET \/axios$/,
      'axios.fetch': /^via-egress GET \/axios-fetch$/,
      // A 200 from a host only the egress answers (its headers and body read empty in a child either way).
      'node-fetch': /^200 /,
      ws: /^via-egress:hi$/,
      'undici.fetch': /^via-egress GET \/undici-fetch$/,
      'undici.request': /^via-egress GET \/undici-request$/,
      WebSocket: /^via-egress:hi$/,
      'tls.connect': /^FAILED ERR_NIMBUS_EGRESS_TLS Nimbus: TLS sockets are not available when the workspace's network goes through an egress/,
    };
    for (const [name, pattern] of Object.entries(expected)) assert.match(results[name] ?? '(missing)', pattern, name);

    // ── The differentials, against host Node ────────────────────────────────
    if (egressed === '1') {
      const host = await hostSide();
      try {
        for (const [name, source] of [['tag.js', PROCESS_TAG], ['echo-server.js', ECHO_SERVER(4555)], ['axios.js', AXIOS], ['ws-echo.js', WS]]) {
          const encoded = Buffer.from(source).toString('base64');
          const wrote = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/clients/${name}', Buffer.from('${encoded}', 'base64'))"`);
          assert.equal(wrote.status, 0, wrote.stdout);
        }
        const tag = [labelled((await terminal.run('cd /home/user/clients && node tag.js')).stdout, 'TAG'),
          labelled((await host.run('tag.js', PROCESS_TAG)).stdout, 'TAG')];
        console.log('  process tag: ' + JSON.stringify(tag[0]));
        assert.deepEqual(tag[0], tag[1], "the child's process is tagged as host Node's");
        assert.equal(tag[0][0], '[object process]');

        // The server is a resident of the session; its launch returns to the prompt.
        const served = await terminal.run('cd /home/user/clients && node echo-server.js', 120_000);
        assert.equal(served.status, 0, served.stdout);
        let ready = '';
        for (let i = 0; i < 60 && ready !== '200'; i++) {
          ready = (await terminal.run('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4555/ready')).stdout.trim();
          if (ready !== '200') await Bun.sleep(250);
        }
        assert.equal(ready, '200', 'the echo server serves in the session');
        const hostPort = await freePort();
        await host.serve('echo-server.js', ECHO_SERVER(hostPort));
        const axios = [labelled((await terminal.run('cd /home/user/clients && node axios.js http://127.0.0.1:4555 https://egress-test.invalid', 120_000)).stdout, 'AXIOS'),
          labelled((await host.run('axios.js', AXIOS, [`http://127.0.0.1:${hostPort}`, `http://127.0.0.1:${hostPort}`])).stdout, 'AXIOS')];
        console.log('  axios: ' + JSON.stringify(axios[0]).slice(0, 300));
        assert.deepEqual(axios[0], axios[1], 'axios against a server of its own gives what host Node gives');

        const ws = [labelled((await terminal.run('cd /home/user/clients && node ws-echo.js wss://egress-test.invalid', 120_000)).stdout, 'WS'),
          labelled((await host.run('ws-echo.js', WS, [host.echoBase])).stdout, 'WS')];
        console.log('  ws: ' + JSON.stringify(ws[0]));
        assert.deepEqual(ws[0], ws[1], 'the ws package against an echo server gives the transcript host Node gives');

        const edgesSource = Buffer.from(WS_EDGES).toString('base64');
        const wroteEdges = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/clients/ws-edges.js', Buffer.from('${edgesSource}', 'base64'))"`);
        assert.equal(wroteEdges.status, 0, wroteEdges.stdout);
        const edges = [labelled((await terminal.run('cd /home/user/clients && node ws-edges.js wss://egress-test.invalid', 180_000)).stdout, 'EDGES'),
          labelled((await host.run('ws-edges.js', WS_EDGES, [host.echoBase])).stdout, 'EDGES')];
        console.log('  ws edges: ' + JSON.stringify(edges[0]));
        assert.deepEqual(edges[0], edges[1], "the upgrade's edges give the transcript host Node gives");

        const abortSource = Buffer.from(WS_ABORT_EXIT).toString('base64');
        const wroteAbort = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/clients/ws-abort-exit.js', Buffer.from('${abortSource}', 'base64'))"`);
        assert.equal(wroteAbort.status, 0, wroteAbort.stdout);
        const ranAt = Date.now();
        const sessionExit = await terminal.run('cd /home/user/clients && node ws-abort-exit.js wss://egress-test.invalid', 120_000);
        console.log(`  ws abort, then a slow refusal: the session's process lived ${/^ELAPSED (\d+)/m.exec(sessionExit.stdout)?.[1]} ms (its run ${Date.now() - ranAt} ms)`);
        const exits = [labelled(sessionExit.stdout, 'ABORTEXIT'), labelled((await host.run('ws-abort-exit.js', WS_ABORT_EXIT, [host.echoBase])).stdout, 'ABORTEXIT')];
        console.log('  ws abort, then a slow refusal: ' + JSON.stringify(exits[0]));
        assert.deepEqual(exits[0], exits[1], 'an aborted upgrade holds nothing once its refusal arrives: the process exits as host Node\'s does');
      } finally {
        host.close();
      }
    }
  } finally {
    await terminal.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - workspace-egress-node-clients-workerd (every common HTTPS client, axios and ws included, goes out through the egress; a TLS socket is refused by name; process tag, axios and ws as host Node)');
