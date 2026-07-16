#!/usr/bin/env bun
// Behavior test: the generated Node http shim's Server.listen honors Node's
// documented overloads. opencode's server adaptor (@hono/node-server-style)
// binds with the OPTIONS-OBJECT form — `server.listen({ host, port }, cb)` —
// so the shim must read `port`/`host` from the object, normalize the port to a
// number, fire the callback, and register the ACTUAL numeric port with the
// supervisor. Before this fix the shim only handled positional args, so
// `this._port` became the whole options object → a garbage port key was
// registered → the loopback/`/port/<n>` route never resolved (ECONNREFUSED).

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

function makeHttp() {
  const registered = [];
  const supervisor = { registerPort: (p) => { registered.push(p); }, unregisterPort: () => {} };
  const code = generateShimsCode();
  const factory = new Function(
    '__vfsBundle', '__vfsWrites', '__vfsDirs', '__vfsManifest', '__supervisor',
    'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + code + '\n;return { http: builtins.http, portRegistry: globalThis.__portRegistry };',
  );
  const sandbox = factory(
    {}, {}, {}, {}, '', supervisor,
    '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
  );
  return { http: sandbox.http, portRegistry: sandbox.portRegistry, registered };
}

// ── listen(options, cb): the options-object overload opencode uses ───────────
{
  const { http, portRegistry, registered } = makeHttp();
  let fired = false;
  const server = http.createServer((_req, _res) => {});
  const ret = server.listen({ host: '127.0.0.1', port: 4096 }, () => { fired = true; });
  assert.equal(ret, server, 'listen returns the server (chainable)');
  assert.equal(server._port, 4096, 'options.port becomes the numeric _port (not the options object)');
  assert.equal(server.listening, true, 'server is marked listening');
  assert.ok(portRegistry.has(4096), 'the ACTUAL port 4096 is keyed in the facet port registry');
  assert.ok(registered.includes(4096), 'SUPERVISOR.registerPort was called with the actual numeric port');
  assert.equal(server.address().port, 4096, 'address() reports the numeric port');
}

// ── listen(options) with no callback still binds ─────────────────────────────
{
  const { http, portRegistry } = makeHttp();
  const server = http.createServer();
  server.listen({ port: 8123, host: '0.0.0.0' });
  assert.equal(server._port, 8123);
  assert.ok(portRegistry.has(8123));
}

// ── string port in options is normalized to a number ─────────────────────────
{
  const { http, portRegistry } = makeHttp();
  const server = http.createServer();
  server.listen({ port: '5544' });
  assert.equal(server._port, 5544, 'string options.port is parsed to a number');
  assert.ok(portRegistry.has(5544));
}

// ── positional forms still work (regression guard) ───────────────────────────
{
  const { http, registered } = makeHttp();
  // listen(port, host, cb)
  let firedA = false;
  const a = http.createServer();
  a.listen(5000, '0.0.0.0', () => { firedA = true; });
  assert.equal(a._port, 5000, 'listen(port, host, cb): numeric port');
  assert.ok(registered.includes(5000));

  // listen(port, cb)
  let firedB = false;
  const b = http.createServer();
  b.listen(3000, () => { firedB = true; });
  assert.equal(b._port, 3000, 'listen(port, cb): numeric port');

  // listen(port) only
  const c = http.createServer();
  c.listen(9090);
  assert.equal(c._port, 9090, 'listen(port): numeric port');

  // string positional port normalizes too
  const d = http.createServer();
  d.listen('7007');
  assert.equal(d._port, 7007, 'listen("7007"): parsed to number');
}

// Callbacks fire on a microtask — flush and confirm.
await new Promise((r) => queueMicrotask(r));

console.log('ok: http.Server.listen honors options-object + positional overloads');
