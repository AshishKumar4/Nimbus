// @serial
// @tier slow — drives a local workerd: native framing, chunking and cancellation of the port relay.
// The port relay as workerd runs it, in a session Durable Object: a declared
// length reaches the wire as Content-Length through the sole FixedLengthStream,
// the output gate sees the producer's 64 KiB chunks (gate before framer; the
// reverse order reads 4 KiB at a time), a framing mismatch fails the body, and
// the process's work for a response ends when it is done with: at EOF, or at
// once when the client leaves while the process is quiet, framed or chunked.
// The client leaving is the session's incoming Request.signal, which only
// `enable_request_signal` provides.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import net from 'node:net';
import { build } from 'esbuild';
import { servePlainWorkerd } from './lib/plain-workerd.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const ENTRY = `
import { DurableObject } from 'cloudflare:workers';
import { PortRegistry } from './packages/core/src/runtime/port-registry.ts';

const MIB = 1024 * 1024, CHUNK = 65536;
export class Session extends DurableObject {
  rows = new Map();
  gated = 0;
  registry = new PortRegistry();
  constructor(ctx, env) {
    super(ctx, env);
    this.registry.setOutput({ releaseOutput: async (pid, deliver) => { this.gated++; deliver(); }, escapeOutput() {} });
    this.registry.bindFacetStub(1, { handleHttpRequest: (request, scope) => this.answer(request, scope) });
    this.registry.register(3000, 1);
  }
  answer(request, scope) {
    const url = new URL(request.url), key = url.searchParams.get('key');
    const row = { aborted: null, settled: null, cancelled: false, controller: null };
    this.rows.set(key, row);
    scope.signal.addEventListener('abort', () => { row.aborted = Date.now(); });
    scope.settled(() => { row.settled = Date.now(); });
    const cancel = () => { row.cancelled = true; };
    if (url.pathname === '/bulk') {
      let remaining = 8 * MIB;
      const chunk = new Uint8Array(CHUNK);
      return new Response(new ReadableStream({ pull(controller) { if (!remaining) return controller.close(); remaining -= CHUNK; controller.enqueue(chunk); }, cancel }),
        { headers: { 'Content-Length': String(8 * MIB) } });
    }
    if (url.pathname === '/mismatch') {
      const size = Number(url.searchParams.get('size'));
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(size)); controller.close(); }, cancel }),
        { headers: { 'Content-Length': '3' } });
    }
    // One chunk, then quiet until poked.
    return new Response(new ReadableStream({ start(controller) { row.controller = controller; controller.enqueue(new Uint8Array(CHUNK)); }, cancel }),
      { headers: url.searchParams.has('chunked') ? {} : { 'Content-Length': String(MIB) } });
  }
  async fetch(request) {
    const url = new URL(request.url), row = this.rows.get(url.searchParams.get('key'));
    if (url.pathname === '/poke') { row.controller.enqueue(new Uint8Array(1)); return new Response('poked'); }
    if (url.pathname === '/stats') return Response.json({ ...row, controller: undefined, gated: this.gated });
    if (url.pathname === '/abandon') {
      // A caller of the relay that leaves on its own signal, as a client does.
      const leave = new AbortController();
      const response = await this.registry.routeRequest(3000, new Request(url.origin + '/paused?' + url.searchParams, { signal: leave.signal }), '/paused');
      const reader = response.body.getReader();
      await reader.read();
      leave.abort(new DOMException('The client has disconnected', 'AbortError'));
      return new Response(response.headers.get('Content-Length') ?? 'chunked');
    }
    return this.registry.routeRequest(3000, request, url.pathname);
  }
}
export default { fetch: (request, env) => new URL(request.url).pathname === '/ready' ? new Response('ready') : env.SESSION.get(env.SESSION.idFromName('one')).fetch(request) };
`;
const bundled = await build({
  stdin: { contents: ENTRY, resolveDir: REPO, sourcefile: 'relay-entry.js', loader: 'js' },
  bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'error',
  mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'import'], external: ['cloudflare:*', 'node:*'],
});
const served = await servePlainWorkerd({
  name: 'port-registry-relay',
  files: { 'main.js': bundled.outputFiles[0].text },
  readyPath: '/ready',
  args: [],
  config: ({ port }) => `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "main", worker = (modules = [(name = "main.js", esModule = embed "main.js")],
  compatibilityDate = "2026-09-26", compatibilityFlags = ["enable_request_signal"],
  durableObjectNamespaces = [(className = "Session", uniqueKey = "port-registry-relay", enableSql = true)], durableObjectStorage = (inMemory = void),
  bindings = [(name = "SESSION", durableObjectNamespace = "Session")]))],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]);`,
});
const { base, port } = served;
const stats = async (key) => (await fetch(`${base}/stats?key=${key}`)).json();
async function until(key, done, label) {
  for (const deadline = Date.now() + 10_000; ;) {
    const row = await stats(key);
    if (done(row)) return row;
    if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(row)}\n${served.logs()}`);
    await new Promise((wake) => setTimeout(wake, 25));
  }
}
/** A raw client that reads the headers and the first chunk, then resets its connection. */
async function leaveAfterFirstChunk(path) {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((done, fail) => { socket.once('connect', done); socket.once('error', fail); });
  socket.write(`GET ${path} HTTP/1.1\r\nHost: relay.test\r\n\r\n`);
  let received = '';
  await new Promise((done) => socket.on('data', (data) => { received += data.toString('latin1'); if (received.length > 65536) done(); }));
  socket.resetAndDestroy?.() ?? socket.destroy();
  return received.slice(0, received.indexOf('\r\n\r\n'));
}

try {
  const bulk = await fetch(`${base}/bulk?key=bulk`);
  assert.equal(bulk.headers.get('content-length'), String(8 * 1024 * 1024), 'the declared length reaches the wire');
  assert.equal(bulk.headers.get('transfer-encoding'), null, 'never chunked');
  assert.equal((await bulk.arrayBuffer()).byteLength, 8 * 1024 * 1024);
  const done = await until('bulk', (row) => row.settled !== null, 'EOF settles the response');
  assert.equal(done.gated, 1 + 128 + 1, 'the gate lets out the head, 128 chunks of 64 KiB, then the end');
  assert.equal(done.aborted, null);
  for (const size of [2, 4]) {
    await assert.rejects(async () => (await fetch(`${base}/mismatch?key=m${size}&size=${size}`)).arrayBuffer(), `a ${size}-byte body for 3 declared fails`);
    await until(`m${size}`, (row) => row.settled !== null, 'a framing mismatch settles the response');
  }
  for (const [label, query] of [['framed', ''], ['chunked', '&chunked']]) {
    // The caller leaves on its own signal while the process writes nothing.
    const key = `abandon-${label}`;
    assert.equal(await (await fetch(`${base}/abandon?key=${key}${query}`)).text(), label === 'framed' ? String(1024 * 1024) : 'chunked');
    const abandoned = await until(key, (row) => row.settled !== null, `${label}: a leaving caller settles the quiet response`);
    assert.notEqual(abandoned.aborted, null);
    await fetch(`${base}/poke?key=${key}`);
    await until(key, (row) => row.cancelled, `${label}: the process's body is cancelled at its next write`);
    // A real client resets its connection: the session's Request.signal says so.
    const reset = `reset-${label}`;
    const head = await leaveAfterFirstChunk(`/paused?key=${reset}${query}`);
    assert.match(head, label === 'framed' ? /content-length: 1048576/i : /transfer-encoding: chunked/i);
    const left = await until(reset, (row) => row.settled !== null, `${label}: a client that resets settles the quiet response`);
    assert.notEqual(left.aborted, null, 'through the incoming request signal');
  }
  console.log('port-registry-relay-workerd: native length, 64 KiB gate chunks, mismatch, and ownership through EOF and a leaving client');
} finally { await served.stop(); }
