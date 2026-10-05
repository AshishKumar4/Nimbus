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

import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

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
const { handleFetch, restorePersistedDevServer: sessionRestorePersistedDevServer } = await import(pathToFileURL(entry.path).href);

const SID = 'nimble-otter-4271';
const BASE_PATH = `/s/${SID}`;
const VITE_PORT = 5173;
const ROOT = 'home/user/example-app';

const INDEX_HTML = '<!DOCTYPE html><html><head><title>hibernated app</title></head><body><div id="root"></div></body></html>';

function makeVfs() {
  const files = new Map([
    [`${ROOT}/index.html`, INDEX_HTML],
    [`${ROOT}/package.json`, JSON.stringify({ name: 'app', dependencies: {} })],
    // Read again by a restored server `vite` started (case 9).
    [`${ROOT}/vite.config.js`, "import react from '@vitejs/plugin-react';\nexport default { plugins: [react({ jsxImportSource: 'preact' })] };\n"],
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
    // The namespace as host code reads it: this fake session's one filesystem.
    getFilesystemAuthority() { this.ensureSqliteFs?.(); return { namespaceFs: (cred) => this.sqliteFs.as(cred) }; },
    viteDevServer: null,
    cirrusReal: null,
    _viteShimPid: null,
    _viteShimPort: null,
    sessionBasePath: BASE_PATH,
    sessionBasePathHydrated: true,
    portRegistry: new PortRegistry(),
    processes: {
      // An entry as the process table makes one: under the credential asked
      // for, else the session user's.
      spawn: (command, argv, cwd, opts = {}) => ({ pid: nextPid++, command, argv, cwd, cred: opts.cred ?? CRED_SESSION_USER }),
      appendOutput: () => {},
    },
    ctx: {
      storage: {
        async get(key) { return store.get(key); },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); },
        // The reservation paths run read-modify-write inside one unit; the
        // stub serializes them the way the DO storage does.
        async transaction(body) { return body(this); },
      },
    },
    get nimbusDebug() { return false; },
    get viteBasePath() { return (this.sessionBasePath || '') + '/preview'; },
    async hydrateSessionBasePath() {},
    ensureSqliteFs() { if (!this.sqliteFs) this.sqliteFs = makeVfs(); },
    // No facet pool in this harness: cold /@modules/ misses take the legacy path.
    ensureBundlePool() { return null; },
    restorePersistedDevServer: (onlyPort) => sessionRestorePersistedDevServer(self, onlyPort),
  };
  self.store = store;
  return self;
}

/** What survives an eviction: DO storage, and nothing else. */
function hibernate(self) {
  return makeWokenSession(Object.fromEntries(self.store));
}

const HIBERNATED = {
  'vite-config': { root: ROOT, basePath: `${BASE_PATH}/preview`, port: VITE_PORT,
    identity: { cwd: `/${ROOT}`, argv: ['vite'], cred: CRED_SESSION_USER },
  },
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

// 8. A config written before it recorded who the server ran as is not
//    restored: it would read the project as someone else.
{
  const self = makeWokenSession({ 'vite-config': { root: ROOT, basePath: `${BASE_PATH}/preview`, port: VITE_PORT } });
  const response = await handleFetch(self, request(`/port/${VITE_PORT}/`));
  assert.equal(response.status, 502, 'nothing serves the port');
  assert.equal(self.viteDevServer, null, 'and no server was started for it');
  console.log('  [8] a config that names no credential is not restored');
}

// 9. A server `vite` started starts from what was kept of its vite.config
//    (its esbuild settings too), reads it again after the restore (it may
//    have changed unwatched), and what it reads is what the next restore
//    starts from; one the config of which came with the request (no
//    configDir) never re-reads.
{
  // Kept, with no directory to read again: the restored server compiles as it says.
  const kept = { esbuild: { jsxDev: true, jsx: 'transform' }, hasConfig: true, unread: [] };
  const plainKept = makeWokenSession({ 'vite-config': { ...HIBERNATED['vite-config'], viteEsbuild: kept } });
  await handleFetch(plainKept, request('/preview/'));
  assert.deepEqual(plainKept.viteDevServer.viteEsbuild, kept, 'the restored server compiles as the kept vite.config said');

  const persisted = { ...HIBERNATED['vite-config'], configDir: ROOT, define: { __APP__: '"one"' }, viteEsbuild: kept };
  const self = makeWokenSession({ 'vite-config': persisted });
  const response = await handleFetch(self, request('/preview/'));
  assert.equal(response.status, 200);
  const server = self.viteDevServer;
  assert.equal(server.configDir, ROOT, 'the restored server re-reads the vite.config it was started from');
  // The re-read after the restore: the project's vite.config says preact now.
  await server.readConfigAgain();
  const reread = { esbuild: { jsxDev: true, jsx: 'automatic', jsxImportSource: 'preact' }, hasConfig: true, unread: [] };
  assert.deepEqual(server.viteEsbuild, reread, 'the restored server reads its vite.config again');
  assert.deepEqual(self.store.get('vite-config').viteEsbuild, reread, 'and what it read is kept');
  server.onConfigChange({ alias: { '@': './src' }, define: { __APP__: '"two"' }, injectBasename: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stored = self.store.get('vite-config');
  assert.deepEqual([stored.define, stored.aliases, stored.injectBasename], [{ __APP__: '"two"' }, { '@': './src' }, false], 'the config read again is kept');
  assert.equal(stored.configDir, ROOT);
  assert.deepEqual(stored.identity, persisted.identity, 'with the rest of what a restore needs');

  const plain = makeWokenSession(HIBERNATED);
  await handleFetch(plain, request('/preview/'));
  assert.equal(plain.viteDevServer.configDir, null, 'a config with no directory is never read again');
  console.log('  [9] a restored server reads its vite.config again, and keeps what it reads');
}

// 10. A restored server's reloads reach the browser: an edit of a file after
//     the restore sends the session terminal's socket a full reload, as the
//     server `vite` started did. Before, a restored server sent them nowhere.
{
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  const write = (path, content) => {
    kernel.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
    kernel.writeFile(path, new TextEncoder().encode(content), { mode: 0o644 });
  };
  write(`${ROOT}/index.html`, INDEX_HTML);
  write(`${ROOT}/package.json`, JSON.stringify({ name: 'app' }));
  write(`${ROOT}/src/main.ts`, 'export const a = 1;\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const self = makeWokenSession(HIBERNATED);
  self.sqliteFs = vfs;
  const sent = [];
  self.terminal = { ws: { send: (message) => sent.push(JSON.parse(message)) } };
  const response = await handleFetch(self, request('/preview/'));
  assert.equal(response.status, 200);
  write(`${ROOT}/src/main.ts`, 'export const a = 2;\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent.filter((m) => m.type === 'hmr').map((m) => m.data.event), ['full-reload'], `an edit after the restore reloads the browser: ${JSON.stringify(sent)}`);
  self.viteDevServer.stop();
  console.log('  [10] a restored server\'s reloads reach the session terminal');
}

await rm(outputDir, { recursive: true, force: true });

console.log('port-route-vite-rehydrate OK: every route back to the dev server restores it');
