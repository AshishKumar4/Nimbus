#!/usr/bin/env bun
// `nimbus wrangler dev` rebuilds the inner Worker on a file change. An inner
// Durable Object that is already running must not keep serving the old build:
// the rebuild ends it (its storage stays), so the next request starts the
// rebuilt class, and stopping wrangler dev ends it too.

import assert from 'node:assert/strict';
import { NimbusWrangler } from '../../packages/worker/src/wrangler/nimbus-wrangler.ts';
import { _rpcInnerDoFetch } from '../../packages/worker/src/session/rpc.ts';

// ctx.facets: get() reuses a running facet without calling start, and abort
// ends it but keeps its storage.
function platformFacets() {
  const running = new Map();
  const stored = new Map();
  return {
    runningNames: () => [...running.keys()],
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

// The Worker Loader: the class it hands back serves the VERSION its bundle declares.
const loader = {
  load({ modules }) {
    const version = /VERSION = "(\w+)"/.exec(modules['worker.js'])[1];
    return {
      getDurableObjectClass: () => class {
        constructor(state) {
          this.state = state;
          this.served = 0;
        }
        async fetch() {
          this.served++;
          const seen = (this.state.storage.get('seen') ?? 0) + 1;
          this.state.storage.set('seen', seen);
          return new Response(`${version} served=${this.served} seen=${seen}`);
        }
      },
      getEntrypoint: () => ({}),
    };
  },
};

const ROOT = 'home/user/app';
const files = new Map([
  [`${ROOT}/wrangler.jsonc`, JSON.stringify({
    name: 'app',
    main: 'src/index.js',
    compatibility_date: '2026-04-01',
    durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] },
  })],
  [`${ROOT}/src/index.js`, 'export const VERSION = "v1"; export class Counter {}'],
]);
let deliverVfsEvents = () => {};
let rebuilt = () => {};
const facets = platformFacets();
const ctx = {
  id: { toString: () => 'wrangler-rebuild-object' },
  facets,
  exports: { NimbusDurableObjectNamespace: (options) => options },
};
const wrangler = new NimbusWrangler({
  vfs: { exists: (path) => files.has(path), readFileString: (path) => files.get(path) },
  vfsEvents: { on(listener) { deliverVfsEvents = listener; return () => {}; } },
  esbuild: {
    async build([entry]) {
      return { errors: [], warnings: [], outputFiles: [{ contents: files.get(entry) }] };
    },
  },
  env: { LOADER: loader },
  ctx,
  root: `/${ROOT}`,
  onLog: () => {},
  onHmrMessage: (message) => { if (message.event === 'full-reload') rebuilt(); },
});
const request = {
  bindingName: 'COUNTER', id: 'room-1', method: 'GET', url: 'https://inner.test/', headers: [], body: null,
};
const answer = async () => new TextDecoder().decode((await _rpcInnerDoFetch({ ctx }, request)).body);

assert.equal(await wrangler.start(), true, 'the project builds');
assert.equal(await answer(), 'v1 served=1 seen=1');
assert.equal(await answer(), 'v1 served=2 seen=2');

files.set(`${ROOT}/src/index.js`, 'export const VERSION = "v2"; export class Counter {}');
const rebuild = new Promise((resolve) => { rebuilt = resolve; });
deliverVfsEvents([{ type: 'change', path: `${ROOT}/src/index.js` }]);
await rebuild;
assert.equal(await answer(), 'v2 served=1 seen=3',
  'after a rebuild the running inner DO restarts on the new build, and its storage stays');

wrangler.stop();
assert.deepEqual(facets.runningNames(), [], 'stopping wrangler dev ends the inner DOs it started');

console.log('ok - wrangler-rebuild-restarts-inner-do (a rebuild restarts running inner DOs on the new build; stop ends them)');
