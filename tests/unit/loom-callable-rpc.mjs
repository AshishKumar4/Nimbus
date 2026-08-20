#!/usr/bin/env bun
// Callable RPC, specified from the Agents SDK surface loom mirrors (agents
// 0.20.1 dist, index.js:883-934 server dispatch, client.js:129-151 client,
// index.js:7169-7233 StreamingResponse):
//
//   - ALLOWLIST: only a `callable()`-marked method answers; a missing or
//     unmarked method is an error FRAME ("does not exist" / "is not
//     callable"), never a crash.
//   - PLAIN CALL: awaited return value comes back as one
//     { success: true, done: true } frame; a throw carries the message only.
//   - STREAMING: the method gets a StreamingResponse PREPENDED to the args;
//     chunks are { done: false } frames; end() closes; a throw with the
//     stream open closes it with the error; writes after close are refused
//     no-ops returning false.
//   - CLIENT: one listener for all calls; ids correlate; plain calls time
//     out at 30s by default, streamed calls never (unless asked); close()
//     rejects everything pending.

import assert from 'node:assert/strict';
import { callable, callableMethods, isCallable } from '../../packages/loom/src/callable.ts';
import { dispatchRpc, StreamingResponse } from '../../packages/loom/src/rpc.ts';
import { actorClient } from '../../packages/loom/src/client.ts';

// ── Fixture: a loopback client socket wired straight into dispatchRpc ──────

function loopback(target) {
  const listeners = new Set();
  const serverConnection = {
    sent: [],
    send(message) {
      this.sent.push(JSON.parse(message));
      for (const listener of [...listeners]) listener({ data: message });
    },
  };
  const socket = {
    send(data) {
      const frame = JSON.parse(data);
      queueMicrotask(() => void dispatchRpc(target, serverConnection, frame));
    },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };
  return { socket, serverConnection };
}

class Greeter {
  greet(name) { return `hello ${name}`; }
  async add(a, b) { return a + b; }
  fail() { throw new Error('greeter refused'); }
  failWeird() { throw 'not-an-error'; }
  hidden() { return 'secret'; }
  async count(stream, upTo) {
    for (let i = 1; i <= upTo; i++) stream.send(i);
    stream.end('counted');
  }
  async leak(stream) { throw new Error('stream broke'); }
}
callable()(Greeter.prototype.greet);
callable()(Greeter.prototype.add);
callable()(Greeter.prototype.fail);
callable()(Greeter.prototype.failWeird);
callable({ streaming: true, description: 'counts up' })(Greeter.prototype.count);
callable({ streaming: true })(Greeter.prototype.leak);

// ── 1. Marking and enumeration ──────────────────────────────────────────────

{
  const greeter = new Greeter();
  assert.equal(isCallable(greeter.greet), true);
  assert.equal(isCallable(greeter.hidden), false);
  const methods = callableMethods(greeter);
  assert.deepEqual([...methods.keys()].sort(), ['add', 'count', 'fail', 'failWeird', 'greet', 'leak']);
  assert.deepEqual(methods.get('count'), { streaming: true, description: 'counts up' });

  // A subclass override without its own mark hides the parent's mark: the
  // override is what `this[name]` resolves to, and it is unmarked.
  class Quiet extends Greeter { greet() { return 'shh'; } }
  assert.equal(callableMethods(new Quiet()).has('greet'), false);
  assert.equal(callableMethods(new Quiet()).has('add'), true);
}

// ── 2. Plain calls: result, args, error envelopes ───────────────────────────

{
  const { socket } = loopback(new Greeter());
  const client = actorClient(socket);
  assert.equal(await client.call('greet', ['loom']), 'hello loom');
  assert.equal(await client.call('add', [2, 3]), 5);
  await assert.rejects(client.call('fail'), /greeter refused/);
  await assert.rejects(client.call('failWeird'), /Unknown error occurred/);
  await assert.rejects(client.call('missing'), /Method missing does not exist/);
  await assert.rejects(client.call('hidden'), /Method hidden is not callable/);
  client.close();
}

// ── 3. The typed stub proxy ─────────────────────────────────────────────────

{
  const { socket } = loopback(new Greeter());
  const client = actorClient(socket);
  const stub = client.stub();
  assert.equal(await stub.greet('stub'), 'hello stub');
  await assert.rejects(stub.hidden(), /is not callable/);
  // The stub is not thenable: resolving it must not fire an RPC named "then".
  assert.equal(stub.then, undefined);
  assert.equal(await Promise.resolve(stub), stub);
  client.close();
}

// ── 4. Streaming: chunks, final value, and mid-stream throw ────────────────

{
  const { socket } = loopback(new Greeter());
  const client = actorClient(socket);
  const chunks = [];
  const final = await client.call('count', [3], { onChunk: (c) => chunks.push(c) });
  assert.deepEqual(chunks, [1, 2, 3]);
  assert.equal(final, 'counted');
  await assert.rejects(client.call('leak', [], { onChunk: () => {} }), /stream broke/);
  client.close();
}

// ── 5. StreamingResponse close discipline ───────────────────────────────────

{
  const sent = [];
  const stream = new StreamingResponse({ send: (m) => sent.push(JSON.parse(m)) }, 'id-1');
  assert.equal(stream.send('a'), true);
  assert.equal(stream.end('b'), true);
  assert.equal(stream.isClosed, true);
  assert.equal(stream.send('after'), false);
  assert.equal(stream.end(), false);
  assert.equal(stream.error('late'), false);
  assert.deepEqual(sent.map((f) => f.done), [false, true]);
}

// ── 6. A gone peer is tolerated; other send errors propagate ────────────────

{
  const goneConnection = {
    send() { throw new TypeError("Can't call WebSocket send() after close()."); },
  };
  // Must not throw: the reply has no one waiting for it.
  await dispatchRpc(new Greeter(), goneConnection, { type: 'rpc', id: 'x', method: 'greet', args: ['gone'] });

  const brokenConnection = { send() { throw new Error('disk on fire'); } };
  await assert.rejects(
    dispatchRpc(new Greeter(), brokenConnection, { type: 'rpc', id: 'y', method: 'greet', args: [] }),
    /disk on fire/,
  );
}

// ── 7. Client timeout and close() ───────────────────────────────────────────

{
  const silentSocket = {
    send() {},
    addEventListener() {},
    removeEventListener() {},
  };
  const client = actorClient(silentSocket);
  await assert.rejects(client.call('greet', [], { timeoutMs: 20 }), /timed out after 20ms/);

  const hanging = client.call('greet', [], { timeoutMs: 60_000 });
  client.close();
  await assert.rejects(hanging, /RPC client closed/);
}

console.log('loom-callable-rpc: all assertions passed');
