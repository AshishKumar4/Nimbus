#!/usr/bin/env bun
// A real-vite dev server started by an exec carries the exec's id, persists
// it with its config, and keeps it across a hibernation.
//
// The `vite` builtin boots real-vite through startRealVite, which reserves
// the server's pid with the identity the command hands it: cwd, argv, and
// the exec id of the process that ran `vite`. The vite-config the restore
// reads carries that identity, so a woken session restores the server with
// the same cwd, argv and execId, and its port still names the job that
// started it. Before, restore passed no identity at all, so a restored
// real-vite pid was `[]` at the root whatever had been persisted.
// The facet internals are stubbed as in port-route-real-vite-restore.mjs.

import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';

const root = new URL('../../', import.meta.url).pathname;
const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-exec-id-real-vite-'));
let routes;
let realVite;
try {
  const entryPath = join(outputDir, 'entry.ts');
  await writeFile(entryPath, [
    `export { handleFetch, restorePersistedDevServer } from '${root}packages/worker/src/session/routes.ts';`,
    `export { startRealVite } from '${root}packages/worker/src/session/start-real-vite.ts';`,
    '',
  ].join('\n'));
  const build = await Bun.build({
    entrypoints: [entryPath],
    outdir: join(outputDir, 'out'),
    target: 'bun',
    format: 'esm',
    plugins: [{
      name: 'cirrus-real-test-stubs',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
        builder.onResolve({ filter: /facets\/cirrus-real\.js$/ }, () => ({ path: 'cirrus', namespace: 'stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
          if (args.path === 'cf') {
            return { contents: 'export class DurableObject {}; export class WorkerEntrypoint {};', loader: 'js' };
          }
          return {
            loader: 'js',
            contents: `
              export function shouldUseRealVite() { return true; }
              export class CirrusReal {
                constructor(opts) { this.opts = opts; this._running = false; }
                get isRunning() { return this._running; }
                async start() { this._running = true; }
                stop() { this._running = false; }
                async handleRequest() { return new Response('real-vite', { status: 200 }); }
                get stats() { return { snapshot: null, viteVersion: 'test' }; }
              }
            `,
          };
        });
      },
    }],
  });
  assert.equal(build.success, true, build.logs.map(String).join('\n'));
  const entry = await import(pathToFileURL(build.outputs.find((o) => o.path.endsWith('/entry.js')).path).href);
  routes = entry;
  realVite = entry.startRealVite;
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

const BASE_PATH = '/s/nimble-otter-4271';
const ROOT = 'home/user/example-app';
const PORT = 5173;

/** One instance of the session: its process table in memory, its storage shared. */
function session(store, generation) {
  const processes = new SessionProcessSupervisor();
  processes.setPidBase(generation * PID_GEN_STRIDE);
  const files = new Map([[`${ROOT}/package.json`, '{"name":"app"}']]);
  const view = {
    exists: (p) => files.has(p),
    isDirectory: () => false,
    readFileString: (p) => files.get(p),
    readFile: (p) => new TextEncoder().encode(files.get(p) ?? ''),
  };
  const self = {
    runtimeWorkspace: { network: ISOLATE_NETWORK },
    env: {},
    sqliteFs: null,
    esbuildService: null,
    viteDevServer: null,
    cirrusReal: null,
    _viteShimPid: null,
    _viteShimPort: null,
    _realViteRestore: null,
    sessionBasePath: BASE_PATH,
    sessionBasePathHydrated: true,
    portRegistry: new PortRegistry(),
    processes,
    ctx: {
      storage: {
        async get(k) { return store.get(k); },
        async put(k, v) { store.set(k, v); },
        async delete(k) { store.delete(k); },
        async transaction(body) { return body(this); },
      },
      acceptWebSocket() {},
    },
    get nimbusDebug() { return false; },
    get viteBasePath() { return `${BASE_PATH}/preview`; },
    async hydrateSessionBasePath() {},
    ensureSqliteFs() { if (!this.sqliteFs) this.sqliteFs = { as: () => view, events: { on: () => () => {} } }; },
    ensureBundlePool() { return null; },
    restorePersistedDevServer: (onlyPort) => routes.restorePersistedDevServer(self, onlyPort),
  };
  return self;
}

const store = new Map();
const first = session(store, 1);
first.ensureSqliteFs();
// What the `vite` builtin hands it when an exec named 'j1' ran `vite --port 5173`.
await realVite(first, {
  root: ROOT, port: PORT, basePath: `${BASE_PATH}/preview`, configDir: ROOT,
  identity: { cwd: `/${ROOT}`, argv: ['vite', '--port', String(PORT)], cred: CRED_SESSION_USER, execId: 'j1' },
});
const served = first.processes.get(first.portRegistry.get(PORT).pid);
assert.equal(served.execId, 'j1', 'the dev server carries the execId of the command that started it');
assert.deepEqual(store.get('vite-config').identity, { cwd: `/${ROOT}`, argv: ['vite', '--port', String(PORT)], cred: CRED_SESSION_USER, execId: 'j1' },
  'the persisted identity carries the execId, and the credential it ran as');
console.log('  [1] a real-vite server started by an exec carries its execId and persists it');

// Hibernation: a new instance over the same storage, nothing in memory.
const woken = session(store, 2);
const res = await routes.handleFetch(woken, new Request(`https://nimbus-os.dev/port/${PORT}/`, { headers: { 'X-Nimbus-Base': '' } }));
assert.equal(res.status, 200, `the restored real-vite serves, got ${res.status}`);
const restored = woken.processes.get(woken.portRegistry.get(PORT).pid);
assert.ok(restored.pid > 2 * PID_GEN_STRIDE, 'under a pid of the new generation');
assert.deepEqual({ cwd: restored.cwd, argv: restored.argv, execId: restored.execId }, { cwd: `/${ROOT}`, argv: ['vite', '--port', String(PORT)], execId: 'j1' },
  'the restored server is given the persisted identity, its execId included');
console.log('  [2] a hibernation restores it with the persisted cwd, argv and execId');

// A config written before it recorded who the server ran as is not
// restored: it would read the project as someone else.
const legacy = new Map([['vite-config', { devServer: 'real', root: ROOT, port: PORT, basePath: `${BASE_PATH}/preview`, configDir: ROOT }]]);
const old = session(legacy, 3);
const oldRes = await routes.handleFetch(old, new Request(`https://nimbus-os.dev/port/${PORT}/`, { headers: { 'X-Nimbus-Base': '' } }));
assert.notEqual(oldRes.status, 200, 'nothing serves the port');
assert.equal(old.portRegistry.get(PORT), undefined, 'and no server was started for it');
console.log('  [3] a config persisted before credentials is not restored');

console.log('exec-id-real-vite-restore OK');
