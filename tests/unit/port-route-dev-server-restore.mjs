#!/usr/bin/env bun
// port-route-dev-server-restore — every door onto a dev server waits on the
// session's restore of the dev servers its previous incarnation ran, and one
// with nothing to serve after it says why a server did not come back.
//
// A new incarnation runs each recorded dev server's command again
// (dev-servers.ts, dev-server-restore.mjs). The doors that reach one —
// `/preview/`, `/preview/?port=N`, `/port/N/` (what the `<port>--<sid>` host
// forwards to) and `/__nimbus/worker/` — must ask for that restore before
// they decide, or the first request after a reset answers "nothing running"
// while the server is coming back; and when the restore failed they answer
// what failed, why, and where its output is, never a bare 502 or the
// "start a dev server" page. Driven through `handleFetch`, the DO's public
// entrypoint, with the restore answered as the session's would.

import assert from 'node:assert/strict';

import { PREVIEW_CAPABILITY_HEADER } from '../../packages/worker/src/_shared/session-router.ts';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { ROOT, VITE_PORT, makeSession, pathRequest, readOnlyVfs, startVite } from './lib/vite-route-rig.mjs';

const routes = await importWorkerBundle({
  'packages/worker/src/session/routes.ts': ['handleFetch'],
  'packages/worker/src/session/port-capability.ts': ['persistPortCapability'],
});
const { handleFetch } = routes;

const INDEX_HTML = '<!DOCTYPE html><html><head><title>restored app</title></head><body><div id="root"></div></body></html>';
const makeVfs = () => readOnlyVfs(new Map([
  [`${ROOT}/index.html`, INDEX_HTML],
  [`${ROOT}/package.json`, JSON.stringify({ name: 'app', dependencies: {} })],
]));

/** A session whose restore runs the built-in dev server again once, as the session's own restore runs a recorded `vite`. */
function restoring() {
  const self = makeSession({}, { vfs: makeVfs, routes });
  let restore = null;
  self.restores = 0;
  self.restoreDevServers = () => restore ??= (async () => {
    self.restores += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await startVite(self, routes);
    return [];
  })();
  return self;
}

const FAILURE = Object.freeze({ command: 'wrangler dev', cwd: '/home/user/w', pid: 2000000007, reason: 'exit 1: no wrangler.jsonc in /home/user/w' });
/** A session whose restore of `wrangler dev` failed. */
function failed() {
  const self = makeSession({}, { vfs: makeVfs, routes, restore: async () => [FAILURE] });
  return self;
}
const assertFailurePage = async (response, door) => {
  assert.equal(response.status, 503, `${door}: ${response.status}`);
  const text = await response.text();
  assert.match(text, /did not start again after the session restarted/, door);
  assert.match(text, /wrangler dev {4}\(in \/home\/user\/w\)/, `${door} names the command and its directory`);
  assert.match(text, /no wrangler\.jsonc in \/home\/user\/w/, `${door} says why`);
  assert.match(text, /log of process 2000000007/, `${door} says where its output is`);
  assert.match(text, /Run the command again in its directory/, `${door} says what to do`);
};

// 1. Each door onto the server waits on the restore, and serves what it started.
for (const [door, path] of [['/preview/', '/preview/'], ['/port/N/', `/port/${VITE_PORT}/`], ['/preview/?port=N', `/preview/?port=${VITE_PORT}`]]) {
  const self = restoring();
  const response = await handleFetch(self, pathRequest(path));
  assert.equal(response.status, 200, `${door}: ${response.status}`);
  assert.match(await response.text(), /restored app/, `${door} serves the restored server on the first request`);
  console.log(`  [1] ${door} waits on the restore and serves the server it started`);
}

// 2. Requests that come together wait on one restore.
{
  const self = restoring();
  const responses = await Promise.all([pathRequest('/preview/'), pathRequest(`/port/${VITE_PORT}/`), pathRequest('/preview/main.js')].map((request) => handleFetch(self, request)));
  assert.equal(self.restores, 1, 'one restore');
  assert.equal(responses[0].status, 200);
  assert.equal(responses[1].status, 200);
  console.log('  [2] requests that come together wait on one restore');
}

// 3. A door with nothing to serve after a failed restore says why.
{
  await assertFailurePage(await handleFetch(failed(), pathRequest('/__nimbus/worker/')), '/__nimbus/worker/');
  await assertFailurePage(await handleFetch(failed(), pathRequest('/preview/')), '/preview/');
  await assertFailurePage(await handleFetch(failed(), pathRequest(`/port/${VITE_PORT}/`)), '/port/N/');
  console.log('  [3] the worker, preview and port doors answer a failed restore with what failed, why, and what to do');
}

// 4. A door whose server runs serves it, whatever else failed to come back.
{
  const self = await startVite(failed(), routes);
  const response = await handleFetch(self, pathRequest(`/port/${VITE_PORT}/`));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /restored app/);
  console.log('  [4] a door whose server runs serves it');
}

// 5. A link handed out for the port of a server that did not come back says
//    why too; a link that never was is still a 404.
{
  const LINK = '0123456789abcdef01234567';
  const self = failed();
  await routes.persistPortCapability(self, VITE_PORT, LINK);
  const linked = (capability) => pathRequest(`/port/${VITE_PORT}/`, { headers: { [PREVIEW_CAPABILITY_HEADER]: capability } });
  await assertFailurePage(await handleFetch(self, linked(LINK)), 'a link to /port/N/');
  assert.equal((await handleFetch(self, linked('fedcba9876543210fedcba98'))).status, 404, 'a link that never was');
  console.log('  [5] a link to a server that did not come back says why; a wrong one is a 404');
}

// 6. With nothing to restore, a port nothing listens on is still an honest 502.
{
  const self = makeSession({}, { vfs: makeVfs, routes });
  const response = await handleFetch(self, pathRequest('/port/3000/'));
  assert.equal(response.status, 502);
  console.log('  [6] nothing restored and nothing listening: 502');
}

console.log('port-route-dev-server-restore OK');
