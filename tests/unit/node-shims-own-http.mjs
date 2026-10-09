import assert from 'node:assert/strict';
import { generateShimsCode } from './lib/node-http-platform.mjs';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';

const nativeClone = Response.prototype.clone;
const routed = [];
const supervisor = {
  registerPort() {}, unregisterPort() {},
  routeLoopback(port, request) {
    routed.push({ port, url: request.url });
    return new Response('peer', { headers: { 'X-Nimbus-Same-Process': '1' } });
  },
};
const factory = new Function(
  '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  generateShimsCode() + '\nreturn { http: builtins.http };',
);
const { http } = factory({}, {}, {}, supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/main.js', '/home/user');
let acquires = 0, releases = 0;
globalThis.__nimbusVfsAcquireBarrier = async () => { acquires++; };
globalThis.__nimbusVfsReleaseBarrier = async () => { releases++; };
const server = http.createServer((request, response) => {
  assert.ok(request instanceof http.IncomingMessage);
  assert.ok(response instanceof http.ServerResponse);
  if (request.method === 'POST') { request.pipe(response); return; }
  response.setHeader('X-Own', request.url);
  response.end('own');
});
let routedAtEnd = 0;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(7421, resolve);
  });
  const view = globalThis.__portRegistry;
  assert.equal(view.get(7421), server);
  assert.equal(view.set, undefined, 'the lifetime view cannot register a listener');
  assert.ok(Object.isFrozen(view));
  const response = await fetch('http://localhost:7421/own?x=1');
  assert.equal(response.headers.get('X-Own'), '/own?x=1');
  assert.equal(await response.text(), 'own');
  assert.deepEqual([routed.length, acquires, releases], [0, 0, 0], 'an own request and body cross no process boundary');

  const bytes = new Uint8Array([0, 128, 255, 13, 10]);
  const request = new Request('http://127.0.0.1:7421/echo', { method: 'POST', body: bytes });
  const echo = await fetch(request);
  assert.deepEqual(new Uint8Array(await echo.arrayBuffer()), bytes);
  assert.deepEqual([routed.length, acquires, releases], [0, 0, 0]);
  assert.equal(Response.prototype.clone, nativeClone, 'native cloning stays intact without a replay journal');
  const cloneable = await fetch('http://localhost:7421/clone');
  const clone = cloneable.clone();
  assert.equal(await cloneable.text(), 'own');
  assert.equal(await clone.text(), 'own');
  assert.equal(acquires, 1, 'an unmarked native clone conservatively keeps the existing body barrier');

  acquires = 0;
  globalThis.__portRegistry = new Map([[7422, server]]);
  globalThis.__nimbusServeHttp = () => { throw new Error('guest-writable dispatcher must not admit own requests'); };
  const peer = await fetch('http://localhost:7422/peer', {
    headers: { 'X-Nimbus-Same-Process': '1', 'X-Nimbus-Vfs-Acquired': '{}' },
  });
  assert.equal(await peer.text(), 'peer');
  assert.deepEqual([routed.length, acquires, releases], [1, 2, 1], 'globals and headers cannot claim a cross-process response');
  assert.equal(routed[0].port, 7422);
  globalThis.__portRegistry = view;
  assert.equal(await (await fetch('http://localhost:7421/still-own')).text(), 'own', 'own dispatch does not call the public dispatcher');
  assert.deepEqual([routed.length, acquires, releases], [1, 2, 1]);
  // ── Whatever the port route takes for an upgrade is one here, however it is spelled ──
  // The oracle is the real port route reading the same Request; no spelling of the rule lives in this test.
  const route = new PortRegistry();
  route.bindFacetStub(1, {
    handleHttpRequest: async () => new Response('http'),
    handleWebSocketRequest: async () => new Response('websocket'),
  });
  route.register(7421, 1);
  const counts = () => [routed.length, acquires, releases];
  const during = async (run) => {
    const before = counts();
    const value = await run();
    return { value, delta: counts().map((count, index) => count - before[index]) };
  };
  const target = 'http://localhost:7421/spelled';
  const spellings = [
    ['absent', target, {}, false],
    ['exact', target, { headers: { upgrade: 'websocket' } }, true],
    ['any case', target, { headers: { Upgrade: 'WebSocket' } }, true],
    ['padded', target, { headers: { upgrade: ' websocket ' } }, true],
    ['tabbed', target, { headers: { upgrade: '\twebsocket\t' } }, true],
    ['pairs', target, { headers: [['Upgrade', ' websocket ']] }, true],
    ['a Headers', target, { headers: new Headers({ upgrade: ' websocket ' }) }, true],
    ['a Request', new Request(target, { headers: { upgrade: ' websocket ' } }), undefined, true],
    ['init over a Request', new Request(target, { headers: { upgrade: 'h2c' } }), { headers: { upgrade: ' websocket ' } }, true],
    ['init clearing a Request', new Request(target, { headers: { upgrade: ' websocket ' } }), { headers: {} }, false],
    ['a list', target, { headers: { upgrade: 'websocket, h2c' } }, false],
    ['a longer token', target, { headers: { upgrade: 'websockets' } }, false],
    ['another protocol', target, { headers: { upgrade: 'h2c' } }, false],
  ];
  for (const [name, input, init, upgrade] of spellings) {
    const entrypoint = await (await route.routeRequest(7421, new Request(input, init), '/')).text();
    assert.equal(entrypoint, upgrade ? 'websocket' : 'http', `${name}: what the port route takes it for`);
    const sent = await during(async () => (await fetch(input, init)).text());
    assert.equal(sent.value, upgrade ? 'peer' : 'own', `${name}: the port route's decision is the one that holds`);
    assert.equal(sent.delta[0], upgrade ? 1 : 0, `${name}: ${upgrade ? 'routed through' : 'kept off'} the supervisor`);
  }

  // ── A foreign body still open can feed a response of the process's own ──
  // Another process's port, by the stub: its response is foreign until read to the end through a barriered method.
  const foreign = await fetch('http://localhost:7422/foreign');
  const gated = await during(async () => (await fetch('http://localhost:7421/gated')).text());
  assert.equal(gated.value, 'peer', 'with a foreign body open the port route decides');
  assert.deepEqual(gated.delta, [1, 2, 1], 'and every barrier of it is taken');
  assert.equal(await foreign.text(), 'peer');
  const free = await during(async () => (await fetch('http://localhost:7421/gated')).text());
  assert.equal(free.value, 'own', 'read to the end through a barriered method, it no longer gates');
  assert.deepEqual(free.delta, [0, 0, 0]);

  // Opened while the handler runs and never read: the response it feeds is read behind the ACQUIRE.
  let leaked;
  const relay = http.createServer(async (_request, response) => {
    leaked = await fetch('http://localhost:7422/relayed');
    response.end('relay');
  });
  await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(7423, resolve); });
  const relayed = await during(async () => (await fetch('http://localhost:7423/')).text());
  assert.equal(relayed.value, 'relay');
  assert.deepEqual(relayed.delta, [1, 3, 1], 'the handler\'s fetch (route, release, headers), then the headers and body of its response');
  assert.equal(await leaked.text(), 'peer');

  // Read to the end by the handler through a barriered method: nothing is left open, so its response needs no ACQUIRE.
  const clean = http.createServer(async (_request, response) => {
    const upstream = await fetch('http://localhost:7422/clean');
    response.end('clean:' + await upstream.text());
  });
  await new Promise((resolve, reject) => { clean.once('error', reject); clean.listen(7424, resolve); });
  const cleaned = await during(async () => (await fetch('http://localhost:7424/')).text());
  assert.equal(cleaned.value, 'clean:peer');
  assert.deepEqual(cleaned.delta, [1, 2, 1], 'the handler\'s fetch and its body; its own response takes no barrier');
  for (const extra of [relay, clean]) await new Promise(resolve => extra.close(resolve));
  routedAtEnd = routed.length;
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
assert.equal(globalThis.__portRegistry.has(7421), false, 'closing retires private ownership');
assert.equal(await (await fetch('http://localhost:7421/closed')).text(), 'peer', 'a closed port returns to the normal route');
assert.equal(routed.length, routedAtEnd + 1);
console.log('node-shims-own-http: native dispatch, private ownership and boundary-specific coherence');
