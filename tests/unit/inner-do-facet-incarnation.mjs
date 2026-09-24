#!/usr/bin/env bun
// An inner Durable Object's facet can outlive the session incarnation that
// started it (a pending timer or outgoing call keeps it running). The next
// incarnation rebuilds the inner worker, so its class for the same facet name
// is new, and on the platform a get() with a new class on that running facet
// resets the whole session object.

import assert from 'node:assert/strict';
import { _rpcInnerDoFetch } from '../../packages/worker/src/session/rpc.ts';
import { registerInnerDoClass } from '../../packages/fabric/src/inner-do-registry.ts';

// ctx.facets of one object, shared by its incarnations: a running facet
// outlives the incarnation that started it, get() reuses a running facet
// without calling start, and abort ends it but keeps its storage.
function facetsOfOneObject() {
  const running = new Map();
  const stored = new Map();
  return {
    get(name, start) {
      return {
        async fetch(request) {
          let instance = running.get(name);
          if (!instance) {
            const { class: InnerDo, id } = await start();
            if (!stored.has(name)) stored.set(name, new Map());
            instance = new InnerDo({ id, storage: stored.get(name) });
            running.set(name, instance);
          }
          return instance.fetch(request);
        },
      };
    },
    abort(name) { running.delete(name); },
    delete(name) { running.delete(name); stored.delete(name); },
  };
}

const counter = (label) => class {
  constructor(state) {
    this.state = state;
    this.served = 0;
  }
  async fetch() {
    this.served++;
    const seen = (this.state.storage.get('seen') ?? 0) + 1;
    this.state.storage.set('seen', seen);
    return new Response(`${label} served=${this.served} seen=${seen}`);
  }
};

const DO_ID = 'inner-do-incarnation-object';
const facets = facetsOfOneObject();
const incarnation = () => ({ ctx: { id: { toString: () => DO_ID }, facets } });
const request = {
  bindingName: 'COUNTER', id: 'room-1', method: 'GET', url: 'https://inner.test/', headers: [], body: null,
};
const answer = async (host) => new TextDecoder().decode((await _rpcInnerDoFetch(host, request)).body);

const first = incarnation();
registerInnerDoClass(DO_ID, 'COUNTER', counter('A'));
assert.equal(await answer(first), 'A served=1 seen=1');

// The first incarnation ends with its facet still running; the next one rebuilds.
const next = incarnation();
registerInnerDoClass(DO_ID, 'COUNTER', counter('B'));
assert.equal(await answer(next), 'B served=1 seen=2',
  'the rebuilt class answers, not the facet the ended incarnation left running, and the storage is kept');
assert.equal(await answer(next), 'B served=2 seen=3',
  'a facet this incarnation opened is not ended by its next request');

console.log('ok - inner-do-facet-incarnation (a new incarnation ends the facet an old one left running; its own stays)');
