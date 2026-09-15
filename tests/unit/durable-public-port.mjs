#!/usr/bin/env bun
// A durable application's public URL is a capability, not a session.
//
// `<cap 24hex>--<port>--<sid>.<suffix>` is the unauthenticated sibling of
// the attach-token preview host: the router names no session:attach scope
// on it, forwards the request with the capability as the only credential,
// and the session answers it only when the port's stored visibility is
// `public` — anything else is 404. The capability and the visibility live
// on the reservation row, minted by `ensureDurableApp` before the
// application has ever booted and re-adopted by every binding it makes.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildPreviewHost,
  buildPublicPreviewHost,
  parsePreviewHost,
} from '../../packages/worker/src/_shared/preview-host.ts';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';
import { issueNimbusToken } from '../../packages/worker/src/auth/token.ts';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { resolveDurableWorkerImage } from '../../packages/worker/src/facets/durable-images.ts';
import {
  reservePort,
  readPortReservation,
} from '../../packages/worker/src/session/port-capability.ts';
import { createFacetWorld, createFacetCtx } from './facet-host-harness.mjs';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import {
  PUBLIC_BEARER_HEADER,
  PREVIEW_CAPABILITY_HEADER,
} from '../../packages/worker/src/_shared/session-router.ts';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const NONE = new Set();
const sid = 'nimble-otter-4271';
const suffix = 'nimbus-os.dev';
const CAP = 'abcdef0123456789abcdef01';

// ── 1. the two host forms are exact, disjoint inverses ───────────────────────
{
  const legacy = buildPreviewHost(sid, 3000, suffix);
  const legacyParsed = parsePreviewHost(legacy, suffix);
  assert.equal(legacyParsed?.port, 3000);
  assert.equal(legacyParsed?.sid, sid);
  assert.equal(legacyParsed?.capability, undefined, 'the legacy form is a scoped preview');

  const publicHost = buildPublicPreviewHost(sid, 3000, CAP, suffix);
  const publicParsed = parsePreviewHost(publicHost, suffix);
  assert.equal(publicParsed?.port, 3000);
  assert.equal(publicParsed?.sid, sid);
  assert.equal(publicParsed?.capability, CAP,
    'the leading 24-hex run is the capability, not the port');

  // Everything that fails either form is not a preview host at all.
  for (const bad of [
    'zzzz--3000--nimble-otter-4271',
    'abcdef0123456789abcdef01--0--nimble-otter-4271',
    'abcdef0123456789abcdef01--3000',
  ]) {
    assert.equal(parsePreviewHost(`${bad}.${suffix}`, suffix), null, `${bad} is not a preview host`);
  }
}

// ── 2. the router forwards the public form with no session:attach auth ───────
{
  class FakeNamespace {
    names = [];
    requests = [];
    idFromName(name) { this.names.push(name); return { name }; }
    get() {
      return {
        fetch: async (request) => {
          this.requests.push(request);
          return Response.json({
            pathname: new URL(request.url).pathname,
            bearer: request.headers.get(PUBLIC_BEARER_HEADER),
            cap: request.headers.get(PREVIEW_CAPABILITY_HEADER),
            tenant: request.headers.get('X-Nimbus-Tenant'),
          });
        },
      };
    }
  }
  // The public directory DO, faked: bind/resolve over a Map.
  const directoryRows = new Map();
  class FakePublicDirectory {
    idFromName(name) { return { name }; }
    get() {
      return {
        bind: async (cap, entry) => { directoryRows.set(cap, entry); },
        unbind: async (cap) => { directoryRows.delete(cap); },
        resolve: async (cap) => directoryRows.get(cap) ?? null,
      };
    }
  }
  const env = {
    JWT_SECRET: 'public-preview-secret',
    NIMBUS_PREVIEW_HOST_SUFFIX: suffix,
    NIMBUS_SESSION: new FakeNamespace(),
    NIMBUS_PUBLIC_DIRECTORY: new FakePublicDirectory(),
  };
  // The session bound the capability when the port went public: the
  // directory knows which tenant segment the URL belongs to.
  directoryRows.set(CAP, { tenantSegment: 'acme:alice', sid, port: 3000 });
  const handler = createNimbusHandler({ auth: { mode: 'enforce' } });
  const host = buildPublicPreviewHost(sid, 3000, CAP, suffix);

  // No Authorization, no cookie, no query token — the capability is all of it.
  const routed = await handler.fetch(new Request(`https://${host}/app.js`), env, { waitUntil() {} });
  assert.equal(routed.status, 200, 'a public capability request reaches the session unauthenticated');
  assert.equal(env.NIMBUS_SESSION.names.at(-1), `acme:alice:${sid}`,
    'the forward names the directory-resolved tenant segment, not a legacy one');
  const forwarded = await routed.json();
  assert.equal(forwarded.pathname, '/port/3000/app.js');
  assert.equal(forwarded.bearer, '1', 'the bearer mark is set');
  assert.equal(forwarded.cap, CAP, 'the capability rides its header');

  // A capability the directory never heard of is a plain 404 — nothing is
  // forwarded anywhere for it.
  const unknown = await handler.fetch(
    new Request(`https://${buildPublicPreviewHost(sid, 3000, '0'.repeat(24), suffix)}/`),
    env,
    { waitUntil() {} },
  );
  assert.equal(unknown.status, 404, 'an unbound capability is 404, not a guess');

  // The scoped form still demands a session attach in enforce mode.
  const scoped = await handler.fetch(
    new Request(`https://${buildPreviewHost(sid, 3000, suffix)}/`),
    env,
    { waitUntil() {} },
  );
  assert.equal(scoped.status, 401, 'the scoped form still requires session:attach');
}

// ── 3. the session gate: visibility is the stored record's, capability the
//      bearer's ─────────────────────────────────────────────────────────────
{
  const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-public-port-test-'));
  const build = await Bun.build({
    entrypoints: ['./packages/worker/src/session/port-capability.ts'],
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
  const entry = build.outputs.find((output) => output.path.endsWith('/port-capability.js'));
  const { routeToSessionPort } = await import(pathToFileURL(entry.path).href);

  const boots = [];
  const world = createFacetWorld(() => {
    const boot = { id: `boot-${boots.length + 1}` };
    boots.push(boot);
    return {
      boot,
      async startProcess() { return { ok: true }; },
      async handleHttpRequest() { return Response.json({ served: boot.id }); },
    };
  });
  const storage = new Map();
  const ctx = createFacetCtx(world, 'public-port-do', storage);
  const disk = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(disk.sql, disk.ctx);
  const portRegistry = new PortRegistry();
  const fm = new FacetManager(ctx, { LOADER: world.loader }, new SessionProcessSupervisor(), portRegistry, processHostFor, {
    notify: () => {},
    resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(vfs, recipe),
  });
  fm.setVfs(vfs);

  // A durable application reserved 'public' with its capability minted on the
  // row — the shape ensureDurableApp writes before the app has ever run.
  await reservePort(ctx, {
    owner: 'app', preferredPort: 20500, occupiedPorts: NONE,
    capability: CAP, visibility: 'public',
  });
  await fm.spawnWorker('export default {}', 'public app', '/app', {
    durable: { owner: 'app' }, port: 20500,
  });
  // The spawn adopted the reservation's minted capability, not a fresh one.
  assert.equal(portRegistry.hasCapability(20500, CAP), true,
    'the durable spawn re-adopted the capability the reservation minted');

  const self = {
    portRegistry,
    cirrusReal: null,
    viteDevServer: null,
    _viteShimPort: null,
    ensureDurableAppOnPort: (p) => fm.ensureDurableAppOnPort(p),
    ctx,
  };
  const bearerRequest = (cap) => new Request(`https://${buildPublicPreviewHost(sid, 20500, suffix)}/`, {
    headers: {
      [PREVIEW_CAPABILITY_HEADER]: cap,
      [PUBLIC_BEARER_HEADER]: '1',
    },
  });

  const routed = await routeToSessionPort(self, 20500, bearerRequest(CAP), '/', '', CAP);
  assert.equal(routed.status, 200, 'a public port answers its public bearer');

  // The same bearer against a scoped port is 404, as is a wrong capability.
  await reservePort(ctx, {
    owner: 'closed', preferredPort: 20501, occupiedPorts: new Set([20500]),
    capability: '111111111111111111111111', visibility: 'scoped',
  });
  await fm.spawnWorker('export default {}', 'scoped app', '/app', {
    durable: { owner: 'closed' }, port: 20501,
  });
  const scoped = await routeToSessionPort(
    self, 20501,
    new Request(`https://${buildPublicPreviewHost(sid, 20501, suffix)}/`, {
      headers: {
        [PREVIEW_CAPABILITY_HEADER]: '111111111111111111111111',
        [PUBLIC_BEARER_HEADER]: '1',
      },
    }),
    '/', '', '111111111111111111111111',
  );
  assert.equal(scoped.status, 404, 'a scoped port never answers the public bearer');
  const wrongCap = await routeToSessionPort(self, 20500, bearerRequest('0'.repeat(24)), '/', '', '0'.repeat(24));
  assert.equal(wrongCap.status, 404, 'a wrong capability is 404');
  const noBearerNoCap = await routeToSessionPort(
    self, 20500,
    new Request('https://probe.test/port/20500/'),
    '/', '',
  );
  assert.equal(noBearerNoCap.status, 200, 'an internal request needs no capability');

  // ── 4. the reservation carries the capability + visibility the durable
  //      application's URL is built on, and re-reserving upgrades in place ──
  const port = await reservePort(ctx, {
    owner: 'embedder-app', preferredPort: 20600, occupiedPorts: NONE,
    capability: 'f00d00f00d00f00d00f00d00', visibility: 'public',
  });
  assert.equal(port, 20600);
  const record = await readPortReservation(ctx, 20600);
  assert.equal(record.owner, 'embedder-app');
  assert.equal(record.capability, 'f00d00f00d00f00d00f00d00',
    'the answered capability is the stored one');
  assert.equal(record.visibility, 'public');

  // Re-ensuring answers the held port and never rotates the capability —
  // but a bare reservation gains the visibility the caller asks for.
  const again = await reservePort(ctx, {
    owner: 'embedder-app', preferredPort: 20600, occupiedPorts: NONE,
    capability: '0'.repeat(24), visibility: 'public',
  });
  assert.equal(again, 20600);
  assert.equal((await readPortReservation(ctx, 20600)).capability, 'f00d00f00d00f00d00f00d00',
    're-reserving never rotates the minted capability');

  await reservePort(ctx, { owner: 'upgrade-me', preferredPort: 20700, occupiedPorts: NONE });
  assert.equal((await readPortReservation(ctx, 20700)).visibility, 'scoped',
    'a bare reservation defaults to scoped');
  await reservePort(ctx, {
    owner: 'upgrade-me', preferredPort: 20700, occupiedPorts: NONE, visibility: 'public',
  });
  assert.equal((await readPortReservation(ctx, 20700)).visibility, 'public',
    're-reserving upgrades visibility in place');

  await rm(outputDir, { recursive: true, force: true });
}

console.log('ok - public durable port (host forms disjoint, router forwards unauthenticated, visibility gates, reservations mint + upgrade)');
