#!/usr/bin/env bun
// `nimbus wrangler dev` says "Worker built" for the build it serves, and only
// once it serves it. A build that something newer superseded — a rebuild a
// later one overtook, or one still bundling when its dev server was stopped
// and `wrangler dev` started again — says nothing and changes nothing: it
// does not replace the newer build's Durable Object classes, end its
// objects, or reload the preview. Red before: the stopped server's rebuild
// printed "Worker built" while the new server was still building (a client
// that opened the Worker then got the waiting page), and re-registered its
// old classes over the new server's.

import assert from 'node:assert/strict';
import { NimbusWrangler } from '../../packages/worker/src/wrangler/nimbus-wrangler.ts';
import { _rpcInnerDoCall } from '../../packages/worker/src/session/rpc.ts';

function platformFacets() {
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

// The class the loader hands back serves the VERSION its bundle declares.
const loader = {
  load({ modules }) {
    const version = /VERSION = "(\w+)"/.exec(modules['worker.js'])[1];
    return {
      getDurableObjectClass: () => class {
        constructor() { this.served = 0; }
        async fetch() { this.served++; return new Response(`${version} served=${this.served}`); }
      },
      getEntrypoint: (name) => (name === 'NimbusDurableObjectClasses' ? { missing: async () => [] } : {}),
    };
  },
};

const ROOT = 'home/user/app';
const ENTRY = `${ROOT}/src/index.js`;
const source = (version) => `export const VERSION = "${version}"; export class Counter {}`;
const files = new Map([
  [`${ROOT}/wrangler.jsonc`, JSON.stringify({
    name: 'app', main: 'src/index.js', compatibility_date: '2026-04-01',
    durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] },
  })],
  [ENTRY, source('v1')],
]);
const ctx = {
  id: { toString: () => 'wrangler-superseded-object' },
  facets: platformFacets(),
  exports: { NimbusDurableObjectNamespace: (options) => options },
};
/** What object `id`'s fetch answers: room-1 is one that runs on; a new id starts the class registered now. */
const answer = async (id = 'room-1') => (await _rpcInnerDoCall({ ctx }, {
  bindingName: 'COUNTER', id, path: ['fetch'], args: [new Request('https://inner.test/')],
})).text();

/** A dev server whose builds are held until `release()`, when `hold` is set. */
function devServer(name, { warn = false, onLog = () => {} } = {}) {
  const log = [];
  const reloads = [];
  const builds = [];
  let deliver = () => {};
  let watching = false;
  let hold = false;
  let requested = () => {};
  const server = new NimbusWrangler({
    vfs: { exists: (path) => files.has(path), readFileString: (path) => files.get(path) },
    bundleFs: {},
    namespace: { watchChanges(_path, listener) { deliver = listener; watching = true; return () => { watching = false; }; } },
    esbuild: {
      build([entry]) {
        const result = { errors: [], warnings: warn ? [{ text: 'a warning' }] : [], outputFiles: [{ contents: files.get(entry) }] };
        requested();
        if (!hold) return Promise.resolve(result);
        return new Promise((resolve) => { builds.push(() => resolve(result)); });
      },
    },
    env: { LOADER: loader },
    ctx,
    root: `/${ROOT}`,
    onLog: (message) => { log.push({ message, serving: server.isRunning }); onLog(message, server); },
    onHmrMessage: (message) => reloads.push(message),
  });
  return {
    server, log, reloads, name,
    watching: () => watching,
    built: () => log.filter((entry) => /Worker built/.test(entry.message)),
    holdBuilds(on) { hold = on; },
    /** Change the entry and wait for the rebuild it starts to ask for its bundle. */
    async change(version) {
      files.set(ENTRY, source(version));
      const asked = new Promise((resolve) => { requested = resolve; });
      deliver([{ type: 'change', path: `/${ENTRY}` }]);
      await asked;
    },
    release: (index) => builds[index](),
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
/** Wait until `ready()` holds, for at most five seconds. */
async function until(ready, what) {
  for (const deadline = Date.now() + 5_000; Date.now() < deadline; await settle()) if (await ready()) return;
  assert.fail(`timed out: ${what}`);
}

// ── "Worker built" is said once the build serves ──────────────────────────
const first = devServer('first');
assert.equal(await first.server.start(), true, 'the project builds');
const firstBuilt = first.built().map((entry) => entry.serving);
assert.equal(await answer(), 'v1 served=1');

// ── a stopped server's build says nothing and changes nothing ─────────────
// Its rebuild is still bundling when `wrangler dev` runs again: the command
// stops it, and starts a new server, which builds and serves.
first.holdBuilds(true);
await first.change('v2');
first.server.stop();
files.set(ENTRY, source('v3'));
const second = devServer('second');
assert.equal(await second.server.start(), true, 'the new server builds');
assert.equal(await answer(), 'v3 served=1', 'the new server serves its build');
const reloadsBefore = first.reloads.length;
const builtBefore = first.built().length;
first.release(0);
await settle();
assert.equal(first.built().length, builtBefore, 'the stopped server does not say "Worker built"');
assert.equal(first.reloads.length, reloadsBefore, 'nor reload the preview');
assert.equal(await answer(), 'v3 served=2', "nor end the new server's objects");
assert.equal(await answer('room-2'), 'v3 served=1', "nor replace the new server's classes");

// ── a rebuild a later one overtook says nothing and changes nothing ───────
second.holdBuilds(true);
await second.change('v4');
second.holdBuilds(false);
// The second change's rebuild is not held: it serves first.
await second.change('v5');
await until(() => second.reloads.length > 0, 'the later rebuild reloads the preview');
assert.equal(await answer(), 'v5 served=1', 'the later rebuild serves');
const builtAfter = second.built().length;
const reloadsAfter = second.reloads.length;
second.release(0);
await settle();
assert.equal(await answer(), 'v5 served=2', 'the overtaken rebuild does not end its objects');
assert.equal(await answer('room-3'), 'v5 served=1', 'nor replace its classes');
assert.equal(second.built().length, builtAfter, 'nor say "Worker built"');
assert.equal(second.reloads.length, reloadsAfter, 'nor reload the preview');
second.server.stop();

// ── a stop() that comes as the build serves, before start resumes ─────────
// It is queued from within the build's last step: start() reports the stop,
// and the server neither serves nor watches.
const third = devServer('third', { warn: true, onLog: (message, server) => { if (/a warning/.test(message)) queueMicrotask(() => server.stop()); } });
assert.equal(await third.server.start(), false, 'a start stopped as it served reports it');
assert.equal(third.server.isRunning, false, 'and the server does not serve');
assert.equal(third.watching(), false, 'nor watch');

// ── a server stopped, then started again, starts ─────────────────────────
const fourth = devServer('fourth');
assert.equal(await fourth.server.start(), true);
fourth.server.stop();
assert.equal(await fourth.server.start(), true, 'a start after a stop that came before it starts');
assert.equal(fourth.server.isRunning, true);
fourth.server.stop();

// ── a start stopped as it served, and started again at once ───────────────
// The second start does not make the first one's report true: the first
// build no longer serves.
let restarted = null;
const fifth = devServer('fifth', {
  warn: true,
  onLog: (message, server) => {
    if (restarted !== null || !/a warning/.test(message)) return;
    restarted = Promise.resolve();
    queueMicrotask(() => { server.stop(); fifth.holdBuilds(true); restarted = server.start(); });
  },
});
assert.equal(await fifth.server.start(), false, 'the first start, stopped as it served, reports it though another began');
fifth.holdBuilds(false);
fifth.release(0);
assert.equal(await restarted, true, 'the second start serves');
assert.equal(fifth.server.isRunning, true);
fifth.server.stop();
assert.deepEqual(firstBuilt, [true], '"Worker built" is said once the Worker serves');

console.log('ok - wrangler-dev-superseded-build ("Worker built" once it serves; a superseded build says and changes nothing)');
