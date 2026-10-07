#!/usr/bin/env bun
// The lifo node's net and tls modules are stubs over one fake socket and one
// fake server (node-compat/index.ts): what Vite touches on import works, and
// nothing reaches a network. They were seven hand-built copies.
import assert from 'node:assert/strict';
import { testBox } from './lib/test-box.mjs';

const box = await testBox();
try {
  const r = await box.commands.run(`node -e "
const net = require('net'), tls = require('tls');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => console.log('listen', JSON.stringify(server.address()), server.unref() === server));
net.connect(1, () => console.log('connect'));
const socket = net.createConnection();
console.log('socket', socket.write('x'), socket.setNoDelay() === socket, socket instanceof net.Socket);
const secure = tls.connect();
console.log('tls', secure.encrypted, secure.write('x'), secure instanceof tls.TLSSocket);
console.log('ip', net.isIP('1.2.3.4'), net.isIP('::1'), net.isIP('x'));
"`);
  assert.equal(r.stderr, '');
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'listen {"port":0,"family":"IPv4","address":"127.0.0.1"} true',
    'socket true true true',
    'tls true true true',
    'ip 4 6 0',
    'connect',
  ]);
} finally {
  box.destroy();
}
console.log('lifo-net-tls-stubs: ok');
