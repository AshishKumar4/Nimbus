// A session DO that just woke from hibernation, for driving the vite routes
// through handleFetch: `vite-config` (or whatever `storage` seeds) is in
// storage, nothing is in memory, and the port registry is empty.

import { ISOLATE_NETWORK } from '../../../packages/core/src/_shared/workspace-network.ts';
import { PortRegistry } from '../../../packages/core/src/runtime/port-registry.ts';
import { CRED_SESSION_USER } from '../../../packages/core/src/runtime/os-contracts.ts';

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
  return { as: () => view, events: { on: () => () => {} } };
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
    getFilesystemAuthority() { this.ensureSqliteFs(); return { namespaceFs: (cred) => this.sqliteFs.as(cred) }; },
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

/** A request through the `<port>--<sid>` host: forwarded as `/port/<n>/…`, mounted at the origin root. */
export function hostRequest(path, init = {}) {
  return new Request(`https://nimbus-os.dev${path}`, { ...init, headers: { 'X-Nimbus-Base': '', ...(init.headers || {}) } });
}

/** A request through a `/s/<sid>/…` path: the base header carries `/s/<sid>`. */
export function pathRequest(path, init = {}) {
  return new Request(`https://nimbus-os.dev${path}`, { ...init, headers: { 'X-Nimbus-Base': BASE_PATH, ...(init.headers || {}) } });
}
