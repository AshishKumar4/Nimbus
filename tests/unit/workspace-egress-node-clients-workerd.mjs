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
//     JSON, a 404 and the fetch adapter give the same results;
//   - the ws package against an echo server (in the session the egress's
//     /ws-echo; on the host its twin, a ws server answering alike): the
//     subprotocol, text, binary and a 70000-byte message echoed, the
//     upgrade's own headers, a ping's pong, a server close and a client
//     close, and a refused upgrade, give the same transcript.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change. Needs the npm registry
// (the session installs the clients, through the egress, which passes it on;
// the host installs the same versions for its side).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
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
require('http').createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
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

/** axios against the echo server at `base`. */
const AXIOS = String.raw`
const axios = require('axios');
const base = process.argv[2];
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
  } catch (error) {
    out.failed = String(error && error.message);
  }
  console.log('AXIOS ' + JSON.stringify(out));
})();
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
async function hostSide() {
  const dir = mkdtempSync(join(tmpdir(), 'node-clients-'));
  const installed = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--prefix', dir, ...PACKAGES], { encoding: 'utf8', timeout: 300_000 });
  assert.equal(installed.status, 0, 'host npm install:\n' + installed.stderr.slice(-1200));
  const { WebSocketServer } = createRequire(join(dir, 'package.json'))('ws');
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => [...protocols][0] ?? false });
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws-refused') {
      const body = JSON.stringify({ error: 'unauthorized' });
      socket.end(`HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\nwww-authenticate: Bearer\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, isBinary) => {
        if (!isBinary && String(data) === 'headers') ws.send(JSON.stringify({ authorization: req.headers.authorization ?? null, origin: req.headers.origin ?? null }));
        else if (!isBinary && String(data) === 'close') ws.close(4001, 'bye');
        else ws.send(data, { binary: isBinary });
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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
    return new Promise((resolve) => child.stdout.on('data', (d) => { if (String(d).includes('LISTENING')) resolve(); }));
  };
  return {
    run,
    serve,
    echoBase: `ws://127.0.0.1:${server.address().port}`,
    close: () => {
      for (const child of children) child.kill();
      wss.close();
      server.close();
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
        const axios = [labelled((await terminal.run('cd /home/user/clients && node axios.js http://127.0.0.1:4555', 120_000)).stdout, 'AXIOS'),
          labelled((await host.run('axios.js', AXIOS, [`http://127.0.0.1:${hostPort}`])).stdout, 'AXIOS')];
        console.log('  axios: ' + JSON.stringify(axios[0]).slice(0, 300));
        assert.deepEqual(axios[0], axios[1], 'axios against a server of its own gives what host Node gives');

        const ws = [labelled((await terminal.run('cd /home/user/clients && node ws-echo.js wss://egress-test.invalid', 120_000)).stdout, 'WS'),
          labelled((await host.run('ws-echo.js', WS, [host.echoBase])).stdout, 'WS')];
        console.log('  ws: ' + JSON.stringify(ws[0]));
        assert.deepEqual(ws[0], ws[1], 'the ws package against an echo server gives the transcript host Node gives');
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
