/**
 * cirrus-real.ts — Real Vite inside a Cloudflare DO facet.
 *
 * Ships alongside the in-process Cirrus shim (src/vite-dev-server.ts,
 * untouched). Users opt into real-vite mode via `NIMBUS_REAL_VITE=1`
 * or `nimbusDevServer: 'real'` in vite.config.ts.
 *
 * Phase status (PHASE2-REAL-VITE-PLAN.md):
 *   0 (import + createServer + listen)        — GREEN, shipped
 *   1 (VFS-backed fs shim)                    — implemented here
 *   2 (HMR over our /ws)                      — implemented here
 *   3 (real @vitejs/plugin-react)             — depends on plugin preload
 *   4 (opt-in polish + boot banner)           — implemented in nimbus-session
 *
 * Architecture:
 *
 *    NimbusSession (supervisor DO)
 *       │
 *       │ LOADER.load({
 *       │   modules: {
 *       │     main.js                — facet entrypoint (generated)
 *       │     vite.bundle.js         — 2.3 MB real Vite (pre-bundled)
 *       │     cirrus-fs.js           — our fs shim (src/real-vite-fs-shim.ts)
 *       │     cirrus-fs-promises.js  — ditto (fs/promises)
 *       │     cirrus-ws.js           — our ws-shim (src/real-vite-hmr.ts)
 *       │     cirrus-chokidar.js     — our chokidar shim (src/real-vite-hmr.ts)
 *       │     real-node-fs.js        — raw node:fs re-export
 *       │     synthetic.js           — seeds globalThis.__cirrusRealFs
 *       │                              with the VFS snapshot
 *       │     user-vite-config.js    — pre-bundled vite.config.ts
 *       │   }
 *       │ })
 *       ▼
 *    Dynamic Worker (facet)
 *       - imports synthetic.js (side-effect: populates globalThis.__cirrusRealFs)
 *       - imports vite.bundle.js (evaluates, sees the seeded fs Map)
 *       - starts Vite server via `createServer().listen()`
 *       - exposes fetch via httpServerHandler({port}) from cloudflare:node
 *       - runs a long-poll loop against env.SUPERVISOR.hmrNextEvent
 *         that delivers VFS change events to the chokidar shim + HMR
 *         client messages to the ws shim
 *
 * All traffic in / out:
 *    Browser ──/preview/* ──>  DO.fetch   ──>  facetStub.fetch
 *    Browser ──/preview/__nimbus_hmr──>  DO.fetch (WS upgrade)
 *                                  │
 *                                  ▼
 *                               HmrBridge (nimbus-session-side)
 *                                  │  long-poll
 *                                  ▼
 *                               facet loop  ──>  chokidar / ws shim
 */

import { REAL_VITE_BUNDLE, REAL_VITE_VERSION, ROLLUP_WASM_BASE64, VITE_CLIENT_MJS, VITE_ENV_MJS } from './real-vite-bundle.generated.js';
import { CIRRUS_PLUGIN_REACT_BUNDLE, CIRRUS_PLUGIN_REACT_VERSION } from './cirrus-plugin-react.generated.js';
import { CIRRUS_NPM_CJS_BUNDLES, CIRRUS_NPM_CJS_VERSIONS } from './cirrus-npm-cjs.generated.js';
import { CF_COMPAT_DATE } from './constants.js';
import { getCtxExports } from './ctx-exports.js';
import {
  buildFsSnapshot,
  generateFsShimModuleCode,
  generateFsPromisesShimModuleCode,
  generateSyntheticModuleCode,
} from './real-vite-fs-shim.js';
import {
  HmrBridge,
  registerHmrBridge,
  unregisterHmrBridge,
  generateWsShimModuleCode,
  generateChokidarShimModuleCode,
} from './real-vite-hmr.js';
import type { SqliteVFS } from './sqlite-vfs.js';
import type { VfsEventEmitter } from './vfs-events.js';

/**
 * Compatibility flags for the real-vite facet.
 *
 *   nodejs_compat                       — base Node polyfills
 *   enable_nodejs_http_modules          — http.get / http.request
 *   enable_nodejs_http_server_modules   — http.createServer / Server
 *
 * (expose_global_message_channel is not strictly required for our flow
 *  since we don't use Worker in FakeWorker mode yet; add later if needed.)
 */
const REAL_VITE_COMPAT_FLAGS = [
  'nodejs_compat',
  'enable_nodejs_http_modules',
  'enable_nodejs_http_server_modules',
];

/**
 * Resolve opt-in mode.
 *
 * Priority: env var > vite.config.ts regex sniff > default ('cirrus').
 */
export function shouldUseRealVite(opts: {
  env?: Record<string, string | undefined> | undefined;
  viteConfigSource?: string | undefined;
}): boolean {
  const env = opts.env || {};
  const v = env.NIMBUS_REAL_VITE;
  if (v != null) {
    const s = String(v).trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'real') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'cirrus' || s === 'shim') return false;
  }
  const cfg = opts.viteConfigSource;
  if (cfg) {
    // Regex-only (safe: no eval). Matches `nimbusDevServer: 'real'` /
    // `'shim'` / `'auto'` with either quote style.
    const m = cfg.match(/nimbusDevServer\s*:\s*['"]([a-z-]+)['"]/i);
    if (m) {
      const mode = m[1].toLowerCase();
      if (mode === 'real' || mode === 'real-vite') return true;
      if (mode === 'cirrus' || mode === 'shim') return false;
      if (mode === 'auto') {
        // Heuristic: if the config imports any @vitejs/* plugin, prefer
        // real-vite; otherwise stick with Cirrus.
        return /@vitejs\/plugin-[\w-]+/.test(cfg);
      }
    }
  }
  return false;
}

// ── Facet entrypoint source generator ─────────────────────────────────

function generateMainModuleCode(opts: {
  port: number;
  root: string;
  basePath: string;
  hasUserViteConfig: boolean;
}): string {
  const { port, root, basePath, hasUserViteConfig } = opts;
  const configImportLine = hasUserViteConfig
    ? `import __userConfig from './user-vite-config.js';`
    : `const __userConfig = {};`;
  return `
// ── Facet entrypoint: real Vite in a DO ─────────────────────────────
// Generated by src/cirrus-real.ts.

globalThis.__cirrusFsDebug = false;
globalThis.__cirrusResolveDebug = false;

// ── Phase-A memory telemetry ──────────────────────────────────────
// Records process.memoryUsage() at key phases so we can measure
// exactly where heap grows. Numbers go to the supervisor RPC
// (telemetry.report) AND stdout for the wrangler log.
let __cirrusPhaseBaseline = null;
function __cirrusMem(phase) {
  try {
    const mu = process.memoryUsage();
    const cache = globalThis.__cirrusRealFs?.files?.size ?? 0;
    const cacheBytes = globalThis.__cirrusRealFsLruSize ?? 0;
    const row = {
      phase,
      heapUsed: (mu.heapUsed / 1024 / 1024).toFixed(1) + 'MB',
      heapTotal: (mu.heapTotal / 1024 / 1024).toFixed(1) + 'MB',
      rss: (mu.rss / 1024 / 1024).toFixed(1) + 'MB',
      external: (mu.external / 1024 / 1024).toFixed(1) + 'MB',
      cacheEntries: cache,
      cacheKB: (cacheBytes / 1024).toFixed(0) + 'KB',
    };
    if (__cirrusPhaseBaseline == null) __cirrusPhaseBaseline = mu.heapUsed;
    row.delta = '+' + ((mu.heapUsed - __cirrusPhaseBaseline) / 1024 / 1024).toFixed(1) + 'MB';
    console.log('[cirrus-mem]', JSON.stringify(row));
  } catch (e) {
    console.log('[cirrus-mem]', phase, 'err:', e?.message || e);
  }
}
__cirrusMem('module-top (pre-imports)');

// workerd sometimes terminates the isolate without surfacing the
// failure on stdout — install uncaught handlers so we at least see
// the event in the wrangler log.
try {
  globalThis.addEventListener?.('error', (ev) => {
    try { console.error('[cirrus-real uncaught]', ev.error?.stack || ev.error?.message || ev.message); } catch {}
  });
  globalThis.addEventListener?.('unhandledrejection', (ev) => {
    try { console.error('[cirrus-real unhandledrejection]', ev.reason?.stack || ev.reason?.message || ev.reason); } catch {}
  });
} catch {}

import { createRequire as __cirrusCreateRequire } from 'node:module';
globalThis.__cirrusNodeCreateRequire = __cirrusCreateRequire;

import './synthetic.js';
__cirrusMem('post synthetic.js');
import './cirrus-ws.js';
import './cirrus-chokidar.js';
__cirrusMem('post ws+chokidar shims');

${configImportLine}
__cirrusMem('post user-vite-config.js');

import * as vite from './vite.bundle.js';
__cirrusMem('post vite.bundle.js');
import { httpServerHandler } from 'cloudflare:node';
__cirrusMem('all imports complete');

const PORT = ${port};
const ROOT = ${JSON.stringify(root)};
const BASE = ${JSON.stringify(basePath)};

let serverReady = null;
let readyError = null;
let boot = null;
let viteServerInstance = null;

// Env bindings — made available to the fs shim + HMR loop via
// globalThis so modules loaded AFTER the first fetch handler can
// reach them without needing env passed through.
let _supervisorBinding = null;
let _hmrBinding = null;

function installBindings(env) {
  const sup = env?.SUPERVISOR;
  if (sup && !_supervisorBinding) {
    _supervisorBinding = sup;
    globalThis.__cirrusRealSupervisor = sup;
  }
  const hmr = env?.CIRRUS_HMR;
  if (hmr && !_hmrBinding) {
    _hmrBinding = hmr;
    globalThis.__cirrusRealHmr = hmr;
  }
}

// Pre-extract HMR controls once vite is ready, so the long-poll loop
// can dispatch events to the bundled-in chokidar-shim watchers and
// ws-shim connections.
function dispatchEvents(events) {
  if (!events || events.length === 0) return;
  console.log('[cirrus-real dispatch]', events.length, 'events. types:', events.map(e => e.type).join(','));
  for (const ev of events) {
    try {
      if (ev.type === 'connection') {
        const wss = globalThis.__cirrusRealWsServer;
        console.log('[cirrus-real] connection event, wss?', !!wss);
        if (wss) wss._acceptConnection(ev.clientId);
      } else if (ev.type === 'message') {
        const wss = globalThis.__cirrusRealWsServer;
        if (wss) wss._dispatchMessage(ev.clientId, ev.msg);
      } else if (ev.type === 'disconnect') {
        const wss = globalThis.__cirrusRealWsServer;
        if (wss) wss._disconnect(ev.clientId);
      } else if (ev.type === 'vfs') {
        const ws = globalThis.__cirrusRealWatchers;
        if (ws) for (const w of ws) {
          try { w._dispatch(ev.event, ev.path, ev.oldPath); } catch {}
        }
        // CRITICAL: invalidate the fs-shim snapshot cache so
        // subsequent readFile calls hit SUPERVISOR.readFile and
        // fetch the fresh content. Without this, Vite serves the
        // OLD source on the HMR update cycle → browser reloads
        // but sees the same content → user thinks HMR is broken.
        if (globalThis.__cirrusRealFs) {
          if (ev.event === 'unlink' || ev.event === 'unlinkDir') {
            globalThis.__cirrusRealFs.files.delete(ev.path);
          } else if (ev.event === 'change' || ev.event === 'add') {
            globalThis.__cirrusRealFs.files.delete(ev.path);
          } else if (ev.event === 'rename' && ev.oldPath) {
            globalThis.__cirrusRealFs.files.delete(ev.oldPath);
            globalThis.__cirrusRealFs.files.delete(ev.path);
          }
        }
      }
    } catch (e) {
      console.warn('[cirrus-real] dispatchEvents item threw:', e?.message);
    }
  }
}

// Poll for HMR events — drive the pump off request cycles so we
// don't leave a long-poll dangling when no request is active
// (workerd may think the request itself is hung). Each fetch kicks
// the pump: a short-timeout poll (2s) that dispatches events and
// returns. If clients are connected, the pump schedules itself again
// via waitUntil.
async function pumpHmrOnce(ctx) {
  if (!_hmrBinding) return;
  try {
    // Short timeout so we don't hold a request's waitUntil chain for
    // too long. The supervisor returns immediately if there are
    // pending events, so latency is fine.
    const events = await _hmrBinding.hmrNextEvent(2_000);
    dispatchEvents(events);
    // Reschedule: if we have active WS clients or recent events, keep
    // polling. Otherwise one shot per request is enough.
    if (ctx?.waitUntil && (globalThis.__cirrusRealWsClients?.size > 0)) {
      ctx.waitUntil(pumpHmrOnce(ctx));
    }
  } catch {
    // RPC error (rare) — back off; next request will try again.
  }
}

function bootOnce() {
  if (serverReady) return serverReady;
  __cirrusMem('bootOnce.start');
  serverReady = (async () => {
    try {
      const resolvedUserConfig = typeof __userConfig === 'function'
        ? await __userConfig({ command: 'serve', mode: 'development', isSsrBuild: false, isPreview: false })
        : (__userConfig && typeof __userConfig === 'object' ? __userConfig : {});
      const cfg = {
        ...resolvedUserConfig,
        root: ROOT || '/',
        base: BASE,
        configLoader: 'runner',
        configFile: false,       // we already loaded the config above
        logLevel: 'info',
        clearScreen: false,
        optimizeDeps: {
          ...(resolvedUserConfig.optimizeDeps || {}),
          noDiscovery: true,
          include: [],
          force: false,
          disabled: true,
          entries: [],
          esbuildOptions: { ...(resolvedUserConfig.optimizeDeps?.esbuildOptions || {}), plugins: [] },
        },
        // legacy.buildSsrCjsExternalHeuristics is a no-op but listed
        // here as a reminder that we want zero esbuild invocations.
        // Disable Vite's esbuild-based TS/JSX transform entirely.
        // esbuild's JS API refuses to run when bundled into another
        // file (it requires spawning a native binary). Plugins like
        // @vitejs/plugin-react handle JSX transforms themselves via
        // Babel, so we don't actually need the built-in esbuild
        // transformer when a plugin is present.
        esbuild: false,
        server: {
          ...(resolvedUserConfig.server || {}),
          port: PORT,
          host: '127.0.0.1',
          strictPort: true,
          fs: { strict: false, ...(resolvedUserConfig.server?.fs || {}) },
          // HMR: path tells the browser @vite/client what URL to open
          // (resolved against window.location.origin). We don't set
          // clientPort/host so the browser uses same-origin — which
          // is how the user reached us in the first place.
          hmr: {
            path: '__nimbus_hmr',
            ...(typeof resolvedUserConfig.server?.hmr === 'object' ? resolvedUserConfig.server.hmr : {}),
          },
          // Enable file watching — our chokidar shim catches the
          // chokidar.watch() call and returns a CirrusWatcher that
          // delivers events from the HmrBridge long-poll. Disabling
          // polling so the shim doesn't waste cycles.
          watch: {
            usePolling: false,
            ...(resolvedUserConfig.server?.watch || {}),
          },
        },
        appType: resolvedUserConfig.appType || 'spa',
      };

      __cirrusMem('bootOnce.before createServer');
      const server = await vite.createServer(cfg);
      viteServerInstance = server;
      __cirrusMem('bootOnce.after createServer');
      await server.listen();
      __cirrusMem('bootOnce.after listen');
      return server;
    } catch (e) {
      readyError = e;
      console.error('[cirrus-real] Vite boot failed:', e && e.stack ? e.stack : e);
      throw e;
    }
  })();
  return serverReady;
}

export default {
  async fetch(request, env, ctx) {
    installBindings(env);
    const fetchUrl = request.url;
    const fetchPath = (() => { try { return new URL(fetchUrl).pathname; } catch { return '?'; } })();
    __cirrusMem('fetch.enter ' + fetchPath);
    try {
      await bootOnce();
    } catch {
      // readyError set; fall through to error response.
    }
    if (readyError) {
      const msg = '[cirrus-real] Vite failed to boot:\\n' +
        (readyError && readyError.stack ? readyError.stack : String(readyError));
      return new Response(msg, {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    // HMR pump: kick once per fetch with a short poll. Events may be
    // queued from a browser WS connection that attached between
    // requests, OR VFS events fired since the last pump. We cap at
    // one iteration per request — pumpHmrOnce re-schedules itself
    // via waitUntil when clients are connected.
    if (ctx?.waitUntil && _hmrBinding) {
      ctx.waitUntil(pumpHmrOnce(ctx));
    }
    if (!boot) boot = httpServerHandler({ port: PORT });
    try {
      const resp = await boot.fetch(request, env, ctx);
      __cirrusMem('fetch.exit ' + fetchPath + ' [' + resp.status + ']');
      return resp;
    } catch (e) {
      return new Response('[cirrus-real] httpServerHandler.fetch threw: ' +
        (e && e.stack ? e.stack : String(e)), {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  },
};
`.trim();
}

// ── Supervisor-side controller class ──────────────────────────────────

export class CirrusReal {
  private env: any;
  private port: number;
  private root: string;
  private basePath: string;
  private vfs: SqliteVFS;
  private vfsEvents: VfsEventEmitter | null;
  private userConfigBundle: string | null;
  private extraSyntheticFiles: Record<string, string>;

  private facetStub: any = null;
  private pid: number = 0;
  private bootError: string | null = null;
  private _startedAt: number = 0;
  private _snapshotStats: {
    fileCount: number;
    dirCount: number;
    totalBytes: number;
    skipped: number;
    packageJsonCount: number;
    pathIndexCount: number;
  } | null = null;

  /** HMR bridge — shared by WS upgrade handler + VFS event pump. */
  public hmr: HmrBridge = new HmrBridge();

  /** Unsubscribe from vfs events on stop(). */
  private _vfsUnsub: (() => void) | null = null;

  constructor(opts: {
    env: any;
    port: number;
    root: string;
    basePath: string;
    vfs: SqliteVFS;
    vfsEvents?: VfsEventEmitter | null;
    userConfigBundle?: string | null;
    extraSyntheticFiles?: Record<string, string>;
  }) {
    this.env = opts.env;
    this.port = opts.port;
    this.root = opts.root;
    this.basePath = opts.basePath;
    this.vfs = opts.vfs;
    this.vfsEvents = opts.vfsEvents || null;
    this.userConfigBundle = opts.userConfigBundle || null;
    this.extraSyntheticFiles = opts.extraSyntheticFiles || {};
  }

  get isRunning(): boolean {
    return this.facetStub != null && this.bootError == null;
  }

  get stats(): Record<string, unknown> {
    return {
      mode: 'real-vite',
      viteVersion: REAL_VITE_VERSION,
      pluginReactVersion: CIRRUS_PLUGIN_REACT_VERSION,
      npmCjsVersions: CIRRUS_NPM_CJS_VERSIONS,
      port: this.port,
      root: this.root,
      basePath: this.basePath,
      bootError: this.bootError,
      uptimeMs: this._startedAt ? Date.now() - this._startedAt : 0,
      snapshot: this._snapshotStats,
      sizeWarning: this._sizeWarning,
      hmrClients: this.hmr.size,
      hmrActive: this.hmr._everAwaitedEvents,
    };
  }

  /** Soft warning set during start() if the project looks too large
   *  for the facet's 128 MB isolate budget. Surfaces in `stats` so
   *  the banner printed by nimbus-session.ts can show it. Empty
   *  string when the project is in the known-good envelope. */
  private _sizeWarning: string = '';

  start(ctx: DurableObjectState, pid: number): void {
    if (this.facetStub) return;
    this.pid = pid;
    this._startedAt = Date.now();

    // Build the project snapshot for the facet's sync-fs Map.
    // (Lazy: eagerly seeds user project source + every package.json
    // under node_modules. Source files in node_modules are loaded on
    // demand via SUPERVISOR.readFile and cached in-facet.)
    const snapshot = buildFsSnapshot(this.vfs, this.root);
    this._snapshotStats = {
      fileCount: snapshot.fileCount,
      dirCount: snapshot.dirs.length,
      totalBytes: snapshot.totalBytes,
      skipped: snapshot.skipped,
      packageJsonCount: snapshot.packageJsonCount,
      pathIndexCount: snapshot.pathIndexCount,
    };

    // Size-based soft warning. Empirical findings (CIRRUS-OOM-TRACE.txt):
    //  - seed project (6307 post-install files, 2.5 MB snapshot,
    //    203 pkg.json) survived 5 min without OOM
    //  - AshishKumar4/personal-website (58033 files, 22 MB snapshot,
    //    945 pkg.json) survived 2 min without OOM
    //  - workerd isolate limit: 128 MB
    //  - static facet footprint: ~40 MB parsed modules + snapshot
    //
    // Above 100k files OR 60 MB snapshot OR 3000 pkg.json, we warn
    // but don't block. Those are empirical — we haven't actually
    // measured the ceiling because the tests held.
    const warn: string[] = [];
    if (snapshot.pathIndexCount > 100_000) {
      warn.push(`${snapshot.pathIndexCount} indexed files in node_modules (above 100k may OOM)`);
    }
    if (snapshot.totalBytes > 60 * 1024 * 1024) {
      warn.push(`snapshot is ${(snapshot.totalBytes / 1024 / 1024).toFixed(1)} MB (>60 MB may OOM)`);
    }
    if (snapshot.packageJsonCount > 3000) {
      warn.push(`${snapshot.packageJsonCount} package.json entries (above 3k strains the resolver)`);
    }
    this._sizeWarning = warn.length > 0
      ? 'size warning: ' + warn.join('; ') + '. If vite crashes, fall back to Cirrus (NIMBUS_REAL_VITE=0 vite).'
      : '';

    // Generate all the module sources.
    const mainCode = generateMainModuleCode({
      port: this.port,
      root: '/' + this.root.replace(/^\/+/, ''),
      basePath: this.basePath,
      hasUserViteConfig: this.userConfigBundle != null,
    });
    const fsShim = generateFsShimModuleCode();
    const fsPromisesShim = generateFsPromisesShimModuleCode();
    const wsShim = generateWsShimModuleCode();
    const chokidarShim = generateChokidarShimModuleCode();
    // Merge the extras (plugin-specific asset files the user-config
    // bundler pre-harvested from node_modules) into the snapshot.
    const mergedFiles = { ...snapshot.files, ...this.extraSyntheticFiles };

    // Map CJS bundle specifiers (e.g. "react/jsx-runtime") to the
    // path suffixes Vite produces when resolving a user-project
    // bare import. Vite's resolver walks node_modules and returns
    // e.g. `/<root>/node_modules/react/index.js` or
    // `/<root>/node_modules/react/jsx-runtime.js`. We use the
    // suffix match to intercept those.
    const SPEC_TO_SUFFIXES: Record<string, string[]> = {
      'react': ['/node_modules/react/index.js'],
      'react/jsx-runtime': ['/node_modules/react/jsx-runtime.js'],
      'react/jsx-dev-runtime': ['/node_modules/react/jsx-dev-runtime.js'],
      'react-dom': ['/node_modules/react-dom/index.js'],
      'react-dom/client': ['/node_modules/react-dom/client.js'],
      'scheduler': ['/node_modules/scheduler/index.js'],
    };
    const cjsPrebuiltBundles: Record<string, string> = {};
    for (const [spec, bundle] of Object.entries(CIRRUS_NPM_CJS_BUNDLES)) {
      const suffixes = SPEC_TO_SUFFIXES[spec] || [];
      for (const suffix of suffixes) {
        cjsPrebuiltBundles[suffix] = bundle.code;
      }
    }

    const syntheticCode = generateSyntheticModuleCode({
      viteVersion: REAL_VITE_VERSION,
      snapshotFiles: mergedFiles,
      snapshotDirs: snapshot.dirs,
      existingPaths: snapshot.existingPaths,
      rollupWasmBase64: ROLLUP_WASM_BASE64,
      cjsPrebuiltBundles,
      viteClientMjs: VITE_CLIENT_MJS,
      viteEnvMjs: VITE_ENV_MJS,
    });

    const ctxExports = getCtxExports();
    const supervisorBinding = ctxExports?.SupervisorRPC
      ? ctxExports.SupervisorRPC({ props: { doId: ctx.id.toString(), pid } })
      : undefined;
    // Phase 2: separate HMR binding so we don't need to modify
    // supervisor-rpc.ts (off-limits). The CirrusHmrRPC class lives in
    // src/real-vite-hmr.ts and is re-exported from src/index.ts so
    // ctx.exports can build a Service Binding for it.
    const hmrBinding = ctxExports?.CirrusHmrRPC
      ? ctxExports.CirrusHmrRPC({ props: { doId: ctx.id.toString() } })
      : undefined;

    // Register this instance's HmrBridge in the module-level registry
    // so the CirrusHmrRPC service can route facet RPCs back to us.
    registerHmrBridge(ctx.id.toString(), this);

    try {
      const worker = this.env.LOADER.load({
        compatibilityDate: CF_COMPAT_DATE,
        compatibilityFlags: REAL_VITE_COMPAT_FLAGS,
        mainModule: 'main.js',
        modules: {
          'main.js': mainCode,
          'vite.bundle.js': REAL_VITE_BUNDLE,
          'synthetic.js': syntheticCode,
          // Phase 1 shims.
          'cirrus-fs.js': fsShim,
          'cirrus-fs-promises.js': fsPromisesShim,
          'real-node-fs.js': `import * as _f from 'node:fs'; export * from 'node:fs'; export default _f.default || _f;`,
          'real-node-fs-promises.js': `import * as _f from 'node:fs/promises'; export * from 'node:fs/promises'; export default _f.default || _f;`,
          // Phase 2 shims.
          'cirrus-ws.js': wsShim,
          'cirrus-chokidar.js': chokidarShim,
          // Phase 3: the user's pre-bundled vite.config.js (if any).
          ...(this.userConfigBundle
            ? {
                'user-vite-config.js': this.userConfigBundle,
                'vite-config-helper.js': `
                  export * from './vite.bundle.js';
                  import * as _v from './vite.bundle.js';
                  export default _v.default || _v;
                `,
                // Path C: prebundled @vitejs/plugin-react. The user's
                // vite.config.ts had `import react from '@vitejs/plugin-react'`,
                // which supervisor-side esbuild marked as external and
                // rewrote to this specifier. The bundle includes babel
                // + react-refresh/babel + the jsx helpers + inlined
                // runtime assets.
                'cirrus-plugin-react.js': CIRRUS_PLUGIN_REACT_BUNDLE,
              }
            : {}),
        },
        env: {
          ...(supervisorBinding ? { SUPERVISOR: supervisorBinding } : {}),
          ...(hmrBinding ? { CIRRUS_HMR: hmrBinding } : {}),
        },
      });
      this.facetStub = worker.getEntrypoint();
    } catch (e: any) {
      this.bootError = e?.stack || e?.message || String(e);
    }

    // Wire the VFS event stream into the HMR bridge so the facet's
    // chokidar shim actually sees file changes.
    if (this.vfsEvents) {
      this._vfsUnsub = this.vfsEvents.on((batch) => {
        for (const ev of batch) {
          const absPath = '/' + ev.path.replace(/^\/+/, '');
          // chokidar uses 'addDir'/'unlinkDir' for directory events;
          // VFS emits the same strings, so we can pass through as-is.
          this.hmr.pushVfsEvent(ev.type, absPath, ev.oldPath);
        }
      });
    }
  }

  stop(): void {
    this.facetStub = null;
    this.hmr.closeAll();
    if (this._vfsUnsub) { try { this._vfsUnsub(); } catch {} }
    this._vfsUnsub = null;
    // Note: we deliberately do NOT unregister from the HMR bridge
    // map here — if the user runs `vite stop` then `vite` again, the
    // bridge must still be lookup-able by doId during the brief
    // restart window. Unregister happens on DO teardown, not here.
  }

  /**
   * Browser WS upgrade request arrived at /preview/__nimbus_hmr.
   * The DO has already accepted the server-side socket via
   * ctx.acceptWebSocket; we register it with the HmrBridge.
   */
  attachHmrClient(ws: WebSocket): string {
    return this.hmr.attachClient(ws);
  }

  detachHmrClient(id: string): void {
    this.hmr.detachClient(id);
  }

  deliverHmrClientMessage(id: string, msg: string): void {
    this.hmr.deliverClientMessage(id, msg);
  }

  /**
   * Route a (non-WS) request into the facet. `pathname` is the path
   * after stripping the session's `/preview` prefix (e.g. `/`,
   * `/@vite/client`, `/src/main.tsx`).
   */
  async handleRequest(request: Request, pathname: string): Promise<Response> {
    if (this.bootError) {
      return new Response(
        '[cirrus-real] facet spawn failed:\n' + this.bootError,
        { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      );
    }
    if (!this.facetStub) {
      return new Response('[cirrus-real] facet not started', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    // Vite is configured with `base: this.basePath` — forward the
    // base-prefixed path so its middleware matches.
    const origUrl = new URL(request.url);
    const joined = this.basePath.replace(/\/+$/, '') + (pathname.startsWith('/') ? '' : '/') + pathname;
    const forwardUrl = 'http://cirrus-real' + joined + (origUrl.search || '');
    const forwardInit: RequestInit = {
      method: request.method,
      headers: request.headers,
      body: (request.method === 'GET' || request.method === 'HEAD')
        ? undefined : await request.arrayBuffer(),
    };
    const forwardReq = new Request(forwardUrl, forwardInit);

    try {
      const resp = await this.facetStub.fetch(forwardReq);
      const out = new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      });
      out.headers.set('Access-Control-Allow-Origin', '*');
      out.headers.set('Cache-Control', 'no-store');
      return out;
    } catch (e: any) {
      return new Response(
        '[cirrus-real] facet.fetch threw: ' + (e?.stack || e?.message || String(e)),
        { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      );
    }
  }
}
