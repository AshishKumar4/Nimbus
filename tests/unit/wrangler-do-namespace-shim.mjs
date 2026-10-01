#!/usr/bin/env bun
// A Worker under `wrangler dev` binds Durable Objects through a loopback whose
// every method is an RPC call, and code written for Cloudflare's API makes ids
// and stubs synchronously: `env.NS.get(env.NS.idFromName("a")).fetch(req)`
// passed the RpcPromise idFromName returned to get(), and workerd refused it
// ("Could not serialize object of type RpcPromise"). The Worker's main module
// now puts the real API in front of its bundle. This loads that main module,
// the bundle and the shim as the Worker Loader would, over a fake loopback.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DO_NAMESPACE_SHIM_MODULE, DO_NAMESPACE_SHIM_SOURCE, doNamespaceWrapperSource } from '../../packages/worker/src/wrangler/do-namespace-shim.ts';

const bundle = `
export class Counter {
  constructor(ctx, env) { this.env = env; }
  peerName() { return this.env.COUNTER.idFromName('peer').name; }
}
export class NotBound {}
export default {
  async fetch(request, env) {
    const id = env.COUNTER.idFromName('room-1');
    const stub = env.COUNTER.get(id);
    const fetched = await (await stub.fetch(request)).text();
    const called = await stub.increment(2, 'x');
    return Response.json({ fetched, called, id: id.toString(), name: id.name, stubId: stub.id.toString() });
  },
};
`;

const dir = mkdtempSync(join(tmpdir(), 'do-namespace-'));
try {
  writeFileSync(join(dir, 'user.js'), bundle);
  writeFileSync(join(dir, DO_NAMESPACE_SHIM_MODULE), DO_NAMESPACE_SHIM_SOURCE);
  writeFileSync(join(dir, 'worker.js'), doNamespaceWrapperSource(['COUNTER'], ['Counter', 'Not-An-Identifier']));
  const worker = await import(join(dir, 'worker.js'));

  // The loopback: only get(id) is called, and the stub it answers.
  const calls = [];
  const loopback = {
    get(id) {
      calls.push(['get', id]);
      return {
        fetch: async (request) => new Response(`fetched ${id} ${new URL(request.url).pathname}`),
        invoke: async (method, args) => ({ method, args, id }),
      };
    },
  };
  const env = { COUNTER: loopback, OTHER: 'kept' };

  const response = await worker.default.fetch(new Request('https://worker.test/path'), env, {});
  const body = await response.json();
  const expected = createHash('sha256').update('room-1').digest('hex');
  assert.equal(body.id, expected, 'idFromName is a 64-hex id, the same for the same name');
  assert.equal(body.name, 'room-1', 'and carries its name');
  assert.equal(body.stubId, expected, 'a stub carries its id');
  assert.equal(body.fetched, `fetched ${expected} /path`, 'stub.fetch reaches the object with the request');
  assert.deepEqual(body.called, { method: 'increment', args: [2, 'x'], id: expected }, 'an RPC method reaches the object with its arguments');
  assert.equal(env.OTHER, 'kept', 'other bindings are untouched');
  assert.notEqual(env.COUNTER, loopback, 'the binding is swapped in place, for cloudflare:workers env readers');

  const ns = env.COUNTER;
  assert.equal(await worker.default.fetch(new Request('https://worker.test/'), env, {}).then((r) => r.status), 200, 'a second request reuses the namespace');
  assert.equal(env.COUNTER, ns, 'and does not wrap it twice');
  assert.ok(ns.idFromName('a').equals(ns.idFromName('a')), 'equal names make equal ids');
  assert.ok(!ns.idFromName('a').equals(ns.idFromName('b')), 'different names do not');
  const unique = ns.newUniqueId();
  assert.match(unique.toString(), /^[0-9a-f]{64}$/, 'newUniqueId is 64 hex digits');
  assert.notEqual(unique.toString(), ns.newUniqueId().toString(), 'and fresh each time');
  assert.equal(unique.name, undefined, 'and has no name');
  assert.ok(ns.idFromString(expected).equals(ns.idFromName('room-1')), 'idFromString round-trips an id');
  assert.throws(() => ns.idFromString('room-1'), TypeError, 'idFromString refuses what is not an id');
  assert.throws(() => ns.get('room-1'), TypeError, 'get takes an id, as Cloudflare\'s does');
  assert.equal(ns.getByName('room-1').id.toString(), expected, 'getByName is get(idFromName(name))');

  // A bound class receives the namespace too; an unbound one is the bundle's own.
  const counter = new worker.Counter({}, { COUNTER: loopback });
  assert.equal(counter.peerName(), 'peer', 'a bound class constructor gets the namespace');
  assert.equal(worker.NotBound, (await import(join(dir, 'user.js'))).NotBound, 'other exports pass through');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('wrangler-do-namespace-shim: Cloudflare\'s namespace API runs unchanged over the loopback');
