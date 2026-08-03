#!/usr/bin/env bun
// port-route-vite-rehydrate — a hibernated session's dev server comes back on
// EVERY route that reaches it, not just `/preview/`.
//
// After a DO is evicted the port registry is empty and `viteDevServer` is
// null; only the persisted `vite-config` survives. The three public ways to
// reach that server — `/preview/`, `/preview/?port=N`, and `/port/N/` (which
// is also what the `<port>--<sid>` preview hostname forwards to) — must all
// restore it. Driven through `handleFetch`, the DO's public entrypoint.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PortRegistry } from '../../packages/worker/src/runtime/port-registry.ts';

// `session/routes.ts` reaches `cloudflare:workers` through its bindings
// module, which bun cannot resolve outside workerd. Same stub-and-bundle
// harness the other session unit tests use.
const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-port-rehydrate-test-'));
const build = await Bun.build({
  entrypoints: ['./packages/worker/src/session/routes.ts'],
  outdir: outputDir,
  target: 'bun',
  format: 'esm',
  plugins: [{
    name: 'cloudflare-workers-test-stub',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
        path: 'cloudflare-workers',
        namespace: 'test',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: 'export class DurableObject {}; export class WorkerEntrypoint {};',
        loader: 'js',
      }));
    },
  }],
});
assert.equal(build.success, true, build.logs.map(String).join('\n'));
const entry = build.outputs.find((output) => output.path.endsWith('/routes.js'));
assert.ok(entry, 'the routes bundle was emitted');
const { handleFetch } = await import(pathToFileURL(entry.path).href);

const SID = 'nimble-otter-4271';
const BASE_PATH = `/s/${SID}`;
const VITE_PORT = 5173;
const ROOT = 'home/user/app';

const INDEX_HTML = '<!DOCTYPE html><html><head><title>hibernated app</title></head><body><div id="root"></div></body></html>';

function makeVfs() {
  const files = new Map([
    [`${ROOT}/index.html`, INDEX_HTML],
    [`${ROOT}/package.json`, JSON.stringify({ name: 'app', dependencies: {} })],
  ]);
  const view = {
    exists: (p) => files.has(p),
    isDirectory: () => false,
    readFileString: (p) => files.get(p),
    readFile: (p) => new TextEncoder().encode(files.get(p) ?? ''),
  };
  return { as: () => view, events: { on: () => () => {} } };
}

/**
 * A supervisor that just woke from hibernation: `vite-config` is in storage,
 * nothing is in memory. `storage` seeds whatever the previous generation
 * persisted.
 */
function makeWokenSession(storage = {}) {
  const store = new Map(Object.entries(storage));
  let nextPid = 100;
  const self = {
    env: {},
    sqliteFs: null,
    esbuildService: null,
    viteDevServer: null,
    cirrusReal: null,
    _viteShimPid: null,
    _viteShimPort: null,
    sessionBasePath: BASE_PATH,
    sessionBasePathHydrated: true,
    portRegistry: new PortRegistry(),
    processes: {
      spawn: () => ({ pid: nextPid++ }),
      appendOutput: () => {},
    },
    ctx: {
      storage: {
        async get(key) { return store.get(key); },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); },
      },
    },
    get nimbusDebug() { return false; },
    get viteBasePath() { return (this.sessionBasePath || '') + '/preview'; },
    async hydrateSessionBasePath() {},
    ensureSqliteFs() { if (!this.sqliteFs) this.sqliteFs = makeVfs(); },
    seedFilesystem() {},
  };
  self.store = store;
  return self;
}

/** What survives an eviction: DO storage, and nothing else. */
function hibernate(self) {
  return makeWokenSession(Object.fromEntries(self.store));
}

const HIBERNATED = {
  'vite-config': { root: ROOT, basePath: `${BASE_PATH}/preview`, port: VITE_PORT },
};

function request(path) {
  return new Request(`https://nimbus-os.dev${path}`, {
    headers: { 'X-Nimbus-Base': BASE_PATH },
  });
}

// 1. `/preview/` restores the dev server. The pre-existing behaviour, pinned
//    so the shared path can't lose it.
{
  const self = makeWokenSession(HIBERNATED);
  const response = await handleFetch(self, request('/preview/'));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /hibernated app/);
  console.log('  [1] /preview/ rehydrates the persisted dev server');
}

// 2. `/port/<n>/` restores it too. This is the route the `<port>--<sid>`
//    preview hostname forwards to, so it is the one users reach by URL.
{
  const self = makeWokenSession(HIBERNATED);
  const response = await handleFetch(self, request(`/port/${VITE_PORT}/`));
  assert.equal(response.status, 200, `expected the port route to serve the app, got ${response.status}`);
  assert.match(await response.text(), /hibernated app/);
  console.log('  [2] /port/<n>/ rehydrates the persisted dev server');
}

// 3. `/preview/?port=N` — the third door onto the same registry.
{
  const self = makeWokenSession(HIBERNATED);
  const response = await handleFetch(self, request(`/preview/?port=${VITE_PORT}`));
  assert.equal(response.status, 200, `expected /preview/?port=N to serve the app, got ${response.status}`);
  assert.match(await response.text(), /hibernated app/);
  console.log('  [3] /preview/?port=N rehydrates the persisted dev server');
}

// 4. Restoring registers the port, so the process table and every later
//    request see one running server rather than a fresh one per request.
{
  const self = makeWokenSession(HIBERNATED);
  await handleFetch(self, request(`/port/${VITE_PORT}/`));
  assert.equal(self.portRegistry.has(VITE_PORT), true, 'restored server must be registered');
  assert.equal(self._viteShimPort, VITE_PORT);
  const pid = self._viteShimPid;
  assert.ok(pid > 0, 'restored server must own a pid');

  const second = await handleFetch(self, request(`/port/${VITE_PORT}/`));
  assert.equal(second.status, 200);
  assert.equal(self._viteShimPid, pid, 'a second request must reuse the restored server');
  console.log('  [4] the restored server is registered once and reused');
}

// 5. A port nothing ever listened on is still an honest 502 — restoring is
//    scoped to the persisted server, not attempted for every miss.
{
  const self = makeWokenSession(HIBERNATED);
  const response = await handleFetch(self, request('/port/3000/'));
  assert.equal(response.status, 502);
  assert.equal(self.viteDevServer, null, 'an unrelated port must not resurrect vite');
  console.log('  [5] an unrelated port is still 502, with no side effects');
}

// 6. A session that never ran a dev server has nothing to restore.
{
  const self = makeWokenSession({});
  const response = await handleFetch(self, request(`/port/${VITE_PORT}/`));
  assert.equal(response.status, 502);
  console.log('  [6] no persisted config means nothing to restore');
}

// 7. A dev server started on a non-default port comes back on THAT port.
//    What gets persisted at start decides what the restore can rebuild, so
//    the writer and the restore are pinned together.
{
  const started = makeWokenSession();
  const start = await handleFetch(started, new Request('https://nimbus-os.dev/api/start-vite', {
    method: 'POST',
    headers: { 'X-Nimbus-Base': BASE_PATH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT, port: 3100 }),
  }));
  assert.equal(start.status, 200);
  assert.equal(started.portRegistry.has(3100), true, 'the started server listens on 3100');

  const woken = hibernate(started);
  const response = await handleFetch(woken, request('/port/3100/'));
  assert.equal(response.status, 200, `expected port 3100 to come back, got ${response.status}`);
  assert.match(await response.text(), /hibernated app/);
  assert.equal(woken._viteShimPort, 3100);
  console.log('  [7] a non-default port survives hibernation on the port route');
}

await rm(outputDir, { recursive: true, force: true });

console.log('port-route-vite-rehydrate OK: every route back to the dev server restores it');
