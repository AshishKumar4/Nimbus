#!/usr/bin/env bun
// A durable application's URL must keep answering the thing it was handed —
// including the request that arrives while the application is still dead.
//
// The alarm pump re-drives a journaled launch on the platform's schedule;
// a port request is a user holding a URL, and it cannot wait for an alarm
// that may never have been armed. `routeToSessionPort` asks the manager to
// ensure the application first: a journaled-but-dead durable app is driven
// back and the request routes to it; a port nobody durable owns is the
// honest 502 it always was; a boot that fails or outlives its bound is a
// 503 the page re-asks on its own refresh.

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
import { resolveDurableWorkerImage } from '../../packages/worker/src/facets/durable-images.ts';
import { reservePort, readPortReservation } from '../../packages/worker/src/session/port-capability.ts';
import {
  createFacetWorld,
  createFacetCtx,
} from './facet-host-harness.mjs';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

// routes.ts transitively imports `cloudflare:workers`; bundle it with a stub,
// the same as the other route tests.
const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-durable-port-test-'));
const build = await Bun.build({
  entrypoints: ['./packages/worker/src/session/routes.ts', './packages/worker/src/facets/compose.ts'],
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
const { routeToSessionPort } = await import(pathToFileURL(entry.path).href);
const composeEntry = build.outputs.find((output) => output.path.endsWith('/compose.js'));
const { composeFacetManager } = await import(pathToFileURL(composeEntry.path).href);

const NONE = new Set();

function setup({ hooks = {}, storage = new Map(), world, disk } = {}) {
  const boots = [];
  if (!world) {
    world = createFacetWorld(() => {
      const boot = { id: `boot-${boots.length + 1}` };
      boots.push(boot);
      return {
        boot,
        async startProcess() { return { ok: true }; },
        async handleHttpRequest() { return Response.json({ boot: boot.id, ok: true }); },
      };
    });
  }
  const ctx = createFacetCtx(world, 'durable-port-do', storage);
  const env = {
    LOADER: world.loader,
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname.replace(/^\//, '');
        try {
          const { readFile } = await import('node:fs/promises');
          return new Response(
            await readFile(new URL(`../../packages/worker/public/${path}`, import.meta.url)),
            { status: 200 },
          );
        } catch {
          return new Response('', { status: 404 });
        }
      },
    },
  };
  const processes = new SessionProcessSupervisor();
  const portRegistry = new PortRegistry();
  if (!disk) disk = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(disk.sql, disk.ctx);
  const fm = new FacetManager(ctx, env, processes, portRegistry, processHostFor, {
    notify: () => {},
    resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(vfs, recipe),
    ...hooks,
  });
  fm.setVfs(vfs);
  return { boots, world, ctx, fm, processes, portRegistry, storage, vfs, disk, env };
}

/** The RoutesHost slice routeToSessionPort reads for this seam. */
function routeHost(fm, portRegistry) {
  return {
    portRegistry,
    cirrusReal: null,
    viteDevServer: null,
    _viteShimPort: null,
    ensureDurableAppOnPort: (port) => fm.ensureDurableAppOnPort(port),
    ctx: { storage: { get: async () => null } },
  };
}

// ── 1. a silent port with a journaled durable app re-drives and routes ───────
{
  const first = setup();
  await reservePort(first.ctx, { owner: 'app', preferredPort: 20300, occupiedPorts: NONE });
  await first.fm.spawnWorker('export default {}', 'durable app', '/app', {
    durable: { owner: 'app' },
    port: 20300,
  });
  assert.equal(first.portRegistry.has(20300), true, 'the durable spawn owns its port');
  assert.equal(first.portRegistry.hasCapability(20300, 'x'.repeat(24)), false);

  // The platform reset: the facet and the whole process registry are gone,
  // the journal row and the VFS the image lives on are not.
  first.world.lose('app-slot-0');
  const next = setup({ storage: first.storage, world: first.world, disk: first.disk });
  next.processes.setPidBase(PID_GEN_STRIDE);
  assert.equal(next.portRegistry.has(20300), false, 'the reset left the port dark');

  const before = first.world.boots.length;
  const response = await routeToSessionPort(
    routeHost(next.fm, next.portRegistry),
    20300,
    new Request('https://probe.test/port/20300/'),
    '/',
    '',
  );
  assert.equal(response.status, 200, 'the request waited out the re-drive and routed');
  assert.equal(first.world.boots.length, before + 1, 'the ensure drove exactly one boot');
  const body = await response.json();
  assert.equal(body.ok, true, 'the re-driven facet answered the request');
  assert.equal(next.portRegistry.has(20300), true, 'the re-drive re-bound the port');
}

// ── 2. a port nothing durable owns stays the honest 502 ─────────────────────
{
  const { fm, portRegistry } = setup();
  const response = await routeToSessionPort(
    routeHost(fm, portRegistry),
    20400,
    new Request('https://probe.test/port/20400/'),
    '/',
    '',
  );
  assert.equal(response.status, 502, 'an unclaimed port is absent, not durable');
}

// ── 3. a reservation with no journaled launch is absent, not restarted ──────
{
  const { ctx, fm, portRegistry } = setup();
  await reservePort(ctx, { owner: 'ghost', preferredPort: 20500, occupiedPorts: NONE });
  const response = await routeToSessionPort(
    routeHost(fm, portRegistry),
    20500,
    new Request('https://probe.test/port/20500/'),
    '/',
    '',
  );
  assert.equal(response.status, 502, 'a reservation without a recipe is absent');
}

// ── 4. a boot that cannot stand is 503, self-refreshing ─────────────────────
{
  const first = setup();
  await reservePort(first.ctx, { owner: 'app', preferredPort: 20600, occupiedPorts: NONE });
  await first.fm.spawnWorker('export default {}', 'durable app', '/app', {
    durable: { owner: 'app' },
    port: 20600,
  });
  first.world.lose('app-slot-0');
  const next = setup({
    storage: first.storage, world: first.world, disk: first.disk,
    hooks: {
      resolveWorkerLaunchFallback: async () => {
        throw new Error('the image store is gone');
      },
    },
  });
  next.processes.setPidBase(PID_GEN_STRIDE);

  const response = await routeToSessionPort(
    routeHost(next.fm, next.portRegistry),
    20600,
    new Request('https://probe.test/port/20600/'),
    '/',
    '',
  );
  assert.equal(response.status, 503, 'a failed re-drive is a retryable 503');
  assert.equal(response.headers.get('Retry-After'), '3', 'the page is told when to re-ask');
}

// ── 5. a node resident on a reserved port claims the durable contract ───────
{
  const { ctx, fm, portRegistry, storage } = setup();
  const CAP = 'a'.repeat(24);
  await reservePort(ctx, {
    owner: 'app', preferredPort: 20310, occupiedPorts: NONE,
    capability: CAP, visibility: 'public',
  });
  const spawned = await fm.spawnNode('const http = require("http");', {
    command: 'node app.js',
    port: 20310,
  });
  assert.ok(spawned.pid > 0, 'the node resident spawned');
  assert.equal(portRegistry.has(20310), true, 'the resident owns its port');
  // The reservation declared the capability; the spawn that claimed it
  // re-adopts it rather than minting a fresh one.
  assert.equal(portRegistry.hasCapability(20310, CAP), true,
    'a resident on a reserved port re-adopts the stored capability');

  const journal = await ctx.storage.list({ prefix: 'resident-launch:' });
  const row = [...journal.values()].find((r) => r.pid === spawned.pid);
  assert.ok(row, 'the resident launch is journaled');
  assert.equal(row.port, 20310, 'the journal row names the port it claimed');
  assert.equal(row.owner, 'app', 'the journal row names the reservation owner');
}

// ── 6. ensure-on-request drives a node resident the reservation owns ────────
{
  const first = setup();
  const CAP = 'b'.repeat(24);
  await reservePort(first.ctx, {
    owner: 'app', preferredPort: 20320, occupiedPorts: NONE,
    capability: CAP, visibility: 'public',
  });
  await first.fm.spawnNode('const http = require("http");', {
    command: 'node app.js',
    port: 20320,
  });

  // The platform reset: the facet the resident claimed is gone with the whole
  // process registry; the journal row and the reservation row are not.
  first.world.lose('app-slot-0');
  const next = setup({ storage: first.storage, world: first.world, disk: first.disk });
  next.processes.setPidBase(PID_GEN_STRIDE);
  assert.equal(next.portRegistry.has(20320), false, 'the reset left the port dark');

  const before = first.world.boots.length;
  const response = await routeToSessionPort(
    routeHost(next.fm, next.portRegistry),
    20320,
    new Request('https://probe.test/port/20320/'),
    '/',
    '',
  );
  assert.equal(response.status, 200, 'the request waited out the node re-drive and routed');
  assert.equal(first.world.boots.length, before + 1, 'the ensure drove exactly one boot');
  assert.equal(next.portRegistry.has(20320), true, 'the re-drive re-bound the port');
  assert.equal(next.portRegistry.hasCapability(20320, CAP), true,
    'the re-drive re-adopted the reservation capability');
}

// ── 7. an unrelated process on a reserved port mints fresh, never the app's ─
{
  const { ctx, fm, portRegistry } = setup();
  const CAP = 'c'.repeat(24);
  await reservePort(ctx, {
    owner: 'app', preferredPort: 20330, occupiedPorts: NONE,
    capability: CAP, visibility: 'public',
  });
  // A pid with no journal row — a process outside the resident lifecycle —
  // registering on a reserved port cannot inherit its capability.
  await fm.registerPort(99999, 20330);
  assert.equal(portRegistry.has(20330), true, 'the unrelated pid took the port');
  assert.equal(portRegistry.hasCapability(20330, CAP), false,
    'the unrelated pid never sees the reservation capability');
  const stored = await readPortReservation(ctx, 20330);
  assert.equal(stored.owner, 'app', 'the reservation still belongs to the owner');
  assert.equal(stored.capability, null,
    'the stored capability retired with the old occupant');
}

// ── 8. removeDurableApp purges a node resident the reservation claimed ──────
{
  const { ctx, fm, portRegistry, storage } = setup();
  await reservePort(ctx, {
    owner: 'app', preferredPort: 20340, occupiedPorts: NONE,
    capability: 'd'.repeat(24), visibility: 'public',
  });
  await fm.spawnNode('const http = require("http");', {
    command: 'node app.js',
    port: 20340,
  });
  assert.equal(portRegistry.has(20340), true);

  const removed = await fm.removeDurableApp('app');
  assert.equal(removed, true, 'removeDurableApp removed the app');
  assert.equal(portRegistry.has(20340), false, 'the port left the registry');
  assert.equal(await readPortReservation(ctx, 20340), null, 'the reservation released');
  const journal = await ctx.storage.list({ prefix: 'resident-launch:' });
  assert.equal([...journal.values()].every((r) => r.owner !== 'app'), true,
    'the node resident\'s journal row is purged');
  assert.equal(await ctx.storage.get('durable-slot:app'), undefined,
    'the durable slot is freed');
}

// ── 9. removeDurableApp answers through the public RPC surface ─────────────
{
  const { ctx, fm, portRegistry, world, processes, vfs, env } = setup();
  await reservePort(ctx, {
    owner: 'app', preferredPort: 20350, occupiedPorts: NONE,
    capability: 'e'.repeat(24), visibility: 'public',
  });
  await fm.spawnNode('const http = require("http");', {
    command: 'node app.js',
    port: 20350,
  });

  const { rpcRemoveDurableApp } = await import('../../packages/worker/src/session/programmatic.ts');
  // The ProgrammaticHost the public RPC reads: already booted (shell set),
  // its facet manager ensured.
  const self = {
    ensureFacetManager() {
      // The delegation contract: returns the composed shape so rpc verbs
      // reach `.apps`. The same fm is under test either way.
      this.facetManagerComposed ??= composeFacetManager({
        ctx, env, processes, portRegistry, vfs,
        hooks: { onExternalExit() {}, notify() {}, requestLaunchTurn() {} },
      });
      this.facetManager = fm;
      return this.facetManagerComposed;
    },
    facetManager: fm,
    ctx,
    portRegistry,
  };

  const gone = await rpcRemoveDurableApp(self, 'app');
  assert.deepEqual(gone, { owner: 'app', removed: true, port: 20350 },
    'removeDurableApp answers the released durable port');
  assert.equal(portRegistry.has(20350), false, 'the port is unregistered');
  assert.equal(await readPortReservation(ctx, 20350), null, 'the reservation released');

  const again = await rpcRemoveDurableApp(self, 'app');
  assert.deepEqual(again, { owner: 'app', removed: false, port: null },
    'removing an owner nothing holds is removed:false, port:null');
}

console.log('ok - durable port recovery (silent port re-drives and routes, absent is 502, failed is 503 self-refreshing, reserved ports are durable across kinds)');
await rm(outputDir, { recursive: true, force: true });
