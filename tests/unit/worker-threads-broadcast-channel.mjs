#!/usr/bin/env bun
// node:worker_threads BroadcastChannel is a constructor, as in Node.
//
// workerd has no BroadcastChannel global, and the shim exported that global,
// so the export was undefined. `nuxt dev` (@nuxt/cli 4) opens its error
// bridge first thing with `new BroadcastChannel(...).unref()` and died there:
// "import_node_worker_threads.BroadcastChannel is not a constructor"
// (nuxt-real on a throwaway, sid arctic-thrush-5123).
//
// The expected behaviour is node v22.22.3's, measured: a message reaches the
// other open channels of its name, never the poster, after the poster's
// microtasks, as a MessageEvent of a structured clone; a ref'd open channel
// keeps the process alive (`node -e "new BroadcastChannel('x')"` never exits)
// and an unref'd one does not.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE } from './lib/shims-namespace.mjs';

// The facet's global, which has none.
delete globalThis.BroadcastChannel;
if (typeof globalThis.BroadcastChannel === 'function') globalThis.BroadcastChannel = undefined;

const factory = new Function(
  '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + SHIMS_STORE_PRELUDE + generateShimsCode() + '\n;return builtins.worker_threads;',
);
const wt = factory({}, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/app.js', '/home/user');
const { BroadcastChannel } = wt;
const held = () => globalThis.__nimbusOpenSockets || 0;

// ── it constructs, and is the global Node also exposes ──
assert.equal(typeof BroadcastChannel, 'function', 'worker_threads.BroadcastChannel must be a constructor');
assert.equal(globalThis.BroadcastChannel, BroadcastChannel);

// ── @nuxt/cli's error bridge, verbatim in shape ──
{
  const before = held();
  const bridge = new BroadcastChannel('nuxt:dev:error');
  assert.equal(held(), before + 1, 'an open channel is a handle');
  assert.equal(bridge.unref(), bridge);
  assert.equal(held(), before, "an unref'd channel holds nothing");
  bridge.postMessage({ type: 'sync' });
  bridge.onmessage = () => {};
  bridge.ref();
  assert.equal(held(), before + 1);
  bridge.close();
  bridge.close();
  assert.equal(held(), before, 'close releases it, once');
}

// ── delivery: the other channels of the name, after the poster's microtasks ──
{
  const order = [];
  const a = new BroadcastChannel('x');
  const b = new BroadcastChannel('x');
  const c = new BroadcastChannel('y');
  const listened = [];
  a.onmessage = () => order.push('self');
  c.onmessage = () => order.push('other-name');
  b.addEventListener('message', (event) => listened.push(event));
  const got = new Promise((resolve) => { b.onmessage = (event) => { order.push('got'); resolve(event); }; });
  const message = { n: 1, nested: { list: [1, 2] } };
  a.postMessage(message);
  Promise.resolve().then(() => order.push('microtask'));
  order.push('posted');
  const event = await got;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ['posted', 'microtask', 'got']);
  assert.equal(event.constructor, MessageEvent);
  assert.equal(event.type, 'message');
  assert.equal(event.target, b);
  assert.deepEqual(event.data, message);
  assert.notEqual(event.data, message, 'a structured clone, not the object posted');
  assert.equal(listened.length, 1, 'addEventListener sees it too');
  assert.equal(b.name, 'x');

  // A message to a channel that closes before it arrives is dropped.
  a.postMessage('late');
  b.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ['posted', 'microtask', 'got']);
  a.close();
  c.close();
}

// ── Node's refusals ──
{
  const closed = new BroadcastChannel('z');
  closed.close();
  assert.throws(() => closed.postMessage(1), (error) => {
    assert.ok(error instanceof DOMException);
    assert.equal(error.name, 'InvalidStateError');
    assert.equal(error.message, 'BroadcastChannel is closed.');
    return true;
  });
  const live = new BroadcastChannel('z');
  assert.throws(() => live.postMessage(), { name: 'TypeError', code: 'ERR_MISSING_ARGS' });
  assert.throws(() => live.postMessage(() => 1), { name: 'DataCloneError' });
  live.close();
  assert.throws(() => new BroadcastChannel(), { name: 'TypeError', code: 'ERR_MISSING_ARGS', message: 'The "name" argument must be specified' });
  const numbered = new BroadcastChannel(1);
  assert.equal(numbered.name, '1');
  assert.equal(numbered.onmessage, null);
  numbered.close();
}

// ── a facet runs process after process in one global: the global is each one's own ──
// (review of 480c94943: a one-shot worker is reused, and the global kept the
// first process's constructor and registry.)
{
  const second = factory({}, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/app.js', '/home/user');
  assert.equal(globalThis.BroadcastChannel, second.BroadcastChannel, "the global is this process's worker_threads constructor");
  const stale = new BroadcastChannel('shared');
  stale.unref();
  const staleGot = [];
  stale.onmessage = (event) => staleGot.push(event.data);
  const viaGlobal = new globalThis.BroadcastChannel('shared');
  const viaModule = new second.BroadcastChannel('shared');
  const got = new Promise((resolve) => { viaModule.onmessage = (event) => resolve(event.data); });
  viaGlobal.postMessage('second');
  assert.equal(await got, 'second', "a global channel and a worker_threads channel of one process talk");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(staleGot, [], "an earlier process's channel hears nothing of a later one's");
  for (const channel of [stale, viaGlobal, viaModule]) channel.close();
}

console.log('worker-threads-broadcast-channel: ok');
