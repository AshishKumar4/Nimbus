#!/usr/bin/env bun
// `composeFacetManager` is the one composition of a FacetManager — the
// embedder's and the session's.
//
// An embedder composing NimbusWorkspace over its own Durable Object supplies
// its ctx, env, process supervisor, port registry and filesystem plus the
// hooks a host has to answer, and gets the manager, the journal, re-drive,
// cold-start recovery and the paced launch pump for free. The session's own
// `ensureFacetManager` calls the same factory, so there is exactly one place
// the isolated esbuild transform and the image-store fallback are wired.
//
//   1. compose over the facet-host fakes, spawn a resident whose launch is
//      paced across turns, drive `pumpLaunches` from a fake alarm, and see
//      the journal row and the port registration land;
//   2. the session's `ensureFacetManager` and the factory wire hooks
//      identically — proven through behaviour: the same launch on each
//      produces the same hook-event sequence, and the transform hook the
//      session used to carry reaches the same loader-backed facet from both.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ESBUILD_TRANSFORM_WORKER_ID } from '../../packages/worker/src/facets/esbuild-transform.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';

import { composeFacetManager } from '../../packages/worker/src/facets/compose.ts';

adoptCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

const ASSETS = {
  async fetch(request) {
    const path = new URL(request.url).pathname.replace(/^\//, '');
    return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)), { status: 200 });
  },
};

/** A filesystem with enough of a dependency tree that a node launch is paced. */
function createDisk() {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const fs = vfs.as(CRED_KERNEL);
  fs.mkdir('home/user/node_modules/dep/lib', { recursive: true, mode: 0o755 });
  fs.writeFile('home/user/node_modules/dep/package.json', JSON.stringify({ name: 'dep', main: 'lib/index.js' }), { mode: 0o644 });
  fs.writeFile(
    'home/user/node_modules/dep/lib/index.js',
    Array.from({ length: 16 }, (_, i) => `require('./mod${i}');`).join('\n') + '\nmodule.exports = 1;\n',
    { mode: 0o644 },
  );
  for (let i = 0; i < 16; i++) {
    fs.writeFile(`home/user/node_modules/dep/lib/mod${i}.js`, `module.exports = ${i};\n// ${'p'.repeat(400)}\n`, { mode: 0o644 });
  }
  return vfs;
}

const settle = async (predicate, tries = 400) => {
  for (let i = 0; i < tries && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
};

// ── 1. the factory over the harness fakes ────────────────────────────────
{
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }));
  const processes = new SessionProcessSupervisor();
  processes.setPidBase(1 * PID_GEN_STRIDE);
  const portRegistry = new PortRegistry();
  const storage = new Map();
  const ctx = createFacetCtx(world, 'embedder-do', storage);
  const vfs = createDisk();
  const events = [];
  // The fake alarm: every turn the launch asks for is granted on a fresh
  // macrotask through the composed pump — exactly what the session's
  // 'resident-launch' alarm does, and what an embedder's alarm handler will.
  let alarmsArmed = 0;
  let composed;
  const armAlarm = (notBefore) => {
    alarmsArmed++;
    events.push(['requestLaunchTurn', typeof notBefore]);
    setTimeout(() => { void composed.pumpLaunches(); }, 0);
  };
  composed = composeFacetManager({
    ctx,
    env: { LOADER: world.loader, ASSETS, NIMBUS_LAUNCH_CHUNK_BYTES: '2048' },
    processes,
    portRegistry,
    vfs,
    hooks: {
      onExternalExit: (pid, code, reason) => { events.push(['onExternalExit', pid, code, reason]); },
      notify: (line) => { events.push(['notify', line]); },
      requestLaunchTurn: armAlarm,
      onSpawn: (pid, command, longRunning) => { events.push(['onSpawn', pid, command, longRunning]); },
    },
  });
  assert.equal(typeof composed.manager.spawnWorker, 'function', 'the manager is the FacetManager');
  assert.equal(typeof composed.pumpLaunches, 'function');

  const { pid } = await composed.manager.spawnNode("require('dep');", {
    filename: '/home/user/server.js', cwd: '/home/user', command: 'node server.js', port: 4444,
  });

  assert.ok(pid > PID_GEN_STRIDE, 'a pid of this generation');
  assert.ok(alarmsArmed >= 1, `the launch was paced across turns the fake alarm granted (armed ${alarmsArmed}×)`);
  assert.equal(composed.manager.hasPendingLaunchTurns, false, 'and the pump drained every one of them');
  const row = storage.get('resident-launch:' + pid);
  assert.ok(row, 'the launch is journalled');
  assert.equal(row.phase, 'running', 'as a running resident once it booted');
  assert.equal(row.port, 4444, 'with the port it bound stamped on the row');
  assert.equal(portRegistry.get(4444)?.pid, pid, 'the port is registered to the resident');
  assert.equal(processes.get(pid)?.state, 'running');
  assert.deepEqual(events.filter((e) => e[0] === 'onSpawn'), [['onSpawn', pid, 'node server.js', true]], 'the host heard the spawn');
  assert.equal(world.configs.size, 1, 'the launch built its module map and booted');

  // The pump is the manager's own — one pump, the one the journal recovers on.
  composed.manager.kill(pid);
  await settle(() => !storage.has('resident-launch:' + pid));
  assert.ok(events.some((e) => e[0] === 'onExternalExit' && e[1] === pid && e[3] === 'killed'), 'the host heard the kill');
  assert.equal(portRegistry.get(4444), undefined, 'the port was released with the process');
}

// ── 2. the session's ensureFacetManager IS the factory ───────────────────
// nimbus-session.ts transitively imports `cloudflare:workers`, so the
// session class comes from a stubbed bundle; the factory under test is the
// same source-graph import the published subpath exposes.
const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-compose-test-'));
let bundle;
try {
  const entryPath = join(outputDir, 'entry.ts');
  await writeFile(entryPath, [
    `export { NimbusSession } from '${new URL('../../', import.meta.url).pathname}packages/worker/src/session/nimbus-session.ts';`,
    `export { composeFacetManager } from '${new URL('../../', import.meta.url).pathname}packages/worker/src/facets/compose.ts';`,
    `export { ensureFacetManager } from '${new URL('../../', import.meta.url).pathname}packages/worker/src/hosted/services.ts';`,
    `export { adoptCtxExports, composeFabric } from '${new URL('../../', import.meta.url).pathname}packages/fabric/src/composition.ts';`,
    '',
  ].join('\n'));
  const build = await Bun.build({
    entrypoints: [entryPath],
    outdir: join(outputDir, 'out'),
    target: 'bun',
    format: 'esm',
    plugins: [{
      name: 'cloudflare-workers-test-stub',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare-workers', namespace: 'test' }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export class DurableObject {}; export class WorkerEntrypoint {}; export class RpcTarget {};',
          loader: 'js',
        }));
      },
    }],
  });
  assert.equal(build.success, true, build.logs.map(String).join('\n'));
  bundle = await import(pathToFileURL(build.outputs.find((o) => o.path.endsWith('/entry.js')).path).href);
  bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC' });
  bundle.adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
{

  /** The same launch, on a manager, recorded as the hook events it produced. */
  async function exercise(manager, events) {
    const spawned = await manager.spawnWorker('export default {}', 'embedder worker', '/home/user', {});
    manager.kill(spawned.pid);
    await settle(() => events.some((e) => e[0] === 'exit'));
    return events.map(([kind, ...rest]) => [kind, ...rest.map((v) => (v === spawned.pid ? '<pid>' : v))]);
  }

  /** What the transform hook reaches: which loader id, which facet, with what. */
  function transformProbe() {
    const reached = [];
    const env = {
      LOADER: {
        load() { throw new Error('unused'); },
        get(id) {
          reached.push(['loader.get', id]);
          return { getDurableObjectClass: (name) => ({ name }) };
        },
      },
      ASSETS,
    };
    const facets = {
      get(name) {
        reached.push(['facets.get', name]);
        return {
          transform: async (code, options) => {
            reached.push(['transform', code, options]);
            return { code: 'T(' + code + ')' };
          },
        };
      },
    };
    return { env, facets, reached };
  }

  const vfs = createDisk();

  // (a) the session's manager, composed by the real ensureFacetManager over
  // a host that carries only what that method reads.
  const sessionWorld = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }));
  const sessionProbe = transformProbe();
  const sessionCtx = createFacetCtx(sessionWorld, 'session-do');
  sessionCtx.facets = { ...sessionWorld.facets, get: (name, start) => (name.startsWith('esbuild-transform-') ? sessionProbe.facets.get(name) : sessionWorld.facets.get(name, start)) };
  const sessionEvents = [];
  const sessionProcesses = new SessionProcessSupervisor();
  sessionProcesses.setPidBase(PID_GEN_STRIDE);
  const terminalWrites = [];
  const host = {
    ctx: sessionCtx,
    env: { LOADER: { ...sessionWorld.loader, get: (id, config) => (id === ESBUILD_TRANSFORM_WORKER_ID ? sessionProbe.env.LOADER.get(id) : sessionWorld.loader.get(id, config)) }, ASSETS },
    processes: sessionProcesses,
    portRegistry: new PortRegistry(),
    sqliteFs: null,
    esbuildService: null,
    facetManagerComposed: null,
    terminal: { write: (text) => { terminalWrites.push(text); } },
    ensureSqliteFs() { this.sqliteFs ??= vfs; },
    _reportExternalExit(pid, code, reason) { sessionEvents.push(['exit', pid, code, reason]); },
    _scheduleLaunchTurn(notBefore) { sessionEvents.push(['turn', typeof notBefore]); return Promise.resolve(true); },
    _notifySession(line) { sessionEvents.push(['notify', line]); },
  };
  bundle.ensureFacetManager(host, {ctx: host.ctx, env: host.env, notify: line => host._notifySession(line), requestLaunchTurn: notBefore => host._scheduleLaunchTurn(notBefore)});
  const sessionManager = host.facetManagerComposed.manager;
  assert.ok(sessionManager, 'the session composed a manager');
  assert.equal(host.sqliteFs, vfs, 'over its filesystem, which it stood up first');
  const sessionRun = await exercise(sessionManager, sessionEvents);
  assert.ok(terminalWrites.some((t) => /\[facet started \(long-running\): pid=\d+ cmd="embedder worker"\]/.test(t)), 'the session-only part of onSpawn wrote to the terminal');

  // (b) the factory, over the same kind of fakes, with an embedder's hooks
  // that record exactly what the session's record.
  const embedderWorld = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }));
  const embedderProbe = transformProbe();
  const embedderCtx = createFacetCtx(embedderWorld, 'embedder-do');
  embedderCtx.facets = { ...embedderWorld.facets, get: (name, start) => (name.startsWith('esbuild-transform-') ? embedderProbe.facets.get(name) : embedderWorld.facets.get(name, start)) };
  const embedderEvents = [];
  const embedderProcesses = new SessionProcessSupervisor();
  embedderProcesses.setPidBase(PID_GEN_STRIDE);
  const composed = bundle.composeFacetManager({
    ctx: embedderCtx,
    env: { LOADER: { ...embedderWorld.loader, get: (id, config) => (id === ESBUILD_TRANSFORM_WORKER_ID ? embedderProbe.env.LOADER.get(id) : embedderWorld.loader.get(id, config)) }, ASSETS },
    processes: embedderProcesses,
    portRegistry: new PortRegistry(),
    vfs,
    hooks: {
      onExternalExit: (pid, code, reason) => { embedderEvents.push(['exit', pid, code, reason]); },
      requestLaunchTurn: (notBefore) => { embedderEvents.push(['turn', typeof notBefore]); },
      notify: (line) => { embedderEvents.push(['notify', line]); },
    },
  });
  const embedderRun = await exercise(composed.manager, embedderEvents);

  assert.deepEqual(sessionRun, embedderRun, 'the same launch produced the same hook events on both');
  assert.deepEqual(sessionRun.map((e) => e[0]), ['exit'], 'a plain worker spawn+kill: one external-exit report, nothing else');
  assert.deepEqual(sessionRun[0].slice(2), [137, 'killed']);

  // (c) the transform hook that used to live in nimbus-session is the
  // factory's default: from either manager it reaches the same loader id
  // and the same facet name with the same payload.
  const sessionTransform = sessionManager.hooks.transformLargeEsm;
  const embedderTransform = composed.manager.hooks.transformLargeEsm;
  assert.equal(typeof sessionTransform, 'function', 'the session manager carries the transform hook');
  assert.equal(typeof embedderTransform, 'function', 'so does the composed one');
  const out1 = await sessionTransform('export const a = 1;', { loader: 'js' });
  const out2 = await embedderTransform('export const a = 1;', { loader: 'js' });
  assert.deepEqual(out1, out2);
  assert.deepEqual(sessionProbe.reached, embedderProbe.reached, 'both reached the same loader id, facet and payload');
  assert.deepEqual(sessionProbe.reached.map((r) => r[0]), ['loader.get', 'facets.get', 'transform']);
  assert.equal(sessionProbe.reached[0][1], ESBUILD_TRANSFORM_WORKER_ID);
  assert.equal(sessionProbe.reached[1][1], `esbuild-transform-${ESBUILD_TRANSFORM_WORKER_ID}`);

  // (d) and both carry the image-store fallback the factory owns.
  assert.equal(typeof sessionManager.hooks.resolveWorkerLaunchFallback, 'function');
  assert.equal(typeof composed.manager.hooks.resolveWorkerLaunchFallback, 'function');
  assert.equal(sessionManager.hooks.resolveWorkerLaunch, undefined, 'the session composes no embedder resolver');
}


console.log('PASS facet-manager-compose');
