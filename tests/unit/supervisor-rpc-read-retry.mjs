#!/usr/bin/env bun
// A facet's filesystem read survives the platform dropping the call to the
// host.
//
// SupervisorRPC forwards every facet syscall to the session Durable Object.
// Measured live: that call occasionally fails with "Network connection
// lost." and `retryable: true` while the session itself is fine, and when it
// was CPython's `stat` of its stdlib the interpreter failed to start
// ("failed to get the Python codec of the filesystem encoding"). A read
// changes nothing, so it is repeated on a fresh stub; a write is never
// repeated, since the dropped call may already have run; and an overloaded
// host is never retried, per Cloudflare's error-handling contract.

import assert from 'node:assert/strict';
import { mock } from 'bun:test';

mock.module('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  },
}));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');

const dropped = (extra = {}) => Object.assign(new Error('Network connection lost.'), { retryable: true }, extra);

/** A host that fails the first `failures` calls with `error`, then answers. */
function host(failures, error) {
  const calls = [];
  const stubs = new Set();
  const env = {
    NIMBUS_SESSION: {
      idFromName: (id) => ({ toString: () => id }),
      idFromString: (id) => ({ toString: () => id }),
      get() {
        const stub = {
          async supervisorOp(envelope) {
            calls.push(envelope.op);
            stubs.add(stub);
            if (calls.length <= failures) throw error();
            return envelope.op === 'stat' ? { type: 'file', size: 3845898 } : 1;
          },
        };
        return stub;
      },
    },
  };
  const rpc = new SupervisorRPC({ props: { doId: 'session', pid: 7, writerId: 'w1' } }, env);
  return { rpc, calls, stubs };
}

{
  const { rpc, calls, stubs } = host(1, () => dropped());
  const st = await rpc.stat('home/user/.nimbus/runtimes/cpython/3.13.14/lib/python313.zip');
  assert.equal(st?.size, 3845898, 'a read the platform dropped once did not answer');
  assert.deepEqual(calls, ['stat', 'stat']);
  assert.equal(stubs.size, 2, 'the retry reused the stub that threw');
  console.log('  ok  a dropped read is answered on a fresh stub');
}

{
  const { rpc, calls } = host(1, () => dropped());
  await assert.rejects(() => rpc.writeFile('home/user/x', 'y'), /Network connection lost/);
  assert.deepEqual(calls, ['writeFile'], 'a dropped write was repeated');
  console.log('  ok  a dropped write is surfaced, not repeated');
}

{
  const { rpc, calls } = host(1, () => dropped({ overloaded: true }));
  await assert.rejects(() => rpc.readdir('home/user'), /Network connection lost/);
  assert.deepEqual(calls, ['readdir'], 'an overloaded host was retried');
  console.log('  ok  an overloaded host is not retried');
}

{
  const { rpc, calls } = host(Infinity, () => dropped());
  await assert.rejects(() => rpc.fsReadRange('home/user/x', 0, 10), /Network connection lost/);
  assert.equal(calls.length, 3, `a read that never lands was tried ${calls.length} times`);
  console.log('  ok  a read that keeps dropping fails after a bounded number of attempts');
}

console.log('supervisor-rpc-read-retry: ok');
