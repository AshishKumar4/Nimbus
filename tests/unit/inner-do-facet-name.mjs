#!/usr/bin/env bun
// A `wrangler dev` Worker's Durable Object is a facet of the session named
// by its binding and its id, each whole: two objects never share a facet,
// so they never share a running instance or its storage. Binding 'A-B' with
// id 'c' and binding 'A' with id 'B-c' are two objects. Nor is an object's
// facet a D1 database's (bindings/d1.ts d1DatabaseFacetName).
//
// Through the real _rpcInnerDoCall, on a session whose facets record the
// names they are asked for. Red before: both objects named facet
// 'innerDO-A-B-c'.
import assert from 'node:assert/strict';
import { _rpcInnerDoCall } from '../../packages/worker/src/session/rpc.ts';
import { registerInnerDoClass } from '../../packages/fabric/src/inner-do-registry.ts';
import { d1DatabaseFacetName } from '../../packages/worker/src/bindings/d1.ts';

const doId = 'a'.repeat(64);
const asked = [];
const self = {
  ctx: {
    id: { toString: () => doId },
    facets: {
      get(name) {
        asked.push(name);
        return { ping: () => name };
      },
      abort() {},
    },
  },
};
const cls = {};
registerInnerDoClass(doId, 'A-B', cls);
registerInnerDoClass(doId, 'A', cls);

const pairs = [['A-B', 'c'], ['A', 'B-c'], ['A', 'B'], ['A-B', 'c"']];
for (const [bindingName, id] of pairs) await _rpcInnerDoCall(self, { bindingName, id, path: ['ping'], args: [] });
assert.equal(new Set(asked).size, pairs.length, `each object its own facet: ${JSON.stringify(asked)}`);
for (const name of asked) {
  assert.ok(!name.startsWith('d1:'), `an object's facet is not in the D1 databases' names: ${name}`);
}
assert.ok(!asked.includes(d1DatabaseFacetName('A', 'B-c')));

// The same object, asked again, is the same facet.
await _rpcInnerDoCall(self, { bindingName: 'A-B', id: 'c', path: ['ping'], args: [] });
assert.equal(asked.at(-1), asked[0]);
console.log('inner-do-facet-name: ok');
