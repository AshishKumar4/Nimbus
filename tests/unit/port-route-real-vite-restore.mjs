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

import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { HIBERNATED_REAL, ROOT, VITE_PORT, hostRequest, makeWokenSession, pathRequest, readOnlyVfs } from './lib/vite-route-rig.mjs';

const routes =
  await importWorkerBundle({ 'packages/worker/src/session/routes.ts': ['handleFetch', 'restorePersistedDevServer', 'acceptCirrusHmrWs'] }, {
    stubs: [
      {
        filter: /observability\/heavy-alloc-coord\.js$/,
        contents: 'export const acquireHeavyAlloc = async () => () => {};\n'
          + 'export const acquireSupervisorReadAllocation = async () => () => {};\n',
      },
      // A fake real-vite controller: no facet, no ASSETS, just enough shape
      // for start-real-vite.ts to register it and for the port proxy to serve.
      {
        filter: /facets\/cirrus-real\.js$/,
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
      },
    ],
  });
const { handleFetch } = routes;

// No vite.config.* on disk → start-real-vite skips esbuild bundling entirely.
const makeVfs = () => readOnlyVfs(new Map([[`${ROOT}/package.json`, '{"name":"app"}']]));
const wake = (storage = {}) => makeWokenSession(storage, { vfs: makeVfs, routes, pidBase: 200 });

// 1. `/port/N/` (the host's forwarding target) restores real-vite, not the
//    Cirrus shim, and serves through it.
{
  const self = wake(HIBERNATED_REAL);
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
  const self = wake(HIBERNATED_REAL);
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
  const self = wake(HIBERNATED_REAL);
  // Wake it first so cirrusReal is running.
  await handleFetch(self, hostRequest(`/port/${VITE_PORT}/`));
  const res = await handleFetch(self, hostRequest(`/port/${VITE_PORT}/__nimbus_hmr`));
  assert.equal(res.status, 426, `HMR path must reach the in-DO WS handler (426 without upgrade), got ${res.status}`);
  console.log('  [3] /port/N/__nimbus_hmr is handled in-DO (426 without an upgrade), not proxied');
}

// 4. The same in-DO HMR handling still works on `/preview/`.
{
  const self = wake(HIBERNATED_REAL);
  await handleFetch(self, pathRequest('/preview/'));
  const res = await handleFetch(self, pathRequest('/preview/__nimbus_hmr'));
  assert.equal(res.status, 426);
  console.log('  [4] /preview/__nimbus_hmr keeps its in-DO handling');
}

// 5. Concurrent wake requests coalesce onto a single boot (no double facet).
{
  const self = wake(HIBERNATED_REAL);
  const [a, b] = await Promise.all([
    handleFetch(self, hostRequest(`/port/${VITE_PORT}/`)),
    handleFetch(self, hostRequest(`/port/${VITE_PORT}/index.html`)),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(self.portRegistry.getAll().length, 1, 'exactly one port registered after concurrent wake');
  console.log('  [5] parallel wake requests coalesce onto one real-vite boot');
}

// 6. The preview door reports the isolation headers of the document it
//    served a navigation, for the shell's offer; `/preview/?port=N` is that
//    port's document (the port registry's to report), not the door's.
{
  const self = wake(HIBERNATED_REAL);
  self.appDocuments = { vite: null, worker: null };
  const navigate = { headers: { 'Sec-Fetch-Mode': 'navigate' } };
  await handleFetch(self, pathRequest('/preview/', navigate));
  assert.deepEqual(self.appDocuments.vite, { embedderPolicy: 'unsafe-none', openerPolicy: 'unsafe-none', resourcePolicy: null });
  const recorded = self.appDocuments.vite;
  await handleFetch(self, pathRequest(`/preview/?port=${VITE_PORT}`, navigate));
  assert.equal(self.appDocuments.vite, recorded, '/preview/?port=N does not report for the preview door');
  await handleFetch(self, pathRequest('/preview/main.js', { headers: { 'Sec-Fetch-Mode': 'no-cors' } }));
  assert.equal(self.appDocuments.vite, recorded, 'a subresource is not the document');
  console.log('  [6] /preview/ reports its document policy; ?port=N and subresources do not');
}


console.log('port-route-real-vite-restore OK: real-vite persists, restores everywhere, and serves HMR in-DO');
