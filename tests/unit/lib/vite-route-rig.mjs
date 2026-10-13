// A session DO that just woke from hibernation, for driving the vite routes
// through handleFetch: `vite-config` (or whatever `storage` seeds) is in
// storage, nothing is in memory, and the port registry is empty.

import { ISOLATE_NETWORK } from '../../../packages/core/src/_shared/workspace-network.ts';
import { PortRegistry } from '../../../packages/core/src/runtime/port-registry.ts';
import { CRED_SESSION_USER } from '../../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';

export const SID = 'nimble-otter-4271';
export const BASE_PATH = `/s/${SID}`;
export const PREVIEW_BASE = `${BASE_PATH}/preview`;
export const VITE_PORT = 5173;
export const ROOT = 'home/user/example-app';

/** What the shim dev server persists at start. */
export const HIBERNATED = Object.freeze({
  'vite-config': { root: ROOT, basePath: PREVIEW_BASE, port: VITE_PORT,
    identity: { cwd: `/${ROOT}`, argv: ['vite'], cred: CRED_SESSION_USER },
  },
});

/** What cirrus-real persists at start (see start-real-vite.ts). */
export const HIBERNATED_REAL = Object.freeze({
  'vite-config': {
    devServer: 'real', root: ROOT, port: VITE_PORT,
    basePath: PREVIEW_BASE, configDir: ROOT,
    identity: { cwd: `/${ROOT}`, argv: ['vite'], cred: CRED_SESSION_USER },
  },
});

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
 * The woken session. `vfs()` builds its filesystem on first use; `routes`
 * is the bundled session/routes.ts (its restorePersistedDevServer, and
 * acceptCirrusHmrWs when the test bundled it). `self.store` is the storage
 * map, for hibernating again.
 */
export function makeWokenSession(storage, { vfs, routes, bundlePool = null, pidBase = 100 }) {
  const store = new Map(Object.entries(storage));
  let nextPid = pidBase;
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
    _realViteRestore: null,
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
      acceptWebSocket() {},
    },
    get nimbusDebug() { return false; },
    get viteBasePath() { return (this.sessionBasePath || '') + '/preview'; },
    async hydrateSessionBasePath() {},
    ensureSqliteFs() { if (!this.sqliteFs) this.sqliteFs = vfs(); },
    // Without a pool, cold /@modules/ misses take the legacy path.
    ensureBundlePool() { return this.bundlePool; },
    restorePersistedDevServer: (onlyPort) => routes.restorePersistedDevServer(self, onlyPort),
    acceptCirrusHmrWs: (request) => routes.acceptCirrusHmrWs(self, request),
  };
  self.store = store;
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
      self.portRegistry.bindFacetStub(entry.pid, {
        async handleHttpRequest(request) {
          return new Response(`real-vite served ${new URL(request.url).pathname}`, { status: 200, headers: { 'X-Served-By': 'cirrus-real' } });
        },
      });
      self.portRegistry.register(opts.port, entry.pid);
      return { pid: entry.pid, boot: {} };
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
      ({ pid: this.pid } = await launcher.spawnWorker('', 'vite (real)', identity.cwd, { port: this.port, identity }));
      this._running = true;
    }
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
