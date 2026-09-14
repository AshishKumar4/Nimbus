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
import { reservePort } from '../../packages/worker/src/session/port-capability.ts';
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
const { routeToSessionPort } = await import(pathToFileURL(entry.path).href);

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
  const env = { LOADER: world.loader };
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
  return { boots, world, ctx, fm, processes, portRegistry, storage, vfs, disk };
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
  const html = await response.text();
  assert.match(html, /http-equiv="refresh" content="3"/, 'the page refreshes itself');
  assert.match(html, /Starting/, 'the page says what is happening');
}

console.log('ok - durable port recovery (silent port re-drives and routes, absent is 502, failed is 503 self-refreshing)');

await rm(outputDir, { recursive: true, force: true });
