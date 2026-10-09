#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mintSession, deleteSession, connectProcessTerminal, Terminal, heredocCommand } from '../_driver.mjs';

async function exercise(peerUrl) {
  const http = require('node:http');
  const fs = require('node:fs');
  const { spawn } = require('node:child_process');
  const work = fs.mkdtempSync('/tmp/own-http-');
  const file = work + '/shared.txt';
  const deferred = () => Promise.withResolvers();
  const streamEnd = deferred();
  let phase = 'idle';
  const closed = child => new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('writer exit ' + code)));
  });
  const server = http.createServer(async (request, response) => {
    if (request.url === '/ready') { response.end('ready'); return; }
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
      method: request.method, url: request.url, phase: enteredPhase,
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

    if (!peerUrl) throw new Error('a separately launched serving process is required');
    await ready(peerUrl, 'peer');
    const crossFetch = await (await fetch(peerUrl + '/fetch')).text();
    const crossHttp = await new Promise((resolve, reject) => {
      const request = http.get(peerUrl + '/http', response => {
        let body = ''; response.on('data', part => { body += part; });
        response.on('end', () => resolve(body)); response.on('error', reject);
      });
      request.on('error', reject);
    });
    let invalidHeader;
    try { http.request(url, { headers: { 'x-invalid': 'bad\nvalue' } }); }
    catch (error) { invalidHeader = error.code; }
    return { viaHttp, viaFetch, piped, streaming: [first, rest], cancellation,
      head: [head.status, await head.text()], empty: [empty.status, await empty.text()],
      coherence: [seenClient, seenServer, seenPeer, seenPeerAtClient], crossPid: [crossFetch, crossHttp], invalidHeader };
  } finally {
    streamEnd.resolve();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const program = `(${exercise.toString()})(process.env.OWN_HTTP_PEER_URL).then(result => console.log('OWN_HTTP_DIFFERENTIAL ' + JSON.stringify(result))).catch(error => { console.error('OWN_HTTP_DIFFERENTIAL_ERROR ' + error.stack); process.exit(1); });`;
const peerProgram = 'const h=require("node:http");const s=h.createServer((q,r)=>r.end("peer"));s.listen(0,"0.0.0.0",()=>console.log("PEER_PORT="+s.address().port));';
const hostPeer = spawn('node', ['-e', peerProgram]);
let node;
try {
  const port = await new Promise((resolve, reject) => {
    let output = '';
    hostPeer.on('error', reject);
    hostPeer.stdout.on('data', part => { output += part; const match = /PEER_PORT=(\d+)/.exec(output); if (match) resolve(Number(match[1])); });
    hostPeer.once('exit', code => reject(new Error('host peer exited before listen: ' + code)));
  });
  node = spawnSync('node', ['-e', program], { encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, OWN_HTTP_PEER_URL: 'http://localhost:' + port } });
} finally {
  const done = new Promise(resolve => hostPeer.once('close', resolve));
  hostPeer.kill('SIGTERM'); await done;
}
assert.equal(node.status, 0, node.stderr);
const expected = JSON.parse(node.stdout.split('OWN_HTTP_DIFFERENTIAL ')[1]);
assert.deepEqual(expected.coherence, ['client', 'server', 'peer-v2', 'peer-v2']);
assert.deepEqual(expected.crossPid, ['peer', 'peer']);
assert.deepEqual(expected.streaming, ['first', 'second']);
assert.deepEqual(expected.piped, [262144, 11010048]);
assert.deepEqual(expected.cancellation, { body: 'first', aborted: true, code: 'ECONNRESET' });
console.log('HOST_NODE ' + JSON.stringify(expected));
const sid = await mintSession();
const terminal = new Terminal(sid);
try {
  await terminal.connect(); await terminal.waitForPrompt(30_000);
  await terminal.run(heredocCommand('/home/user/own-http-peer.js', peerProgram), 30_000);
  const peerStarted = await terminal.run('node /home/user/own-http-peer.js', 60_000);
  let peerOutput = peerStarted.output;
  if (!/PEER_PORT=\d+/.test(peerOutput)) {
    const peerPid = Number(peerOutput.match(/(?:long-running\): |started[^\n]*?)pid=(\d+)/)?.[1] ?? 0);
    assert.ok(peerPid, peerOutput);
    const peerTerminal = await connectProcessTerminal(sid, peerPid);
    await peerTerminal.waitFor(text => /PEER_PORT=\d+/.test(text), 30_000, 'peer listener');
    peerOutput += '\n' + peerTerminal.output; peerTerminal.ws.close();
  }
  const peerPort = Number(peerOutput.match(/PEER_PORT=(\d+)/)[1]);
  await terminal.run(heredocCommand('/home/user/own-http.js', program), 30_000);
  const started = await terminal.run('OWN_HTTP_PEER_URL=http://localhost:' + peerPort + ' node /home/user/own-http.js', 120_000);
  let output = started.output;
  const pid = Number(output.match(/(?:long-running\): |started[^\n]*?)pid=(\d+)/)?.[1] ?? 0);
  if (!output.includes('OWN_HTTP_DIFFERENTIAL ') && pid > 0) {
    const processTerminal = await connectProcessTerminal(sid, pid);
    await processTerminal.waitFor(text => /OWN_HTTP_DIFFERENTIAL(?: |_ERROR )/.test(text), 180_000, 'own HTTP differential');
    output += '\n' + processTerminal.output; processTerminal.ws.close();
  }
  const actualLine = output.match(/OWN_HTTP_DIFFERENTIAL ([^\r\n]+)/)?.[1];
  assert.ok(actualLine, output);
  const actual = JSON.parse(actualLine);
  console.log('NIMBUS ' + JSON.stringify(actual));
  // Approved dispatch-only scope: the native client flattens set-cookie.
  // workerd v1.20260926.1 internal_http_incoming.ts #setFetchResponse reads
  // each field through Headers.get rather than getSetCookie. Assert the gap
  // separately, exactly: its fix must turn this test red until it is updated.
  const { cookies: nodeCookies, ...nodeHttp } = expected.viaHttp;
  const { cookies: nativeCookies, ...nativeHttp } = actual.viaHttp;
  assert.deepEqual(nodeCookies, ['a=1', 'b=2']);
  assert.equal(nativeCookies, 'a=1, b=2', 'known native set-cookie failure; update this assertion when workerd fixes it');
  console.log('KNOWN_WORKERD_FAILURE: http headers set-cookie = ' + JSON.stringify(nativeCookies) + '; Node = ' + JSON.stringify(nodeCookies));
  assert.deepEqual({ ...actual, viaHttp: nativeHttp }, { ...expected, viaHttp: nodeHttp },
    'the common HTTP contract, shared-view coherence and cross-pid routing match Node');
} finally {
  await terminal.close(); assert.ok((await deleteSession(sid)).ok, 'differential session deleted');
}
