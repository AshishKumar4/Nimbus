#!/usr/bin/env bun
// The generated guest source, with only native networking stood in for:
// returning a Socket is synchronous, opening its transport is ordered
// behind the same replay-boundary acknowledgement as supervisor/fetch I/O.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); promise.catch(() => {}); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 40; i++) await null; };

function fixture(proxied) {
  const notice = deferred(), registration = deferred();
  const calls = [], effects = [], carriers = [];
  let registered = false;
  class Socket extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.connecting = false; }
    connect(options) { if (this.connecting) throw Object.assign(new Error('Socket is already connecting'), { code: 'ERR_SOCKET_CONNECTING' }); calls.push({ options, registered }); this.connecting = true; return this; }
    destroy(error) { if (this.destroyed) return this; this.destroyed = true; this.connecting = false; queueMicrotask(() => { if (error) this.emit('error', error); this.emit('close'); }); return this; }
    ref() { return this; }
    unref() { return this; }
  }
  const net = { Socket, connect(options) { const socket = new Socket(); carriers.push(socket); return socket.connect(options); } };
  const tls = { connect(options) {
    const socket = new Socket();
    socket.carrier = options.socket;
    options.socket.on('error', (error) => socket.destroy(error));
    return socket;
  } };
  const supervisor = { netTls: async (action) => {
    assert.equal(action, 'open');
    await notice.promise;
    await registration.promise;
    registered = true;
    return true;
  } };
  const replay = { outbound: proxied, effect: (what) => effects.push(what), afterBoundary: () => notice.promise };
  const factory = new Function('__real_net', '__real_tls', '__nimbusStopReplay', '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    generateShimsCode() + '\nreturn { tls: __tlsMod };');
  const guest = factory(net, tls, replay, {}, {}, supervisor,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/', [], {}, '/main.js', '/');
  return { ...guest, Socket, notice, registration, calls, effects, carriers };
}

for (const kind of ['plain', 'tls']) {
  for (const state of ['delayed', 'refused']) {
    const name = `${kind}-${state}`;
    if (process.env.NIMBUS_SOCKET_BOUNDARY_CASE && process.env.NIMBUS_SOCKET_BOUNDARY_CASE !== name) continue;
    const f = fixture(kind === 'tls');
    const socket = kind === 'plain' ? new f.Socket() : f.tls.connect({ host: 'example.test', port: 443 });
    const errors = [];
    socket.on('error', (error) => errors.push(error));
    if (kind === 'plain') assert.equal(socket.connect({ host: 'example.test', port: 80 }), socket, 'connect returns its Socket at once');
    await tick();
    assert.equal(f.calls.length, 0, `${name}: no native connect before the boundary acknowledgement`);
    if (state === 'delayed') {
      f.notice.resolve(); await tick();
      if (kind === 'tls') {
        assert.equal(f.calls.length, 0, 'the TLS carrier also waits for its target registration');
        f.registration.resolve(); await tick();
      }
      assert.equal(f.calls.length, 1, `${name}: transport opens once after acknowledgement`);
      if (kind === 'tls') assert.equal(f.calls[0].registered, true, 'no unregistered carrier reaches the outbound');
      assert.deepEqual(errors, []);
      socket.destroy();
      socket.carrier?.destroy();
    } else {
      const original = Object.assign(new Error('the replay boundary was refused'), { code: 'ERR_REPLAY_BOUNDARY' });
      f.notice.reject(original); await tick();
      assert.equal(f.calls.length, 0, 'a refused notice never opens a transport');
      assert.equal(socket.destroyed, true);
      assert.deepEqual(errors, [original], 'the original refusal is emitted once, not a generic missing-connection error');
      assert.equal(errors[0], original, 'the exact refusal object survives the gate');
      if (kind === 'tls') assert.equal(socket.carrier.destroyed, true);
    }
    console.log(`ok - stop-replay-socket-boundary ${name}`);
  }
}
