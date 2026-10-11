#!/usr/bin/env bun
// A process's HTTP request to a server of its own, as one program under Node and under Nimbus, and held to the
// route every other process's request takes: the port route. A request the process answers itself must see what
// that route would show it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintSession, deleteSession, connectProcessTerminal, Terminal, heredocCommand } from '../_driver.mjs';

/**
 * The routes every server of this test runs: the program's own, and the two processes it is compared with.
 * `/slow` is a stream's source, which ends only once the client says go and has replaced a file; `/proxy` pipes
 * that stream on from `upstream` without reading it. Answers whether the request was one of them.
 */
function sharedRoutes(http, fs, { dir, upstream }) {
  const go = dir + '/go';
  const file = dir + '/shared.txt';
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/ready') { response.end('ready'); return true; }
    if (url.pathname === '/app') { response.end('app:' + request.method + ' ' + request.url); return true; }
    if (url.pathname === '/slow') {
      response.writeHead(200); response.flushHeaders(); response.write('head');
      const until = Date.now() + 30_000;
      for (;;) {
        try { await fs.promises.stat(go); break; }
        catch (error) { if (error.code !== 'ENOENT' || Date.now() > until) throw error; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await fs.promises.writeFile(file, 'after-' + url.searchParams.get('id'));
      response.end('tail');
      return true;
    }
    if (url.pathname === '/proxy') {
      http.get(upstream + '/slow?id=' + url.searchParams.get('id'), from => from.pipe(response))
        .on('error', error => response.destroy(error));
      return true;
    }
    return false;
  };
}

async function exercise({ dir, sourceUrl, proxyUrl, upgrade }) {
  const http = require('node:http');
  const fs = require('node:fs');
  const { spawn } = require('node:child_process');
  const file = dir + '/shared.txt';
  const go = dir + '/go';
  const deferred = () => Promise.withResolvers();
  const streamEnd = deferred();
  let phase = 'idle';
  const closed = child => new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('writer exit ' + code)));
  });
  const shared = sharedRoutes(http, fs, { dir, upstream: sourceUrl });
  const server = http.createServer(async (request, response) => {
    if (await shared(request, response)) return;
    if (request.url === '/pipe') { request.pipe(response); return; }
    if (request.url === '/stream') {
      response.writeHead(200); response.flushHeaders(); response.write('first');
      await streamEnd.promise;
      response.end('second'); return;
    }
    if (request.url === '/cancel') {
      response.writeHead(200); response.flushHeaders(); response.write('first'); return;
    }
    if (request.url === '/empty') { response.statusCode = 204; response.end('ignored'); return; }
    if (request.url === '/write') {
      const before = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, 'server');
      response.end(before); return;
    }
    if (request.url === '/peer-write') {
      // The request has begun; a different process writes before the handler's
      // synchronous read. Its exit delivery refreshes this one shared view.
      const child = spawn('node', ['-e', 'require("node:fs").writeFileSync(' + JSON.stringify(file) + ', "peer-v2")']);
      await closed(child);
      response.end(fs.readFileSync(file, 'utf8')); return;
    }
    const enteredPhase = phase;
    const parts = [];
    let buffers = true;
    for await (const part of request) { buffers &&= Buffer.isBuffer(part); parts.push(part); }
    response.writeHead(201, 'Created', { 'x-native': 'yes', 'set-cookie': ['a=1', 'b=2'] });
    response.end(JSON.stringify({
      method: request.method, url: request.url, phase,
      admittedAfterReturn: !enteredPhase.endsWith('-call'),
      native: request instanceof http.IncomingMessage && response instanceof http.ServerResponse,
      buffers, bytes: Array.from(Buffer.concat(parts)),
      headers: ['if-modified-since', 'user-agent', 'content-type'].map(name => [name, request.headers[name]]),
    }));
  });
  const listen = new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '0.0.0.0', resolve);
  });
  try {
    await listen;
    const url = 'http://localhost:' + server.address().port;
    const ready = async (base, body) => {
      const until = Date.now() + 30_000;
      let last = '';
      for (;;) {
        try {
          const reply = await fetch(base + '/ready');
          last = reply.status + ':' + await reply.text();
          if (last === '200:' + body) return;
        } catch (error) { if (Date.now() >= until) throw error; }
        if (Date.now() >= until) throw new Error('port did not become ready: ' + last);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    await ready(url, 'ready');
    const headers = {
      'if-modified-since': 'Tue, 29 Sep 2026 10:00:00 GMT',
      'user-agent': 'Mozilla/5.0 (KHTML, like Gecko)',
      'content-type': 'application/octet-stream',
    };
    const bytes = new Uint8Array([0, 128, 255, 13, 10, 195, 169]);
    phase = 'http-call';
    const viaHttp = await new Promise((resolve, reject) => {
      const request = http.request(url + '/echo?x=%2F', { method: 'POST', headers }, response => {
        const parts = [];
        response.on('data', part => parts.push(part));
        response.on('error', reject);
        response.on('end', () => resolve({
          native: request instanceof http.ClientRequest && response instanceof http.IncomingMessage,
          status: response.statusCode, reason: response.statusMessage,
          header: response.headers['x-native'], cookies: response.headers['set-cookie'],
          body: JSON.parse(Buffer.concat(parts).toString()),
        }));
      });
      request.on('error', reject);
      request.on('finish', () => { phase = 'http-finished'; });
      request.write(bytes.subarray(0, 3)); request.end(bytes.subarray(3));
      phase = 'http-returned';
    });
    phase = 'fetch-call';
    const pending = fetch(url + '/echo?x=%2F', { method: 'POST', headers, body: bytes });
    phase = 'fetch-returned';
    const reply = await pending;
    const viaFetch = { status: reply.status, reason: reply.statusText, header: reply.headers.get('x-native'), cookies: reply.headers.getSetCookie(), body: await reply.json() };
    const piped = await new Promise((resolve, reject) => {
      const request = http.request(url + '/pipe', { method: 'POST' }, response => {
        let length = 0, sum = 0;
        response.on('data', part => { length += part.length; for (const byte of part) sum += byte; });
        response.on('error', reject); response.on('end', () => resolve([length, sum]));
      });
      request.on('error', reject);
      const chunk = Buffer.alloc(128 * 1024, 42);
      // Respect native writable backpressure, and exercise the pipe's drain.
      if (request.write(chunk)) request.end(chunk);
      else request.once('drain', () => request.end(chunk));
    });
    const streaming = await fetch(url + '/stream');
    const reader = streaming.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    streamEnd.resolve();
    let rest = '';
    for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
    const cancellation = await new Promise((resolve, reject) => {
      const request = http.get(url + '/cancel', response => {
        let body = '', aborted = false, code = null;
        response.on('aborted', () => { aborted = true; });
        response.on('error', error => { code = error.code; });
        response.on('data', part => { body += part; request.destroy(); });
        response.on('close', () => resolve({ body, aborted, code }));
      });
      request.on('error', reject);
    });
    const head = await fetch(url + '/echo', { method: 'HEAD', headers });
    const empty = await fetch(url + '/empty');
    fs.writeFileSync(file, 'client');
    const seenClient = await (await fetch(url + '/write')).text();
    const seenServer = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, 'peer-v1');
    const seenPeer = await (await fetch(url + '/peer-write')).text();
    const seenPeerAtClient = fs.readFileSync(file, 'utf8');

    if (!sourceUrl || !proxyUrl) throw new Error('two separately launched serving processes are required');
    await ready(sourceUrl, 'ready');
    await ready(proxyUrl, 'ready');
    const crossFetch = await (await fetch(sourceUrl + '/fetch')).text();

    // A stream that comes from another process through a server: the client has the headers, says go, and reads
    // the tail the source wrote only after replacing a file. Having read it, the client's next read of that file
    // is owed the replacement: Node has it from the file system, the port route from the ACQUIRE after the body.
    // The proxy is a process of its own (reached by the port route) or this very one.
    let id = 0;
    const proxied = async (base) => {
      id += 1;
      await fs.promises.rm(go, { force: true });
      await fs.promises.writeFile(file, 'before-' + id);
      const answer = await fetch(base + '/proxy?id=' + id);
      await fs.promises.writeFile(go, String(id));
      const body = await answer.text();
      return [answer.status, body, fs.readFileSync(file, 'utf8')];
    };
    const proxy = { portRoute: await proxied(proxyUrl), own: await proxied(url) };

    // However an Upgrade header is spelled, the process's own server answers as the port route does. A node server
    // answers both of the route's entrypoints alike, so what is compared is the answer; which entrypoint a spelling
    // takes is held where the two are told apart (tests/unit/node-shims-own-http.mjs). Node, which serves any such
    // request as an ordinary one, is left out.
    let upgraded;
    if (upgrade) {
      const asked = async (base, value) => {
        const answer = await fetch(base + '/app', value === undefined ? {} : { headers: { upgrade: value } });
        return [answer.status, (await answer.text()).replace(/\d{4,5}/g, 'PORT')];
      };
      upgraded = {};
      for (const value of [undefined, 'websocket', 'WebSocket', ' websocket ', '\twebsocket\t', 'websocket, h2c']) {
        upgraded[JSON.stringify(value) ?? 'none'] = { own: await asked(url, value), portRoute: await asked(proxyUrl, value) };
      }
    }
    const crossHttp = await new Promise((resolve, reject) => {
      const request = http.get(sourceUrl + '/http', response => {
        let body = ''; response.on('data', part => { body += part; });
        response.on('end', () => resolve(body)); response.on('error', reject);
      });
      request.on('error', reject);
    });
    // After a body was piped through, and read raw: its own requests are still answered as Node answers them.
    const afterwards = await fetch(url + '/app');
    const answeredAfterwards = [afterwards.status, await afterwards.text()];
    let invalidHeader;
    try { http.request(url, { headers: { 'x-invalid': 'bad\nvalue' } }); }
    catch (error) { invalidHeader = error.code; }
    return { viaHttp, viaFetch, piped, streaming: [first, rest], cancellation,
      head: [head.status, await head.text()], empty: [empty.status, await empty.text()],
      coherence: [seenClient, seenServer, seenPeer, seenPeerAtClient], crossPid: [crossFetch, crossHttp],
      proxy, answeredAfterwards, invalidHeader, upgraded };
  } finally {
    streamEnd.resolve();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

const program = `${sharedRoutes}
(${exercise})({ dir: process.env.OWN_HTTP_DIR, sourceUrl: process.env.OWN_HTTP_SOURCE, proxyUrl: process.env.OWN_HTTP_PROXY, upgrade: process.env.OWN_HTTP_UPGRADE === '1' })
  .then(result => console.log('OWN_HTTP_DIFFERENTIAL ' + JSON.stringify(result)))
  .catch(error => { console.error('OWN_HTTP_DIFFERENTIAL_ERROR ' + error.stack); process.exit(1); });`;
const peerProgram = `${sharedRoutes}
const http = require('node:http');
const routes = sharedRoutes(http, require('node:fs'), { dir: process.env.OWN_HTTP_DIR, upstream: process.env.OWN_HTTP_UPSTREAM });
const server = http.createServer(async (request, response) => { if (!await routes(request, response)) response.end('peer'); });
server.listen(0, '0.0.0.0', () => console.log('PEER_PORT=' + server.address().port));`;

/** A serving process on this machine, and where it listens. */
async function hostPeer(env) {
  const child = spawn('node', ['-e', peerProgram], { env: { ...process.env, ...env } });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    child.on('error', reject);
    child.stdout.on('data', part => { output += part; const match = /PEER_PORT=(\d+)/.exec(output); if (match) resolve(Number(match[1])); });
    child.once('exit', code => reject(new Error('host peer exited before listen: ' + code)));
  });
  return { port, stop: async () => { const done = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await done; } };
}

const hostDir = mkdtempSync(join(tmpdir(), 'own-http-'));
const hostPeers = [];
let node;
try {
  const source = await hostPeer({ OWN_HTTP_DIR: hostDir });
  hostPeers.push(source);
  const proxy = await hostPeer({ OWN_HTTP_DIR: hostDir, OWN_HTTP_UPSTREAM: 'http://localhost:' + source.port });
  hostPeers.push(proxy);
  node = spawnSync('node', ['-e', program], { encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, OWN_HTTP_DIR: hostDir, OWN_HTTP_SOURCE: 'http://localhost:' + source.port, OWN_HTTP_PROXY: 'http://localhost:' + proxy.port } });
} finally {
  for (const peer of hostPeers) await peer.stop();
  rmSync(hostDir, { recursive: true, force: true });
}
assert.equal(node.status, 0, node.stderr);
const expected = JSON.parse(node.stdout.split('OWN_HTTP_DIFFERENTIAL ')[1]);
assert.deepEqual(expected.coherence, ['client', 'server', 'peer-v2', 'peer-v2']);
assert.deepEqual(expected.crossPid, ['peer', 'peer']);
assert.deepEqual(expected.streaming, ['first', 'second']);
assert.deepEqual(expected.piped, [262144, 11010048]);
assert.deepEqual(expected.cancellation, { body: 'first', aborted: true, code: 'ECONNRESET' });
assert.deepEqual(expected.proxy, { portRoute: [200, 'headtail', 'after-1'], own: [200, 'headtail', 'after-2'] });
assert.deepEqual(expected.answeredAfterwards, [200, 'app:GET /app']);
console.log('HOST_NODE ' + JSON.stringify(expected));

const sid = await mintSession();
const terminal = new Terminal(sid);
/** A serving process of the session: the shared program, run with `env`, and the port it printed. */
async function sessionPeer(name, env) {
  const started = await terminal.run(`${env} node /home/user/${name}.js`, 60_000);
  let output = started.output;
  if (!/PEER_PORT=\d+/.test(output)) {
    const pid = Number(output.match(/(?:long-running\): |started[^\n]*?)pid=(\d+)/)?.[1] ?? 0);
    assert.ok(pid, output);
    const peerTerminal = await connectProcessTerminal(sid, pid);
    await peerTerminal.waitFor(text => /PEER_PORT=\d+/.test(text), 30_000, `${name} listener`);
    output += '\n' + peerTerminal.output; peerTerminal.ws.close();
  }
  return Number(output.match(/PEER_PORT=(\d+)/)[1]);
}
try {
  await terminal.connect(); await terminal.waitForPrompt(30_000);
  const dir = '/tmp/own-http-' + Date.now().toString(36);
  await terminal.run('mkdir -p ' + dir, 30_000);
  await terminal.run(heredocCommand('/home/user/own-http-peer.js', peerProgram), 30_000);
  const sourcePort = await sessionPeer('own-http-peer', `OWN_HTTP_DIR=${dir}`);
  const proxyPort = await sessionPeer('own-http-peer', `OWN_HTTP_DIR=${dir} OWN_HTTP_UPSTREAM=http://localhost:${sourcePort}`);
  await terminal.run(heredocCommand('/home/user/own-http.js', program), 30_000);
  const started = await terminal.run(
    `OWN_HTTP_DIR=${dir} OWN_HTTP_SOURCE=http://localhost:${sourcePort} OWN_HTTP_PROXY=http://localhost:${proxyPort} OWN_HTTP_UPGRADE=1 node /home/user/own-http.js`,
    120_000);
  let output = started.output;
  const pid = Number(output.match(/(?:long-running\): |started[^\n]*?)pid=(\d+)/)?.[1] ?? 0);
  if (!output.includes('OWN_HTTP_DIFFERENTIAL ') && pid > 0) {
    const processTerminal = await connectProcessTerminal(sid, pid);
    await processTerminal.waitFor(text => /OWN_HTTP_DIFFERENTIAL(?: |_ERROR )/.test(text), 180_000, 'own HTTP differential');
    output += '\n' + processTerminal.output; processTerminal.ws.close();
  }
  const actualLine = output.match(/OWN_HTTP_DIFFERENTIAL ([^\r\n]+)/)?.[1];
  assert.ok(actualLine, output);
  const { upgraded, ...actual } = JSON.parse(actualLine);
  console.log('NIMBUS ' + JSON.stringify({ ...actual, upgraded }));
  assert.equal(actual.viaHttp.body.admittedAfterReturn, true);
  assert.equal(actual.viaFetch.body.admittedAfterReturn, true);
  const { upgraded: _nodeUpgraded, ...nodeExpected } = expected;
  assert.deepEqual(actual, nodeExpected,
    'the common HTTP contract, shared-view coherence, a stream proxied through and cross-pid routing match Node');
  // The port route's answer is the one the process's own server is held to, for every spelling.
  assert.deepEqual(upgraded.none.own, [200, 'app:GET /app']);
  for (const [spelling, answers] of Object.entries(upgraded)) {
    assert.deepEqual(answers.own, answers.portRoute, `Upgrade: ${spelling} is answered as the port route answers it`);
  }
} finally {
  await terminal.close(); assert.ok((await deleteSession(sid)).ok, 'differential session deleted');
}
