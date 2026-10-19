#!/usr/bin/env bun
// A Durable Object's pools note each facet call they make, for
// /api/_diag/session: whether the loader built the call's worker (cold) or
// answered with one it kept (warm), and the times. The last sixteen are
// kept, oldest first; another Durable Object's are its own.

import assert from 'node:assert/strict';
import { IsolatePool, recentFacetCalls } from '../../packages/fabric/src/isolate-pool.ts';
import { facetTaskSource } from '../../packages/core/src/runtime/facet-task.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';

/** A loader that keeps each worker it builds, as workerd's does: its callback runs once per id. */
function keepingLoader() {
  const built = new Map();
  return {
    LOADER: {
      get(id, load) {
        if (!built.has(id)) built.set(id, load());
        return {
          getEntrypoint: () => ({
            async fetch() {
              await built.get(id);
              return new Response('ok');
            },
          }),
        };
      },
    },
  };
}

const ctx = (name) => ({ id: { toString: () => name }, waitUntil() {} });
const one = ctx('facet-calls-one');
const other = ctx('facet-calls-other');
const call = (pool) => pool.submitRequest(facetTaskSource("async () => new Response('ok')"), new Request('https://facet.internal/run'));

const pool = new IsolatePool(keepingLoader(), one, { tag: 'calls', network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0 });
for (let i = 0; i < 20; i++) assert.equal(await (await call(pool)).text(), 'ok');

const calls = recentFacetCalls(one);
assert.equal(calls.length, 16, 'the last sixteen are kept');
assert.ok(calls.every((c) => c.tag === 'calls' && !c.cold && c.callMs >= 0), `the kept ones ran warm: ${JSON.stringify(calls.slice(0, 2))}`);
assert.ok(calls.every((c, i) => i === 0 || c.at >= calls[i - 1].at), 'oldest first');

// The first call is the cold one: seen while it is still among the last sixteen.
const fresh = new IsolatePool(keepingLoader(), other, { tag: 'fresh', network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0 });
await call(fresh);
await call(fresh);
assert.deepEqual(recentFacetCalls(other).map((c) => c.cold), [true, false], 'the first call built its worker, the next was answered warm');
assert.equal(recentFacetCalls(one).length, 16, 'another Durable Object\'s calls are its own');
console.log('isolate-pool-facet-calls: ok');
