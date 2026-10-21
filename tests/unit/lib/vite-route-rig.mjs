// A session DO for driving the vite routes through handleFetch: whatever
// `storage` seeds is in storage, nothing is in memory, and the port registry
// is empty. startVite runs a dev server in it.

import { ISOLATE_NETWORK } from '../../../packages/core/src/_shared/workspace-network.ts';
import { PortRegistry } from '../../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../../packages/core/src/runtime/session-process-supervisor.ts';
import { ProcessFiles } from '../../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { memoryStorage } from './do-storage.mjs';
import { sessionProcessEnv } from '../../../packages/worker/src/session/process-env.ts';

export const SID = 'nimble-otter-4271';
export const BASE_PATH = `/s/${SID}`;
export const PREVIEW_BASE = `${BASE_PATH}/preview`;
export const VITE_PORT = 5173;
export const ROOT = 'home/user/example-app';

/** A read-only filesystem over `files` (path → text), as the vite routes read it. */
export function readOnlyVfs(files) {
  const view = {
    exists: (p) => files.has(p),
    isDirectory: () => false,
    readFileString: (p) => files.get(p),
    readFile: (p) => new TextEncoder().encode(files.get(p) ?? ''),
  };
  return { as: () => view };
}

/** The session's namespace over `fs`: a database's own; a read-only stand-in tells no changes. */
const namespaces = new WeakMap();
function namespaceOf(fs) {
  if (!(fs instanceof SqliteVFS)) return { watchChanges: () => () => {} };
  if (!namespaces.has(fs)) namespaces.set(fs, new ProcessFiles(fs).vfs);
  return namespaces.get(fs);
}

/**
 * The session. `vfs()` builds its filesystem on first use; `routes` is the
 * bundled session/routes.ts (its acceptCirrusHmrWs when the test bundled it).
 * `restore` is what the session's restore of the dev servers a previous
 * incarnation ran answers (dev-servers.ts; it has none by default).
 * `self.store` is the storage map.
 */
export function makeSession(storage, { vfs, routes, bundlePool = null, pidBase = 100, restore = async () => [] }) {
  const store = new Map(Object.entries(storage));
  const processes = new SessionProcessSupervisor();
  processes.setPidBase(pidBase);
  const sessionStorage = memoryStorage({ rows: store });
  const self = {
    // The session's workspace, for what it hands a dev server: its network (no egress here).
    runtimeWorkspace: { network: ISOLATE_NETWORK },
    env: {},
    sqliteFs: null,
    esbuildService: null,
    // The namespace as host code reads it: this fake session's one filesystem.
    getFilesystemAuthority() { this.ensureSqliteFs(); return { namespaceFs: (cred) => this.sqliteFs.as(cred), vfs: namespaceOf(this.sqliteFs) }; },
    bundlePool,
    viteDevServer: null,
    cirrusReal: null,
    _viteShimPid: null,
    _viteShimPort: null,
    sessionBasePath: BASE_PATH,
    sessionBasePathHydrated: true,
    portRegistry: new PortRegistry(),
    processes,
    ctx: {
      storage: sessionStorage,
      acceptWebSocket() {},
    },
    processEnv: sessionProcessEnv(sessionStorage),
    get nimbusDebug() { return false; },
    get viteBasePath() { return (this.sessionBasePath || '') + '/preview'; },
    async hydrateSessionBasePath() {},
    ensureSqliteFs() { if (!this.sqliteFs) this.sqliteFs = vfs(); },
    // Without a pool, cold /@modules/ misses take the legacy path.
    ensureBundlePool() { return this.bundlePool; },
    restoreDevServers: restore,
    acceptCirrusHmrWs: (request) => routes.acceptCirrusHmrWs(self, request),
  };
  self.store = store;
  return self;
}

/** Run the built-in dev server in `self` on `port`, serving ROOT, as /api/start-vite starts one. */
export async function startVite(self, routes, port = VITE_PORT) {
  const response = await routes.handleFetch(self, pathRequest('/api/start-vite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: ROOT, port }),
  }));
  if (response.status !== 200) throw new Error(`/api/start-vite answered ${response.status}: ${await response.text()}`);
  return self;
}

/**
 * `self`'s facet manager, as far as a real-vite launch reads it: a resident
 * under the identity it is given, its port bound to the process, which
 * answers as the real-vite server.
 */
export function withResidentLauncher(self) {
  self.facetManager = {
    async spawnWorker(_code, command, cwd, opts) {
      const entry = self.processes.spawn(command, opts.identity.argv, cwd, { cred: opts.identity.cred, execId: opts.identity.execId });
      const handleHttpRequest = async (request) =>
        new Response(`real-vite served ${new URL(request.url).pathname}`, { status: 200, headers: { 'X-Served-By': 'cirrus-real' } });
      self.portRegistry.bindFacetStub(entry.pid, { handleHttpRequest });
      self.portRegistry.register(opts.port, entry.pid);
      return { pid: entry.pid, boot: {}, facet: { fetch: handleHttpRequest } };
    },
    kill: () => true,
  };
  self.ensureFacetManager = () => self.facetManager;
  return self;
}

/** The real-vite controller with its launch stubbed: it launches through the session's manager. */
export const REAL_VITE_STUB = `
  export function shouldUseRealVite() { return true; }
  export class CirrusReal {
    constructor(opts) { this.opts = opts; this.port = opts.port; this.pid = 0; this._running = false; }
    get isRunning() { return this._running; }
    async start(_ctx, launcher, _processes, identity) {
      ({ pid: this.pid, facet: { fetch: this.route } } = await launcher.spawnWorker('', 'vite (real)', identity.cwd, { port: this.port, identity }));
      this._running = true;
    }
    handleRequest(request, innerPath) { return this.route(new Request('http://cirrus-real' + innerPath, request)); }
    attachHmrClient() { return 'client-1'; }
    get stats() { return { snapshot: null, viteVersion: 'test' }; }
  }
`;

/** A request through the `<port>--<sid>` host: forwarded as `/port/<n>/…`, mounted at the origin root. */
export function hostRequest(path, init = {}) {
  return new Request(`https://nimbus-os.dev${path}`, { ...init, headers: { 'X-Nimbus-Base': '', ...(init.headers || {}) } });
}

/** A request through a `/s/<sid>/…` path: the base header carries `/s/<sid>`. */
export function pathRequest(path, init = {}) {
  return new Request(`https://nimbus-os.dev${path}`, { ...init, headers: { 'X-Nimbus-Base': BASE_PATH, ...(init.headers || {}) } });
}
