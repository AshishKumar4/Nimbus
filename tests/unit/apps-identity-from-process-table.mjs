#!/usr/bin/env bun
// Every process serving a port has an identity, journal row or not.
//
// The app verbs used to answer only for residents the facet manager launched
// (a journal row carries the derived owner). The most common launch — `npx
// vite`, which the `vite` builtin runs in process and registers directly —
// had no row, so `apps.expose(5173)` refused it. One resolver now answers for
// every pid: the journal row when there is one, the process table's cwd+argv
// otherwise. Pinned here through the public RPC surface over the facet-host
// harness:
//
//   1. a serving pid with no journal row (the dev-server shape) exposes,
//      lists as running, rotates, re-adopts its link after a restart with the
//      same cwd+argv, refuses a different program on its port, and removes —
//      the removal ending the live process;
//   2. a bin/npx resident IS journalled at spawn — the wrapper pid the bin
//      resolver allocated carries a row with the derived owner, and the
//      resolver answers the row, not the table;
//   3. the Cirrus dev server started through `/api/start-vite`, exposed under
//      a name, survives a hibernation: the restored pid derives the same
//      identity from the persisted cwd+argv, re-adopts the shared link at
//      registration, and rotates as the same application;
//   4. a pid that is neither running nor journalled is refused by name;
//   5. the SDK's own launch: `startProcess('npx vite …')` allocates the wrapper
//      pid the builtin adopts and registers the port under — the shell line
//      returning must not mark that pid exited, or the port is served by a
//      dead pid nothing can expose (the live failure).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { deriveResidentOwner } from '../../packages/worker/src/facets/resident-identity.ts';
import { readPortReservation } from '../../packages/worker/src/session/port-capability.ts';
import { createFacetWorld, createFacetCtx } from './facet-host-harness.mjs';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { buildPublicPreviewHost } from '../../packages/worker/src/_shared/preview-host.ts';
import { PUBLIC_BEARER_HEADER, PREVIEW_CAPABILITY_HEADER } from '../../packages/worker/src/_shared/session-router.ts';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-apps-identity-'));
const build = await Bun.build({
  entrypoints: ['./packages/worker/src/session/routes.ts', './packages/worker/src/session/port-capability.ts', './packages/worker/src/session/programmatic.ts', './packages/worker/src/facets/compose.ts'],
  outdir: outputDir,
  target: 'bun',
  format: 'esm',
  plugins: [{
    name: 'cloudflare-workers-test-stub',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: 'export class DurableObject {}; export class WorkerEntrypoint {};',
        loader: 'js',
      }));
    },
  }],
});
assert.equal(build.success, true, build.logs.map(String).join('\n'));
const { handleFetch, restorePersistedDevServer: sessionRestorePersistedDevServer } = await import(pathToFileURL(build.outputs.find((o) => o.path.endsWith('/routes.js')).path).href);
const { routeToSessionPort } = await import(pathToFileURL(build.outputs.find((o) => o.path.endsWith('/port-capability.js')).path).href);
const { rpcExposeApp, rpcListApps, rpcRotateLink, rpcRemoveApp, rpcStartProcess } = await import(pathToFileURL(build.outputs.find((o) => o.path.endsWith('/programmatic.js')).path).href);
const { composeFacetManager } = await import(pathToFileURL(build.outputs.find((o) => o.path.endsWith('/compose.js')).path).href);

const SID = 'nimble-otter-4271';
const SUFFIX = 'nimbus-os.dev';
const TENANT = 'acme:alice';
const BASE_PATH = `/s/${SID}`;

function fakeDirectory() {
  const rows = new Map();
  return {
    rows,
    namespace: {
      idFromName(name) { return { name }; },
      get() {
        return {
          bind: async (cap, entry) => { rows.set(cap, entry); },
          unbind: async (cap) => { rows.delete(cap); },
          resolve: async (cap) => rows.get(cap) ?? null,
        };
      },
    },
  };
}

/** The VFS slice the in-process dev server reads: one index.html at the root. */
function fakeSessionFs(root) {
  const files = new Map([
    [`${root}/index.html`, '<!DOCTYPE html><html><head><title>identity app</title></head><body></body></html>'],
    [`${root}/package.json`, JSON.stringify({ name: 'app', dependencies: {} })],
  ]);
  const view = {
    exists: (p) => files.has(p),
    isDirectory: () => false,
    readFileString: (p) => files.get(p),
    readFile: (p) => new TextEncoder().encode(files.get(p) ?? ''),
  };
  return { as: () => view, events: { on: () => () => {} } };
}

function setup({ storage = new Map(), world, directory = fakeDirectory(), notices = [], sessionFs = null } = {}) {
  if (!world) {
    world = createFacetWorld(() => ({
      async startProcess() { return { ok: true }; },
      async handleHttpRequest(request) { return Response.json({ ok: true, path: new URL(request.url).pathname }); },
    }));
  }
  const ctx = createFacetCtx(world, `${TENANT}:${SID}`, storage);
  ctx.id = { name: `${TENANT}:${SID}`, toString: () => `${TENANT}:${SID}` };
  const env = {
    LOADER: world.loader,
    NIMBUS_PREVIEW_HOST_SUFFIX: SUFFIX,
    NIMBUS_PUBLIC_DIRECTORY: directory.namespace,
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname.replace(/^\//, '');
        try {
          const { readFile } = await import('node:fs/promises');
          return new Response(await readFile(new URL(`../../packages/worker/public/${path}`, import.meta.url)), { status: 200 });
        } catch {
          return new Response('', { status: 404 });
        }
      },
    },
  };
  const processes = new SessionProcessSupervisor();
  const portRegistry = new PortRegistry();
  const fm = new FacetManager(ctx, env, processes, portRegistry, processHostFor, { notify: (line) => notices.push(line) });
  const vfsHarness = sessionFs ? null : createSqliteVfsTestHarness();
  const vfs = sessionFs ?? new SqliteVFS(vfsHarness.sql, vfsHarness.ctx);
  if (sessionFs === null) {
    fm.setVfs(vfs);
  }
  const self = {
    shell: {},
    env,
    ctx,
    portRegistry,
    facetManagerComposed: null,
    facetManager: fm,
    processes,
    sessionBasePath: BASE_PATH,
    sessionBasePathHydrated: true,
    sessionOrigin: 'https://probe.test',
    sqliteFs: sessionFs,
    esbuildService: null,
    cirrusReal: null,
    viteDevServer: null,
    _viteShimPid: null,
    _viteShimPort: null,
    get nimbusDebug() { return false; },
    get viteBasePath() { return `${BASE_PATH}/preview`; },
    async hydrateSessionBasePath() {},
    ensureSqliteFs() {},
    // No facet pool in this harness: cold /@modules/ misses take the legacy path.
    ensureBundlePool() { return null; },
    seedFilesystem() {},
    ensureFacetManager() {
      this.facetManagerComposed ??= composeFacetManager({
        ctx, env, processes, portRegistry, vfs,
        hooks: { onExternalExit() {}, notify() {}, requestLaunchTurn() {} },
      });
      this.facetManager = fm;
      return this.facetManagerComposed;
    },
    restorePersistedDevServer: (onlyPort) => sessionRestorePersistedDevServer(self, onlyPort),
    ensureDurableAppOnPort: (port) => fm.ensureDurableAppOnPort(port),
  };
  return { world, ctx, env, fm, processes, portRegistry, storage, self, directory, notices };
}

const bearer = (port, cap) => new Request(`https://${buildPublicPreviewHost(SID, port, cap, SUFFIX)}/`, {
  headers: { [PREVIEW_CAPABILITY_HEADER]: cap, [PUBLIC_BEARER_HEADER]: '1' },
});
const journalRows = async (ctx) => [...(await ctx.storage.list({ prefix: 'resident-launch:' })).values()];
const stub = (tag) => ({ handleHttpRequest: async () => new Response(tag) });

/** A serving process nothing journalled: the shape the `vite` builtin registers. */
async function serve(t, { command, argv, cwd, port, tag }) {
  const entry = t.processes.spawn(command, argv, cwd, { longRunning: true });
  t.portRegistry.bindFacetStub(entry.pid, stub(tag));
  await t.fm.registerPort(entry.pid, port);
  return entry;
}

// ── 1. the dev-server shape: expose, list, rotate, restart, refuse, remove ──
{
  const t = setup();
  const { self, fm, ctx, portRegistry, processes, directory } = t;
  const CWD = '/home/user/app';
  const ARGV = ['npx vite --host --port 5173'];
  const vite = await serve(t, { command: 'npx vite --host --port 5173', argv: ARGV, cwd: CWD, port: 5173, tag: 'vite-1' });
  assert.equal(await ctx.storage.get(`resident-launch:${vite.pid}`), undefined, 'the dev server has no journal row');
  const owner = await deriveResidentOwner(CWD, ARGV);

  const exposed = await rpcExposeApp(self, 5173, { visibility: 'public', name: 'web' });
  assert.equal(exposed.owner, owner, 'expose derived the identity from the process table');
  assert.equal(exposed.pid, vite.pid);
  assert.equal(exposed.name, 'web');
  assert.match(exposed.capability, /^[a-f0-9]{24}$/);
  assert.equal(exposed.url, `https://${exposed.capability}--web--${SID}.${SUFFIX}/`);
  assert.deepEqual(await readPortReservation(ctx, 5173), { kind: 'derived', owner, capability: exposed.capability, visibility: 'public', name: 'web' });
  assert.equal(portRegistry.hasCapability(5173, exposed.capability), true);
  assert.equal((await routeToSessionPort(self, 5173, bearer(5173, exposed.capability), '/', '', exposed.capability)).status, 200);

  const listed = (await rpcListApps(self)).find((app) => app.owner === owner);
  assert.deepEqual(listed, {
    owner, name: 'web', port: 5173, pid: vite.pid, status: 'running', visibility: 'public',
    capability: exposed.capability, restart: 'never', diagnostic: null,
    url: `https://${exposed.capability}--web--${SID}.${SUFFIX}/`,
  }, 'apps.list shows the un-journalled server running under its derived identity');

  const rotated = await rpcRotateLink(self, 'web');
  assert.notEqual(rotated.capability, exposed.capability);
  assert.equal(rotated.pid, vite.pid);
  assert.equal((await routeToSessionPort(self, 5173, bearer(5173, exposed.capability), '/', '', exposed.capability)).status, 404, 'the old link is dead');
  assert.equal((await routeToSessionPort(self, 5173, bearer(5173, rotated.capability), '/', '', rotated.capability)).status, 200, 'the new link answers');

  // A restart of the same program — same cwd, same argv, a new pid — is the
  // same application: its registration re-adopts the shared link.
  fm.kill(vite.pid);
  const again = await serve(t, { command: 'npx vite --host --port 5173', argv: ARGV, cwd: CWD, port: 5173, tag: 'vite-2' });
  assert.notEqual(again.pid, vite.pid);
  assert.equal(portRegistry.hasCapability(5173, rotated.capability), true, 'the restarted server re-adopted the capability');
  assert.equal(directory.rows.get(rotated.capability)?.name, 'web', 'the directory row survived the restart');
  assert.equal((await rpcListApps(self)).find((app) => app.owner === owner)?.pid, again.pid);

  // A different program on the same port is a foreign occupant: the link
  // retires, and the name refuses to be exposed or rotated onto it.
  fm.kill(again.pid);
  const other = await serve(t, { command: 'node other.js', argv: ['node other.js'], cwd: CWD, port: 5173, tag: 'other' });
  assert.equal(portRegistry.hasCapability(5173, rotated.capability), false, 'a different program never sees the link');
  assert.equal((await readPortReservation(ctx, 5173)).owner, owner, 'the reservation stays with the identity');
  assert.equal(directory.rows.has(rotated.capability), false);
  const foreign = await deriveResidentOwner(CWD, ['node other.js']);
  await assert.rejects(rpcRotateLink(self, 'web'), { message: `port 5173 is served by a different process (owner ${foreign})` });
  await assert.rejects(rpcExposeApp(self, { owner }, { visibility: 'public' }), { message: `port 5173 is served by a different process (owner ${foreign})` });
  assert.equal((await rpcListApps(self)).find((app) => app.owner === foreign)?.status, 'running', 'the foreign server is listed under its own identity');

  // remove ends the live process — the one the verbs identified, not a
  // journal row — and releases the reservation.
  fm.kill(other.pid);
  const third = await serve(t, { command: 'npx vite --host --port 5173', argv: ARGV, cwd: CWD, port: 5173, tag: 'vite-3' });
  const removed = await rpcRemoveApp(self, 'web');
  assert.deepEqual(removed, { owner, removed: true, port: 5173 });
  assert.notEqual(processes.get(third.pid)?.state, 'running', 'remove killed the serving process');
  assert.equal(portRegistry.has(5173), false);
  assert.equal(await readPortReservation(ctx, 5173), null);
  assert.equal((await rpcListApps(self)).some((app) => app.owner === owner), false);
}

// ── 2. a bin/npx resident is journalled at spawn under the derived owner ────
{
  const { fm, ctx, processes } = setup();
  // The npm-bin resolver allocates the wrapper pid, then the node runner
  // launches the resident under it (skipSpawn + callerPid).
  const wrapper = processes.spawn('serve -p 3000', ['serve', '-p', '3000'], '/home/user/app', { longRunning: true });
  const argv = ['/home/user/app/node_modules/serve/build/main.js', '-p', '3000'];
  const spawned = await fm.spawnNode('const http = require("http"); http.createServer(() => {}).listen(3000);', {
    command: 'serve -p 3000', argv, cwd: '/home/user/app', skipSpawn: true, callerPid: wrapper.pid,
  });
  assert.equal(spawned.pid, wrapper.pid, 'the resident runs under the wrapper pid');
  const row = (await journalRows(ctx)).find((r) => r.pid === wrapper.pid);
  assert.ok(row, 'the bin resident has a journal row — it re-drives like any resident');
  assert.equal(row.owner, await deriveResidentOwner('/home/user/app', argv), 'the row carries the launch\'s derived owner');
  const identity = await fm.residentIdentity(wrapper.pid);
  assert.equal(identity.owner, row.owner, 'the resolver answers the row, never a second source');
}

// ── 3. the Cirrus dev server, exposed, survives hibernation as the same app ──
{
  const ROOT = 'home/user/app';
  const directory = fakeDirectory();
  const first = setup({ sessionFs: fakeSessionFs(ROOT), directory });
  const started = await handleFetch(first.self, new Request('https://probe.test/api/start-vite', {
    method: 'POST', headers: { 'X-Nimbus-Base': BASE_PATH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: ROOT, port: 5173 }),
  }));
  assert.equal(started.status, 200, await started.clone().text());
  const pid = first.self._viteShimPid;
  const identity = await first.fm.residentIdentity(pid);
  assert.match(identity.owner, /^auto:[a-f0-9]{24}$/, 'the in-process dev server has a derived identity');
  const persisted = await first.ctx.storage.get('vite-config');
  assert.deepEqual(persisted.identity, { cwd: first.processes.get(pid).cwd, argv: first.processes.get(pid).argv },
    'the identity inputs are persisted with the dev-server config');

  const exposed = await rpcExposeApp(first.self, 5173, { visibility: 'public', name: 'web' });
  assert.equal(exposed.owner, identity.owner);
  assert.equal((await rpcListApps(first.self)).find((app) => app.name === 'web')?.status, 'running');

  // Hibernation: a new instance over the same storage, nothing in memory.
  const next = setup({ storage: first.storage, world: first.world, sessionFs: fakeSessionFs(ROOT), directory });
  next.processes.setPidBase(PID_GEN_STRIDE);
  const woken = await handleFetch(next.self, new Request(`https://probe.test/port/5173/`, { headers: { 'X-Nimbus-Base': BASE_PATH } }));
  assert.equal(woken.status, 200, `the restored dev server answers, got ${woken.status}`);
  assert.match(await woken.text(), /identity app/);
  const restoredPid = next.self._viteShimPid;
  assert.ok(restoredPid > PID_GEN_STRIDE, 'the restored server owns a pid of the new generation');
  assert.equal((await next.fm.residentIdentity(restoredPid)).owner, identity.owner, 'the restored server is the same application');
  assert.equal(next.portRegistry.hasCapability(5173, exposed.capability), true, 'registration re-adopted the shared link');
  assert.equal(directory.rows.get(exposed.capability)?.name, 'web', 'the directory row was never unbound');
  const listed = (await rpcListApps(next.self)).find((app) => app.name === 'web');
  assert.equal(listed?.status, 'running');
  assert.equal(listed?.pid, restoredPid);
  const rotated = await rpcRotateLink(next.self, 'web');
  assert.equal(rotated.owner, identity.owner);
  assert.equal(rotated.pid, restoredPid);
  assert.equal(next.portRegistry.hasCapability(5173, rotated.capability), true);
}

// ── 4. a pid that is neither running nor journalled is refused by name ──────
{
  const { self, processes } = setup();
  const gone = processes.spawn('node gone.js', ['node gone.js'], '/home/user');
  processes.exit(gone.pid, 0);
  await assert.rejects(rpcExposeApp(self, { pid: gone.pid }), { message: `pid ${gone.pid} is not running and has no launch record` });
  await assert.rejects(rpcExposeApp(self, 4242), /nothing listens on port 4242 and no process 4242 exists|nothing is serving/);
}

// ── 5. startProcess: the wrapper pid a builtin adopts stays running ─────────
{
  const t = setup();
  const { self, processes, portRegistry, ctx } = t;
  // The shell the SDK drives: `npx vite` resolves to the builtin, which
  // adopts the wrapper pid the job allocated (the bin-spawn contract) and
  // registers the dev server's port under it, then the shell line returns 0.
  self.shell = {
    getEnv: () => ({ HOME: '/home/user' }),
    getCwd: () => '/home/user',
    async execute(line, options) {
      const adopted = options.commandContext.__nimbusBinSpawn.callerPid;
      portRegistry.bindFacetStub(adopted, stub('vite'));
      await t.fm.registerPort(adopted, 5173);
      return { exitCode: 0 };
    },
  };
  self._w1SessionDestroyed = false;
  self.shellProcessPid = null;
  self.terminal = null;
  self.initSession = () => { throw new Error('already booted'); };
  self.ctx.waitUntil = (p) => { ctx.waited.push(Promise.resolve(p).catch(() => {})); };
  const started = await rpcStartProcess(self, 'npx vite --host --port 5173', { cwd: '/home/user/app' });
  await Promise.all(ctx.waited);
  const entry = processes.get(started.pid);
  assert.equal(entry.state, 'running', 'the line returned, but the pid still serves a port: it stays running');
  assert.equal(portRegistry.get(5173)?.pid, started.pid);
  const exposed = await rpcExposeApp(self, 5173, { visibility: 'public', name: 'web' });
  assert.equal(exposed.owner, await deriveResidentOwner('/home/user/app', ['npx vite --host --port 5173']),
    'the identity is the wrapper pid\'s cwd and shell line');
  assert.equal(exposed.pid, started.pid);
  assert.equal((await rpcListApps(self)).find((app) => app.name === 'web')?.status, 'running');
}

console.log('ok - apps identity from the process table (dev-server expose/list/rotate/restart/refuse/remove, bin resident journalled, hibernation keeps identity, dead pid refused, startProcess wrapper pid stays running)');
await rm(outputDir, { recursive: true, force: true });
