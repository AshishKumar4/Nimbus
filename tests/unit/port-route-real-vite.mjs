#!/usr/bin/env bun
// port-route-real-vite — a cirrus-real (real `vite`) server is what the
// session's doors serve, on every route, and its HMR socket is accepted
// in-DO on the port route (not proxied).
//
// `/__nimbus_hmr` was once handled only under `/preview/`, so the
// `<port>--<sid>` host — which forwards to /port/N — never accepted an HMR
// upgrade. Driven through `handleFetch`, the DO's public entrypoint, with
// only the heavy facet internals stubbed.

import assert from 'node:assert/strict';

import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { REAL_VITE_STUB, ROOT, VITE_PORT, hostRequest, makeSession, pathRequest, readOnlyVfs, withResidentLauncher } from './lib/vite-route-rig.mjs';

const routes =
  await importWorkerBundle({
    'packages/worker/src/session/routes.ts': ['handleFetch', 'acceptCirrusHmrWs'],
    'packages/worker/src/session/start-real-vite.ts': ['startRealVite'],
  }, {
    stubs: [
      {
        filter: /observability\/heavy-alloc-coord\.js$/,
        contents: 'export const acquireHeavyAlloc = async () => () => {};\n'
          + 'export const acquireSupervisorReadAllocation = async () => () => {};\n',
      },
      // A real-vite controller with no facet and no ASSETS: it launches
      // through the session's manager, whose process the port proxy serves.
      { filter: /facets\/cirrus-real\.js$/, contents: REAL_VITE_STUB },
    ],
  });
const { handleFetch } = routes;

// No vite.config.* on disk → start-real-vite skips esbuild bundling entirely.
const makeVfs = () => readOnlyVfs(new Map([[`${ROOT}/package.json`, '{"name":"app"}']]));
/** A session running real Vite on VITE_PORT, as `NIMBUS_REAL_VITE=1 vite` in ROOT boots it. */
async function running() {
  const self = withResidentLauncher(makeSession({}, { vfs: makeVfs, routes, pidBase: 200 }));
  self.ensureSqliteFs();
  await routes.startRealVite(self, {
    root: ROOT, port: VITE_PORT, basePath: self.viteBasePath, configDir: ROOT,
    identity: { cwd: `/${ROOT}`, argv: ['vite'], cred: CRED_SESSION_USER },
  });
  return self;
}

// 1. `/port/N/` (the host's forwarding target) and `/preview/` serve real Vite, not the Cirrus shim.
{
  const self = await running();
  const port = await handleFetch(self, hostRequest(`/port/${VITE_PORT}/`));
  assert.equal(port.status, 200, `expected real-vite to serve, got ${port.status}`);
  assert.equal(port.headers.get('X-Served-By'), 'cirrus-real', 'served by the real-vite facet');
  const preview = await handleFetch(self, pathRequest('/preview/'));
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('X-Served-By'), 'cirrus-real');
  assert.equal(self.viteDevServer, null, 'the Cirrus shim is not built');
  console.log('  [1] /port/N and /preview/ serve real-vite');
}

// 3. HMR on the port route is accepted in-DO, not proxied. A non-upgrade probe
//    reaches acceptCirrusHmrWs and gets its 426 — proof the port route now
//    routes `/__nimbus_hmr` to the in-DO handler rather than the registry.
{
  const self = await running();
  const res = await handleFetch(self, hostRequest(`/port/${VITE_PORT}/__nimbus_hmr`));
  assert.equal(res.status, 426, `HMR path must reach the in-DO WS handler (426 without upgrade), got ${res.status}`);
  console.log('  [3] /port/N/__nimbus_hmr is handled in-DO (426 without an upgrade), not proxied');
}

// 4. The same in-DO HMR handling still works on `/preview/`.
{
  const self = await running();
  const res = await handleFetch(self, pathRequest('/preview/__nimbus_hmr'));
  assert.equal(res.status, 426);
  console.log('  [4] /preview/__nimbus_hmr keeps its in-DO handling');
}

// 5. The preview door reports the isolation headers of the document it
//    served a navigation, for the shell's offer; `/preview/?port=N` is that
//    port's document (the port registry's to report), not the door's.
{
  const self = await running();
  self.appDocuments = { vite: null, worker: null };
  const navigate = { headers: { 'Sec-Fetch-Mode': 'navigate' } };
  await handleFetch(self, pathRequest('/preview/', navigate));
  assert.deepEqual(self.appDocuments.vite, { embedderPolicy: 'unsafe-none', openerPolicy: 'unsafe-none', resourcePolicy: null });
  const recorded = self.appDocuments.vite;
  await handleFetch(self, pathRequest(`/preview/?port=${VITE_PORT}`, navigate));
  assert.equal(self.appDocuments.vite, recorded, '/preview/?port=N does not report for the preview door');
  await handleFetch(self, pathRequest('/preview/main.js', { headers: { 'Sec-Fetch-Mode': 'no-cors' } }));
  assert.equal(self.appDocuments.vite, recorded, 'a subresource is not the document');
  console.log('  [5] /preview/ reports its document policy; ?port=N and subresources do not');
}


console.log('port-route-real-vite OK: real-vite serves on every route, and HMR in-DO');
