#!/usr/bin/env bun
// port-route-real-vite-restore — a cirrus-real (real `vite`) session persists
// its config and comes back as real-vite after hibernation, on every route,
// and its HMR socket is accepted in-DO on the port route (not proxied).
//
// Before this, cirrus-real wrote no vite-config at all, so a woken session had
// nothing to restore and 502'd everywhere; and `/__nimbus_hmr` was handled only
// under `/preview/`, so the `<port>--<sid>` host — which forwards to /port/N —
// never accepted an HMR upgrade. Driven through `handleFetch`, the DO's public
// entrypoint, with only the heavy facet internals stubbed.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';

const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-real-vite-restore-test-'));
const build = await Bun.build({
  entrypoints: ['./packages/worker/src/session/routes.ts'],
  outdir: outputDir,
  target: 'bun',
  format: 'esm',
  plugins: [{
    name: 'cirrus-real-test-stubs',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
      builder.onResolve({ filter: /facets\/cirrus-real\.js$/ }, () => ({ path: 'cirrus', namespace: 'stub' }));
      builder.onResolve({ filter: /observability\/heavy-alloc-coord\.js$/ }, () => ({ path: 'heavy', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
        if (args.path === 'cf') {
          return { contents: 'export class DurableObject {}; export class WorkerEntrypoint {};', loader: 'js' };
        }
        if (args.path === 'heavy') {
          return {
            contents: 'export const acquireHeavyAlloc = async () => () => {};\n'
              + 'export const acquireSupervisorReadAllocation = async () => () => {};\n',
            loader: 'js',
          };
        }
        // A fake real-vite controller: no facet, no ASSETS, just enough shape
        // for start-real-vite.ts to register it and for the port proxy to serve.
        return {
          loader: 'js',
          contents: `
            export function shouldUseRealVite() { return true; }
            export class CirrusReal {
              constructor(opts) { this.opts = opts; this._running = false; }
              get isRunning() { return this._running; }
              async start() { this._running = true; }
              stop() { this._running = false; }
              attachHmrClient() { return 'client-1'; }
              async handleRequest(_req, innerPath) {
                return new Response('real-vite served ' + innerPath + ' base=' + this.opts.basePath, {
                  status: 200, headers: { 'X-Served-By': 'cirrus-real' },
                });
              }
              get stats() { return { snapshot: null, viteVersion: 'test' }; }
            }
          `,
        };
      });
    },
  }],
});
assert.equal(build.success, true, build.logs.map(String).join('\n'));
const entry = build.outputs.find((o) => o.path.endsWith('/routes.js'));
assert.ok(entry, 'the routes bundle was emitted');
const { handleFetch } = await import(pathToFileURL(entry.path).href);

const SID = 'nimble-otter-4271';
const BASE_PATH = `/s/${SID}`;
const PREVIEW_BASE = `${BASE_PATH}/preview`;
const VITE_PORT = 5173;
const ROOT = 'home/user/app';

function makeVfs() {
  // No vite.config.* on disk → start-real-vite skips esbuild bundling entirely.
  const files = new Map([[`${ROOT}/package.json`, '{"name":"app"}']]);
  const view = {
    exists: (p) => files.has(p),
    isDirectory: () => false,
    readFileString: (p) => files.get(p),
    readFile: (p) => new TextEncoder().encode(files.get(p) ?? ''),
  };
  return { as: () => view, events: { on: () => () => {} } };
}

function makeWokenSession(storage = {}) {
  const store = new Map(Object.entries(storage));
  let nextPid = 200;
  const self = {
    env: {},
    sqliteFs: null,
    esbuildService: null,
    viteDevServer: null,
    cirrusReal: null,
    _viteShimPid: null,
    _viteShimPort: null,
    _realViteRestore: null,
    sessionBasePath: BASE_PATH,
    sessionBasePathHydrated: true,
    portRegistry: new PortRegistry(),
    processes: { spawn: () => ({ pid: nextPid++ }), appendOutput: () => {} },
    ctx: {
      storage: {
        async get(k) { return store.get(k); },
        async put(k, v) { store.set(k, v); },
        async delete(k) { store.delete(k); },
      },
      acceptWebSocket() {},
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

// What cirrus-real persists at start (see start-real-vite.ts).
const HIBERNATED_REAL = {
  'vite-config': {
    devServer: 'real', root: ROOT, port: VITE_PORT,
    basePath: PREVIEW_BASE, configDir: 'home/user/app',
  },
};

function hostRequest(path, init = {}) {
  return new Request(`https://nimbus-os.dev${path}`, { headers: { 'X-Nimbus-Base': '', ...(init.headers || {}) }, ...init });
}
function pathRequest(path, init = {}) {
  return new Request(`https://nimbus-os.dev${path}`, { headers: { 'X-Nimbus-Base': BASE_PATH, ...(init.headers || {}) }, ...init });
}

// 1. `/port/N/` (the host's forwarding target) restores real-vite, not the
//    Cirrus shim, and serves through it.
{
  const self = makeWokenSession(HIBERNATED_REAL);
  const res = await handleFetch(self, hostRequest(`/port/${VITE_PORT}/`));
  assert.equal(res.status, 200, `expected real-vite to serve, got ${res.status}`);
  assert.equal(res.headers.get('X-Served-By'), 'cirrus-real', 'served by the real-vite facet');
  assert.ok(self.cirrusReal?.isRunning, 'cirrus-real is the restored server');
  assert.equal(self.viteDevServer, null, 'the Cirrus shim must NOT be built for a real-vite config');
  assert.equal(self.portRegistry.has(VITE_PORT), true, 'the port is registered after restore');
  console.log('  [1] /port/N restores real-vite (not the shim) and serves through it');
}

// 2. `/preview/` restores the same real-vite server — one restore path.
{
  const self = makeWokenSession(HIBERNATED_REAL);
  const res = await handleFetch(self, pathRequest('/preview/'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Served-By'), 'cirrus-real');
  assert.ok(self.cirrusReal?.isRunning);
  console.log('  [2] /preview/ restores the same real-vite server');
}

// 3. HMR on the port route is accepted in-DO, not proxied. A non-upgrade probe
//    reaches acceptCirrusHmrWs and gets its 426 — proof the port route now
//    routes `/__nimbus_hmr` to the in-DO handler rather than the registry.
{
  const self = makeWokenSession(HIBERNATED_REAL);
  // Wake it first so cirrusReal is running.
  await handleFetch(self, hostRequest(`/port/${VITE_PORT}/`));
  const res = await handleFetch(self, hostRequest(`/port/${VITE_PORT}/__nimbus_hmr`));
  assert.equal(res.status, 426, `HMR path must reach the in-DO WS handler (426 without upgrade), got ${res.status}`);
  console.log('  [3] /port/N/__nimbus_hmr is handled in-DO (426 without an upgrade), not proxied');
}

// 4. The same in-DO HMR handling still works on `/preview/`.
{
  const self = makeWokenSession(HIBERNATED_REAL);
  await handleFetch(self, pathRequest('/preview/'));
  const res = await handleFetch(self, pathRequest('/preview/__nimbus_hmr'));
  assert.equal(res.status, 426);
  console.log('  [4] /preview/__nimbus_hmr keeps its in-DO handling');
}

// 5. Concurrent wake requests coalesce onto a single boot (no double facet).
{
  const self = makeWokenSession(HIBERNATED_REAL);
  const [a, b] = await Promise.all([
    handleFetch(self, hostRequest(`/port/${VITE_PORT}/`)),
    handleFetch(self, hostRequest(`/port/${VITE_PORT}/index.html`)),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(self.portRegistry.getAll().length, 1, 'exactly one port registered after concurrent wake');
  console.log('  [5] parallel wake requests coalesce onto one real-vite boot');
}

await rm(outputDir, { recursive: true, force: true });

console.log('port-route-real-vite-restore OK: real-vite persists, restores everywhere, and serves HMR in-DO');
