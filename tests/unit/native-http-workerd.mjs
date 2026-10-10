// @serial
// @tier slow — drives a local workerd; CI median 4 s wall, 1 s CPU, 0.0 GiB peak (6 runs, 2026-10-06)
// Compare the native guest HTTP bridge with Node's HTTP server: binary
// requests, pipe, streaming before end, HEAD/204, duplicate listen errors,
// closure and two independent ephemeral listeners. Also exercise Nimbus's
// parked-listener and response-header deadline around real workerd dispatch.
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_HTTP_SOURCE } from '../../packages/worker/src/runtime/native-http.ts';
import { ENTRYPOINT_EVENT_LOOP } from '../../packages/worker/src/facets/manager.ts';
import { clientLifetime, pendingListenLifetime, pendingCloseLifetime, exchangeLifetime } from './lib/native-http-lifetimes.mjs';
import { httpFetchCases } from './lib/http-fetch-cases.mjs';
import { httpFetchReviewCases } from './lib/http-fetch-review-cases.mjs';
import { NODE_ERROR_PREAMBLE } from '../../packages/worker/src/loaders/generated-workers.ts';
import { generateNodeLibModule, generateNodeDnsModule } from '../../packages/worker/src/runtime/node-lib-module.ts';
import { opencodeBuiltinBridgeModules } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';

async function exercise(http, serve) {
  const opened = [];
  const listen = async server => {
    opened.push(server);
    const ready = Promise.withResolvers();
    server.once('error', ready.reject);
    server.listen({ port: 0, host: '127.0.0.1' }, ready.resolve);
    await ready.promise;
    return server.address().port;
  };
  const finish = Promise.withResolvers();
  const server = http.createServer(async (req, res) => {
    if (req.url === '/pipe') { req.pipe(res); return; }
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.flushHeaders();
      res.write('first');
      await finish.promise;
      res.end('second');
      return;
    }
    if (req.url === '/dictionary') {
      const fields = Object.assign(Object.create(null), { 'x-dictionary': 'yes' });
      res.writeHead(202, fields); res.end('dictionary'); return;
    }
    if (req.url === '/empty') { res.statusCode = 204; res.end('ignored'); return; }
    if (req.url === '/headers') {
      const names = ['if-modified-since', 'user-agent', 'authorization', 'referer'];
      const raw = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (names.includes(req.rawHeaders[i].toLowerCase())) raw.push([req.rawHeaders[i].toLowerCase(), req.rawHeaders[i + 1]]);
      }
      res.end(JSON.stringify({ headers: names.map(n => [n, req.headers[n]]), raw: raw.sort() }));
      return;
    }
    if (req.url === '/conditional') {
      // A static server's conditional GET (the `fresh` rule serve-static and
      // http-server use): not modified since the client's HTTP date.
      const lastModified = 'Mon, 28 Sep 2026 10:00:00 GMT';
      const since = Date.parse(req.headers['if-modified-since']);
      if (since >= Date.parse(lastModified)) { res.statusCode = 304; res.end(); return; }
      res.writeHead(200, { 'last-modified': lastModified }); res.end('fresh body'); return;
    }
    if (req.url === '/echo') {
      const parts = [];
      let buffers = true;
      for await (const part of req) { buffers &&= Buffer.isBuffer(part); parts.push(part); }
      const bytes = Buffer.concat(parts);
      res.end(JSON.stringify({ buffers, bytes: Array.from(bytes), native: req instanceof http.IncomingMessage && res instanceof http.ServerResponse }));
      return;
    }
    res.writeHead(201, { 'x-list': ['one', 'two'] });
    res.end('body');
  });
  try {
    const port = await listen(server);
    const request = (path, init = {}) => serve(port, new Request('http://loopback' + path, init));
    const bytes = new Uint8Array([0, 128, 255, 13, 10, 195, 169]);
    const echo = await (await request('/echo', { method: 'POST', body: bytes })).json();
    const pipe = new Uint8Array(await (await request('/pipe', { method: 'POST', body: bytes })).arrayBuffer());
    const head = await request('/status', { method: 'HEAD' });
    const empty = await request('/empty');
    const dictionaryResponse = await request('/dictionary');
    const dictionary = [dictionaryResponse.status, dictionaryResponse.headers.get('x-dictionary'), await dictionaryResponse.text()];
    // Values with commas in the fields workerd splits: an HTTP date, Chrome's
    // User-Agent, a Digest Authorization and a Referer with a comma.
    const sent = {
      'if-modified-since': 'Tue, 29 Sep 2026 10:00:00 GMT',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      authorization: 'Digest username="u", realm="r, with comma", nonce="n", uri="/headers", response="x"',
      referer: 'http://loopback/a,b?c=d,e',
    };
    const headers = await (await request('/headers', { headers: sent })).json();
    const conditional = await request('/conditional', { headers: { 'if-modified-since': sent['if-modified-since'] } });
    const stream = await request('/stream');
    const reader = stream.body.getReader();
    const first = await reader.read();
    finish.resolve();
    let rest = '';
    for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
    const duplicate = http.createServer();
    const error = Promise.withResolvers();
    duplicate.once('error', error.resolve);
    duplicate.listen(port);
    const duplicateCode = (await error.promise).code;
    const parked = http.createServer();
    const otherPort = await listen(parked);
    const waiting = serve(otherPort, new Request('http://loopback/parked'));
    queueMicrotask(() => parked.on('request', (_q, s) => s.end('attached-later')));
    const parkedBody = await (await waiting).text();
    const closed = Promise.withResolvers();
    server.close(closed.resolve);
    await closed.promise;
    return {
      dictionary,
      headers, conditional: [conditional.status, await conditional.text()],
      echo, pipe: Array.from(pipe), allocated: port > 0 && otherPort > 0 && port !== otherPort,
      head: [head.status, await head.text(), head.headers.get('x-list').split(',').map(s => s.trim())],
      empty: [empty.status, await empty.text()], stream: [new TextDecoder().decode(first.value), rest],
      duplicateCode, parkedBody, closed: server.address() === null,
    };
  } finally {
    finish.resolve();
    for (const s of opened) { if (s.listening) s.close(); }
  }
}

const node = spawnSync('node', ['--input-type=module', '-e', `
  import http from 'node:http';
  import dns from 'node:dns';
  import net from 'node:net';
  const exercise = ${exercise.toString()};
  const httpFetchCases = ${httpFetchCases.toString()};
  const httpFetchReviewCases = ${httpFetchReviewCases.toString()};
  const result = await exercise(http, (port, request) => {
    const url = new URL(request.url); url.hostname = '127.0.0.1'; url.port = String(port);
    return fetch(url, { method: request.method, headers: request.headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, duplex: 'half' });
  });
  console.log(JSON.stringify({ result, client: await httpFetchCases(http), review: await httpFetchReviewCases(http, dns, net) }));
`], { encoding: 'utf8', timeout: 30000 });
assert.equal(node.status, 0, node.stderr);
const { result: expected, client: expectedClient, review: expectedReview } = JSON.parse(node.stdout);
assert.equal(expected.duplicateCode, 'EADDRINUSE');
assert.equal(expected.allocated, true);
assert.deepEqual(expected.stream, ['first', 'second']);
assert.equal(expected.headers.headers[0][1], 'Tue, 29 Sep 2026 10:00:00 GMT', 'Node keeps the full HTTP date');
assert.match(expected.headers.headers[1][1], /\(KHTML, like Gecko\) Chrome/, 'Node keeps the full User-Agent');
assert.deepEqual(expected.conditional, [304, ''], 'Node answers the conditional GET not modified');

// Node's process lifetime around one exchange (exchangeLifetime's program as a
// Node process): alive while the exchange is open after server.close(), and
// exited once it completes; an unread request body does not hold it. The
// client asks for `Connection: close`: an idle keep-alive connection is a
// socket of Node's own that a Nimbus server, reached without one, never has.
async function nodeExchange(mode) {
  const program = `const http = require("node:http");
    const server = http.createServer(async (request, response) => {
      server.close();
      if (process.argv[1] === "ignored") { response.end("ok"); return; }
      response.writeHead(200); response.flushHeaders(); response.write("first");
      let data = ""; for await (const chunk of request) data += chunk;
      response.end("last:" + data);
    });
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));`;
  const child = Bun.spawn(['node', '-e', program, mode], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const stdout = child.stdout.getReader();
  const url = `http://127.0.0.1:${Number(new TextDecoder().decode((await stdout.read()).value).trim())}/`;
  const exited = () => Promise.race([child.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
  try {
    if (mode === 'ignored') {
      const body = await (await fetch(url, { method: 'POST', body: 'unread', headers: { connection: 'close' } })).text();
      return { body, heldAfter: !(await exited()) };
    }
    let upload;
    const stream = new ReadableStream({ start(controller) { upload = controller; controller.enqueue(new TextEncoder().encode('a')); } });
    const reader = (await fetch(url, { method: 'POST', body: stream, duplex: 'half', headers: { connection: 'close' } })).body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await Bun.sleep(200);
    const heldWhileOpen = child.exitCode === null;
    upload.enqueue(new TextEncoder().encode('b'));
    upload.close();
    let rest = '';
    for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
    return { first, heldWhileOpen, rest, heldAfter: !(await exited()) };
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await child.exited; }
  }
}
const expectedExchange = { exchange: await nodeExchange('exchange'), ignored: await nodeExchange('ignored') };
assert.deepEqual(expectedExchange, {
  exchange: { first: 'first', heldWhileOpen: true, rest: 'last:ab', heldAfter: false },
  ignored: { body: 'ok', heldAfter: false },
}, 'Node 22 holds the process for an open exchange and releases it after');

const require = createRequire(import.meta.url);
const fromWrangler = createRequire(require.resolve('wrangler/package.json'));
const binary = fromWrangler('workerd').default;
const dir = mkdtempSync(join(tmpdir(), 'nimbus-native-http-'));
const portReady = Promise.withResolvers();
const probePort = net.createServer(); probePort.listen(0, '127.0.0.1', portReady.resolve);
await portReady.promise;
const port = probePort.address().port;
const released = Promise.withResolvers(); probePort.close(released.resolve); await released.promise;
writeFileSync(join(dir, 'node-lib.js'), generateNodeLibModule());
writeFileSync(join(dir, 'node-dns.js'), generateNodeDnsModule());
const httpBridges = opencodeBuiltinBridgeModules('attached');
writeFileSync(join(dir, 'http-bridge.js'), httpBridges['node:http'].js);
writeFileSync(join(dir, 'https-bridge.js'), httpBridges['node:https'].js);
writeFileSync(join(dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "main", worker = (modules = [(name = "main.js", esModule = embed "main.js"), (name = "node-lib.js", commonJsModule = embed "node-lib.js"), (name = "node-dns.js", commonJsModule = embed "node-dns.js"), (name = "node:http", esModule = embed "http-bridge.js"), (name = "node:https", esModule = embed "https-bridge.js")], compatibilityDate = "2026-09-26", compatibilityFlags = ["nodejs_compat", "new_module_registry"]))], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]);`);
writeFileSync(join(dir, 'main.js'), `
const __real_http = globalThis.process.getBuiltinModule('http');
const __real_https = globalThis.process.getBuiltinModule('https');
import * as __real_net from 'node:net';
import * as __real_util from 'node:util';
import * as __real_url from 'node:url';
import * as __real_buffer from 'node:buffer';
import __real_process from 'node:process';
import lib from './node-lib.js';
import { handleAsNodeRequest as __nimbusHandleAsNodeRequest } from 'cloudflare:node';
const builtins = {}, __pendingIO = [], registered = new Map();
let nextPort = 49152;
const __supervisor = {
  async allocatePort() { const port = nextPort++; registered.set(port, true); return port; },
  async registerPort(port) { registered.set(port, true); },
  async unregisterPort(port) { registered.delete(port); },
};
const __nimbusInboundBarrier = async () => {};
// The shims' stop and replay control (node-shims.ts): none in this runner.
const __nimbusReplay = null;
const __nimbusProcessExitPromise = Promise.withResolvers().promise;
globalThis.__nimbusRawSetTimeout = setTimeout;
const previousHttp = { ...__real_http, request: __real_http.request };
const previousAddress = __real_http.Server.prototype.address;
const previousListen = __real_http.Server.prototype.listen;
${NODE_ERROR_PREAMBLE}
const primordials = {};
lib.primordialsOf(primordials, globalThis);
const nodeLib = lib.createNodeLib({
  util: __real_util.default, Buffer: __real_buffer.Buffer, process: __real_process, url: __real_url.default,
  primordials, sources: lib.sources, errors: { codes: nodeErrorCodes, hideStackFrames, isErrorStackTraceLimitWritable },
  slots: lib.createWorkerdSlots(__real_util.default), builtinObjects: lib.builtinObjects, uvErrors: lib.uvErrors,
  optionValue: () => undefined, fetch: fetch.bind(globalThis), timers: { setTimeout, clearTimeout },
  createCaresBinding: lib.createCaresBinding,
});
builtins.dns = nodeLib.require('dns');
${ENTRYPOINT_EVENT_LOOP}
${NATIVE_HTTP_SOURCE}
globalThis.__nimbusOpencodeBuiltins = builtins;
const exercise = ${exercise.toString()};
const httpFetchCases = ${httpFetchCases.toString()};
const httpFetchReviewCases = ${httpFetchReviewCases.toString()};
const clientLifetime = ${clientLifetime.toString()};
const pendingListenLifetime = ${pendingListenLifetime.toString()};
const pendingCloseLifetime = ${pendingCloseLifetime.toString()};
const exchangeLifetime = ${exchangeLifetime.toString()};
const drain = async () => { while (__pendingIO.length) await Promise.all(__pendingIO.splice(0)); };
export default { async fetch(request) {
  if (new URL(request.url).pathname === '/ready') return new Response('ready');
  const http = builtins.http;
  const mode = new URL(request.url).searchParams.get('case');
  if (mode === 'client-parity' || mode === 'client-esm' || mode === 'review-parity' || mode === 'review-previous') {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const incoming = new Request(url, init);
      const headers = new Headers(incoming.headers);
      headers.set('X-Nimbus-Port', new URL(incoming.url).port);
      return globalThis.__nimbusServeHttp(new Request(incoming, { headers }));
    };
    try {
      if (mode === 'client-esm') {
        const { request, get, ClientRequest, default: defaultHttp } = await import('node:http');
        const { request: httpsRequest, default: defaultHttps } = await import('node:https');
        if (request !== http.request || get !== http.get || ClientRequest !== http.ClientRequest || request !== defaultHttp.request || httpsRequest !== defaultHttps.request || httpsRequest !== builtins.https.request) throw new Error('HTTP ESM exports bypass the canonical transport');
        return Response.json(await httpFetchCases({ ...defaultHttp, request, get, ClientRequest }));
      }
      if (mode === 'review-previous') return Response.json(await httpFetchReviewCases(previousHttp, builtins.dns, __real_net.default, (server) => previousAddress.call(server), (server, callback) => previousListen.call(server, 0, '::1%lo', callback)));
      if (mode === 'review-parity') return Response.json(await httpFetchReviewCases(http, builtins.dns, __real_net.default));
      return Response.json(await httpFetchCases(http));
    }
    finally { globalThis.fetch = nativeFetch; }
  }
  if (mode === 'client' || mode === 'error' || mode === 'cancel') return Response.json(await clientLifetime(builtins.https, __nimbusRunEntrypointToExit, mode));
  if (mode === 'pending') return Response.json(await pendingListenLifetime(http, __nimbusRunEntrypointToExit, __supervisor, drain));
  if (mode === 'close') return Response.json(await pendingCloseLifetime(http, __supervisor, registered, drain));
  if (mode === 'exchange' || mode === 'ignored') {
    return Response.json(await exchangeLifetime(http, __nimbusLiveHandles, (port, request) => {
      const headers = new Headers(request.headers); headers.set('X-Nimbus-Port', String(port));
      return globalThis.__nimbusServeHttp(new Request(request, { headers, duplex: 'half' }));
    }, mode));
  }
  const result = await exercise(http, (port, request) => {
    const headers = new Headers(request.headers); headers.set('X-Nimbus-Port', String(port));
    return globalThis.__nimbusServeHttp(new Request(request, { headers }));
  });
  await Promise.all(__pendingIO.splice(0));
  return Response.json({ result, registered: [...registered.keys()] });
} };`);
const child = spawn(binary, ['serve', 'config.capnp', '--experimental'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
try {
  const until = Date.now() + 30000;
  for (;;) {
    try { await fetch(`http://127.0.0.1:${port}/ready`); break; } catch {}
    if (child.exitCode !== null || Date.now() >= until) throw new Error(logs);
    await Bun.sleep(30);
  }
  const response = await fetch(`http://127.0.0.1:${port}/run`, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, logs);
  const actual = await response.json();
  assert.deepEqual(actual.result, expected, logs);
  assert.deepEqual(actual.registered, [], 'closing native servers releases Nimbus ports');
  const clientResponse = await fetch(`http://127.0.0.1:${port}/run?case=client-parity`, { signal: AbortSignal.timeout(15000) });
  assert.equal(clientResponse.status, 200, logs);
  const actualClient = await clientResponse.json();
  console.log('HTTP_CLIENT_PARITY ' + JSON.stringify({ node: expectedClient, ours: actualClient }));
  assert.deepEqual(actualClient.parity, expectedClient.parity, 'client headers, upload, abort and bound addresses match Node');
  const esmClient = await (await fetch(`http://127.0.0.1:${port}/run?case=client-esm`, { signal: AbortSignal.timeout(15000) })).json();
  console.log('HTTP_ESM_PARITY ' + JSON.stringify({ node: expectedClient, nimbus: esmClient }));
  // Compare both reviewed paths before asserting, so a red prints all the evidence.
  const gaps = JSON.parse(readFileSync(new URL('../fixtures/node-http-fetch-gaps.json', import.meta.url), 'utf8'));
  assert.deepEqual({ node: expectedClient.gaps, nimbus: actualClient.gaps }, gaps, 'physical socket gaps stay pinned until Outbound TCP');
  let previous;
  try { previous = await (await fetch(`http://127.0.0.1:${port}/run?case=review-previous`, { signal: AbortSignal.timeout(10000) })).json(); }
  catch (error) { throw new Error(logs, { cause: error }); }
  const review = await (await fetch(`http://127.0.0.1:${port}/run?case=review-parity`, { signal: AbortSignal.timeout(10000) })).json();
  console.log('HTTP_REVIEW_PARITY ' + JSON.stringify({ node: expectedReview, previous, nimbus: review }));
  assert.deepEqual(esmClient.parity, expectedClient.parity, 'native ESM named imports join the same HTTP client transport');
  assert.deepEqual(review, expectedReview, 'review regressions match host Node and are compared with the previous native shim');
  const snapshots = {};
  for (const mode of ['client', 'error', 'cancel', 'pending', 'close', 'exchange', 'ignored']) {
    const reply = await fetch(`http://127.0.0.1:${port}/run?case=${mode}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(reply.status, 200, logs);
    snapshots[mode] = await reply.json();
  }
  assert.deepEqual(snapshots, {
    client: { ended: true, errored: false, closed: true, streamed: true, body: 'firstsecond', cancelled: false, pending: 0 },
    error: { ended: false, errored: true, closed: true, streamed: true, body: 'first', cancelled: false, pending: 0 },
    cancel: { ended: false, errored: false, closed: true, streamed: true, body: 'first', cancelled: true, pending: 0 },
    pending: { listening: true, pending: 0 },
    close: { closes: 1, callbacks: 1, listening: true, relistenError: null, port: 55001, oldReleased: true, newRetained: true },
    ...expectedExchange,
  }, 'the process may exit only after native I/O has completed, and pending close must permit a new listen');
  console.log('native-http-workerd: Node parity for binary, streams, HEAD/204, listen errors and lifecycle');
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  rmSync(dir, { recursive: true, force: true });
}
