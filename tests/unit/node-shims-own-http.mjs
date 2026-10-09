import assert from 'node:assert/strict';
import { generateShimsCode } from './lib/node-http-platform.mjs';

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
  assert.equal(await (await fetch('http://localhost:7421/upgrade', { headers: { upgrade: 'websocket' } })).text(), 'peer');
  assert.deepEqual([routed.length, acquires, releases], [2, 4, 2], 'WebSocket admission keeps its existing route even on an own port');
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
assert.equal(globalThis.__portRegistry.has(7421), false, 'closing retires private ownership');
assert.equal(await (await fetch('http://localhost:7421/closed')).text(), 'peer', 'a closed port returns to the normal route');
assert.equal(routed.length, 3);
console.log('node-shims-own-http: native dispatch, private ownership and boundary-specific coherence');
