#!/usr/bin/env bun
// Every server is durable and reachable by its owner; only what is exposed
// is shareable.
//
// Durability used to require a port reservation an embedder made up front.
// Under the universal model the reservation is created lazily at expose
// time and identity is DERIVED for an ordinary process: `auto:` + a digest
// of the working directory and argv, never the env. This pins the model
// through the public surfaces — the manager's spawn/registration seams,
// `routeToSessionPort`, the programmatic app verbs, the preview-host parser
// and the router — over the facet-host harness:
//
//   1. a port registration stamps the row unconditionally, and a stamped
//      row re-drives on request with no reservation anywhere;
//   2. the derived owner is stable across a re-spawn and an env change, and
//      distinct across argv;
//   3. a concurrent duplicate is ephemeral: not journalled, not exposable;
//   4. expose lazily reserves the port for the identity and binds the
//      directory when public;
//   5. the capability is bound to identity: an unrelated server on the same
//      port retires it, the shared link 404s, the identity is re-exposable;
//   6. rotateLink invalidates the old capability;
//   7. remove purges process, reservation, rows, slot and directory;
//   8. the name host forms parse and resolve, in the router and the session;
//   9. `$PORT`/`$NIMBUS_APP` are injected under a reservation, and a resident
//      that binds another port is registered but reported as failed;
//  10. restart 'on-failure' re-drives a crash within budget, 'never' and a
//      clean exit release the row;
//  11. apps.list reports every stamped identity in its shape.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { FENCED_WORK_MAX_ATTEMPT } from '../../packages/fabric/src/fenced-work.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { resolveDurableWorkerImage } from '../../packages/worker/src/facets/durable-images.ts';
import { deriveResidentOwner } from '../../packages/worker/src/facets/resident-identity.ts';
import { rubyResidentStart } from '../../packages/worker/src/runtime/ruby-resident.ts';
import {
  readPortReservation,
  readPortReservationByName,
  reservePort,
} from '../../packages/worker/src/session/port-capability.ts';
import { createFacetWorld, createFacetCtx } from './facet-host-harness.mjs';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import {
  buildPreviewHost,
  buildPublicPreviewHost,
  parsePreviewHost,
} from '../../packages/worker/src/_shared/preview-host.ts';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';
import {
  PUBLIC_BEARER_HEADER,
  PREVIEW_CAPABILITY_HEADER,
} from '../../packages/worker/src/_shared/session-router.ts';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

// routes.ts transitively imports `cloudflare:workers`; bundle it with a stub.
const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-universal-durability-'));
const build = await Bun.build({
  entrypoints: ['./packages/worker/src/session/routes.ts', './packages/worker/src/session/programmatic.ts'],
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
const routesEntry = build.outputs.find((o) => o.path.endsWith('/routes.js'));
const programmaticEntry = build.outputs.find((o) => o.path.endsWith('/programmatic.js'));
const { routeToSessionPort, routeToSessionApp } = await import(pathToFileURL(routesEntry.path).href);
const {
  rpcExposeApp, rpcExposePort, rpcListApps, rpcRotateLink, rpcRemoveApp, rpcStartProcess,
} = await import(pathToFileURL(programmaticEntry.path).href);

const SID = 'nimble-otter-4271';
const SUFFIX = 'nimbus-os.dev';
const TENANT = 'acme:alice';
const NONE = new Set();

/** The public directory DO, faked over a Map so bind/unbind/resolve are observable. */
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

function setup({ hooks = {}, storage = new Map(), world, disk, directory = fakeDirectory(), notices = [] } = {}) {
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
  if (!disk) disk = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(disk.sql, disk.ctx);
  const fm = new FacetManager(ctx, env, processes, portRegistry, processHostFor, {
    notify: (line) => notices.push(line),
    resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(vfs, recipe),
    ...hooks,
  });
  fm.setVfs(vfs);
  /** The ProgrammaticHost slice the app verbs read: booted, manager ensured. */
  const self = {
    shell: {},
    env,
    ctx,
    portRegistry,
    processes,
    facetManager: fm,
    sessionBasePath: `/s/${SID}`,
    sessionOrigin: 'https://probe.test',
    ensureSqliteFs() {},
    ensureFacetManager() { this.facetManager = fm; },
    cirrusReal: null,
    viteDevServer: null,
    _viteShimPort: null,
    ensureDurableAppOnPort: (port) => fm.ensureDurableAppOnPort(port),
  };
  return { world, ctx, env, fm, processes, portRegistry, storage, vfs, disk, self, directory, notices };
}

const journalRows = async (ctx) => [...(await ctx.storage.list({ prefix: 'resident-launch:' })).values()];
const rowFor = async (ctx, pid) => (await journalRows(ctx)).find((r) => r.pid === pid);
const bearer = (port, cap) => new Request(`https://${buildPublicPreviewHost(SID, port, cap, SUFFIX)}/`, {
  headers: { [PREVIEW_CAPABILITY_HEADER]: cap, [PUBLIC_BEARER_HEADER]: '1' },
});
const SERVER = 'const http = require("http"); http.createServer(() => {}).listen(process.env.PORT || 3000);';

// ── 1. unconditional stamp; re-drive on request with no reservation ─────────
{
  const first = setup();
  const spawned = await first.fm.spawnNode(SERVER, {
    command: 'node server.js', argv: ['/home/user/app/server.js'], cwd: '/home/user/app',
  });
  // A runtime-learned port (the http shim's listen → registerPort): stamped
  // on the row with no reservation in sight.
  assert.equal(await readPortReservation(first.ctx, 20700), null, 'nothing reserved the port');
  await first.fm.registerPort(spawned.pid, 20700);
  const row = await rowFor(first.ctx, spawned.pid);
  assert.equal(row.port, 20700, 'the registration stamped the port unconditionally');
  assert.match(row.owner, /^auto:[a-f0-9]{24}$/, 'the row carries the derived owner');
  assert.equal(first.portRegistry.get(20700)?.pid, spawned.pid);

  // A declared-port resident, also unreserved — the shape the re-drive can
  // re-register on its own (the harness program never calls listen()).
  const declared = await first.fm.spawnNode(SERVER, {
    command: 'node api.js', argv: ['/home/user/app/api.js', '--port', '20701'], cwd: '/home/user/app', port: 20701,
  });
  assert.equal((await rowFor(first.ctx, declared.pid)).port, 20701, 'the declared port is stamped too');

  // The platform reset: facets and the registry are gone, the rows are not.
  for (const name of first.world.liveFacets()) first.world.lose(name);
  const next = setup({ storage: first.storage, world: first.world, disk: first.disk });
  next.processes.setPidBase(PID_GEN_STRIDE);
  assert.equal(next.portRegistry.has(20701), false, 'the reset left the port dark');
  const before = first.world.boots.length;
  const response = await routeToSessionPort(next.self, 20701, new Request('https://probe.test/port/20701/'), '/', '');
  assert.equal(response.status, 200, 'a scoped request re-drove the unreserved resident and routed');
  assert.equal(first.world.boots.length, before + 1, 'exactly one boot');
  assert.equal(next.portRegistry.has(20701), true, 'the re-drive re-bound the port');
  assert.equal(await readPortReservation(next.ctx, 20701), null, 'still no reservation — none was needed');
}

// ── 2. derived owner: stable across re-spawn and env, distinct across argv ──
{
  const { fm, ctx, processes } = setup();
  const a1 = await fm.spawnNode(SERVER, {
    command: 'node server.js', argv: ['/home/user/app/server.js'], cwd: '/home/user/app', env: { SECRET: 'one' },
  });
  const owner1 = (await rowFor(ctx, a1.pid)).owner;
  assert.equal(owner1, await deriveResidentOwner('/home/user/app', ['/home/user/app/server.js']),
    'the owner is the documented digest of cwd and argv');
  fm.kill(a1.pid);
  const a2 = await fm.spawnNode(SERVER, {
    command: 'node server.js', argv: ['/home/user/app/server.js'], cwd: '/home/user/app', env: { SECRET: 'rotated', PORT: '9' },
  });
  assert.equal((await rowFor(ctx, a2.pid)).owner, owner1, 'a re-spawn with a different env keeps its identity');
  const b = await fm.spawnNode(SERVER, {
    command: 'node other.js', argv: ['/home/user/app/other.js'], cwd: '/home/user/app',
  });
  assert.notEqual((await rowFor(ctx, b.pid)).owner, owner1, 'a different argv is a different identity');
  const c = await fm.spawnNode(SERVER, {
    command: 'node server.js', argv: ['/home/user/other/server.js'], cwd: '/home/user/other',
  });
  assert.notEqual((await rowFor(ctx, c.pid)).owner, owner1, 'a different cwd is a different identity');
  assert.equal(processes.get(a2.pid)?.state, 'running');
}

// ── 3. a concurrent duplicate is ephemeral ──────────────────────────────────
{
  const { fm, ctx, notices } = setup();
  const opts = { command: 'node pair.js', argv: ['/home/user/pair.js'], cwd: '/home/user' };
  const pair = await Promise.all([fm.spawnNode(SERVER, opts), fm.spawnNode(SERVER, opts)]);
  const rows = await journalRows(ctx);
  assert.equal(rows.length, 1, 'simultaneous launches cannot both win the owner claim');
  const owner = await deriveResidentOwner(opts.cwd, opts.argv);
  assert.equal(await ctx.storage.get(`resident-owner:${owner}`), rows[0].pid);
  const duplicate = pair.find(({ pid }) => pid !== rows[0].pid);
  assert.equal((await fm.residentIdentity(duplicate.pid)).ephemeral, true);
  assert.equal(notices.filter((line) => line.includes('not the durable one')).length, 1);
  fm.kill(duplicate.pid);
  await Promise.all(ctx.waited);
  assert.equal(await ctx.storage.get(`resident-owner:${owner}`), rows[0].pid, 'duplicate terminal cannot release winner');
  fm.kill(rows[0].pid);
  await Promise.all(ctx.waited);
  assert.equal(await ctx.storage.get(`resident-owner:${owner}`), undefined, 'winner terminal releases its claim');
}
{
  const { fm, ctx, self, notices } = setup();
  const a1 = await fm.spawnNode(SERVER, {
    command: 'node server.js', argv: ['/home/user/app/server.js'], cwd: '/home/user/app', port: 20710,
  });
  const a2 = await fm.spawnNode(SERVER, {
    command: 'node server.js', argv: ['/home/user/app/server.js'], cwd: '/home/user/app',
  });
  assert.ok(a2.pid > a1.pid);
  assert.equal(await rowFor(ctx, a2.pid), undefined, 'the second instance is not journalled');
  assert.ok(notices.some((line) => /second instance of ".*server\.js" is not the durable one/.test(line)),
    `the user is told; notices were: ${JSON.stringify(notices)}`);
  const identity = await fm.residentIdentity(a2.pid);
  assert.equal(identity.ephemeral, true, 'the identity seam reports it ephemeral');
  await assert.rejects(rpcExposeApp(self, { pid: a2.pid }), /not the durable one/,
    'the duplicate cannot be exposed');
  // Its registration on the identity's port retires the capability like any
  // unrelated process: it does not claim the reservation.
  const exposed = await rpcExposeApp(self, 20710, { visibility: 'public' });
  assert.match(exposed.capability, /^[a-f0-9]{24}$/);
  await fm.registerPort(a2.pid, 20710);
  assert.equal((await readPortReservation(ctx, 20710)).owner, (await rowFor(ctx, a1.pid)).owner,
    'the reservation still belongs to the first instance');
  assert.equal((await readPortReservation(ctx, 20710)).capability, null,
    'the duplicate retired the capability rather than claiming it');
  // Once the first instance is gone, the same program is the durable one again.
  fm.kill(a1.pid); fm.kill(a2.pid);
  const a3 = await fm.spawnNode(SERVER, {
    command: 'node server.js', argv: ['/home/user/app/server.js'], cwd: '/home/user/app',
  });
  assert.equal((await rowFor(ctx, a3.pid)).owner, (await readPortReservation(ctx, 20710)).owner,
    'a later instance carries the identity');
}

// ── 4. expose lazily reserves and binds; 5. capability bound to identity;
//      6. rotateLink invalidates; 7. remove purges everything ──────────────
{
  const { fm, ctx, self, portRegistry, directory, world } = setup();
  const a = await fm.spawnNode(SERVER, {
    command: 'node server.js', argv: ['/home/user/app/server.js'], cwd: '/home/user/app', port: 20720,
  });
  assert.equal(await readPortReservation(ctx, 20720), null, 'no reservation before expose');
  const owner = (await rowFor(ctx, a.pid)).owner;

  const exposed = await rpcExposeApp(self, 20720, { visibility: 'public', name: 'api' });
  assert.equal(exposed.owner, owner, 'expose resolved the serving pid\'s derived owner');
  assert.equal(exposed.name, 'api');
  assert.equal(exposed.port, 20720);
  assert.equal(exposed.pid, a.pid);
  assert.equal(exposed.visibility, 'public');
  assert.match(exposed.capability, /^[a-f0-9]{24}$/);
  assert.equal(exposed.url, `https://${exposed.capability}--api--${SID}.${SUFFIX}/`,
    'the URL is the public name host form');
  const reservation = await readPortReservation(ctx, 20720);
  assert.deepEqual(reservation, { kind: 'derived', owner, capability: exposed.capability, visibility: 'public', name: 'api' },
    'expose reserved the port for the identity, with the name');
  assert.equal(portRegistry.hasCapability(20720, exposed.capability), true, 'the live registration answers it');
  assert.deepEqual(directory.rows.get(exposed.capability), { tenantSegment: TENANT, sid: SID, port: 20720, name: 'api' },
    'the directory row carries the name');
  const CAP1 = exposed.capability;
  assert.equal((await routeToSessionPort(self, 20720, bearer(20720, CAP1), '/', '', CAP1)).status, 200,
    'the public bearer answers');

  // A name must be unique per session and DNS-label-safe.
  const b0 = await fm.spawnNode(SERVER, {
    command: 'node b.js', argv: ['/home/user/app/b.js'], cwd: '/home/user/app', port: 20721,
  });
  await assert.rejects(rpcExposeApp(self, 20721, { name: 'api' }), /already taken/, 'a duplicate name is refused');
  await assert.rejects(rpcExposeApp(self, 20721, { name: '3000' }), /not a valid app name/, 'a numeric name is refused');
  await assert.rejects(rpcExposeApp(self, 20721, { name: 'a--b' }), /not a valid app name/, 'a double-hyphen name is refused');
  await assert.rejects(rpcExposeApp(self, 20721, { name: 'a'.repeat(24) }), /not a valid app name/, 'a capability-shaped name is refused');
  // Another owner cannot take the port.
  fm.kill(b0.pid);

  // 5. an unrelated server on the same port after the app stops.
  fm.kill(a.pid);
  const other = await fm.spawnNode(SERVER, {
    command: 'node other.js', argv: ['/home/user/app/other.js'], cwd: '/home/user/app', port: 20720,
  });
  assert.equal(portRegistry.get(20720)?.pid, other.pid, 'the unrelated server took the port');
  assert.equal(portRegistry.hasCapability(20720, CAP1), false, 'it never sees the app\'s capability');
  assert.equal((await readPortReservation(ctx, 20720)).owner, owner, 'the reservation stays with the identity');
  assert.equal((await readPortReservation(ctx, 20720)).capability, null, 'the stored capability retired');
  assert.equal(directory.rows.has(CAP1), false, 'the directory row went with it');
  assert.equal((await routeToSessionPort(self, 20720, bearer(20720, CAP1), '/', '', CAP1)).status, 404,
    'the shared link 404s');
  assert.equal((await rowFor(ctx, other.pid)).owner, await deriveResidentOwner('/home/user/app', ['/home/user/app/other.js']),
    'the unrelated server keeps its own identity — the derived reservation does not claim it');
  await assert.rejects(rpcExposeApp(self, 20720, { visibility: 'public' }), /held by another owner|already holds/,
    'the unrelated server cannot expose over the identity\'s reservation');

  const foreignOwner = (await rowFor(ctx, other.pid)).owner;
  const freshLiveCapability = portRegistry.get(20720).capability;
  for (const target of ['api', { name: 'api' }, { owner }, owner]) {
    for (const act of [() => rpcExposeApp(self, target, { visibility: 'public' }), () => rpcRotateLink(self, target)]) {
      await assert.rejects(act, { message: `port 20720 is served by a different process (owner ${foreignOwner})` });
      assert.equal((await readPortReservation(ctx, 20720)).capability, null, 'refusal does not mint onto the reservation');
      assert.equal(portRegistry.get(20720).capability, freshLiveCapability, 'refusal never replaces the foreign listener capability');
      assert.equal(directory.rows.size, 0, 'refusal cannot publish a directory entry');
    }
  }

  // The original identity is re-exposable.
  fm.kill(other.pid);
  const again = await fm.spawnNode(SERVER, {
    command: 'node server.js', argv: ['/home/user/app/server.js'], cwd: '/home/user/app', port: 20720,
  });
  const reExposed = await rpcExposeApp(self, 'api', { visibility: 'public' });
  assert.equal(reExposed.owner, owner);
  assert.match(reExposed.capability, /^[a-f0-9]{24}$/);
  assert.notEqual(reExposed.capability, CAP1, 'a fresh capability, the retired one is never reused');
  assert.equal((await routeToSessionPort(self, 20720, bearer(20720, reExposed.capability), '/', '', reExposed.capability)).status, 200);
  const CAP2 = reExposed.capability;

  // 6. rotateLink
  const rotated = await rpcRotateLink(self, 'api');
  assert.notEqual(rotated.capability, CAP2);
  assert.equal(rotated.url, `https://${rotated.capability}--api--${SID}.${SUFFIX}/`);
  assert.equal((await routeToSessionPort(self, 20720, bearer(20720, CAP2), '/', '', CAP2)).status, 404, 'the old link 404s');
  assert.equal((await routeToSessionPort(self, 20720, bearer(20720, rotated.capability), '/', '', rotated.capability)).status, 200,
    'the new link answers at once');
  assert.equal(directory.rows.has(CAP2), false, 'the old directory row is gone');
  assert.equal(directory.rows.get(rotated.capability)?.name, 'api', 'the new one is bound with the name');

  // The name→port resolution inside the session, and the name door.
  assert.deepEqual((await readPortReservationByName(ctx, 'api'))?.port, 20720);
  const viaName = await routeToSessionApp(self, 'api', new Request('https://probe.test/app/api/x'), '/x');
  assert.equal(viaName.status, 200, 'the name door routes to the port');
  assert.equal((await viaName.json()).path, '/x');
  assert.equal((await routeToSessionApp(self, 'nope', new Request('https://probe.test/app/nope/'), '/')).status, 404,
    'an unknown name is 404');

  // ports.expose on the same port is the same lazy reservation, thin alias.
  const viaPort = await rpcExposePort(self, 20720, {});
  assert.equal(viaPort.owner, owner);
  assert.equal(viaPort.name, 'api');
  assert.equal(viaPort.capability, rotated.capability, 'ports.expose never rotates');

  // 7. remove
  const slotBefore = await ctx.storage.get(`durable-slot:${owner}`);
  assert.equal(typeof slotBefore, 'number', 'the identity took its durable slot once it held a reservation');
  const removed = await rpcRemoveApp(self, 'api');
  assert.deepEqual(removed, { owner, removed: true, port: 20720 });
  assert.notEqual(self.processes.get(again.pid)?.state, 'running', 'the live process was killed');
  assert.equal(portRegistry.has(20720), false);
  assert.equal(await readPortReservation(ctx, 20720), null, 'the reservation released');
  assert.equal((await journalRows(ctx)).some((r) => r.owner === owner), false, 'the journal rows purged');
  assert.equal(await ctx.storage.get(`durable-slot:${owner}`), undefined, 'the slot freed');
  assert.equal(directory.rows.has(rotated.capability), false, 'the directory unbound');
  assert.equal((await rpcListApps(self)).some((app) => app.owner === owner), false, 'gone from apps.list');
  assert.ok(world.boots.length > 0);
}

// ── 8. name host parse matrix + router resolution ───────────────────────────
{
  const world = createFacetWorld(() => ({
    async startProcess(args) { return { state: 'listening', port: 20820, stdout: args.userEnv.LABEL }; },
    async handleHttpRequest() { return new Response('ruby resident'); },
  }));
  const first = setup({ world });
  first.vfs.as(CRED_KERNEL).writeFile('ruby.wasm', new Uint8Array([0, 97, 115, 109]));
  const argv = ['ruby', 'server.rb'];
  const started = await rubyResidentStart(first.fm)({
    argv, command: 'ruby server.rb', cwd: '/home/user', wasmVfsPath: 'ruby.wasm',
    startArgs: { userCode: '# large boot input\n'.repeat(12000), rbArgv: ['server.rb'], progName: 'server.rb', cwd: '/home/user',
      userEnv: { LABEL: 'original' }, fsSnapshot: { root: 'home/user', preopens: [], files: {}, dirs: [] } },
  });
  assert.ok(started.spawnedPid);
  const row = await rowFor(first.ctx, started.spawnedPid);
  assert.equal(row.owner, await deriveResidentOwner('/home/user', argv));
  assert.equal(row.port, 20820);
  assert.equal(row.recipe.startArgs, undefined, 'large runtime snapshot never becomes a DO storage value');
  assert.ok(JSON.stringify(row).length < 2048, 'journal contains digests, not runtime boot payload');
  assert.equal(await readPortReservation(first.ctx, 20820), null);
  for (const name of world.liveFacets()) world.lose(name);
  const next = setup({ storage: first.storage, world, disk: first.disk });
  next.processes.setPidBase(PID_GEN_STRIDE);
  assert.equal(await next.fm.ensureDurableAppOnPort(20820), 'started');
  const recovered = (await journalRows(next.ctx)).find((candidate) => candidate.pid > PID_GEN_STRIDE);
  assert.equal(recovered.owner, row.owner, 'runtime re-drive preserves derived identity');
  assert.equal(recovered.port, 20820);
}
{
  const { fm, ctx, portRegistry, vfs } = setup();
  await reservePort(ctx, { owner: 'A', preferredPort: 20801, occupiedPorts: NONE, kind: 'derived' });
  const a = await fm.spawnNode(SERVER, { argv: ['owner-A.js'], port: 20801 });
  const ownerA = (await rowFor(ctx, a.pid)).owner;
  const reservationBefore = await readPortReservation(ctx, 20801);
  await fm.removeDurableApp(ownerA);
  assert.deepEqual(await readPortReservation(ctx, 20801), reservationBefore, 'removing a foreign occupant never releases the reservation');

  await reservePort(ctx, { owner: 'worker-A', preferredPort: 20802, occupiedPorts: NONE });
  await reservePort(ctx, { owner: 'worker-B', preferredPort: 20803, occupiedPorts: NONE });
  const wa = await fm.spawnWorker('export default {}', 'worker-A', '/home/user', { port: 20802, durable: { owner: 'worker-A' }, env: { label: 'A' } });
  const wb = await fm.spawnWorker('export default {}', 'worker-B', '/home/user', { port: 20803, durable: { owner: 'worker-B' }, env: { label: 'B' } });
  const ia = (await rowFor(ctx, wa.pid)).recipe.image;
  const ib = (await rowFor(ctx, wb.pid)).recipe.image;
  assert.equal(ia.runner, ib.runner, 'shared content-addressed runner');
  fm.kill(wa.pid);
  await Promise.all(ctx.waited);
  await fm.removeDurableApp('worker-A');
  const kernel = vfs.as(CRED_KERNEL);
  assert.equal(kernel.exists(`.nimbus/images/${ia.application}`), false, 'stopped owner images purged after its journal row is gone');
  assert.equal(kernel.exists(`.nimbus/images/${ib.runner}`), true, 'shared runner stays for other owner');
  assert.equal(portRegistry.get(20803).pid, wb.pid);
  await fm.removeDurableApp('worker-B');
  assert.equal(kernel.exists(`.nimbus/images/${ib.runner}`), false);
  assert.equal(kernel.exists(`.nimbus/images/${ib.application}`), false);
}
{
  const { fm, ctx, portRegistry, notices } = setup();
  const cap = 'e'.repeat(24);
  await reservePort(ctx, { owner: 'explicit-app', preferredPort: 20800, occupiedPorts: NONE, capability: cap });
  assert.equal((await readPortReservation(ctx, 20800)).kind, 'explicit');
  const first = await fm.spawnNode(SERVER, { argv: ['first.js'] });
  await fm.registerPort(first.pid, 20800);
  assert.equal((await rowFor(ctx, first.pid)).owner, 'explicit-app', 'first runtime binder adopts explicit declaration');
  assert.equal(portRegistry.hasCapability(20800, cap), true);
  const second = await fm.spawnNode(SERVER, { argv: ['second.js'] });
  const secondOwner = (await rowFor(ctx, second.pid)).owner;
  await fm.registerPort(second.pid, 20800);
  assert.equal((await rowFor(ctx, second.pid)).owner, secondOwner, 'second binder cannot adopt while owner is live');
  assert.equal(portRegistry.hasCapability(20800, cap), false);
  assert.ok(notices.some((line) => line.includes(`pid ${second.pid} registers ephemeral`)));
  assert.equal((await readPortReservation(ctx, 20800)).owner, 'explicit-app');
}
{
  const CAP = 'abcdef0123456789abcdef01';
  const cases = [
    [`3000--${SID}`, { port: 3000, sid: SID }],
    [`api--${SID}`, { name: 'api', sid: SID }],
    [`my-api-2--${SID}`, { name: 'my-api-2', sid: SID }],
    [`${CAP}--3000--${SID}`, { port: 3000, sid: SID, capability: CAP }],
    [`${CAP}--api--${SID}`, { name: 'api', sid: SID, capability: CAP }],
  ];
  for (const [label, expected] of cases) {
    assert.deepEqual(parsePreviewHost(`${label}.${SUFFIX}`, SUFFIX), expected, label);
  }
  for (const bad of [
    `03000--${SID}`,             // a non-canonical port is not a name either
    `${CAP}--${SID}`,            // a 24-hex label is never a name
    `a--b--${SID}`,              // three labels without a capability
    `${CAP}--0--${SID}`,
    `api.x--${SID}`,
    `-api--${SID}`,
  ]) {
    assert.equal(parsePreviewHost(`${bad}.${SUFFIX}`, SUFFIX), null, `${bad} is not a preview host`);
  }
  assert.equal(buildPreviewHost(SID, 'api', SUFFIX), `api--${SID}.${SUFFIX}`);
  assert.equal(buildPublicPreviewHost(SID, 'api', CAP, SUFFIX), `${CAP}--api--${SID}.${SUFFIX}`);

  // The router: scoped name form forwards `/app/<name>/`; public name form
  // resolves by capability and verifies the name against the directory.
  class FakeNamespace {
    names = [];
    idFromName(name) { this.names.push(name); return { name }; }
    get() {
      return {
        fetch: async (request) => Response.json({
          pathname: new URL(request.url).pathname,
          bearer: request.headers.get(PUBLIC_BEARER_HEADER),
          cap: request.headers.get(PREVIEW_CAPABILITY_HEADER),
        }),
      };
    }
  }
  const directory = fakeDirectory();
  directory.rows.set(CAP, { tenantSegment: TENANT, sid: SID, port: 4173, name: 'api' });
  const env = {
    JWT_SECRET: 'name-host-secret',
    NIMBUS_PREVIEW_HOST_SUFFIX: SUFFIX,
    NIMBUS_SESSION: new FakeNamespace(),
    NIMBUS_PUBLIC_DIRECTORY: directory.namespace,
  };
  const handler = createNimbusHandler({ auth: { mode: 'enforce' } });
  const ctx = { waitUntil() {} };

  const named = await handler.fetch(new Request(`https://${CAP}--api--${SID}.${SUFFIX}/hello`), env, ctx);
  assert.equal(named.status, 200, 'the public name form reaches the session unauthenticated');
  assert.deepEqual(await named.json(), { pathname: '/port/4173/hello', bearer: '1', cap: CAP },
    'the name resolved to the directory\'s port');
  assert.equal(env.NIMBUS_SESSION.names.at(-1), `${TENANT}:${SID}`);
  const wrongName = await handler.fetch(new Request(`https://${CAP}--web--${SID}.${SUFFIX}/`), env, ctx);
  assert.equal(wrongName.status, 404, 'a capability under a name it was not bound with is 404');
  directory.rows.set(CAP, { tenantSegment: TENANT, sid: SID, port: 4174, name: 'renamed' });
  const renamed = await handler.fetch(new Request(`https://${CAP}--renamed--${SID}.${SUFFIX}/now`), env, ctx);
  assert.equal(renamed.status, 200, 'rename bypasses the stale positive cache immediately');
  assert.equal((await renamed.json()).pathname, '/port/4174/now');
  const wrongPort = await handler.fetch(new Request(`https://${CAP}--9999--${SID}.${SUFFIX}/`), env, ctx);
  assert.equal(wrongPort.status, 404, 'a capability is bound to the directory port, not the host port');
  directory.rows.set(CAP, { tenantSegment: TENANT, sid: SID, port: 4175, name: 'renamed' });
  const moved = await handler.fetch(new Request(`https://${CAP}--4175--${SID}.${SUFFIX}/now`), env, ctx);
  assert.equal(moved.status, 200, 'port host mismatch re-resolves once too');
  assert.equal((await moved.json()).pathname, '/port/4175/now');
  const unknownCap = await handler.fetch(new Request(`https://${'0'.repeat(24)}--api--${SID}.${SUFFIX}/`), env, ctx);
  assert.equal(unknownCap.status, 404);
  const scoped = await handler.fetch(new Request(`https://api--${SID}.${SUFFIX}/`), env, ctx);
  assert.equal(scoped.status, 401, 'the scoped name form still requires session:attach');
  const { issueNimbusToken } = await import('../../packages/worker/src/auth/token.ts');
  const token = await issueNimbusToken(env, { tn: 'acme', sub: 'alice', scopes: ['session:attach'], sid: SID });
  const attached = await handler.fetch(
    new Request(`https://api--${SID}.${SUFFIX}/x/y`, { headers: { Authorization: `Bearer ${token}` } }), env, ctx,
  );
  assert.equal(attached.status, 200);
  assert.equal((await attached.json()).pathname, '/app/api/x/y', 'the scoped name form is forwarded to the name door');
}

// ── 9. $PORT / $NIMBUS_APP injection, and the mismatch diagnostic ───────────
{
  const { fm, ctx, world, self } = setup();
  await reservePort(ctx, { owner: 'worker-env', preferredPort: 20830, occupiedPorts: NONE, name: 'worker-web' });
  const started = await fm.spawnWorker('export default {}', 'worker-env', '/home/user', {
    durable: { owner: 'worker-env' }, env: { PORT: '9', NIMBUS_APP: 'wrong', KEEP: 'yes' },
  });
  assert.deepEqual(world.boots.at(-1).config.env, { PORT: '20830', NIMBUS_APP: 'worker-web', KEEP: 'yes' });
  assert.equal((await rowFor(ctx, started.pid)).injectedPort, 20830);
  await fm.registerPort(started.pid, 20831);
  const app = (await rpcListApps(self)).find((row) => row.owner === 'worker-env');
  assert.equal(app.status, 'failed');
  assert.equal(app.diagnostic, 'listened on 20831, owns 20830');
  const resolved = await resolveDurableWorkerImage(self.facetManager.vfs, (await rowFor(ctx, started.pid)).recipe);
  assert.equal(resolved.env.PORT, '9', 'launch overlay was not persisted into the image');
}
{
  const { fm, ctx, self, vfs, notices, world } = setup();
  const owner = await deriveResidentOwner('/home/user/app', ['/home/user/app/server.js']);
  // The identity holds a named reservation (a previous expose): the next
  // spawn is launched under it.
  await reservePort(ctx, { owner, preferredPort: 20730, occupiedPorts: NONE, name: 'web' });
  const boots = world.boots.length;
  const a = await fm.spawnNode(SERVER, {
    command: 'node server.js', argv: ['/home/user/app/server.js'], cwd: '/home/user/app', env: { PORT: '3000', TERM: 'xterm' },
  });
  assert.equal(world.boots.length, boots + 1);
  const row = await rowFor(ctx, a.pid);
  assert.equal(row.injectedPort, 20730, 'the row records the injected port');
  assert.equal(row.port, 20730, 'the reserved port is the row\'s port from the start');
  // The launch env is visible in the image the facet booted from: the
  // generated worker.js carries `__NIMBUS_ARGS` with the env.
  const kernel = vfs.as(CRED_KERNEL);
  const images = kernel.readdir('var/lib/nimbus/facet-images').map((e) => e.name)
    .map((name) => new TextDecoder().decode(kernel.readFile(`var/lib/nimbus/facet-images/${name}`)));
  const booted = images.find((text) => text.includes('__NIMBUS_ARGS') && text.includes('"NIMBUS_APP":"web"'));
  assert.ok(booted, 'the resident was booted with $NIMBUS_APP set to the reservation name');
  assert.ok(booted.includes('"PORT":"20730"'), 'the recipe\'s PORT=3000 was overridden by the reserved port');
  assert.ok(!(await journalRows(ctx)).some((r) => JSON.stringify(r).includes('20730"') && JSON.stringify(r.recipe).includes('"PORT":"20730"')),
    'the injected env is never journalled into the recipe');
  const slot = await ctx.storage.get(`durable-slot:${owner}`);
  assert.equal(typeof slot, 'number', 'a spawn under its reservation binds the durable slot');

  // Registering the reserved port: healthy.
  await fm.registerPort(a.pid, 20730);
  assert.equal((await rowFor(ctx, a.pid)).portMismatch, undefined);
  let listed = (await rpcListApps(self)).find((app) => app.owner === owner);
  assert.equal(listed.status, 'running');
  assert.equal(listed.name, 'web');
  assert.equal(listed.url, `https://web--${SID}.${SUFFIX}/`, 'the scoped URL is the name form');

  // A resident that ignores $PORT: registered anyway, reported as failed.
  fm.kill(a.pid);
  const b = await fm.spawnNode(SERVER, {
    command: 'node server.js', argv: ['/home/user/app/server.js'], cwd: '/home/user/app',
  });
  await fm.registerPort(b.pid, 3000);
  assert.equal(fm.portRegistry?.get?.(3000)?.pid ?? self.portRegistry.get(3000)?.pid, b.pid, 'the server is not broken: 3000 is registered');
  const mismatched = await rowFor(ctx, b.pid);
  assert.deepEqual(mismatched.portMismatch, { listened: 3000, reserved: 20730 });
  assert.equal(mismatched.port, 3000, 'the row names the port it actually bound');
  assert.ok(notices.some((line) => /listened on 3000 but its reservation owns 20730/.test(line)),
    `the user is told loudly; notices were: ${JSON.stringify(notices)}`);
  listed = (await rpcListApps(self)).find((app) => app.owner === owner);
  assert.equal(listed.status, 'failed');
  assert.equal(listed.diagnostic, 'listened on 3000, owns 20730');
}

// ── 10. restart policy ──────────────────────────────────────────────────────
{
  const { fm, ctx, self, processes, notices, world } = setup();
  // 'on-failure' rides the env into the row.
  const a = await fm.spawnNode(SERVER, {
    command: 'node crashy.js', argv: ['/home/user/app/crashy.js'], cwd: '/home/user/app', port: 20740,
    env: { NIMBUS_RESTART: 'on-failure' },
  });
  assert.equal((await rowFor(ctx, a.pid)).restart, 'on-failure');
  const boots = world.boots.length;
  // The process crashes: the terminal hook re-drives it after the backoff.
  fm.finishProcess(a.pid, 1, 'crashed');
  const redriven = await waitFor(async () => (await journalRows(ctx)).find((r) => r.pid > a.pid && r.command === 'node crashy.js'), 5_000);
  assert.ok(redriven, 'a crash under on-failure re-drove the launch');
  assert.equal(redriven.restarts, undefined, 'no parallel restart counter');
  assert.equal(redriven.restart, 'on-failure', 'so is the policy');
  await waitFor(async () => processes.get(redriven.pid)?.state === 'running' && self.portRegistry.get(20740)?.pid === redriven.pid, 5_000);
  assert.equal(world.boots.length, boots + 1, 'one boot for the restart');
  assert.equal(await rowFor(ctx, a.pid), undefined, 'the crashed row is superseded');
  assert.ok(notices.some((line) => /exited with code 1 — restarting in 1s \(FencedWork attempt 1/.test(line)), JSON.stringify(notices));

  // Healthy boot resets the SAME attempt budget. A spent unproven launch
  // cannot bypass the journal's ceiling through the terminal-hook path.
  const healthy = await rowFor(ctx, redriven.pid);
  assert.equal(healthy.attempt, 0);
  await ctx.storage.put(`resident-launch:${redriven.pid}`, { ...healthy, phase: 'starting', attempt: FENCED_WORK_MAX_ATTEMPT });
  fm.finishProcess(redriven.pid, 1, 'crashed before healthy boot');
  await waitFor(async () => (await rowFor(ctx, redriven.pid)) === undefined, 5_000);
  assert.ok(notices.some((line) => /leaving it stopped/.test(line)), JSON.stringify(notices.slice(-3)));
  assert.equal((await journalRows(ctx)).some((r) => r.command === 'node crashy.js'), false, 'nothing left to re-drive');

  // 'never' (the default) and a clean exit release the row.
  const b = await fm.spawnNode(SERVER, {
    command: 'node fine.js', argv: ['/home/user/app/fine.js'], cwd: '/home/user/app', port: 20741,
  });
  assert.equal((await rowFor(ctx, b.pid)).restart, 'never');
  const bootsBefore = world.boots.length;
  fm.finishProcess(b.pid, 1, 'crashed');
  await waitFor(async () => (await rowFor(ctx, b.pid)) === undefined, 5_000);
  assert.equal((await journalRows(ctx)).some((r) => r.command === 'node fine.js'), false, "'never' releases on a crash");
  const c = await fm.spawnNode(SERVER, {
    command: 'node clean.js', argv: ['/home/user/app/clean.js'], cwd: '/home/user/app', port: 20742,
    env: { NIMBUS_RESTART: 'on-failure' },
  });
  fm.finishProcess(c.pid, 0, 'exited');
  await waitFor(async () => (await rowFor(ctx, c.pid)) === undefined, 5_000);
  assert.equal((await journalRows(ctx)).some((r) => r.command === 'node clean.js'), false, 'a clean exit releases under on-failure too');
  const d = await fm.spawnNode(SERVER, {
    command: 'node killed.js', argv: ['/home/user/app/killed.js'], cwd: '/home/user/app', port: 20743,
    env: { NIMBUS_RESTART: 'on-failure' },
  });
  fm.kill(d.pid);
  await waitFor(async () => (await rowFor(ctx, d.pid)) === undefined, 5_000);
  assert.equal((await journalRows(ctx)).some((r) => r.command === 'node killed.js'), false, 'a kill is not a failure');
  assert.equal(world.boots.length, bootsBefore + 2, 'no restart booted for never/clean/killed — only c and d booted');

  // startProcess({ restart }) is the SDK's way in: it lands in the env.
  await assert.rejects(rpcStartProcess(self, 'node x.js', { restart: 'sometimes' }), /restart must be/,
    'an unknown policy is refused before anything starts');
}

// ── 11. apps.list shapes ────────────────────────────────────────────────────
{
  const { self, portRegistry, ctx } = setup();
  portRegistry.register(20840, 999);
  const exposed = await rpcExposePort(self, 20840);
  assert.equal(exposed.owner, null, 'legacy bare ports remain supported through the shared exposure implementation');
  assert.equal((await readPortReservation(ctx, 20840)).owner, null);
  assert.equal(exposed.capability, portRegistry.get(20840).capability);
}
{
  const { fm, ctx, self } = setup();
  await reservePort(ctx, { owner: 'embedder-app', preferredPort: 20750, occupiedPorts: NONE, visibility: 'public', capability: 'f'.repeat(24), name: 'shop' });
  const a = await fm.spawnNode(SERVER, {
    command: 'node server.js', argv: ['/home/user/app/server.js'], cwd: '/home/user/app', port: 20751,
  });
  const apps = await rpcListApps(self);
  const reservedOnly = apps.find((app) => app.owner === 'embedder-app');
  assert.deepEqual(reservedOnly, {
    owner: 'embedder-app', name: 'shop', port: 20750, pid: null, status: 'stopped', visibility: 'public',
    capability: 'f'.repeat(24), restart: 'never', diagnostic: null,
    url: `https://${'f'.repeat(24)}--shop--${SID}.${SUFFIX}/`,
  }, 'a reservation nothing serves is stopped, with its public name URL');
  const live = apps.find((app) => app.pid === a.pid);
  assert.deepEqual(live, {
    owner: (await rowFor(ctx, a.pid)).owner, name: null, port: 20751, pid: a.pid, status: 'running', visibility: 'scoped',
    capability: null, restart: 'never', diagnostic: null, url: `https://20751--${SID}.${SUFFIX}/`,
  }, 'a live unexposed resident is running, scoped, with the port URL');
  // A path-form deployment (no suffix) answers the path form on the session's origin.
  const pathSelf = { ...self, env: { ...self.env, NIMBUS_PREVIEW_HOST_SUFFIX: undefined } };
  const pathApps = await rpcListApps(pathSelf);
  assert.equal(pathApps.find((app) => app.owner === 'embedder-app').url, `https://probe.test/s/${SID}/app/shop/`);
  assert.equal(pathApps.find((app) => app.pid === a.pid).url, `https://probe.test/s/${SID}/port/20751/`);
}

async function waitFor(probe, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor: nothing within ${budgetMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

console.log('ok - universal durability (unconditional stamp + re-drive without reservation, derived identity, ephemeral duplicate, lazy expose, capability bound to identity, rotate, remove, name hosts, $PORT injection + mismatch, restart policy, apps.list)');
await rm(outputDir, { recursive: true, force: true });
