/**
 * nimbus-session.ts — NimbusSession Durable Object (v2.0).
 *
 * The supervisor DO that owns the VFS, shell, and all commands.
 * `node` execution is delegated to dynamic workers via LOADER.load().
 * IPC between facets and the supervisor flows through SupervisorRPC.
 */

import {
  Kernel,
  Shell,
  createDefaultRegistry,
  ProcessRegistry,
  MemoryPersistenceBackend,
  createNodeCommand,
  createNpmCommand,
  createNpxCommand,
  createCurlCommand,
  createPsCommand,
  createTopCommand,
  createKillCommand,
  createWatchCommand,
  createHelpCommand,
  rehydrateGlobalPackages,
} from '@lifo-sh/core';
import { DurableObject as CloudflareDurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { SqliteVFS, SqliteVFSProvider } from './sqlite-vfs.js';
import { WebSocketTerminal } from './ws-terminal.js';
import { FacetManager } from './facet-manager.js';
import { ProcessTable } from './process-table.js';
import { ProcessLogStore, stripAnsi, type LogChunk, type PersistAdapter, type ProcessExitInfo } from './process-logs.js';
import { configureWsHibernation, type WsHibernationConfigResult } from './ws-hibernation-config.js';
import { PortRegistry } from './port-registry.js';
import { EsbuildService } from './esbuild-service.js';
import { ViteDevServer } from './vite-dev-server.js';
import { CirrusReal, shouldUseRealVite } from './cirrus-real.js';
import { acquireHeavyAlloc, registerAllocObserver } from './heavy-alloc-coord.js';
import { NimbusWrangler } from './nimbus-wrangler.js';
import { NpmInstaller } from './npm-installer.js';
import { NpmCache } from './npm-cache.js';
import { readDiagCounters } from './diag-counters.js';
import {
  getFailures,
  getLastRpcFrame,
  getLastFacetId,
  snapshotForStorage,
  rehydrateFromStorage,
  recordFailure,
} from './oom-discriminator.js';
import { classifyError } from './oom-classify.js';
import { LRU_MAX_ENTRIES } from './constants.js';
import { getEsbuildWasmBytes as _getCachedEsbuildWasmBytes } from './esbuild-wasm-bytes.js';
import { handleSupervisorRpc } from './supervisor-rpc.js';
import { setCtxExports } from './ctx-exports.js';
import { NIMBUS_VERSION, DEFAULT_HOSTNAME, DEFAULT_MOUNT_POINTS, CF_COMPAT_DATE } from './constants.js';
import { registerUnixCommands } from './unix-commands.js';
import { registerGitCommands } from './git-commands.js';
import { seedProject, hasSeededProject, SEED_PROJECT_DIR } from './seed-project.js';
import { HeredocHandler } from './shell-features.js';
import { BASE_PATH_HEADER } from './session-router.js';
import { enc, dec } from './_shared/bytes.js';
import { getInnerDoClass } from './inner-do-registry.js';
import {
  notifyTerminalEvent,
  handleLogsWebSocketRequest,
  handleProcessesListRequest,
  matchLogsPath,
} from './process-logs-api.js';

/**
 * Render a polished "no dev server" placeholder HTML page for the /preview/
 * route. Matches the Nimbus shell MOTD aesthetic (near-black background,
 * green monospace accents). Auto-reloads when /api/stats reports the named
 * service has flipped to `running: true`.
 *
 * All CSS inlined — no external deps so it works offline.
 */
// (esbuild wasm bytes cache lives in src/esbuild-wasm-bytes.ts;
//  imported above. _rpcGetEsbuildWasm delegates there.)

function renderNoDevServerHtml(opts: {
  /** Shell hint to display in the code block (already HTML-escaped). */
  hint: string;
  /** Fully-qualified URL path to poll (e.g. `/s/<id>/api/stats`). */
  polled: string;
  /** Stats field to watch for `.running === true`. */
  liveKey: 'vite' | 'wrangler';
}): string {
  const polled = opts.polled;
  const live = opts.liveKey;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nimbus Preview — waiting</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%}
  body{
    background:#0a192f;
    color:#ccd6f6;
    font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    display:flex;align-items:center;justify-content:center;
    background-image:
      radial-gradient(900px 400px at 15% -5%,rgba(100,255,218,0.06),transparent 55%),
      radial-gradient(800px 450px at 100% 105%,rgba(100,255,218,0.04),transparent 55%);
    padding:20px;
  }
  .card{
    width:min(560px,94vw);
    padding:36px 40px;
    background:rgba(17,34,64,0.7);
    border:1px solid #1e3a5f;
    border-radius:10px;
    box-shadow:0 24px 48px rgba(0,0,0,0.4);
    backdrop-filter:blur(6px);
  }
  .brand{
    display:flex;align-items:center;gap:10px;margin-bottom:28px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:12px;letter-spacing:0.08em;text-transform:uppercase;
  }
  .dot{
    width:8px;height:8px;border-radius:50%;background:#64ffda;
    box-shadow:0 0 10px #64ffda;
    animation:pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(0.75)}}
  .brand-label{color:#64ffda;font-weight:600}
  h1{font-size:22px;font-weight:600;color:#e6f1ff;margin-bottom:8px;letter-spacing:-0.01em}
  .sub{font-size:14px;color:#8892b0;margin-bottom:26px;line-height:1.55}
  .hint-label{
    font-size:10px;color:#64ffda;
    text-transform:uppercase;letter-spacing:0.12em;
    margin-bottom:8px;font-weight:600;
  }
  .hint{
    padding:14px 16px;
    background:#0a192f;
    border:1px solid #1e3a5f;
    border-radius:6px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:13px;color:#ccd6f6;
    overflow-x:auto;
  }
  .hint .prompt{color:#64ffda;user-select:none;margin-right:8px;font-weight:600}
  .footer{
    margin-top:28px;padding-top:18px;border-top:1px solid #1e3a5f;
    display:flex;align-items:center;justify-content:space-between;
    font-size:12px;color:#8892b0;
    font-family:ui-monospace,monospace;
  }
  .status{display:flex;align-items:center;gap:8px}
  .spinner{
    width:10px;height:10px;border-radius:50%;
    border:1.5px solid #1e3a5f;border-top-color:#64ffda;
    animation:spin 0.9s linear infinite;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="dot"></div>
      <div class="brand-label">Nimbus · Preview</div>
    </div>
    <h1>Preview not available</h1>
    <p class="sub">Start a dev server to see your app here. This page auto-reloads the moment the server comes online.</p>
    <div class="hint-label">Run in terminal</div>
    <div class="hint"><span class="prompt">$</span>${opts.hint}</div>
    <div class="footer">
      <div class="status"><div class="spinner"></div>Watching for ${live}</div>
      <div>auto-refresh 2s</div>
    </div>
  </div>
  <script>
    (function(){
      var failures = 0;
      function tick(){
        fetch(${JSON.stringify(polled)},{cache:'no-store'})
          .then(function(r){return r.ok?r.json():null})
          .then(function(s){
            failures=0;
            if(s && s[${JSON.stringify(live)}] && s[${JSON.stringify(live)}].running){
              location.reload();
            }
          })
          .catch(function(){failures++})
          .finally(function(){
            var delay = failures > 3 ? 5000 : 2000;
            setTimeout(tick, delay);
          });
      }
      setTimeout(tick, 1500);
    })();
  </script>
</body>
</html>`;
}

/**
 * Known bundler / framework CLIs that need node_modules to be usable.
 * If an npm script starts with one of these binaries, missing node_modules
 * is a hard error (exit 1) rather than a warning. Scripts that don't match
 * get a soft warning; the script runs anyway in case it's something like
 * `echo hi` that doesn't need deps at all.
 */
const BUNDLER_BIN_PREFIXES = [
  'vite',
  'next',
  'webpack',
  'rollup',
  'parcel',
  'tsc',
  'tsx',
  'ts-node',
  'esbuild',
  'nuxt',
  'remix',
  'astro',
  'svelte-kit',
  'react-scripts',
];

/**
 * Bins that can't execute inside a Durable Object isolate, with tailored
 * guidance for the user. These are commands that CAN install into
 * node_modules/.bin but that crash or hang at runtime because they depend
 * on primitives (child_process.spawn, native binaries, real sockets) that
 * Nimbus doesn't provide.
 *
 * Used by the `npm run` handler's Fix-1 pre-flight: if a script starts
 * with one of these bins, we short-circuit with a deterministic error
 * instead of letting it enter the shell.execute black hole.
 *
 * Keep the keys as the RAW bin name the user's script would invoke;
 * point to the Nimbus-native alternative if one exists.
 *
 * NOTE: `wrangler` is NOT here anymore — it's registered as a transparent
 * alias for `nimbus-wrangler` in initSession, so `npm run dev` with a
 * wrangler-based dev script Just Works via the DO-in-DO implementation.
 * If a user's Worker uses bindings that nimbus-wrangler can't provide
 * (durable_objects, assets, worker_loaders, etc.), the wrapper prints a
 * loud warning BEFORE building so there are no mysterious runtime errors.
 */
const NIMBUS_UNSUPPORTED_BINS: Record<string, { reason: string; alternative?: string }> = {
  // Intentionally empty — all previously-listed bins have working
  // Nimbus alternatives. Keep the map in place so future truly-
  // unsupported bins can be added without re-plumbing the call site.
};

/**
 * wrangler CLI flags that have no meaning inside Nimbus (the DO provides
 * its own host/port/log routing). If present in a wrangler/npm-run-dev
 * invocation, we strip them silently rather than failing — user scripts
 * authored for real wrangler shouldn't need modification.
 *
 * Flags are matched by exact name; the following token (value) is also
 * consumed when the flag is a known "takes a value" variant.
 */
const WRANGLER_IGNORED_FLAGS = new Set<string>([
  '--ip', '--port', '--host',                    // local network flags — DO routes its own
  '--local', '--remote',                         // mode flags — we only do local-ish
  '--log-level', '--logfile',                    // logging routes through DO terminal
  '--inspect', '--inspect-brk', '--inspector-port', // devtools attach — not available
  '--live-reload',                               // HMR is built-in
  '--upstream-protocol', '--protocol',           // protocol selection
  '--experimental-json-config', '--experimental-vectorize-bind-to-prod',
]);
const WRANGLER_IGNORED_FLAGS_WITH_VALUE = new Set<string>([
  '--ip', '--port', '--host', '--log-level', '--logfile',
  '--inspector-port', '--upstream-protocol', '--protocol',
]);

/**
 * Strip wrangler-specific flags (and their values when applicable) from
 * an argv slice. Returns both the cleaned args AND the list of ignored
 * tokens so the caller can log them (once) for transparency.
 */
function filterWranglerFlags(argv: string[]): { args: string[]; ignored: string[] } {
  const out: string[] = [];
  const ignored: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    // Support `--flag=value` too.
    const eq = tok.indexOf('=');
    const base = eq >= 0 ? tok.slice(0, eq) : tok;
    if (WRANGLER_IGNORED_FLAGS.has(base)) {
      ignored.push(tok);
      if (eq < 0 && WRANGLER_IGNORED_FLAGS_WITH_VALUE.has(base) && i + 1 < argv.length) {
        // Consume the value token too (e.g. `--port 8787`).
        ignored.push(argv[i + 1]);
        i++;
      }
      continue;
    }
    out.push(tok);
  }
  return { args: out, ignored };
}

/**
 * wrangler.jsonc binding fields that require real wrangler / the real
 * Cloudflare runtime with proper binding provisioning. nimbus-wrangler
 * can bundle the Worker and load it via env.LOADER, but these bindings
 * are not wired up — the Worker will get `undefined` when it tries to
 * access them, which is usually a runtime crash.
 *
 * We don't refuse to start — some Workers use these bindings only on
 * certain paths or in a way that a runtime-undefined value just causes
 * a specific endpoint to fail. We warn LOUDLY so users know why their
 * Worker might crash.
 */
// Wrangler config top-level fields that represent bindings nimbus-wrangler
// can't fully provision. The warning is printed before build so the user
// knows WHY their inner Worker will crash when it tries to access one.
//
// This list is trimmed as new synthesis code lands:
//   Phase 0 (vars + services)     — removed `services`
//   Phase 1 (assets)              — removed `assets`
//   Phase 2 (worker_loaders)      — removed `worker_loaders`
//   Phase 3 (durable_objects)     — removed `durable_objects`
//
// `vars` was never in this list because it's trivially synthesizable.
// Remaining fields genuinely can't be synthesized without the real CF
// platform (KV/D1/R2/Queues/Vectorize/AI/Browser/Hyperdrive/Analytics/
// Dispatch) and would require building a full emulation layer.
const WRANGLER_UNSUPPORTED_CONFIG_FIELDS = [
  'kv_namespaces',
  'd1_databases',
  'r2_buckets',
  'queues',
  'vectorize',
  'ai',
  'browser',
  'hyperdrive',
  'analytics_engine_datasets',
  'dispatch_namespaces',
];

/**
 * Read the user's wrangler config from the VFS and return any field names
 * from WRANGLER_UNSUPPORTED_CONFIG_FIELDS that are present and non-empty.
 *
 * Best-effort: tolerates JSONC comments and syntax errors (returns [] on
 * parse failure). The caller decides whether to warn or block — we only
 * report; nimbus-wrangler itself still runs.
 */
function detectUnsupportedWranglerConfig(vfs: SqliteVFS, root: string): string[] {
  const candidates = [root + '/wrangler.jsonc', root + '/wrangler.json'];
  let text: string | null = null;
  for (const p of candidates) {
    try {
      if (vfs.exists(p)) { text = vfs.readFileString(p); break; }
    } catch {}
  }
  if (text == null) return [];

  // Strip JSONC comments for JSON.parse. Same logic as NimbusWrangler.readConfig
  // — kept local (and simple) so we don't couple detection to that class.
  let cleaned = '';
  let inString = false;
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { cleaned += ch + (text[i + 1] || ''); i += 2; continue; }
      if (ch === '"') inString = false;
      cleaned += ch; i++;
    } else {
      if (ch === '"') { inString = true; cleaned += ch; i++; }
      else if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; }
      else if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; }
      else { cleaned += ch; i++; }
    }
  }
  let cfg: any;
  try { cfg = JSON.parse(cleaned); } catch { return []; }
  if (!cfg || typeof cfg !== 'object') return [];

  const found: string[] = [];
  for (const field of WRANGLER_UNSUPPORTED_CONFIG_FIELDS) {
    const v = cfg[field];
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    found.push(field);
  }
  return found;
}

/**
 * Parse the first token of an npm script's command string and decide whether
 * it's a bundler/framework CLI that requires node_modules. Handles common
 * prefixes like `cross-env FOO=bar vite`, `node ./server.js`, and npx.
 *
 * Returns the detected bundler bin name (e.g. "vite") or null.
 */
function detectBundlerBin(script: string): string | null {
  if (!script) return null;
  const tokens = script.trim().split(/\s+/);
  // Skip env-var assignments (FOO=bar) and wrapper commands (cross-env, npx).
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Z_][A-Z0-9_]*=/.test(t)) { i++; continue; }        // FOO=bar
    if (t === 'cross-env' || t === 'env') { i++; continue; }     // env/cross-env wrappers
    if (t === 'npx') { i++; continue; }                           // npx vite
    break;
  }
  const bin = (tokens[i] || '').replace(/^\.\/node_modules\/\.bin\//, '');
  for (const pfx of BUNDLER_BIN_PREFIXES) {
    if (bin === pfx || bin.startsWith(pfx + '.')) return pfx;
  }
  return null;
}

/**
 * Check whether a project directory has installed dependencies.
 *
 * Returns { missing: true, depCount } if package.json declares deps AND
 * node_modules/ doesn't exist. `missing: false` when:
 *   - There's no package.json (we're not in a project, no guard needed)
 *   - package.json declares zero deps (no install needed)
 *   - node_modules/ exists (even if stale — caught by runtime error overlay)
 */
function checkNodeModulesGuard(
  vfs: SqliteVFS,
  projectRoot: string,
): { missing: boolean; depCount: number } {
  try {
    const pkgPath = projectRoot + '/package.json';
    if (!vfs.exists(pkgPath)) return { missing: false, depCount: 0 };
    if (vfs.exists(projectRoot + '/node_modules')) return { missing: false, depCount: 0 };
    let depCount = 0;
    try {
      const pkg = JSON.parse(vfs.readFileString(pkgPath));
      depCount = Object.keys(pkg.dependencies || {}).length +
                 Object.keys(pkg.devDependencies || {}).length;
    } catch { /* unreadable package.json */ }
    // If the project declares zero deps, a missing node_modules/ is fine.
    if (depCount === 0) return { missing: false, depCount: 0 };
    return { missing: true, depCount };
  } catch {
    return { missing: false, depCount: 0 };
  }
}

export class NimbusSession extends CloudflareDurableObject {
  // this.ctx and this.env are provided by the DurableObject base class
  private sqliteFs: SqliteVFS | null = null;
  private kernel: Kernel | null = null;
  private shell: Shell | null = null;
  private terminal: WebSocketTerminal | null = null;
  private facetManager: FacetManager | null = null;
  private esbuildService: EsbuildService | null = null;
  private viteDevServer: ViteDevServer | null = null;
  /**
   * Opt-in real-vite mode (Phase 0 spike). Activated when the user sets
   * NIMBUS_REAL_VITE=1 in the shell env or `nimbusDevServer: 'real'` in
   * vite.config.ts. Runs real Vite in a dynamic-worker facet, bypassing
   * the in-process Cirrus shim. Coexists with viteDevServer — only one
   * is live per session.
   */
  private cirrusReal: CirrusReal | null = null;
  /**
   * Map of HMR WebSocket (server-side) → clientId. Populated when the
   * browser's @vite/client opens a connection at /preview/__nimbus_hmr;
   * consumed by the message+close handlers on the WS itself.
   * Non-hibernatable (we use server.accept(), not ctx.acceptWebSocket).
   */
  private _cirrusHmrWsClients: Map<WebSocket, string> | null = null;
  private nimbusWrangler: NimbusWrangler | null = null;
  private npmInstaller: NpmInstaller | null = null;
  /** Singleton fetch proxy entrypoint — created once, reused for all npm fetches. */
  private fetchProxyEntrypoint: any = null;
  private processTable: ProcessTable;
  private portRegistry: PortRegistry;
  private processLogs: ProcessLogStore = new ProcessLogStore();
  /** Janitor timer handle for dropOlderThan sweeps. */
  private processLogsTimer: any = null;

  // ── W9 — hibernation persistence + auto-response config ───────────────
  /**
   * Result of `configureWsHibernation` at constructor time. Exposed via
   * `/api/_diag/memory` under `hib.autoResponseConfigured`,
   * `hib.timeoutSetMs` etc. `null` until the constructor's wiring runs
   * (which it does unconditionally — left null only on a defensive
   * catch-all).
   */
  private _w9WsConfig: WsHibernationConfigResult | null = null;
  /**
   * Monotonic isolate generation counter. Each fresh isolate (cold start
   * or post-hibernation wake) increments this and persists to storage.
   * Lets `/api/_diag/memory` confirm whether a wake actually happened
   * between two probe calls.
   */
  private _w9IsolateGen = 0;
  /** True once we've persisted the bumped gen counter to storage. */
  private _w9IsolateGenPersisted = false;
  /** Storage key for the isolate-gen counter. */
  private static readonly _W9_ISOLATE_GEN_KEY = 'w9_isolate_gen';
  /** SQL DDL — idempotent; run on first fetch. */
  private _w9SchemaInit = false;
  /** Have we wired the persist adapter into ProcessLogStore yet? */
  private _w9PersistWired = false;
  /**
   * Debounced flush state. Append marks the timer; the timer fires
   * after `_W9_FLUSH_DEBOUNCE_MS` and calls `processLogs.flush()`. We
   * also flush eagerly when `dirtyChunks * pidCount` crosses a threshold
   * — but the debounce handles the steady-state case.
   */
  private _w9FlushTimer: any = null;
  private static readonly _W9_FLUSH_DEBOUNCE_MS = 250;

  // ── Heap-pressure probe state ───────────────────────────────────────────
  /**
   * Peak supervisor heap (rss + heapUsed) seen since process start. Updated
   * by `_diagSampleMemory()` on every call to `/api/_diag/memory`. Used to
   * confirm OOM hypotheses without re-running the failure: a peak that
   * grew toward 128 MB during pre-bundle is direct evidence the supervisor
   * isolate is the one being killed. Survives the lifetime of THIS isolate
   * only — a DO reboot resets it to 0, which is itself a useful signal
   * (peak == 0 immediately after the banner re-printed = the killed
   * isolate took its peak with it).
   */
  private _diagPeakRss: number = 0;
  private _diagPeakHeapUsed: number = 0;
  private _diagPeakAt: number = 0;
  private _diagSampleCount: number = 0;

  /**
   * Fix 5: toggled by env NIMBUS_DEBUG=1 (checked each call; cheap enough).
   * When true: spawn banners and exit traces are unconditional (not just
   * long-running facets), RPC envelope errors are surfaced to the terminal
   * with a [rpc-error] prefix, and the exit trace includes duration_ms.
   *
   * The flag is derived from `this.env.NIMBUS_DEBUG` — the binding comes
   * from wrangler's var declaration or a test harness.
   */
  private get nimbusDebug(): boolean {
    try {
      const e = this.env as any;
      return e?.NIMBUS_DEBUG === '1' || e?.NIMBUS_DEBUG === 'true';
    } catch { return false; }
  }

  /**
   * Public URL prefix this DO is mounted at (e.g. `/s/nimble-otter-4271`).
   * Set from the `X-Nimbus-Base` request header on the first forwarded
   * request and persisted so it survives hibernation. Empty string means
   * "unknown" (e.g. direct DO stub call from legacy callers) — in that
   * case ViteDevServer falls back to the bare `/preview` default.
   *
   * NOTE: this is the SESSION prefix, not the vite preview prefix. The
   * full vite basePath is `sessionBasePath + '/preview'`.
   */
  private sessionBasePath: string = '';
  /** Have we attempted to hydrate sessionBasePath from storage yet? */
  private sessionBasePathHydrated = false;
  /**
   * Has the "wrangler is aliased to nimbus-wrangler" banner been shown
   * this session? Reset on WebSocket close/reopen so a reconnecting user
   * sees it once per terminal attach. Purely cosmetic; no persistence.
   */
  private wranglerAliasBannerShown = false;

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env); // enables RPC on the DO
    // In `wrangler dev`, the outer Worker and this DO share a single
    // workerd process, so the `setCtxExports(ctx.exports)` call in the
    // outer fetch handler (src/index.ts) is visible here via the
    // module-level singleton in ctx-exports.ts. In PROD they run in
    // separate isolates — that outer setter never reaches us, so
    // getCtxExports() returns null, the facet pool falls back silently,
    // and facets get `env.SUPERVISOR === undefined` → writeBatch throws.
    //
    // DurableObjectState.exports is exposed at compat date ≥ 2025-11-17.
    // We're on 2026-04-01, so `ctx.exports` is present. Capture it here
    // so the DO's own loopback bindings are available to the facet-pool
    // and facet-manager in prod as well as dev.
    const ctxExports = (ctx as any)?.exports;
    if (ctxExports) setCtxExports(ctxExports);
    this.processTable = new ProcessTable();
    this.portRegistry = new PortRegistry();
    this._ensureLogJanitor();

    // ── W9 (CF research §C.3 + §C.4) ──────────────────────────────────
    //
    // Configure WS auto-response (`ping`/`pong`) so vite HMR + xterm
    // idle pings don't wake the actor from hibernation. ~95% drop in
    // billable wakes per the research doc. Auto-response config and
    // hibernation event timeout both survive hibernation per the
    // STOR/Durable Objects WebSocket Primer ("Survives: Auto-response
    // configuration") — set once, forget.
    //
    // Failures are non-fatal — older workerd builds may lack the APIs.
    // The result lands in /api/_diag/memory.hib for verification.
    try {
      this._w9WsConfig = configureWsHibernation(this.ctx);
    } catch (e: any) {
      console.warn('[nimbus/W9] configureWsHibernation threw:', e?.message);
      this._w9WsConfig = {
        autoResponseConfigured: false,
        timeoutSetMs: null,
        autoResponseError: e?.message,
        timeoutError: e?.message,
      };
    }

    // Wire the ProcessLogStore to its persist adapter (CF research §C.2,
    // Lever 11). Idempotent: only runs once per isolate. The DDL +
    // adapter run lazily on first append/read, but the wiring itself
    // happens here so any subsequent call (including initSession) sees
    // the adapter in place.
    this._w9WireProcessLogPersist();
  }

  /**
   * W9: install the SQL-backed PersistAdapter on `this.processLogs`.
   *
   * NOTE: any future alarm-driven subsystem MUST coordinate via a single
   * `alarm()` dispatcher (e.g., a `nextAlarmReason` storage key checked
   * inside the dispatcher). Today W9 is the only consumer; the dispatcher
   * lives in `_w9OnAlarm()` invoked from the exported `alarm()` handler.
   */
  private _w9WireProcessLogPersist(): void {
    if (this._w9PersistWired) return;
    this._w9PersistWired = true;
    const self = this;
    const adapter: PersistAdapter = {
      load(pid: number) {
        try {
          self._w9EnsureSchema();
          const sql: any = self.ctx.storage.sql;
          const chunkRows = [...sql.exec(
            'SELECT pid, seq, ts, stream, data, binary FROM w9_proc_logs WHERE pid = ? ORDER BY seq ASC',
            pid,
          )] as any[];
          const exitRows = [...sql.exec(
            'SELECT code, at, reason FROM w9_proc_exits WHERE pid = ?',
            pid,
          )] as any[];
          const chunks: LogChunk[] = chunkRows.map((r) => ({
            ts: Number(r.ts),
            stream: r.stream === 'stderr' ? 'stderr' : 'stdout',
            data: String(r.data),
            binary: !!r.binary,
            ...(r.seq !== undefined ? { seq: Number(r.seq) } : {}),
          } as any));
          const exit: ProcessExitInfo | null = exitRows.length > 0
            ? {
                code: Number(exitRows[0].code),
                at: Number(exitRows[0].at),
                reason: exitRows[0].reason ?? undefined,
              }
            : null;
          return { chunks, exit };
        } catch {
          return null;
        }
      },
      persistChunks(pid, rows) {
        if (rows.length === 0) return;
        try {
          self._w9EnsureSchema();
          const sql: any = self.ctx.storage.sql;
          // Use a single transactionSync wrapping the per-row INSERTs so
          // a partial write either fully lands or fully rolls back. Real
          // multi-row VALUES (?,?,?), (?,?,?), … is faster but requires
          // dynamic-arity SQL building — clarity wins here; flushes
          // happen at most once per debounce window so the volume is low.
          self.ctx.storage.transactionSync(() => {
            for (const r of rows) {
              const c = r.chunk;
              sql.exec(
                'INSERT OR REPLACE INTO w9_proc_logs (pid, seq, ts, stream, data, binary) VALUES (?, ?, ?, ?, ?, ?)',
                pid, r.seq, c.ts, c.stream, c.data, c.binary ? 1 : 0,
              );
            }
          });
        } catch (e: any) {
          console.warn('[nimbus/W9] persistChunks failed:', e?.message);
        }
      },
      persistExit(pid, info) {
        try {
          self._w9EnsureSchema();
          const sql: any = self.ctx.storage.sql;
          sql.exec(
            'INSERT OR REPLACE INTO w9_proc_exits (pid, code, at, reason) VALUES (?, ?, ?, ?)',
            pid, info.code, info.at, info.reason ?? null,
          );
        } catch (e: any) {
          console.warn('[nimbus/W9] persistExit failed:', e?.message);
        }
      },
      dropPid(pid) {
        try {
          self._w9EnsureSchema();
          const sql: any = self.ctx.storage.sql;
          self.ctx.storage.transactionSync(() => {
            sql.exec('DELETE FROM w9_proc_logs WHERE pid = ?', pid);
            sql.exec('DELETE FROM w9_proc_exits WHERE pid = ?', pid);
          });
        } catch (e: any) {
          console.warn('[nimbus/W9] dropPid failed:', e?.message);
        }
      },
      pruneBeforeSeq(pid, seq) {
        try {
          self._w9EnsureSchema();
          const sql: any = self.ctx.storage.sql;
          sql.exec('DELETE FROM w9_proc_logs WHERE pid = ? AND seq < ?', pid, seq);
        } catch (e: any) {
          console.warn('[nimbus/W9] pruneBeforeSeq failed:', e?.message);
        }
      },
    };
    this.processLogs.setPersist(adapter);

    // Wrap append/markExit on the store to schedule a debounced flush.
    // We patch via method override rather than monkey-patching because
    // the store doesn't (and shouldn't) know about timers — flush
    // scheduling is the host's responsibility.
    const origAppend = this.processLogs.append.bind(this.processLogs);
    const origMarkExit = this.processLogs.markExit.bind(this.processLogs);
    this.processLogs.append = (pid, stream, data) => {
      origAppend(pid, stream, data);
      this._w9ScheduleFlush();
    };
    this.processLogs.markExit = (pid, code, reason) => {
      origMarkExit(pid, code, reason);
      // Exit-on-process-end is a strong "flush soon" signal — if the
      // process crashed we want the dump persisted before the actor
      // can hibernate. Schedule but don't bypass debounce, so a fast
      // exit-after-spawn doesn't double-fire.
      this._w9ScheduleFlush();
    };
  }

  /** W9: idempotent SQL schema bootstrap. */
  private _w9EnsureSchema(): void {
    if (this._w9SchemaInit) return;
    this._w9SchemaInit = true;
    try {
      const sql: any = this.ctx.storage.sql;
      sql.exec(
        'CREATE TABLE IF NOT EXISTS w9_proc_logs (' +
          'pid INTEGER NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, ' +
          'stream TEXT NOT NULL, data TEXT NOT NULL, binary INTEGER NOT NULL, ' +
          'PRIMARY KEY (pid, seq))',
      );
      sql.exec('CREATE INDEX IF NOT EXISTS w9_proc_logs_ts ON w9_proc_logs(ts)');
      sql.exec(
        'CREATE TABLE IF NOT EXISTS w9_proc_exits (' +
          'pid INTEGER PRIMARY KEY, code INTEGER NOT NULL, at INTEGER NOT NULL, ' +
          'reason TEXT)',
      );
    } catch (e: any) {
      console.warn('[nimbus/W9] schema init failed:', e?.message);
      this._w9SchemaInit = false; // retry next time
    }
  }

  /**
   * W9: ensure the alarm is set for the next flush window. Cheap to
   * call repeatedly — we only set the alarm if it isn't already set.
   * `setAlarm` writes to storage, so we additionally bracket with a
   * timer-based fallback so tests + hot-path appends don't block.
   */
  private _w9ScheduleFlush(): void {
    if (this._w9FlushTimer) return;
    // Local timer for fast in-isolate flush; alarm ensures the post-
    // hibernation case also drains.
    this._w9FlushTimer = setTimeout(() => {
      this._w9FlushTimer = null;
      try {
        this.processLogs.flush();
      } catch (e: any) {
        console.warn('[nimbus/W9] flush threw:', e?.message);
      }
    }, NimbusSession._W9_FLUSH_DEBOUNCE_MS);
    // Best-effort alarm (storage). On older runtimes / wrangler-dev where
    // setAlarm is unavailable this is a no-op.
    try {
      const fn = (this.ctx.storage as any).setAlarm;
      if (typeof fn === 'function') {
        fn.call(this.ctx.storage, Date.now() + NimbusSession._W9_FLUSH_DEBOUNCE_MS * 4);
      }
    } catch { /* fail-soft */ }
  }

  /**
   * W9: alarm handler. Today only flush; if more subsystems need alarms,
   * route through a single `nextAlarmReason` storage key checked here.
   */
  async alarm(): Promise<void> {
    try {
      this.processLogs.flush();
    } catch (e: any) {
      console.warn('[nimbus/W9] alarm flush threw:', e?.message);
    }
  }

  /** W9: increment + persist isolate-gen counter once per fresh isolate. */
  private async _w9MaybeBumpIsolateGen(): Promise<void> {
    if (this._w9IsolateGenPersisted) return;
    this._w9IsolateGenPersisted = true;
    try {
      const prev = (await this.ctx.storage.get(NimbusSession._W9_ISOLATE_GEN_KEY)) as number | undefined;
      const next = (typeof prev === 'number' ? prev : 0) + 1;
      this._w9IsolateGen = next;
      await this.ctx.storage.put(NimbusSession._W9_ISOLATE_GEN_KEY, next);
    } catch (e: any) {
      console.warn('[nimbus/W9] isolate-gen bump failed:', e?.message);
    }
  }

  /**
   * Convenience: the full URL prefix for the Vite dev server inside this
   * session (e.g. `/s/nimble-otter-4271/preview`). Falls back to the
   * historical default when sessionBasePath is unknown so legacy callers
   * and unit tests keep working.
   */
  private get viteBasePath(): string {
    return (this.sessionBasePath || '') + '/preview';
  }

  /**
   * Lazily hydrate sessionBasePath from storage, then overwrite with the
   * current request's `X-Nimbus-Base` header if present. Call at the top
   * of `_handleFetch` before any HTML rendering or ViteDevServer spawn.
   *
   * We always trust the most recent header over storage, because a DO
   * instance is always pinned to one session ID (via idFromName) but the
   * URL prefix COULD change across deploys (e.g. if we ever rename `/s/`).
   */
  private async hydrateSessionBasePath(request: Request): Promise<void> {
    if (!this.sessionBasePathHydrated) {
      try {
        const saved = await this.ctx.storage.get('session-base-path');
        if (typeof saved === 'string') this.sessionBasePath = saved;
      } catch { /* storage unavailable — stay empty */ }
      this.sessionBasePathHydrated = true;
    }
    const fromHeader = request.headers.get(BASE_PATH_HEADER);
    if (fromHeader && fromHeader !== this.sessionBasePath) {
      this.sessionBasePath = fromHeader;
      try { await this.ctx.storage.put('session-base-path', fromHeader); } catch {}
    }
  }

  // ── Supervisor RPC methods (called by SupervisorRPC → DO stub) ────────
  // These are public methods that SupervisorRPC's _getStub() calls via RPC.
  // They provide facets with live access to the supervisor's VFS and terminal.

  async _rpcReadFile(path: string): Promise<string | null> {
    this.ensureSqliteFs();
    try {
      return this.sqliteFs!.readFileString(path.replace(/^\/+/, ''));
    } catch { return null; }
  }

  /**
   * Read a file as raw bytes (Uint8Array). Used by git network facet for
   * binary .git/objects/** and packfile reads, where TextDecoder/TextEncoder
   * round-tripping through readFile (string) would corrupt bytes.
   */
  async _rpcReadFileBytes(path: string): Promise<Uint8Array | null> {
    this.ensureSqliteFs();
    try {
      return this.sqliteFs!.readFile(path.replace(/^\/+/, ''));
    } catch { return null; }
  }

  /**
   * Phase-3 inner-DO fetch dispatcher. Called by NimbusDOStub.fetch()
   * from the inner Worker via the env.NIMBUS_SESSION loopback. We
   * resolve the inner DO class from the module-level registry (keyed
   * by <thisDoId>:<bindingName>), use ctx.facets.get with the inner's
   * id string as the facet id, and forward the serialized Request.
   *
   * All steps run in THIS RPC method's context, so no cross-request
   * I/O boundaries are crossed — the ctx.facets stub and its fetch()
   * are both created here.
   */
  async _rpcInnerDoFetch(req: {
    bindingName: string;
    id: string;
    method: string;
    url: string;
    headers: [string, string][];
    body: ArrayBuffer | null;
  }): Promise<{
    status: number;
    statusText: string;
    headers: [string, string][];
    body: ArrayBuffer | null;
  }> {
    const cls = getInnerDoClass(this.ctx.id.toString(), req.bindingName);
    if (!cls) {
      const body = enc.encode(
        `Nimbus: inner DO binding '${req.bindingName}' has no registered class (supervisor=${this.ctx.id.toString()})`,
      );
      return {
        status: 502,
        statusText: 'Bad Gateway',
        headers: [['Content-Type', 'text/plain']],
        body: body.buffer as ArrayBuffer,
      };
    }
    const facetName = 'innerDO-' + req.bindingName + '-' + req.id;
    const facet = (this.ctx as any).facets.get(facetName, async () => ({
      class: cls,
      id: req.id, // FacetStartupOptions.id — inner DO sees this as its ctx.id
    }));
    try {
      // Reconstruct the Request in the current context.
      const headers = new Headers();
      for (const [k, v] of req.headers) headers.append(k, v);
      const r = new Request(req.url, {
        method: req.method,
        headers,
        body: req.body,
      });
      const res: Response = await facet.fetch(r);
      const resHeaderList: [string, string][] = [];
      res.headers.forEach((v: string, k: string) => { resHeaderList.push([k, v]); });
      const resBody = await res.arrayBuffer();
      return {
        status: res.status,
        statusText: res.statusText,
        headers: resHeaderList,
        body: resBody,
      };
    } catch (e: any) {
      const body = enc.encode(
        `Nimbus inner DO error: ${e?.message || String(e)}`,
      );
      return {
        status: 500,
        statusText: 'Internal Server Error',
        headers: [['Content-Type', 'text/plain']],
        body: body.buffer as ArrayBuffer,
      };
    }
  }

  async _rpcWriteFile(path: string, content: string): Promise<void> {
    this.ensureSqliteFs();
    const p = path.replace(/^\/+/, '');
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (dir && !this.sqliteFs!.exists(dir)) this.sqliteFs!.mkdir(dir, { recursive: true });
    }
    this.sqliteFs!.writeFile(p, content);
  }

  async _rpcStat(path: string): Promise<any> {
    this.ensureSqliteFs();
    try {
      return this.sqliteFs!.stat(path.replace(/^\/+/, ''));
    } catch { return null; }
  }

  async _rpcReaddir(path: string): Promise<{ name: string; type: string }[]> {
    this.ensureSqliteFs();
    try {
      return this.sqliteFs!.readdir(path.replace(/^\/+/, ''));
    } catch { return []; }
  }

  async _rpcExists(path: string): Promise<boolean> {
    this.ensureSqliteFs();
    return this.sqliteFs!.exists(path.replace(/^\/+/, ''));
  }

  async _rpcMkdir(path: string): Promise<void> {
    this.ensureSqliteFs();
    this.sqliteFs!.mkdir(path.replace(/^\/+/, ''), { recursive: true });
  }

  /**
   * Called by CirrusHmrRPC.hmrSend. Runs in the DO's own context so
   * we can legally write to hibernatable WS sockets owned by this
   * DO. The HmrBridge holds the client→WS map; we delegate to it.
   */
  async _rpcHmrRelay(clientId: string | null, msg: string): Promise<void> {
    if (!this.cirrusReal) return;
    this.cirrusReal.hmr.relayToBrowser(clientId, msg);
  }

  async _rpcUnlink(path: string): Promise<void> {
    this.ensureSqliteFs();
    try { this.sqliteFs!.unlink(path.replace(/^\/+/, '')); } catch {}
  }

  /**
   * Bulk-write files and directories via one transactionSync().
   * Called from facets that accumulate writes locally (git clone/fetch/pull,
   * potentially others) to avoid thousands of individual writeFile RPCs.
   *
   * payload: {
   *   inodes: BatchInodeEntry[],
   *   chunks: { path, chunkId, data: Uint8Array | ArrayBuffer }[],
   *   deletePaths?: string[]
   * }
   */
  async _rpcWriteBatch(payload: any): Promise<{ inodes: number; chunks: number }> {
    this.ensureSqliteFs();
    const inodes = Array.isArray(payload?.inodes) ? payload.inodes : [];
    const rawChunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
    const deletePaths = Array.isArray(payload?.deletePaths) ? payload.deletePaths : undefined;

    // Normalize chunk data — RPC may deliver Uint8Array, ArrayBuffer, or { type: 'Buffer', data: [...] }
    const chunks = rawChunks.map((c: any) => {
      let data: Uint8Array;
      if (c.data instanceof Uint8Array) {
        data = c.data;
      } else if (c.data instanceof ArrayBuffer) {
        data = new Uint8Array(c.data);
      } else if (ArrayBuffer.isView(c.data)) {
        data = new Uint8Array((c.data as ArrayBufferView).buffer,
          (c.data as ArrayBufferView).byteOffset,
          (c.data as ArrayBufferView).byteLength);
      } else if (Array.isArray(c.data)) {
        data = new Uint8Array(c.data);
      } else if (c.data && typeof c.data === 'object' && Array.isArray(c.data.data)) {
        // Buffer JSON serialization fallback
        data = new Uint8Array(c.data.data);
      } else {
        data = new Uint8Array(0);
      }
      return { path: String(c.path), chunkId: Number(c.chunkId), data };
    });

    return this.sqliteFs!.writeBatch({
      inodes,
      chunks,
      deletePaths,
    });
  }

  /**
   * Bulk-write npm registry cache entries in ONE RPC. Used by the
   * resolver-facet to flush a wave of resolved packages back to the
   * supervisor without per-entry round-trips.
   *
   * Payload is the array of RegistryCacheEntry shapes from src/npm-cache.ts.
   * Returns { written, failed } so the facet can surface partial-write
   * warnings to the install log.
   */
  async _rpcPutRegistryEntries(entries: any[]): Promise<{ written: number; failed: number }> {
    this.ensureSqliteFs();
    const npmCache = new NpmCache(this.ctx.storage.sql);
    if (!Array.isArray(entries)) return { written: 0, failed: 0 };
    return npmCache.putRegistryEntries(entries);
  }

  /**
   * Return the raw esbuild-wasm bytes (~11.4 MiB) as an ArrayBuffer.
   *
   * Kept for compatibility — the production pre-bundle path no longer
   * uses this (commit: pre-bundle wasm via modules-map). Bytes are
   * shipped to the facet via the LOADER's `modules` map shape
   * `{ name: { wasm: ArrayBuffer } }` instead, which workerd compiles
   * at facet module-load (startup phase, eval permitted) and exposes
   * via a standard ESM import.
   *
   * Earlier attempts that DIDN'T work (history kept for context):
   *   1. Inline 16 MiB base64 in preamble → OOM via per-dispatch
   *      module-source allocation. (commit dead0e3 removed this.)
   *   2. RPC returning Uint8Array, facet calls WebAssembly.compile →
   *      "Wasm code generation disallowed by embedder" at request time.
   *      (commit 7636995 moved JS eval to startup; this one couldn't
   *      be similarly relocated because the bytes are async.)
   *   3. RPC returning pre-compiled WebAssembly.Module from supervisor
   *      → "Unable to deserialize cloned data" — workerd's
   *      structured-clone refuses Module transfer in this deploy.
   *      (commit f9e321e tried; reverted to bytes here.)
   *
   * The modules-map approach (current) sidesteps all three failure
   * modes because the bytes are bundled into the worker code object
   * BEFORE workerd compiles the worker, so compile happens in the
   * permitted module-load phase via workerd's own internal pipeline,
   * not via JS-side eval or cross-isolate transfer.
   */
  async _rpcGetEsbuildWasm(): Promise<ArrayBuffer> {
    return _getCachedEsbuildWasmBytes();
  }

  async _rpcStdout(pid: number, data: string): Promise<void> {
    // Always buffer raw data (keeps ANSI for replay). Terminal paint only
    // if someone is listening — detached sessions shouldn't silently lose
    // output. Skip pid=0 (the supervisor-rpc fallback when no props.pid
    // was threaded) to avoid polluting a sentinel slot with output from
    // un-traceable facets.
    try {
      if (pid > 0) this.processLogs.append(pid, 'stdout', data);
      if (this.terminal) this.terminal.write(data);
    } catch (e: any) {
      // Fix 5: surface RPC envelope errors when NIMBUS_DEBUG=1. Silent
      // drops here are exactly what hides bugs; default-off so we don't
      // blow up terminals with normal-operation noise, but diagnosable on
      // demand.
      if (this.nimbusDebug && this.terminal) {
        try { this.terminal.write(`\x1b[33m[rpc-error] _rpcStdout(pid=${pid}) threw: ${e?.message || e}\x1b[0m\r\n`); } catch {}
      }
    }
  }

  async _rpcStderr(pid: number, data: string): Promise<void> {
    try {
      if (pid > 0) this.processLogs.append(pid, 'stderr', data);
      // Terminal gets red wrapping; the ring buffer keeps it raw so the
      // stream tag can drive color decisions at replay time.
      if (this.terminal) this.terminal.write(`\x1b[31m${data}\x1b[0m`);
    } catch (e: any) {
      if (this.nimbusDebug && this.terminal) {
        try { this.terminal.write(`\x1b[33m[rpc-error] _rpcStderr(pid=${pid}) threw: ${e?.message || e}\x1b[0m\r\n`); } catch {}
      }
    }
  }

  /**
   * Called by facets from their `finally` block after I/O has drained.
   * Marks the log store so `logs` / `ps` can show the exit code, and
   * fires `_emitExitDump` if the process exited non-zero with buffered
   * output.
   *
   * Idempotent — double-call is a no-op (ProcessLogStore.markExit guards).
   */
  async _rpcReportExit(pid: number, code: number, tail: string): Promise<void> {
    if (pid <= 0) return; // Ignore the pid-0 sentinel.
    if (tail) this.processLogs.append(pid, 'stderr', tail);
    // Guard against double-reporting: if we've already recorded exit
    // (e.g. from an external kill path) don't dump twice.
    if (this.processLogs.getExit(pid)) return;
    this.processLogs.markExit(pid, code);
    // Structured exit notification for the tabs UI. Idempotent on the
    // client — subscribeExit fires once, and the shell-exec finalizer
    // also emits, so we dedupe on pid there. Include the command (when
    // available via ProcessTable) so the UI can surface a tab for pids
    // whose spawn event was suppressed (e.g. `node -e` short evals).
    const cmdFromTable = this.processTable.get(pid)?.command;
    notifyTerminalEvent(this.terminal, { type: 'exit', pid, code, command: cmdFromTable });

    // Fix 4: dump whenever the ring buffer has bytes, regardless of code.
    // A facet that exits 0 but has a stderr traceback in the buffer is the
    // clean-but-silent case we're hunting. The replay surfaces it even if
    // the user's terminal was detached during the live stream.
    if (this.processLogs.size(pid) > 0) {
      this._emitExitDump(pid, code);
    }

    // Fix 5: verbose exit trace gated on NIMBUS_DEBUG=1. Facets already
    // get a spawn banner via FacetManager.onSpawn; this closes the loop.
    if (this.nimbusDebug && this.terminal) {
      const entry = this.processTable.get(pid);
      const cmd = entry?.command || `pid ${pid}`;
      const colorExit = code === 0 ? '\x1b[2m' : '\x1b[2;31m';
      this.terminal.write(
        `${colorExit}[facet exited: pid=${pid} code=${code} cmd="${cmd}"]\x1b[0m\r\n`,
      );
    }
  }

  /**
   * Emit a formatted exit-dump banner + last 30 lines of output to the
   * terminal. Called from both the facet-reported exit path and the
   * external-kill path (timeout / abort).
   *
   * Race notes:
   *   - Terminal.write is buffered with a 5ms flush; concurrent writes
   *     from facet stdout still in flight interleave cleanly at flush
   *     time.
   *   - If no terminal is attached, the dump is simply skipped — the
   *     log buffer still has everything, so `logs <pid>` recovers it.
   */
  private _emitExitDump(pid: number, code: number): void {
    if (!this.terminal) return;
    const entry = this.processTable.get(pid);
    const cmd = entry?.command || `pid ${pid}`;
    const chunks = this.processLogs.tail(pid, { lines: 30 });
    const sep = '─'.repeat(60);
    const color = code === 0 ? '\x1b[2;33m' : '\x1b[31m'; // yellow-dim for clean-silent
    this.terminal.write(
      `\r\n${color}${sep}\r\n` +
      `Process ${pid} (${cmd}) exited with code ${code}\r\n` +
      `${sep}\x1b[0m\r\n`,
    );
    for (const c of chunks) {
      const painted = c.stream === 'stderr' ? `\x1b[31m${c.data}\x1b[0m` : c.data;
      this.terminal.write(painted);
    }
    this.terminal.write(`${color}${sep}\x1b[0m\r\n`);
  }

  /**
   * Fix 3 + Fix 4 + Fix 5: finalizer for shellExecuteTracked.
   *
   * Runs after a tracked shell.execute finishes (any path). Chooses when
   * to emit the exit-dump banner and when to log the debug trace.
   *
   * Dump policy (Fix 4):
   *   - Non-zero exit AND any buffered output → always dump.
   *   - Zero exit AND buffered output has >0 bytes → dump anyway. Rationale:
   *     an npm run that returned "success" while the ring buffer still has
   *     a traceback is the exact "clean-but-silent failure" we're hunting.
   *     The replay is unique information the user didn't see live (e.g.
   *     because the terminal was reconnected after the fact).
   *   - Zero exit AND empty buffer → nothing to say. Skip.
   *
   * Trace policy (Fix 5):
   *   - NIMBUS_DEBUG=1: always print `[exited pid=N code=C duration=Xms]`.
   *   - Default: print only for non-zero OR long-running scripts (the
   *     cmd-start banner makes them expect an exit marker).
   *
   * Called with the already-marked pid (processTable.exit + processLogs.markExit
   * ran in shellExecuteTracked's finally).
   */
  _emitShellExecDone(pid: number, cmd: string, code: number, durationMs: number): void {
    const bufSize = this.processLogs.size(pid);
    const shouldDump = bufSize > 0 && (code !== 0 || bufSize > 0);
    //                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    // Reads as redundant but is deliberate: Fix 4's intent is "non-empty
    // buffer → dump, regardless of code". Keeping the full expression so
    // the code self-documents WHY we're dumping on clean exits.

    if (shouldDump) {
      this._emitExitDump(pid, code);
    }

    if (this.terminal) {
      const traceAlways = this.nimbusDebug;
      const isLongRunning = /^(vite|wrangler|next|nuxt|astro|remix|dev|serve|start|watch)\b/.test(cmd);
      if (traceAlways || code !== 0 || isLongRunning) {
        const colorExit = code === 0 ? '\x1b[2m' : '\x1b[2;31m';
        this.terminal.write(
          `${colorExit}[shell exited: pid=${pid} code=${code} duration=${durationMs}ms]\x1b[0m\r\n`,
        );
      }
    }
  }

  /**
   * External-exit path: invoked by FacetManager when a process is killed
   * outside the facet's own try/finally (timeout, explicit abort, or the
   * `kill` shell command). Appends a synthetic stderr line so the dump
   * has useful context, then runs the same dump machinery.
   */
  _reportExternalExit(pid: number, code: number, reason: string): void {
    if (this.processLogs.getExit(pid)) return;
    if (reason) {
      this.processLogs.append(pid, 'stderr', `[process killed: ${reason}]\n`);
    }
    this.processLogs.markExit(pid, code, reason);
    const cmdFromTable = this.processTable.get(pid)?.command;
    notifyTerminalEvent(this.terminal, { type: 'exit', pid, code, reason, command: cmdFromTable });
    if (this.terminal && this.processLogs.size(pid) > 0) {
      this._emitExitDump(pid, code);
    }
    // W5 Lever 5: ring entry for every external exit with a non-zero
    // code. The FacetManager already records its own exits inline via
    // _w5RecordTermination — this catches the residual paths
    // (timeouts dispatched via the timeout-handler in FacetManager
    // call back through hooks.onExternalExit, which reaches here).
    // The ring is bounded; double-recording is harmless.
    if (code !== 0) {
      try {
        let cause = classifyError(reason);
        if (code === 124 && cause === 'unknown') cause = 'rpc_timeout';
        recordFailure({
          at: Date.now(),
          phase: 'facet',
          cause,
          rssEstimateBytes: this._diagPeakRss,
          heapUsedBytes: this._diagPeakHeapUsed,
          lruBytes: 0, inFlightBytes: 0,
          lastRpcFrame: getLastRpcFrame(),
          lastFacetId: getLastFacetId(),
          exitCode: code,
          pid,
          message: reason,
        });
      } catch { /* fail-soft */ }
    }
  }

  /**
   * Kick off a janitor that sweeps expired exit records every 60 s.
   * Idempotent — safe to call repeatedly (guards on this.processLogsTimer).
   */
  private _ensureLogJanitor(): void {
    if (this.processLogsTimer) return;
    const tick = () => {
      try {
        this.processLogs.dropOlderThan(
          undefined,
          // A pid is "orphaned" if the process table has no record of
          // it — either reap() already removed it, or it never fully
          // registered. Long-running facets that hang and get GC'd
          // fall into this category.
          (pid) => !this.processTable.get(pid),
        );
      } catch { /* best-effort */ }
      this.processLogsTimer = setTimeout(tick, 60_000);
    };
    this.processLogsTimer = setTimeout(tick, 60_000);
  }

  async _rpcPrefetch(cwd: string, entryCode: string): Promise<Record<string, string>> {
    // W2.6a: de-quarantined. require-resolver.ts is now the primary
    // content-bundle source for FacetManager.exec via buildPrefetchBundle.
    // This RPC entrypoint is retained for facet-side callers that may
    // want to refresh the bundle mid-execution; today only the
    // SupervisorRPC.prefetch surface exposes it externally.
    this.ensureSqliteFs();
    const { prefetchForRequire } = await import('./require-resolver.js');
    return prefetchForRequire(this.sqliteFs!, entryCode, cwd).bundle;
  }

  async _rpcRegisterPort(pid: number, port: number): Promise<void> {
    // Port registration stores the facet association
    // The actual facet stub is stored by FacetManager separately
    this.portRegistry.register(port, pid, null);
  }

  async _rpcUnregisterPort(port: number): Promise<void> {
    this.portRegistry.unregister(port);
  }

  async _rpcTransform(code: string, loader: string): Promise<{ code: string; map: string } | null> {
    if (!this.esbuildService) {
      this.ensureSqliteFs();
      this.esbuildService = new EsbuildService(this.sqliteFs!);
    }
    try {
      const result = await this.esbuildService.transform(code, {
        loader: loader as any || 'ts',
        format: 'esm',
        target: 'esnext',
        sourcemap: 'inline',
      });
      return { code: result.code, map: result.map };
    } catch (e: any) {
      return null;
    }
  }

  // ── Legacy VFS RPC Entrypoints (direct method calls) ──────────────────
  // Kept for backward compatibility with direct DO stub callers.

  /** RPC: Read a file from the VFS. Returns ArrayBuffer or null. */
  vfsReadFile(path: string): ArrayBuffer | null {
    this.ensureSqliteFs();
    try {
      const stripped = path.replace(/^\/+/, '');
      const data = this.sqliteFs!.readFile(stripped);
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    } catch {
      return null;
    }
  }

  /** RPC: Read a file as string. Returns string or null. */
  vfsReadFileString(path: string): string | null {
    this.ensureSqliteFs();
    try {
      const stripped = path.replace(/^\/+/, '');
      return this.sqliteFs!.readFileString(stripped);
    } catch {
      return null;
    }
  }

  /** RPC: Stat a path. Returns { type, size, mtime, mode } or null. */
  vfsStat(path: string): { type: string; size: number; mtime: number; mode: number } | null {
    this.ensureSqliteFs();
    try {
      const stripped = path.replace(/^\/+/, '');
      return this.sqliteFs!.stat(stripped);
    } catch {
      return null;
    }
  }

  /** RPC: Check if path exists. */
  vfsExists(path: string): boolean {
    this.ensureSqliteFs();
    const stripped = path.replace(/^\/+/, '');
    return this.sqliteFs!.exists(stripped);
  }

  /** RPC: List directory contents. Returns array of { name, type }. */
  vfsReaddir(path: string): { name: string; type: string }[] {
    this.ensureSqliteFs();
    try {
      const stripped = path.replace(/^\/+/, '');
      return this.sqliteFs!.readdir(stripped);
    } catch {
      return [];
    }
  }

  /** RPC: Write a file to the VFS. */
  vfsWriteFile(path: string, data: ArrayBuffer): void {
    this.ensureSqliteFs();
    const stripped = path.replace(/^\/+/, '');
    this.sqliteFs!.writeFile(stripped, new Uint8Array(data));
  }

  // ── HTTP handler ──────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    try {
      return await this._handleFetch(request);
    } catch (e: any) {
      console.error('[nimbus] Unhandled fetch error:', e?.message, e?.stack);
      return new Response(`Internal Error: ${e?.message}`, { status: 500 });
    }
  }

  private async _handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Capture session basePath from the routing header (if forwarded by the
    // Worker's session-router). Threaded through to ViteDevServer so the
    // served app's module URLs, HMR paths, <base href>, and router basename
    // all resolve under `/s/<id>/preview/...`.
    await this.hydrateSessionBasePath(request);
    // W9: bump the isolate generation counter on the FIRST request of a
    // new isolate (cold start or post-hibernation wake). Cheap — one
    // storage.get + one storage.put per isolate. Subsequent calls in the
    // same isolate are a fast no-op (gated by _w9IsolateGenPersisted).
    await this._w9MaybeBumpIsolateGen();

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      // Audit F2 (STABILITY-AUDIT.md C-S2): reject a second /ws upgrade
      // while the session already has an attached terminal. Previously
      // initSession unconditionally overwrote this.terminal / this.shell
      // / this.kernel, silently cross-wiring two browser tabs to the
      // same session DO (tab A's keystrokes routed to tab B's shell).
      // There is no per-ws terminal map today, so the safe behaviour
      // is to keep one-at-a-time and tell the client.
      if (this.shell != null) {
        return new Response(
          JSON.stringify({
            error: 'session already has active terminal',
            hint: 'open a new /new session',
          }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      // Audit F1: tag the shell socket so webSocketClose/webSocketError
      // can discriminate it from HMR sockets (which tag themselves
      // 'cirrus-hmr' at :1239). Without this, a hibernation-attached
      // shell socket's attachment is undefined — indistinguishable
      // from any other untagged hibernation socket — and the close
      // handler can't tell whether to null the terminal.
      try { (server as any).serializeAttachment?.({ kind: 'shell' }); } catch {}
      try {
        this.initSession(server);
      } catch (err: any) {
        console.error('initSession error:', err?.message, err?.stack);
        return new Response('Init failed: ' + err?.message, { status: 500 });
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Process log streaming / listing — see src/process-logs-api.ts ──
    const logsPid = matchLogsPath(url.pathname);
    if (logsPid !== null) {
      return handleLogsWebSocketRequest(request, logsPid, {
        processLogs: this.processLogs,
        processTable: this.processTable,
        // W9: pass ctx so the upgrade uses ctx.acceptWebSocket (hibernatable).
        ctx: this.ctx as any,
      });
    }
    if (url.pathname === '/api/processes') {
      return handleProcessesListRequest(this.processTable, this.processLogs);
    }

    if (url.pathname === '/api/memory') {
      // Minimal memory probe for stability investigations (WORKERD-CRASH
      // hypotheses). Reports whatever we can measure inside workerd:
      //   - vfs.{totalFiles, totalBytes} from the SQLite VFS
      //   - process.memoryUsage() if nodejs_compat exposes it (else zeros)
      //   - performance.memory when present (Chromium-style heap info)
      this.ensureSqliteFs();
      let nodeMem: any = null;
      try {
        const g: any = globalThis as any;
        if (g.process && typeof g.process.memoryUsage === 'function') {
          const mu = g.process.memoryUsage();
          nodeMem = {
            rss: mu.rss | 0,
            heapTotal: mu.heapTotal | 0,
            heapUsed: mu.heapUsed | 0,
            external: mu.external | 0,
            arrayBuffers: mu.arrayBuffers | 0,
          };
        }
      } catch { /* ignore */ }
      let perfMem: any = null;
      try {
        const g: any = globalThis as any;
        if (g.performance && g.performance.memory) {
          perfMem = {
            jsHeapSizeLimit: g.performance.memory.jsHeapSizeLimit | 0,
            totalJSHeapSize: g.performance.memory.totalJSHeapSize | 0,
            usedJSHeapSize: g.performance.memory.usedJSHeapSize | 0,
          };
        }
      } catch { /* ignore */ }
      const vfs = this.sqliteFs!.getStats();
      return Response.json({
        vfs: { files: vfs.files, usedBytes: vfs.usedBytes },
        nodeMem,
        perfMem,
        ts: Date.now(),
      });
    }

    // ── Diagnostic memory probe ──────────────────────────────────────────
    // /api/_diag/memory — supervisor heap pressure with peak tracking.
    //
    // Why a second endpoint when /api/memory already exists:
    //   1. /api/memory is a snapshot only. To prove an OOM hypothesis
    //      we need the PEAK heap during a workload, captured even if
    //      the kill happens microseconds after the high-water mark.
    //   2. Peak survives across many polls; one poll right after the
    //      crash's reboot will report peak=0 (this isolate just started),
    //      itself a positive signal that the prior isolate was killed.
    //   3. Never colocate diagnostic state with the prod /api/memory
    //      contract — keep behavioural endpoints stable, evolve
    //      /api/_diag/* freely.
    //
    // Returns the same nodeMem/perfMem fields as /api/memory plus:
    //   - peak: { rssBytes, heapUsedBytes, atMs, samples } — high-water
    //     marks observed since this isolate started. Updated on every
    //     call to this endpoint (cheap; pre-bundle and install paths
    //     can call it themselves to record their own peaks).
    //   - limitBytes: workerd's hard DO heap cap (128 MiB) for context.
    //   - usagePctOfLimit: heapUsed / limit, for at-a-glance reading.
    //
    // Permanent infra: keep this endpoint even after the prebundle OOM
    // is fixed. Future memory regressions will use it the same way.
    if (url.pathname === '/api/_diag/memory') {
      this.ensureSqliteFs();
      this._diagSampleMemory();
      const nodeMem = this._diagReadNodeMem();
      const perfMem = this._diagReadPerfMem();
      const vfs = this.sqliteFs!.getStats();
      const DO_HEAP_LIMIT_BYTES = 128 * 1024 * 1024;
      const heapUsed = nodeMem?.heapUsed ?? 0;
      // Application-level counters from src/diag-counters.ts. workerd's
      // process.memoryUsage() returns 0 for all fields inside DO class
      // contexts (only dynamic-worker isolates under nodejs_compat get
      // the real implementation). These deterministic counters are the
      // primary signal for OOM-hypothesis verification —
      // `cumulativePackumentBytesDecoded` in particular is the smoking
      // gun for the resolver-phase OOM. Pre-fix it climbs into hundreds
      // of MB on the supervisor; post-fix (resolver moved to facet) it
      // stays near 0.
      const counters = readDiagCounters();
      // W5 Lever 5: cause-discriminated last-failures + last-RPC-frame
      // + last-facet-id + LRU shrink state. Back-compat with v1: every
      // existing field preserved; new fields are additive. See
      // audit/sections/W5-plan.md §5.
      // `vfs` here is the getStats() result (line 1268). vfs.cache holds
      // the LRU stats including the W5-augmented maxEntries/lruShrunk.
      const cacheStats = (vfs as any).cache ?? {};
      const lastFailures = getFailures();
      return Response.json({
        // ── v1 fields (preserved) ─────────────────────────────────
        vfs: { files: vfs.files, usedBytes: vfs.usedBytes },
        nodeMem,
        perfMem,
        peak: {
          rssBytes: this._diagPeakRss,
          heapUsedBytes: this._diagPeakHeapUsed,
          atMs: this._diagPeakAt,
          samples: this._diagSampleCount,
        },
        counters,
        limitBytes: DO_HEAP_LIMIT_BYTES,
        usagePctOfLimit: heapUsed > 0
          ? Math.round((heapUsed / DO_HEAP_LIMIT_BYTES) * 1000) / 10
          : 0,
        ts: Date.now(),

        // ── v2 / W5 additions ─────────────────────────────────────
        lastFailures,
        vfsDetail: {
          lruBytes: cacheStats.hotBytes ?? 0,
          lruMaxEntries: cacheStats.maxEntries ?? LRU_MAX_ENTRIES,
          lruMaxBytes: cacheStats.maxBytes ?? (LRU_MAX_ENTRIES * 65536),
          lruShrunk: cacheStats.lruShrunk ?? false,
          evictions: cacheStats.evictions ?? 0,
          hitRate: cacheStats.hitRate ?? 0,
        },
        rpc: {
          lastFrame: getLastRpcFrame(),
        },
        facet: {
          lastDispatch: getLastFacetId(),
        },

        // ── W9: hibernation observability ───────────────────────────
        // `hib.isolateGen` increments per fresh isolate (cold start or
        // post-hibernation wake). Two probe calls a minute apart with
        // different gens means a hibernation/wake cycle ran in between.
        // `rehydrated*` counters are >0 only on the first hydrate after
        // a wake. `flushed*` counters track the alarm-driven SQL writes.
        // `autoResponseConfigured` reports the runtime's actual
        // capability (older workerd builds report false).
        hib: {
          isolateGen: this._w9IsolateGen,
          autoResponseConfigured: this._w9WsConfig?.autoResponseConfigured ?? false,
          autoResponseError: this._w9WsConfig?.autoResponseError ?? null,
          hibernationEventTimeoutMs: this._w9WsConfig?.timeoutSetMs ?? null,
          timeoutError: this._w9WsConfig?.timeoutError ?? null,
          ...this.processLogs.hibStats(),
        },
      });
    }

    // ── W9: hibernation simulation + diagnostic spawn (NIMBUS_DEBUG=1) ──
    //
    // These endpoints exist to let local probes exercise the cross-
    // hibernation code path. Real DO hibernation only happens in prod;
    // wrangler dev keeps state across requests. So we simulate the
    // "fresh isolate per dispatch" rule by clearing the in-memory
    // ProcessLogStore — the next read MUST hydrate from SQL.
    //
    // 404 when NIMBUS_DEBUG isn't set, so prod isn't a free vector.
    if (url.pathname.startsWith('/api/_test/') ) {
      if (!this.nimbusDebug) {
        return new Response('not found', { status: 404 });
      }
      if (url.pathname === '/api/_test/hib/simulate' && request.method === 'POST') {
        // Drain any pending writes first so SQL is the source of truth,
        // then nuke the in-memory ring. The next read on any pid will
        // re-hydrate via the adapter.
        try { this.processLogs.flush(); } catch {}
        const fresh = new ProcessLogStore();
        // Re-wire persist on the new store (mirrors constructor path).
        this._w9PersistWired = false;
        this.processLogs = fresh;
        this._w9WireProcessLogPersist();
        return Response.json({ cleared: true, ts: Date.now() });
      }
      if (url.pathname === '/api/_test/spawn-emitter' && request.method === 'POST') {
        // Spawns a synthetic emitter directly into ProcessLogStore +
        // ProcessTable without going through FacetManager. Lets the e2e
        // probe drive the W9 code path without a real long-running
        // facet (which the test environment may not support).
        try {
          const body = await request.json() as any;
          const lines = Math.max(1, Math.min(1000, Number(body.lines) || 50));
          const text = String(body.lineText || 'line');
          const entry = this.processTable.spawn(`_test:${text}`, ['_test'], '/');
          const pid = entry.pid;
          for (let i = 0; i < lines; i++) {
            this.processLogs.append(pid, 'stdout', `${text} ${i}\n`);
          }
          // Force-flush so SQL reflects state before the next request.
          try { this.processLogs.flush(); } catch {}
          return Response.json({ pid, lines });
        } catch (e: any) {
          return Response.json({ error: e?.message }, { status: 400 });
        }
      }
      if (url.pathname === '/api/_test/log-tail' && request.method === 'GET') {
        const pid = parseInt(url.searchParams.get('pid') || '', 10);
        const linesQ = parseInt(url.searchParams.get('lines') || '0', 10) || undefined;
        if (!Number.isFinite(pid) || pid <= 0) {
          return Response.json({ error: 'bad pid' }, { status: 400 });
        }
        const chunks = this.processLogs.tail(pid, linesQ ? { lines: linesQ } : {});
        const allText = chunks.map((c) => c.data).join('');
        const lines = allText.split('\n').filter((l) => l !== '');
        return Response.json({ pid, lines, chunkCount: chunks.length });
      }
      return new Response('unknown _test endpoint', { status: 404 });
    }

    if (url.pathname === '/api/stats') {
      this.ensureSqliteFs();
      const vfsStats = this.sqliteFs!.getStats();
      const processStats = this.processTable.stats;
      const logStoreStats = this.processLogs.stats;
      // Preview UI polls vite.running to decide between /preview/ and
      // the "no dev server" placeholder. We report running:true if
      // EITHER the Cirrus in-process ViteDevServer OR the opt-in
      // real-vite facet (cirrusReal) is live. Without this merge, a
      // session on NIMBUS_REAL_VITE=1 saw vite.running=false even
      // while real-vite was happily serving on /preview/.
      const legacyViteStats = this.viteDevServer?.stats || null;
      const cirrusRealRunning = !!this.cirrusReal?.isRunning;
      const viteStats = cirrusRealRunning
        ? {
            running: true,
            root: legacyViteStats?.root ?? 'home/user/app',
            backend: 'real' as const,
          }
        : legacyViteStats;
      const wranglerStats = this.nimbusWrangler?.stats || null;
      const portStats = this.portRegistry.stats;
      // Audit C3: same-origin only. The UI shell at /s/<id>/ polls this
      // from its own origin; no cross-origin reader is intended. If
      // future embeds need cross-origin reads, add an explicit origin
      // allowlist — not a wildcard.
      return Response.json({ ...vfsStats, processes: processStats, logStore: logStoreStats, ports: portStats, vite: viteStats, wrangler: wranglerStats });
    }

    // ── File write API: bypasses shell for fast bulk seeding ──
    // Audit C3: mutation endpoints do NOT advertise any CORS policy.
    // A cross-origin page that learns a session ID would otherwise be
    // able to write arbitrary files through the user's logged-in tab.
    // Same-origin POSTs from the session shell still work — SOP (not
    // CORS) governs them, so no preflight is emitted; cross-origin
    // requests are rejected by the browser before reaching the Worker.
    if (url.pathname === '/api/write-file' && request.method === 'POST') {
      this.ensureSqliteFs();
      try {
        const body = await request.json() as any;
        const path = String(body.path).replace(/^\/+/, '');
        // Ensure parent dirs
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
          const dir = parts.slice(0, i).join('/');
          if (dir && !this.sqliteFs!.exists(dir)) this.sqliteFs!.mkdir(dir, { recursive: true });
        }
        this.sqliteFs!.writeFile(path, String(body.content));
        return Response.json({ ok: true, path });
      } catch (e: any) {
        return Response.json({ error: e?.message }, { status: 400 });
      }
    }

    if (url.pathname === '/api/mkdir' && request.method === 'POST') {
      this.ensureSqliteFs();
      try {
        const body = await request.json() as any;
        const path = String(body.path).replace(/^\/+/, '');
        this.sqliteFs!.mkdir(path, { recursive: true });
        return Response.json({ ok: true, path });
      } catch (e: any) {
        return Response.json({ error: e?.message }, { status: 400 });
      }
    }

    // ── Start vite via HTTP API (survives WS disconnects) ──
    if (url.pathname === '/api/start-vite' && request.method === 'POST') {
      this.ensureSqliteFs();
      try {
        const body = await request.json() as any;
        const root = String(body.root || 'home/user').replace(/^\/+/, '');

        // Stop existing server
        if (this.viteDevServer?.isRunning) this.viteDevServer.stop();

        // Start in-process ViteDevServer
        if (!this.esbuildService) this.esbuildService = new EsbuildService(this.sqliteFs!);
        const basePath = this.viteBasePath;
        this.viteDevServer = new ViteDevServer({
          vfs: this.sqliteFs!, esbuild: this.esbuildService!, root,
          aliases: body.aliases, define: body.define,
          onHmrMessage: () => {},
          sql: this.ctx.storage.sql,
          injectBasename: body.injectBasename,
          basePath,
          // env+ctx enable the on-demand facet bundle path. Without
          // these, ViteDevServer falls back to in-supervisor esbuild
          // for /preview/@modules/<spec> cold-path bundles — which OOMs
          // on large packages (lucide-react). See vite-dev-server.ts:
          // ensureOnDemandPool / serveModule.
          env: this.env,
          ctx: this.ctx,
        });
        this.viteDevServer.start();

        // Persist so vite survives DO hibernation. basePath included so the
        // rehydrated server after DO sleep emits URLs under the same prefix
        // even before the next forwarded request updates sessionBasePath.
        await this.ctx.storage.put('vite-config', { root, aliases: body.aliases, define: body.define, injectBasename: body.injectBasename, basePath });

        return Response.json({ ok: true, root, running: true });
      } catch (e: any) {
        return Response.json({ error: e?.message }, { status: 400 });
      }
    }

    // ── Supervisor RPC: facets call back for stdout/stderr/VFS ──
    // Audit C3: mutation endpoint. Same-origin only — a facet that
    // needs to reach the supervisor goes through ctx.exports RPC
    // (loopback, not HTTP), and there is no user-facing cross-origin
    // use case.
    if (url.pathname === '/api/supervisor-rpc' && request.method === 'POST') {
      this.ensureSqliteFs();
      return handleSupervisorRpc(request, {
        vfs: this.sqliteFs!,
        processTable: this.processTable,
        portRegistry: this.portRegistry,
        terminal: this.terminal,
        processLogs: this.processLogs,
      });
    }

    // CORS preflight for API endpoints (audit C3).
    // Respond 204 with NO Access-Control-Allow-Origin. The browser
    // treats a missing ACAO as "cross-origin denied," which is what
    // we want for every endpoint in this DO: same-origin requests
    // from the session shell skip preflight entirely (SOP governs
    // them, not CORS); cross-origin callers are rejected.
    //
    // This handler matches only /api/* — the /preview, /worker, and
    // /port proxies retain their own header handling (some of those
    // still set wildcard ACAO in sibling modules like vite-dev-server
    // and nimbus-wrangler; tightening those is tracked as follow-up
    // since they serve user-controlled content and require separate
    // review of each consumer).
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204 });
    }

    // ── Preview route: serves the Vite dev server output ──
    // Uses in-process ViteDevServer (synchronous VFS access + esbuild transforms).
    // This is reliable and avoids facet lifecycle issues.
    if (url.pathname.startsWith('/preview/') || url.pathname === '/preview') {
      // Ensure the starter project exists even if the user hits /preview/
      // before opening a terminal session. Idempotent — no-op if already seeded.
      try {
        this.ensureSqliteFs();
        this.seedFilesystem();
      } catch { /* non-fatal */ }

      // ── Real-vite takes precedence if running ───────────────────────
      // Cirrus shim and real-vite are mutually exclusive per session.
      // cirrusReal is checked first since users explicitly opted in via
      // NIMBUS_REAL_VITE=1 or `nimbusDevServer: 'real'`.
      if (this.cirrusReal?.isRunning) {
        const previewPath = (url.pathname.replace(/^\/preview/, '') || '/') + url.search;

        // Phase 2: HMR WebSocket upgrade. Vite's @vite/client opens a
        // WS against `<base>/__nimbus_hmr` (our custom HMR path). We
        // accept it here and plug it into cirrusReal.hmr so the facet's
        // ws-shim sees a 'connection' event on its next long-poll.
        // Non-hibernatable (server.accept, not ctx.acceptWebSocket) —
        // clients auto-reconnect on DO wake.
        if (previewPath.startsWith('/__nimbus_hmr') || previewPath === '/__nimbus_hmr') {
          if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 });
          }
          const pair = new WebSocketPair();
          const [client, server] = Object.values(pair);
          // Use ctx.acceptWebSocket (hibernatable) — required because
          // HMR sends messages from a DIFFERENT request context (the
          // facet's long-poll RPC). workerd forbids cross-request I/O
          // on server.accept()'d sockets.
          this.ctx.acceptWebSocket(server, ['cirrus-hmr']);
          const clientId = this.cirrusReal.attachHmrClient(server);
          (server as any).serializeAttachment?.({ kind: 'cirrus-hmr', clientId });
          const hmrClients = (this._cirrusHmrWsClients ||= new Map());
          hmrClients.set(server, clientId);
          // Echo the vite-hmr subprotocol.
          const wantedProto = request.headers.get('Sec-WebSocket-Protocol') || '';
          const useProto = wantedProto.split(',').map(s => s.trim()).find(p => p === 'vite-hmr' || p === 'vite-ping');
          const respHeaders: Record<string, string> = {};
          if (useProto) respHeaders['Sec-WebSocket-Protocol'] = useProto;
          return new Response(null, { status: 101, webSocket: client, headers: respHeaders });
        }

        return this.cirrusReal.handleRequest(request, previewPath);
      }

      // Lazy-init: if DO hibernated and ViteDevServer was GC'd, reconstruct from saved config
      if (!this.viteDevServer || !this.viteDevServer.isRunning) {
        try {
          const config = await this.ctx.storage.get('vite-config') as any;
          if (config?.root) {
            this.ensureSqliteFs();
            if (!this.esbuildService) this.esbuildService = new EsbuildService(this.sqliteFs!);
            // Prefer the current request's basePath (just captured from the
            // X-Nimbus-Base header) over the stored one — the latter is only
            // a fallback for cold rehydrates that precede any header hit.
            const basePath = this.viteBasePath || config.basePath;
            this.viteDevServer = new ViteDevServer({
              vfs: this.sqliteFs!, esbuild: this.esbuildService!, root: config.root,
              aliases: config.aliases, define: config.define,
              onHmrMessage: () => {},
              sql: this.ctx.storage.sql,
              injectBasename: config.injectBasename,
              basePath,
              env: this.env,
              ctx: this.ctx,
            });
            this.viteDevServer.start();
          }
        } catch { /* lazy-init failed, fall through to "no server" response */ }
      }
      if (this.viteDevServer?.isRunning) {
        const previewPath = (url.pathname.replace(/^\/preview/, '') || '/') + url.search;
        return this.viteDevServer.handleRequest(request, previewPath);
      }
      // Polished placeholder — auto-reloads when vite starts.
      // Checks the VFS for the starter app so we can offer a context-aware hint.
      const hasSeed = (() => {
        try {
          return this.sqliteFs!.exists('home/user/app') &&
                 this.sqliteFs!.exists('home/user/app/package.json');
        } catch { return false; }
      })();
      const hint = hasSeed
        ? 'cd app &amp;&amp; npm install &amp;&amp; npm run dev'
        : 'vite';
      // The placeholder JS polls the session's /api/stats. If this DO was
      // reached directly (no session prefix), fall back to a relative path.
      const statsUrl = (this.sessionBasePath || '') + '/api/stats';
      return new Response(
        renderNoDevServerHtml({ hint, polled: statsUrl, liveKey: 'vite' }),
        // Audit C3: HTML served same-origin to the session shell.
        // No wildcard ACAO — the page's own fetch to /api/stats is
        // same-origin and needs no CORS header.
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
      );
    }

    // ── Worker route: serves the nimbus-wrangler dev worker output ──
    if (url.pathname.startsWith('/worker/') || url.pathname === '/worker') {
      if (!this.nimbusWrangler?.isRunning) {
        // Mirror the polished /preview/ placeholder — auto-reloads when
        // nimbus-wrangler starts. The placeholder references BOTH command
        // names so users coming from either `wrangler dev` or
        // `nimbus-wrangler dev` see a familiar hint.
        const hasWranglerConfig = (() => {
          try {
            this.ensureSqliteFs();
            return this.sqliteFs!.exists('home/user/wrangler.jsonc') ||
                   this.sqliteFs!.exists('home/user/wrangler.json') ||
                   this.sqliteFs!.exists('home/user/wrangler.toml');
          } catch { return false; }
        })();
        const hint = hasWranglerConfig
          ? 'npm run dev'
          : 'wrangler dev';
        return new Response(
          renderNoDevServerHtml({ hint, polled: (this.sessionBasePath || '') + '/api/stats', liveKey: 'wrangler' }),
          // Audit C3: same-origin HTML, no ACAO needed (see /preview/).
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
        );
      }
      const workerPath = url.pathname.replace(/^\/worker/, '') || '/';
      // Full outer-facing prefix for the proxy (e.g.
      // "/s/nimble-otter-4271/worker"). The proxy uses this to rewrite
      // Location headers emitted by the inner Worker so cross-redirects
      // (POST /new → /s/<inner>/) land back on the correctly-prefixed
      // outer URL rather than a bare /s/<inner>/ path that would spawn
      // a different outer session.
      const outerWorkerBase = (this.sessionBasePath || '') + '/worker';
      return this.nimbusWrangler.handleRequest(request, workerPath, outerWorkerBase);
    }

    // ── Port route: routes to facet HTTP servers ──
    // Audit F3 (STABILITY-AUDIT.md C-S3): routeRequest now always
    // returns a Response — 501 when no facet has a stub registered
    // (the normal case today, since the facet-side producer was
    // never wired), or a real proxied response once wiring lands.
    // The post-routeRequest null-branch + 502 fallback below is kept
    // defensively for any future refactor that returns null for a
    // different error condition.
    const portMatch = url.pathname.match(/^\/port\/(\d+)(\/.*)?$/);
    if (portMatch) {
      const port = parseInt(portMatch[1]);
      const path = portMatch[2] || '/';
      const result = await this.portRegistry.routeRequest(port, request, path);
      if (result) return result;
      return new Response(`No process listening on port ${port}`, {
        status: 502,
      });
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Read process.memoryUsage() if nodejs_compat exposes it. Returns null
   * on environments where the binding is absent (older compat dates,
   * non-Workers test harnesses). Never throws — heap probes must be
   * fault-tolerant so a probe that fails in prod doesn't take the
   * request handler down with it.
   */
  private _diagReadNodeMem(): { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number } | null {
    try {
      const g: any = globalThis as any;
      if (g.process && typeof g.process.memoryUsage === 'function') {
        const mu = g.process.memoryUsage();
        return {
          rss: mu.rss | 0,
          heapTotal: mu.heapTotal | 0,
          heapUsed: mu.heapUsed | 0,
          external: mu.external | 0,
          arrayBuffers: mu.arrayBuffers | 0,
        };
      }
    } catch { /* ignore */ }
    return null;
  }

  private _diagReadPerfMem(): { jsHeapSizeLimit: number; totalJSHeapSize: number; usedJSHeapSize: number } | null {
    try {
      const g: any = globalThis as any;
      if (g.performance && g.performance.memory) {
        return {
          jsHeapSizeLimit: g.performance.memory.jsHeapSizeLimit | 0,
          totalJSHeapSize: g.performance.memory.totalJSHeapSize | 0,
          usedJSHeapSize: g.performance.memory.usedJSHeapSize | 0,
        };
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Sample current heap and update peak trackers. Idempotent on call
   * count beyond `_diagSampleCount`. Safe to call from any code path
   * (request handler, install/bundle progress callbacks) — does NO
   * I/O, NO async work, returns immediately. Cost: one process.memoryUsage()
   * which is microseconds.
   *
   * Use sites that want to record peaks during long operations should
   * call this directly rather than relying on external HTTP polling
   * (HTTP polling can miss the spike between requests).
   */
  private _diagSampleMemory(): void {
    this._diagSampleCount++;
    const mu = this._diagReadNodeMem();
    if (!mu) return;
    const now = Date.now();
    if (mu.rss > this._diagPeakRss) {
      this._diagPeakRss = mu.rss;
      this._diagPeakAt = now;
    }
    if (mu.heapUsed > this._diagPeakHeapUsed) {
      this._diagPeakHeapUsed = mu.heapUsed;
      // _diagPeakAt is whichever is most recent of the two; prefer
      // heapUsed peaks since rss is a lagging indicator that may include
      // freed-but-not-returned pages.
      this._diagPeakAt = now;
    }
  }

  private ensureSqliteFs() {
    if (!this.sqliteFs) {
      this.sqliteFs = new SqliteVFS(this.ctx.storage.sql, this.ctx);
      // Audit C1: surface deferred-flush failures. SqliteVFS.writeFile()
      // is synchronous (fire-and-forget by design — see LIFO MountProvider
      // contract) so it can't return an error to the caller. Instead the
      // VFS retries once and then calls these handlers for chunks that
      // failed twice. We log to the user's terminal (non-spammy — the
      // VFS also logs to the Worker console for operator triage) and
      // make the error visible in /api/stats via getStats().
      this.sqliteFs.onWriteError((err) => {
        try {
          if (this.terminal) {
            this.terminal.write(
              `\x1b[31m[vfs] write failed: ${err.path} chunk ${err.chunkId} ` +
              `(attempts=${err.attempts}): ${err.error}\x1b[0m\r\n`,
            );
          }
        } catch { /* handler must not throw back into the flush path */ }
      });
      // W5 Lever 8: shrinkForInstall() during heavy-alloc windows.
      // The observer fires only on 0→1 / ≥1→0 edges (registerAllocObserver
      // in heavy-alloc-coord.ts handles the refcount). Default shrink
      // target 128 entries × 64 KB = 8 MiB; +24 MiB heap headroom
      // during install / clone / pre-bundle. See W5-plan.md §2.
      const vfs = this.sqliteFs;
      registerAllocObserver({
        onAcquire: () => {
          try { vfs.shrinkForInstall(); } catch (e: any) {
            console.warn('[nimbus/W5] shrinkForInstall threw:', e?.message);
          }
        },
        onRelease: () => {
          try { vfs.restoreAfterInstall(); } catch (e: any) {
            console.warn('[nimbus/W5] restoreAfterInstall threw:', e?.message);
          }
        },
      });
      // W5 Lever 5: rehydrate the OOM ring from storage (best-effort).
      // Survives DO hibernation; lets cf-tail-style forensics include
      // pre-hibernate failures. Fail-soft on garbage / missing — the
      // rehydrate function's own contract.
      this._w5RehydrateRingFromStorage().catch((e: any) => {
        console.warn('[nimbus/W5] ring rehydrate failed:', e?.message);
      });
    }
  }

  // ── W5 Lever 5: ring buffer persistence on DO storage ─────────────────
  // Storage key for the OOM-discriminator snapshot. Bounded ≤20 KB by
  // oom-discriminator.ts; one async put per webSocketClose where the
  // ring is non-empty.
  private static readonly _W5_RING_STORAGE_KEY = 'w5_oom_ring_v1';
  /** Track when we last persisted to avoid redundant writes. */
  private _w5LastPersistAt: number = 0;
  /** Track ring size at last persist; skip write if unchanged. */
  private _w5LastPersistRingSize: number = -1;

  private async _w5RehydrateRingFromStorage(): Promise<void> {
    try {
      const blob = await this.ctx.storage.get(NimbusSession._W5_RING_STORAGE_KEY);
      if (blob) rehydrateFromStorage(blob);
    } catch (e: any) {
      // Storage read can fail on a fresh isolate or after schema reset.
      // The ring stays empty — perfectly OK.
    }
  }

  /** Snapshot the ring + persist to ctx.storage. Async; callers should
   *  pass the returned promise to ctx.waitUntil so close-handler return
   *  doesn't race the put. Skips redundant writes. */
  private _w5PersistRing(): Promise<void> | null {
    try {
      const failures = getFailures();
      if (failures.length === 0) return null;
      if (failures.length === this._w5LastPersistRingSize) return null;
      const snap = snapshotForStorage();
      this._w5LastPersistRingSize = failures.length;
      this._w5LastPersistAt = Date.now();
      // ctx.storage.put returns a promise; await semantics for the
      // caller's waitUntil. Errors here are non-fatal — log and move on.
      return this.ctx.storage.put(
        NimbusSession._W5_RING_STORAGE_KEY,
        snap,
      ).catch((e: any) => {
        console.warn('[nimbus/W5] ring persist failed:', e?.message);
      });
    } catch (e: any) {
      console.warn('[nimbus/W5] ring persist threw:', e?.message);
      return null;
    }
  }

  private ensureFacetManager() {
    if (!this.facetManager) {
      this.facetManager = new FacetManager(
        this.ctx,
        this.env,
        this.processTable,
        this.portRegistry,
        {
          onExternalExit: (pid, code, reason) => this._reportExternalExit(pid, code, reason),
          onSpawn: (pid, command, longRunning) => {
            // Only surface long-running / user-visible spawns to keep
            // the terminal uncluttered. Short `node <file>` evals also
            // get a line because users want the pid for `logs`/`kill`.
            if (!this.terminal) return;
            const label = longRunning ? 'started (long-running)' : 'started';
            this.terminal.write(
              `\x1b[2m[facet ${label}: pid=${pid} cmd="${command}"]\x1b[0m\r\n`,
            );
            // Structured event so the tabs UI can auto-open a log tab
            // for long-running processes (vite, wrangler dev, etc.).
            notifyTerminalEvent(this.terminal, { type: 'spawn', pid, command, longRunning });
          },
        },
      );
    }
    if (this.facetManager && this.sqliteFs) {
      this.facetManager.setVfs(this.sqliteFs);
    }
  }

  /**
   * Get or create the singleton fetch proxy entrypoint.
   * ONE dynamic worker is created via LOADER.load() and reused for ALL npm
   * fetch calls across the lifetime of this DO instance. This prevents
   * ephemeral port exhaustion from creating a new worker per fetch.
   */
  private ensureFetchProxy(log?: (msg: string) => void): any | null {
    if (this.fetchProxyEntrypoint) return this.fetchProxyEntrypoint;

    try {
      const env = this.env as any;
      if (!env?.LOADER?.load) {
        log?.('LOADER.load not available — using global fetch');
        return null;
      }

      // Buffered proxy: reads the entire response body into an ArrayBuffer
      // and returns it in ONE message instead of forwarding a ReadableStream.
      // In workerd local dev, streaming responses across a service-binding
      // RPC fabric opens a separate loopback socket PER chunk (~16KB), which
      // exhausts ephemeral ports for larger installs (npm registry packuments
      // are 500KB-3MB, tarballs up to 5MB). Buffering to arrayBuffer means
      // 1 stub call = 1 loopback connection, not N connections.
      //
      // 32MB cap prevents a malformed giant response from OOMing the proxy
      // isolate. Packages with tarballs larger than 32MB will fail to install
      // cleanly (returned as 413 → caller treats as failed fetch).
      const proxyCode = [
        'const MAX_BYTES = 32 * 1024 * 1024;',
        'export default {',
        '  async fetch(request, workerEnv) {',
        '    try {',
        '      const body = await request.json();',
        '      const resp = await fetch(body.url, {',
        '        method: body.method || "GET",',
        '        headers: body.headers || {},',
        '      });',
        '      // Check advertised Content-Length before buffering',
        '      const clStr = resp.headers.get("content-length");',
        '      if (clStr) {',
        '        const cl = parseInt(clStr, 10);',
        '        if (cl > MAX_BYTES) {',
        '          return new Response(',
        '            JSON.stringify({ error: "response too large: " + cl + " bytes (cap " + MAX_BYTES + ")" }),',
        '            { status: 413, headers: { "Content-Type": "application/json" } }',
        '          );',
        '        }',
        '      }',
        '      // Buffer entire body — ONE message, not streamed chunks',
        '      const buf = await resp.arrayBuffer();',
        '      if (buf.byteLength > MAX_BYTES) {',
        '        return new Response(',
        '          JSON.stringify({ error: "response exceeded cap: " + buf.byteLength + " bytes" }),',
        '          { status: 413, headers: { "Content-Type": "application/json" } }',
        '        );',
        '      }',
        '      return new Response(buf, {',
        '        status: resp.status,',
        '        statusText: resp.statusText,',
        '        headers: Object.fromEntries(resp.headers.entries()),',
        '      });',
        '    } catch (e) {',
        '      return new Response(JSON.stringify({ error: e.message }), {',
        '        status: 502,',
        '        headers: { "Content-Type": "application/json" },',
        '      });',
        '    }',
        '  }',
        '};',
      ].join('\n');

      const worker = env.LOADER.load({
        compatibilityDate: CF_COMPAT_DATE,
        compatibilityFlags: ['nodejs_compat'],
        mainModule: 'fetch-proxy.js',
        modules: { 'fetch-proxy.js': proxyCode },
      });
      this.fetchProxyEntrypoint = worker.getEntrypoint();
      log?.('Fetch proxy worker created (singleton)');
      return this.fetchProxyEntrypoint;
    } catch (e: any) {
      log?.(`Fetch proxy creation failed: ${e?.message}`);
      return null;
    }
  }

  /**
   * Build a FetchFn that routes through the singleton proxy entrypoint.
   * All concurrent fetches share ONE worker — no port exhaustion.
   */
  private buildFetchFn(log?: (msg: string) => void): ((url: string, init?: RequestInit) => Promise<Response>) | undefined {
    const entrypoint = this.ensureFetchProxy(log);
    if (!entrypoint) return undefined;

    return async (url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => { headers[k] = v; });
        } else if (typeof init.headers === 'object') {
          Object.assign(headers, init.headers);
        }
      }
      return entrypoint.fetch(new Request('http://fetch-proxy/do-fetch', {
        method: 'POST',
        body: JSON.stringify({ url, method: init?.method || 'GET', headers }),
      }));
    };
  }

  private ensureNpmInstaller(onProgress?: (msg: string) => void) {
    this.ensureSqliteFs();
    if (!this.esbuildService) {
      this.esbuildService = new EsbuildService(this.sqliteFs!);
    }
    // ── Lazy fetch-proxy ────────────────────────────────────────────
    // The fetch-proxy is a singleton dynamic worker (LOADER.load) that
    // buffers registry responses to dodge wrangler-local-dev port
    // exhaustion. It is ONLY needed by the legacy in-supervisor
    // resolveTree path (src/npm-resolver.ts). With NIMBUS_FACET_RESOLVER
    // default-on (commit 9194998) the resolver runs in a facet that
    // uses bare globalThis.fetch — no proxy needed. Same for the
    // install-batch-facet path (commit c285025) — uses bare fetch.
    //
    // workerd has a per-DO cap on concurrent dynamic workers (~5-6
    // empirically). A permanent live proxy worker eats one of those
    // slots for the entire DO lifetime. Skipping the proxy in the
    // default-on configuration buys us back a slot.
    //
    // Proxy is only built when ANY legacy fallback is active — this
    // way `NIMBUS_FACET_RESOLVER=0` (rolling back the resolver) or
    // `NIMBUS_FACET_NPM_INSTALL_BATCH=0` (rolling back install-batch)
    // still works exactly as before. Same emergency-rollback contract.
    const useFacetResolver = this._envFlagDefaultOn('NIMBUS_FACET_RESOLVER');
    const useFacetInstall  = this._envFlagDefaultOn('NIMBUS_FACET_NPM_INSTALL');
    const useBatchFacet    = this._envFlagDefaultOn('NIMBUS_FACET_NPM_INSTALL_BATCH');
    const needProxy = !(useFacetResolver && useFacetInstall && useBatchFacet);
    const fetchFn = needProxy ? this.buildFetchFn(onProgress) : undefined;
    if (!needProxy) {
      onProgress?.(`[npm] Lazy fetch-proxy: skipped (all facet paths default-on)`);
    }
    this.npmInstaller = new NpmInstaller(
      this.sqliteFs!,
      this.ctx.storage.sql,
      {
        esbuild: this.esbuildService,
        ctx: this.ctx,
        env: this.env,
        onProgress,
        fetchFn,
      },
    );
  }

  /**
   * Read an environment flag with default-on semantics. Mirrors the
   * shouldUseFacetPool / shouldUseFacetResolver / shouldUseBatchFacet
   * gates inside NpmInstaller — kept here as a private helper so the
   * lazy-proxy decision uses identical semantics without leaking that
   * private API across modules.
   */
  private _envFlagDefaultOn(name: string): boolean {
    const raw = (this.env as any)?.[name];
    if (raw === undefined || raw === null) return true;
    const s = String(raw).toLowerCase();
    if (s === '0' || s === '' || s === 'false' || s === 'off' || s === 'no') return false;
    return true;
  }

  // ── Session initialization ────────────────────────────────────────────

  private initSession(ws: WebSocket) {
    this.ensureSqliteFs();
    this.ensureFacetManager();
    this.seedFilesystem();

    this.terminal = new WebSocketTerminal(ws);

    // ── Boot kernel with in-memory VFS (mounts delegate to SqliteFS) ──
    this.kernel = new Kernel(new MemoryPersistenceBackend());
    this.kernel.initFilesystem();

    // ── Mount SqliteFSProvider at all top-level directories ──
    const mountPoints = DEFAULT_MOUNT_POINTS;
    for (const mp of mountPoints) {
      const provider = new SqliteVFSProvider(this.sqliteFs!, mp);
      this.kernel.vfs.mount('/' + mp, provider);
    }

    // ── Monkey-patch appendFile to go through mount provider ──
    const vfs = this.kernel.vfs;
    const originalAppendFile = vfs.appendFile.bind(vfs);
    vfs.appendFile = (path: string, content: string | Uint8Array) => {
      const prov = (vfs as any).getProvider?.(path);
      if (prov) {
        try {
          const existing = prov.provider.readFile(prov.subpath);
          const nc = typeof content === 'string' ? enc.encode(content) : content;
          const combined = new Uint8Array(existing.length + nc.length);
          combined.set(existing, 0);
          combined.set(nc, existing.length);
          prov.provider.writeFile(prov.subpath, combined);
        } catch {
          prov.provider.writeFile(prov.subpath, content);
        }
      } else {
        originalAppendFile(path, content);
      }
    };

    // ── Create command registry ──
    const registry = createDefaultRegistry();
    const kernel = this.kernel;
    const sqliteFs = this.sqliteFs!;
    const facetMgr = this.facetManager!;

    // ── Unix commands (30+ real implementations) ──
    registerUnixCommands(registry, sqliteFs);

    // ── Git integration (isomorphic-git) ──
    // ctx + env are passed for clone/fetch/pull which run in a facet to avoid
    // exhausting the supervisor DO's CPU budget on large repos.
    registerGitCommands(registry, sqliteFs, this.ctx, this.env);

    // ── node command: facet-based execution ─────────────────────────────
    // Parses args, reads script from VFS, delegates to FacetManager.
    // The facet creates a dynamic worker where new Function() is allowed
    // during module startup.
    registry.register('node', async (ctx: any) => {
      const args: string[] = ctx.args || [];

      // node -v / --version
      if (args.includes('-v') || args.includes('--version')) {
        ctx.stdout.write('v20.0.0\n');
        return 0;
      }

      // node --help
      if (args.includes('--help') || args.includes('-h')) {
        ctx.stdout.write('Usage: node [options] [script.js] [arguments]\n');
        ctx.stdout.write('       node -e "code"\n\n');
        ctx.stdout.write('Options:\n');
        ctx.stdout.write('  -e, --eval <code>   Evaluate code\n');
        ctx.stdout.write('  -v, --version       Print version\n');
        ctx.stdout.write('  -h, --help          Print help\n');
        ctx.stdout.write('\nExecution via DO Facets (isolated V8 isolate)\n');
        return 0;
      }

      // node -e "code" / --eval "code"
      const evalIdx = args.indexOf('-e') !== -1 ? args.indexOf('-e') : args.indexOf('--eval');
      if (evalIdx !== -1) {
        const code = args[evalIdx + 1];
        if (!code) {
          ctx.stderr.write('node: -e requires an argument\n');
          return 1;
        }
        const result = await facetMgr.exec(code, {
          argv: args.slice(evalIdx + 2),
          env: ctx.env,
          cwd: ctx.cwd,
          filename: '<eval>',
          dirname: ctx.cwd,
        });
        if (result.stdout) ctx.stdout.write(result.stdout);
        if (result.stderr) ctx.stderr.write(result.stderr);
        return result.exitCode;
      }

      // node script.js [args...]
      const scriptPath = args[0];
      if (!scriptPath) {
        ctx.stderr.write('node: REPL not supported. Use node -e "code" or node script.js\n');
        return 1;
      }

      // Resolve the script path relative to cwd
      let resolvedPath = scriptPath;
      if (!scriptPath.startsWith('/')) {
        const cwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');
        resolvedPath = cwd + '/' + scriptPath;
      } else {
        resolvedPath = scriptPath.replace(/^\/+/, '');
      }

      // Handle `node .` — read package.json main field
      if (scriptPath === '.' || scriptPath === './') {
        const cwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');
        const pkgPath = cwd + '/package.json';
        try {
          const pkg = JSON.parse(sqliteFs.readFileString(pkgPath));
          const main = pkg.main || 'index.js';
          resolvedPath = cwd + '/' + main;
        } catch {
          resolvedPath = cwd + '/index.js';
        }
      }

      // Try extensions: .js, .ts, .tsx, .mjs, .jsx
      if (!sqliteFs.exists(resolvedPath)) {
        const exts = ['.js', '.ts', '.tsx', '.mjs', '.jsx', '/index.js', '/index.ts'];
        for (const ext of exts) {
          if (sqliteFs.exists(resolvedPath + ext)) { resolvedPath += ext; break; }
        }
      }

      // Read the script
      let code: string;
      try {
        code = sqliteFs.readFileString(resolvedPath);
      } catch (e: any) {
        ctx.stderr.write(`node: cannot find module '${scriptPath}'\n`);
        return 1;
      }

      // Auto-transform TypeScript/TSX/JSX via esbuild before execution
      if (resolvedPath.endsWith('.ts') || resolvedPath.endsWith('.tsx') || resolvedPath.endsWith('.jsx')) {
        try {
          if (!self.esbuildService) {
            self.ensureSqliteFs();
            self.esbuildService = new EsbuildService(self.sqliteFs!);
          }
          const ext = resolvedPath.split('.').pop()!;
          const loader = ext === 'tsx' ? 'tsx' : ext === 'jsx' ? 'jsx' : 'ts';
          const transformed = await self.esbuildService.transform(code, { loader, format: 'cjs' });
          code = transformed.code;
        } catch (e: any) {
          ctx.stderr.write(`node: transform error for ${scriptPath}: ${e?.message}\n`);
          return 1;
        }
      }

      const filename = '/' + resolvedPath;
      const dirname = filename.includes('/') ? filename.substring(0, filename.lastIndexOf('/')) : '/';

      const result = await facetMgr.exec(code, {
        argv: [filename, ...args.slice(1)],
        env: ctx.env,
        cwd: ctx.cwd,
        filename,
        dirname,
      });
      if (result.stdout) ctx.stdout.write(result.stdout);
      if (result.stderr) ctx.stderr.write(result.stderr);
      return result.exitCode;
    });

    try {
      registry.register('curl', createCurlCommand(kernel));
    } catch {}

    // ── df with SQLite stats + cache + process metrics ──────────────────
    registry.register('df', async (ctx: any) => {
      const stats = sqliteFs.getStats();
      const pstats = facetMgr.stats;
      const used = stats.usedBytes;
      const cap = stats.capacityBytes;
      const avail = cap - used;
      const pct = ((used / cap) * 100).toFixed(0);
      const fmt = (b: number) => {
        if (b >= 1e9) return (b / 1e9).toFixed(1) + 'G';
        if (b >= 1e6) return (b / 1e6).toFixed(1) + 'M';
        if (b >= 1e3) return (b / 1e3).toFixed(1) + 'K';
        return b + 'B';
      };
      ctx.stdout.write('Filesystem      Size  Used Avail Use% Mounted on\n');
      ctx.stdout.write(
        'sqlite         ' + fmt(cap).padStart(5) + ' ' + fmt(used).padStart(5) +
        ' ' + fmt(avail).padStart(5) + ' ' + pct.padStart(3) + '% /\n'
      );
      ctx.stdout.write(
        '\nCache: ' + stats.cache.entries + '/' + stats.cache.maxEntries +
        ' slots | hit rate: ' + stats.cache.hitRate +
        '% | evictions: ' + stats.cache.evictions + '\n'
      );
      ctx.stdout.write(
        'Procs: ' + pstats.running + ' running, ' +
        pstats.exited + ' exited, ' +
        pstats.total + ' total (next PID: ' + pstats.nextPid + ')\n'
      );
      return 0;
    });

    // ── esbuild command: transform/bundle via esbuild facet ───────────────
    // Lazy-creates the EsbuildService on first use (esbuild-wasm is ~10MB).
    const self = this;
    registry.register('esbuild', async (ctx: any) => {
      const args: string[] = ctx.args || [];

      if (args.includes('--version')) {
        ctx.stdout.write('0.24.2 (esbuild-wasm, bundled)\n');
        return 0;
      }

      if (args.includes('--help') || args.length === 0) {
        ctx.stdout.write('Usage: esbuild [options] [entry points]\n\n');
        ctx.stdout.write('Options:\n');
        ctx.stdout.write('  --bundle           Bundle all dependencies into output\n');
        ctx.stdout.write('  --outfile=<path>   Write output to a file\n');
        ctx.stdout.write('  --outdir=<path>    Write output to a directory\n');
        ctx.stdout.write('  --format=esm|cjs   Output format (default: esm)\n');
        ctx.stdout.write('  --platform=browser|node  Target platform\n');
        ctx.stdout.write('  --minify           Minify output\n');
        ctx.stdout.write('  --sourcemap        Generate source maps\n');
        ctx.stdout.write('  --target=<target>  JS target (default: esnext)\n');
        ctx.stdout.write('  --loader=<loader>  Force file loader (ts, tsx, jsx, css)\n');
        ctx.stdout.write('  --version          Show version\n');
        ctx.stdout.write('\nPowered by esbuild-wasm (bundled in supervisor).\n');
        return 0;
      }

      // Lazy-init esbuild service
      if (!self.esbuildService) {
        self.ensureSqliteFs();
        self.esbuildService = new EsbuildService(self.sqliteFs!);
      }

      // Parse flags
      const flags: Record<string, string> = {};
      const entryPoints: string[] = [];
      for (const arg of args) {
        if (arg.startsWith('--')) {
          const eqIdx = arg.indexOf('=');
          if (eqIdx > 0) {
            flags[arg.substring(2, eqIdx)] = arg.substring(eqIdx + 1);
          } else {
            flags[arg.substring(2)] = 'true';
          }
        } else {
          entryPoints.push(arg);
        }
      }

      // Transform-only mode (single file, no --bundle)
      if (entryPoints.length === 1 && !flags['bundle']) {
        // Read the file and transform it
        let filePath = entryPoints[0];
        if (!filePath.startsWith('/')) {
          filePath = (ctx.cwd || '/home/user').replace(/^\/+/, '') + '/' + filePath;
        } else {
          filePath = filePath.replace(/^\/+/, '');
        }

        let code: string;
        try {
          code = sqliteFs.readFileString(filePath);
        } catch {
          ctx.stderr.write(`esbuild: could not read file: ${entryPoints[0]}\n`);
          return 1;
        }

        try {
          ctx.stderr.write('Transforming...\n');
          const result = await self.esbuildService!.transform(code, {
            loader: (flags['loader'] as any) || (() => {
              const ext = filePath.split('.').pop()?.toLowerCase();
              return ({ ts: 'ts', tsx: 'tsx', jsx: 'jsx', js: 'js', mts: 'ts', mjs: 'js', css: 'css', json: 'json' } as any)[ext || ''];
            })(),
            format: (flags['format'] as any) || 'esm',
            target: flags['target'] || 'esnext',
            sourcemap: flags['sourcemap'] === 'true',
            minify: flags['minify'] === 'true',
          });

          if (flags['outfile']) {
            const outPath = flags['outfile'].replace(/^\/+/, '');
            // Ensure parent dirs exist
            const parts = outPath.split('/');
            for (let i = 1; i < parts.length; i++) {
              const dir = parts.slice(0, i).join('/');
              if (dir && !sqliteFs.exists(dir)) sqliteFs.mkdir(dir, { recursive: true });
            }
            sqliteFs.writeFile(outPath, result.code);
            ctx.stdout.write(`  ${outPath}  ${result.code.length} bytes\n`);
          } else {
            ctx.stdout.write(result.code);
          }
          for (const w of result.warnings || []) {
            ctx.stderr.write(`warning: ${w.text}\n`);
          }
          return 0;
        } catch (e: any) {
          ctx.stderr.write(`esbuild error: ${e?.message || e}\n`);
          return 1;
        }
      }

      // Bundle mode
      if (entryPoints.length === 0) {
        ctx.stderr.write('esbuild: no entry points specified\n');
        return 1;
      }

      // Resolve entry points relative to cwd
      const resolvedEntryPoints = entryPoints.map(ep => {
        if (ep.startsWith('/')) return ep.replace(/^\/+/, '');
        return (ctx.cwd || '/home/user').replace(/^\/+/, '') + '/' + ep;
      });

      try {
        ctx.stderr.write('Bundling...\n');
        const result = await self.esbuildService!.build(resolvedEntryPoints, {
          bundle: flags['bundle'] === 'true',
          format: (flags['format'] as any) || 'esm',
          target: flags['target'] || 'esnext',
          platform: (flags['platform'] as any) || 'browser',
          outdir: flags['outfile'] ? undefined : (flags['outdir'] || '/dist'),
          outfile: flags['outfile'],
          sourcemap: flags['sourcemap'] === 'true',
          minify: flags['minify'] === 'true',
          external: flags['external']?.split(','),
        });

        for (const e of result.errors || []) {
          ctx.stderr.write(`error: ${e.text}\n`);
        }
        for (const w of result.warnings || []) {
          ctx.stderr.write(`warning: ${w.text}\n`);
        }

        if (result.errors?.length) return 1;

        // Write output files to VFS
        for (const f of result.outputFiles || []) {
          const outPath = f.path.replace(/^\/+/, '');
          const parts = outPath.split('/');
          for (let i = 1; i < parts.length; i++) {
            const dir = parts.slice(0, i).join('/');
            if (dir && !sqliteFs.exists(dir)) sqliteFs.mkdir(dir, { recursive: true });
          }
          sqliteFs.writeFile(outPath, f.contents);
          ctx.stdout.write(`  ${outPath}  ${f.contents.length} bytes\n`);
        }

        ctx.stderr.write(`Done (${result.outputFiles?.length || 0} output files)\n`);
        return 0;
      } catch (e: any) {
        ctx.stderr.write(`esbuild error: ${e?.message || e}\n`);
        return 1;
      }
    });

    // ── vite command: start/stop the dev server ──────────────────────────
    registry.register('vite', async (ctx: any) => {
      const args: string[] = ctx.args || [];
      const cwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');

      if (args.includes('--help') || args.includes('-h')) {
        ctx.stdout.write('Usage: vite [command] [options]\n\n');
        ctx.stdout.write('Commands:\n');
        ctx.stdout.write('  (default)   Start dev server\n');
        ctx.stdout.write('  build       Build for production\n');
        ctx.stdout.write('  preview     Serve the built dist/\n');
        ctx.stdout.write('  stop        Stop dev server\n\n');
        ctx.stdout.write('Options:\n');
        ctx.stdout.write('  --root <dir>  Project root\n');
        ctx.stdout.write('  --port <n>    Server port\n');
        return 0;
      }

      self.ensureSqliteFs();

      // ── Parse vite.config.ts if it exists ──
      const viteConfig: any = {};
      for (const cfgName of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
        const cfgPath = cwd + '/' + cfgName;
        if (self.sqliteFs!.exists(cfgPath)) {
          try {
            let cfgCode = self.sqliteFs!.readFileString(cfgPath);
            // Transform TS to JS
            if (cfgName.endsWith('.ts')) {
              if (!self.esbuildService) self.esbuildService = new EsbuildService(self.sqliteFs!);
              const t = await self.esbuildService.transform(cfgCode, { loader: 'ts', format: 'esm' });
              cfgCode = t.code;
            }
            // Extract config values via regex (safer than eval in Workers)
            const rootMatch = cfgCode.match(/root\s*:\s*['"]([^'"]+)['"]/);
            if (rootMatch) viteConfig.root = rootMatch[1];
            const portMatch = cfgCode.match(/port\s*:\s*(\d+)/);
            if (portMatch) viteConfig.port = parseInt(portMatch[1]);
            const outDirMatch = cfgCode.match(/outDir\s*:\s*['"]([^'"]+)['"]/);
            if (outDirMatch) viteConfig.outDir = outDirMatch[1];
            const baseMatch = cfgCode.match(/base\s*:\s*['"]([^'"]+)['"]/);
            if (baseMatch) viteConfig.base = baseMatch[1];
            // Nimbus-specific: opt out of the React Router basename injection.
            // Users who want to handle /preview/ routing themselves can set
            // `nimbusInjectBasename: false` in vite.config.ts.
            const injectMatch = cfgCode.match(/nimbusInjectBasename\s*:\s*(true|false)/);
            if (injectMatch) viteConfig.injectBasename = injectMatch[1] === 'true';
            // resolve.alias: "@": path.resolve(__dirname, "./src") or "@": "./src"
            // After esbuild transform, values can be string literals OR path.resolve() calls.
            // Supports any alias key (not just @-prefixed): "@", "~", "#", "components", etc.
            if (!viteConfig.alias) viteConfig.alias = {};
            // Match string literal values: "key": "./path"
            const aliasLiterals = cfgCode.matchAll(/["']([^"']+)["']\s*:\s*["'](\.[^"']+)["']/g);
            for (const am of aliasLiterals) {
              viteConfig.alias[am[1]] = am[2];
            }
            // Match path.resolve() values: "key": path.resolve(__dirname, "./path")
            const aliasResolves = cfgCode.matchAll(/["']([^"']+)["']\s*:\s*(?:path\.resolve|resolve)\s*\([^,]*,\s*["']([^"']+)["']\s*\)/g);
            for (const am of aliasResolves) {
              viteConfig.alias[am[1]] = am[2];
            }
          } catch (e: any) {
            ctx.stderr.write(`Warning: could not parse ${cfgName}: ${e?.message}\n`);
          }
          break;
        }
      }

      // ── vite build ──
      if (args[0] === 'build') {
        if (!self.esbuildService) self.esbuildService = new EsbuildService(self.sqliteFs!);
        const htmlPath = cwd + '/index.html';
        let entryPoint = cwd + '/src/main.tsx';
        let origHtml = '';
        try {
          origHtml = self.sqliteFs!.readFileString(htmlPath);
          const m = origHtml.match(/src=["']([^"']+\.(?:tsx?|jsx?|mjs))["']/);
          if (m) entryPoint = cwd + '/' + m[1].replace(/^\//, '');
        } catch { ctx.stderr.write('Warning: no index.html\n'); }
        if (!self.sqliteFs!.exists(entryPoint)) {
          const alts = [cwd+'/src/main.tsx', cwd+'/src/main.ts', cwd+'/src/index.tsx', cwd+'/src/index.ts'];
          entryPoint = alts.find(p => self.sqliteFs!.exists(p)) || entryPoint;
        }

        ctx.stdout.write('Building for production...\n');
        ctx.stdout.write('  Entry: ' + entryPoint + '\n');
        const t0 = Date.now();

        try {
          const outDir = viteConfig.outDir || 'dist';
          const distDir = cwd + '/' + outDir;

          // Detect which packages are installed vs need CDN
          const nmDir = cwd + '/node_modules';
          const externals: string[] = [];
          const cdnPackages: string[] = [];
          for (const pkg of ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client']) {
            const pkgBase = pkg.split('/')[0];
            if (!self.sqliteFs!.exists(nmDir + '/' + pkgBase)) {
              externals.push(pkg);
              if (!cdnPackages.includes(pkgBase)) cdnPackages.push(pkgBase);
            }
          }
          if (viteConfig.alias) externals.push(...Object.keys(viteConfig.alias));

          // Bundle JS
          const result = await self.esbuildService.build([entryPoint], {
            bundle: true, format: 'esm', target: 'es2020', platform: 'browser',
            minify: true, outdir: '/' + distDir + '/assets',
            external: externals.length > 0 ? externals : undefined,
          });
          if (result.errors?.length) {
            for (const e of result.errors) ctx.stderr.write('  error: ' + e.text + '\n');
            return 1;
          }

          // Generate content hash for filenames
          let jsContent = '';
          for (const f of result.outputFiles || []) {
            jsContent = f.contents;
          }
          const hashNum = jsContent.split('').reduce((h: number, c: string) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
          const hash = (hashNum >>> 0).toString(36).padStart(6, '0');

          // Write JS with hashed filename
          const jsFilename = 'index-' + hash + '.js';
          const jsPath = distDir + '/assets/' + jsFilename;
          self.sqliteFs!.mkdir(distDir + '/assets', { recursive: true });
          self.sqliteFs!.writeFile(jsPath, jsContent);
          ctx.stdout.write('  \x1b[2m' + outDir + '/assets/' + jsFilename + '\x1b[0m  ' + (jsContent.length / 1024).toFixed(2) + ' kB\n');

          // Collect all CSS files from src/
          let allCss = '';
          const collectCss = (dir: string) => {
            try {
              for (const e of self.sqliteFs!.readdir(dir)) {
                const fp = dir + '/' + e.name;
                if (e.type === 'directory') collectCss(fp);
                else if (e.name.endsWith('.css')) {
                  try { allCss += self.sqliteFs!.readFileString(fp) + '\n'; } catch {}
                }
              }
            } catch {}
          };
          collectCss(cwd + '/src');
          const cssFilename = 'index-' + hash + '.css';
          if (allCss.trim()) {
            self.sqliteFs!.writeFile(distDir + '/assets/' + cssFilename, allCss);
            ctx.stdout.write('  \x1b[2m' + outDir + '/assets/' + cssFilename + '\x1b[0m  ' + (allCss.length / 1024).toFixed(2) + ' kB\n');
          }

          // Generate dist/index.html
          if (origHtml) {
            let distHtml = origHtml;
            // Only remove importmap if ALL packages are bundled (no CDN needed)
            if (cdnPackages.length === 0) {
              distHtml = distHtml.replace(/<script\s+type=["']importmap["']>[\s\S]*?<\/script>\s*/i, '');
            }
            distHtml = distHtml
              .replace(/(<script[^>]*)\ssrc=["'][^"']+\.(?:tsx?|jsx?|mjs)["']/, '$1 src="/assets/' + jsFilename + '"')
              .replace(/<link[^>]*href=["'][^"']*\.css["'][^>]*\/?>/, '<link rel="stylesheet" crossorigin href="/assets/' + cssFilename + '">');
            self.sqliteFs!.writeFile(distDir + '/index.html', distHtml);
            ctx.stdout.write('  \x1b[2m' + outDir + '/index.html\x1b[0m  ' + (distHtml.length / 1024).toFixed(2) + ' kB\n');
            if (cdnPackages.length > 0) {
              ctx.stdout.write('  \x1b[33mNote: ' + cdnPackages.join(', ') + ' loaded from CDN (not bundled)\x1b[0m\n');
            }
          }

          ctx.stdout.write('\n\x1b[32m\u2713 built in ' + ((Date.now() - t0) / 1000).toFixed(2) + 's\x1b[0m\n');
          return 0;
        } catch (e: any) {
          ctx.stderr.write('Build error: ' + (e?.message || e) + '\n');
          return 1;
        }
      }

      // ── vite preview ──
      if (args[0] === 'preview') {
        ctx.stdout.write('Serving dist/ — open ' + self.viteBasePath + '/\n');
        const distRoot = cwd + '/' + (viteConfig.outDir || 'dist');
        if (!self.sqliteFs!.exists(distRoot)) {
          ctx.stderr.write('dist/ not found. Run vite build first.\n');
          return 1;
        }
        // Start vite on the dist directory
        if (!self.esbuildService) self.esbuildService = new EsbuildService(self.sqliteFs!);
        if (self.viteDevServer?.isRunning) self.viteDevServer.stop();
        const previewBasePath = self.viteBasePath;
        self.viteDevServer = new ViteDevServer({
          vfs: self.sqliteFs!, esbuild: self.esbuildService!, root: distRoot,
          onHmrMessage: () => {},
          sql: self.ctx.storage.sql,
          basePath: previewBasePath,
          env: self.env,
          ctx: self.ctx,
        });
        self.viteDevServer.start();
        try { await self.ctx.storage.put('vite-config', { root: distRoot, basePath: previewBasePath }); } catch {}
        ctx.stdout.write('Serving at ' + previewBasePath + '/\n');
        return 0;
      }

      // ── vite stop ──
      if (args[0] === 'stop') {
        let stopped = false;
        if (self.cirrusReal?.isRunning) {
          self.cirrusReal.stop();
          self.cirrusReal = null;
          stopped = true;
        }
        if (self.viteDevServer?.isRunning) {
          self.viteDevServer.stop();
          self.viteDevServer = null;
          try { await self.ctx.storage.delete('vite-config'); } catch {}
          stopped = true;
        }
        if (stopped) {
          ctx.stdout.write('\x1b[33mDev server stopped.\x1b[0m\n');
        } else {
          ctx.stdout.write('No dev server running.\n');
        }
        return 0;
      }

      // ── vite (default: dev server) ──
      let vfsRoot = cwd;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--root' && args[i + 1]) vfsRoot = args[i + 1].replace(/^\/+/, '');
      }
      if (viteConfig.root && viteConfig.root !== '.') {
        // Resolve relative root against cwd
        const configRoot = viteConfig.root.replace(/^\.\//, '');
        vfsRoot = configRoot.startsWith('/') ? configRoot : cwd + '/' + configRoot;
      }
      // Normalize: remove /., //, leading/trailing slashes
      vfsRoot = vfsRoot
        .replace(/\/\.\//g, '/')     // /./ → /
        .replace(/\/\.$/,  '')       // trailing /.
        .replace(/\/+/g,   '/')      // collapse //
        .replace(/^\/+/,   '')       // leading /
        .replace(/\/+$/,   '');      // trailing /

      // ── Preflight: node_modules guard ────────────────────────────────────
      // Direct `vite` invocation requires installed deps. Bail loudly BEFORE
      // spawning a dev server that would just serve broken modules and
      // confuse the user. --force / --no-install-check bypasses the check.
      const bypassInstallCheck = args.includes('--force') || args.includes('--no-install-check');
      if (!bypassInstallCheck) {
        const guard = checkNodeModulesGuard(self.sqliteFs!, vfsRoot);
        if (guard.missing) {
          ctx.stderr.write(
            '\x1b[31m\u2718\x1b[0m \x1b[1mnode_modules/ not found\x1b[0m' +
            (guard.depCount > 0 ? ` (${guard.depCount} dependencies declared)` : '') + '\n' +
            '  Run \x1b[36mnpm install\x1b[0m in ' + vfsRoot + ' first,\n' +
            '  or re-run with \x1b[36m--force\x1b[0m to skip this check.\n'
          );
          return 1;
        }
      }

      if (self.viteDevServer?.isRunning) self.viteDevServer.stop();

      // ── Real-vite mode (Phase 0 spike, opt-in) ─────────────────────────
      // NIMBUS_REAL_VITE=1 or `nimbusDevServer: 'real'` in vite.config.ts
      // routes the session through a dynamic-worker facet running the
      // real `vite` npm package. The in-process Cirrus shim is bypassed.
      //
      // This is EXPERIMENTAL and gated behind an explicit opt-in. Any
      // error here falls back to Cirrus by the user re-running without
      // the env flag — we do not silently fall back (fidelity over
      // magic).
      let realViteCfgSource: string | undefined;
      try {
        const p = [cwd + '/vite.config.ts', cwd + '/vite.config.js', cwd + '/vite.config.mjs']
          .find(p => self.sqliteFs!.exists(p));
        if (p) realViteCfgSource = self.sqliteFs!.readFileString(p);
      } catch {}
      const sessionEnv = (ctx && ctx.env) || {};
      const useReal = shouldUseRealVite({ env: sessionEnv, viteConfigSource: realViteCfgSource });
      if (useReal) {
        if (self.cirrusReal?.isRunning) self.cirrusReal.stop();
        // 5173 is Vite's default; under workerd it's a routing key, not
        // a real socket, so we reuse the same number per session.
        const vitePort = viteConfig.port || 5173;
        const previewBasePath = self.viteBasePath;

        // Acquire the heavy-alloc gate so the fire-and-forget pre-bundle
        // phase (still in flight on a fresh `npm install && npm run dev`)
        // pauses new dispatches while we allocate the cirrus-real boot
        // payload (user-vite-config esbuild bundle ~few MiB, plugin-react
        // bundle, syntheticCode string with snapshotFiles inlined ~few
        // MiB, LOADER.load worker bundle). With concurrent allocations
        // and a shared isolate (Mini-PRD: DO shared isolate issues), peak
        // pressure is what kills us — not steady-state. Released right
        // after cirrusReal.start() in a finally so a throw in the boot
        // path doesn't permanently pin the gate.
        const heavyAllocRelease = acquireHeavyAlloc();
        // Safety net: release the gate after a generous ceiling even
        // if the release path is bypassed by an unexpected control
        // flow (defensive — boot always reaches start() in well-tested
        // code paths today). Without this, a future regression that
        // exits the cirrus-real boot block without hitting our finally
        // would leave pre-bundle blocked for 30 s on every later
        // dispatch attempt — annoying but not fatal (waitForLowAllocPressure
        // has its own 30 s ceiling).
        const heavyAllocCeiling = setTimeout(() => heavyAllocRelease(), 60_000);

        // Pre-bundle the user's vite.config.ts if present. Must handle
        // plugin imports — @vitejs/plugin-react, vite-plugin-svgr, etc.
        // — which live in the project's node_modules. esbuild resolves
        // those against the VFS via our existing EsbuildService, then
        // emits an ESM string the facet imports as user-vite-config.js.
        let userConfigBundle: string | null = null;
        // Extra synthetic files to seed into the facet's fs snapshot.
        // Populated below when pre-bundling plugin-react — it does
        // fs.readFileSync(_require.resolve('./refreshUtils.js')) at
        // transform time and expects to find that file on disk.
        const extraSyntheticFiles: Record<string, string> = {};
        const cfgPath = [cwd + '/vite.config.ts', cwd + '/vite.config.js', cwd + '/vite.config.mjs']
          .find(p => self.sqliteFs!.exists(p));
        if (cfgPath) {
          try {
            if (!self.esbuildService) self.esbuildService = new EsbuildService(self.sqliteFs!);
            const bundleResult = await self.esbuildService.build([cfgPath], {
              bundle: true,
              format: 'esm',
              target: 'es2022',
              platform: 'neutral',
              // Path C externals:
              //   - vite: the facet provides vite-config-helper.js
              //     re-exporting the prebundled vite.bundle.js.
              //   - @vitejs/plugin-react: the facet provides a
              //     prebundled cirrus-plugin-react.js (built by
              //     scripts/bundle-plugin-react.mjs at build time;
              //     includes babel, react-refresh, inlined assets).
              //   - @vitejs/plugin-react/jsx-runtime: same bundle.
              // Any OTHER plugin the user imports (plugin-vue,
              // plugin-svgr, etc.) falls through to esbuild bundling,
              // which may or may not work depending on whether its
              // assets can be fully inlined.
              external: [
                'node:*', 'fs', 'path', 'url', 'util', 'os', 'crypto',
                'events', 'stream', 'buffer', 'module', 'perf_hooks',
                'esbuild', 'esbuild-wasm',
                'vite', 'vite/*',
                '@vitejs/plugin-react', '@vitejs/plugin-react/*',
              ],
              // Same synthetic import.meta.url hack as vite.bundle.js so
              // plugins that use `fileURLToPath(import.meta.url)` to find
              // their own install dir don't crash.
              define: {
                'import.meta.url': JSON.stringify('file:///user-vite-config.js'),
              },
              keepNames: true,
            });
            const out = bundleResult.outputFiles?.[0];
            if (out) {
              userConfigBundle = String(out.contents);
              // LOADER.load requires .js-suffixed specifiers. Externals
              // survive bundling as bare specifiers in the output; we
              // rewrite them to .js-suffixed paths pointing at the
              // facets helper modules.
              userConfigBundle = userConfigBundle.replace(
                /from\s*["']vite["']/g,
                'from "./vite-config-helper.js"',
              );
              userConfigBundle = userConfigBundle.replace(
                /from\s*["']vite\/(.+?)["']/g,
                'from "./vite-config-helper.js"',
              );
              userConfigBundle = userConfigBundle.replace(
                /from\s*["']@vitejs\/plugin-react["']/g,
                'from "./cirrus-plugin-react.js"',
              );
              userConfigBundle = userConfigBundle.replace(
                /from\s*["']@vitejs\/plugin-react\/(.+?)["']/g,
                'from "./cirrus-plugin-react.js"',
              );
              // Path C eliminates the need for userspaceRequire /
              // createRequire / node:fs rewrites in the user-config
              // bundle — the heavy lifting moved into the
              // prebundled @vitejs/plugin-react. Left as-is in case
              // other plugins the user adds still need them.
              userConfigBundle = userConfigBundle.replace(
                /\bimport\(\s*(["'][^"']+["'])\s*\)/g,
                (_, spec) =>
                  `Promise.resolve().then(() => {` +
                  ` const m = globalThis.__cirrusRealUserspaceRequire?.(${spec});` +
                  ` if (!m) throw new Error('[cirrus-real] dynamic import failed for ' + ${spec});` +
                  ` return { default: m.default ?? m, ...(typeof m === 'object' ? m : {}) };` +
                  ` })`,
              );
              userConfigBundle = userConfigBundle.replace(
                /\bcreateRequire\(/g,
                '(globalThis.__cirrusNodeCreateRequire || createRequire)(',
              );
              userConfigBundle = userConfigBundle.replace(
                /from\s*["']node:fs["']/g,
                'from "./cirrus-fs.js"',
              );
              userConfigBundle = userConfigBundle.replace(
                /from\s*["']node:fs\/promises["']/g,
                'from "./cirrus-fs-promises.js"',
              );
              if (bundleResult.errors?.length) {
                console.warn('[vite-cmd] esbuild bundle errors:', bundleResult.errors);
              }
            } else {
              console.warn('[vite-cmd] esbuild.build produced no output');
            }
          } catch (e: any) {
            ctx.stderr.write('\x1b[33m!\x1b[0m vite.config bundling failed: ' + (e?.message || e) + '\n');
            ctx.stderr.write('  Real-vite will run with default config.\n');
          }
        }

        self.cirrusReal = new CirrusReal({
          env: self.env,
          port: vitePort,
          root: vfsRoot,
          basePath: previewBasePath,
          vfs: self.sqliteFs!,
          vfsEvents: self.sqliteFs!.events,
          userConfigBundle,
          extraSyntheticFiles,
        });
        // Reserve a PID so `ps`/logs show it like any other facet.
        const entry = self.processTable.spawn('vite (real, ' + vfsRoot + ')', [], vfsRoot);
        try {
          self.cirrusReal.start(self.ctx, entry.pid);
        } finally {
          // Cirrus-real boot allocation done (or threw). Pre-bundle is
          // free to resume. If start() threw, the gate must still
          // release so a future retry doesn't deadlock pre-bundle.
          clearTimeout(heavyAllocCeiling);
          heavyAllocRelease();
        }

        // ── Boot banner (§4.3 of PHASE2-REAL-VITE-PLAN.md) ──────
        const snap = (self.cirrusReal.stats as any).snapshot;
        ctx.stdout.write('\n\x1b[1;36m  Nimbus: real-vite mode\x1b[0m \x1b[2m(experimental, Phase 1-4)\x1b[0m\n\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Preview:    \x1b[36m' + previewBasePath + '/\x1b[0m\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Vite:       ' + (self.cirrusReal.stats as any).viteVersion + ' (bundled)\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Root:       ' + vfsRoot + '\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Port:       ' + vitePort + ' \x1b[2m(virtual routing key)\x1b[0m\n');
        if (snap) {
          const kb = (snap.totalBytes / 1024).toFixed(1);
          const pkgJson = (snap as any).packageJsonCount;
          ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Snapshot:   ' + snap.fileCount + ' files / ' +
            kb + ' KB ' +
            (pkgJson ? '\x1b[2m(incl. ' + pkgJson + ' package.json, rest lazy)\x1b[0m' : '') + '\n');
        }
        if (userConfigBundle) {
          ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Config:     ' + cfgPath + ' \x1b[2m(' +
            (userConfigBundle.length / 1024).toFixed(0) + ' KB bundled)\x1b[0m\n');
        }
        ctx.stdout.write('\n  \x1b[2mWorks:\x1b[0m @vitejs/plugin-react, JSX/TSX transforms, SPA fallback, HMR.\n');
        ctx.stdout.write('  \x1b[2mPartial:\x1b[0m other plugins (Babel-family generally OK; SWC/Rolldown blocked).\n');
        ctx.stdout.write('  \x1b[2mBlocked:\x1b[0m vite build (rolldown needs node:wasi). Use cirrus for build.\n');
        ctx.stdout.write('\n  \x1b[2mRun \x1b[0mvite stop\x1b[2m, or \x1b[0mNIMBUS_REAL_VITE=0 vite\x1b[2m for Cirrus.\x1b[0m\n\n');
        return 0;
      }

      // Parse define config from vite.config.ts (e.g. define: { global: "globalThis" })
      let viteDefine: Record<string, string> | undefined;
      try {
        const cfgPath = [cwd + '/vite.config.ts', cwd + '/vite.config.js', cwd + '/vite.config.mjs']
          .find(p => self.sqliteFs!.exists(p));
        if (cfgPath) {
          let cfgCode = self.sqliteFs!.readFileString(cfgPath);
          if (cfgPath.endsWith('.ts')) {
            const t = await self.esbuildService!.transform(cfgCode, { loader: 'ts', format: 'esm' });
            cfgCode = t.code;
          }
          const defineMatch = cfgCode.match(/define\s*:\s*\{([^}]+)\}/);
          if (defineMatch) {
            viteDefine = {};
            const entries = defineMatch[1].matchAll(/["']?([^"',:\s]+)["']?\s*:\s*["']([^"']+)["']/g);
            for (const e of entries) viteDefine[e[1]] = e[2];
          }
        }
      } catch {}

      if (!self.esbuildService) self.esbuildService = new EsbuildService(self.sqliteFs!);
      const previewBasePath = self.viteBasePath;
      self.viteDevServer = new ViteDevServer({
        vfs: self.sqliteFs!,
        esbuild: self.esbuildService!,
        root: vfsRoot,
        aliases: viteConfig.alias,
        define: viteDefine,
        onHmrMessage: (msg) => {
          if (self.terminal) try { self.terminal!.ws.send(JSON.stringify({ type: 'hmr', data: msg })); } catch {}
        },
        sql: self.ctx.storage.sql,
        injectBasename: viteConfig.injectBasename,
        basePath: previewBasePath,
        env: self.env,
        ctx: self.ctx,
      });
      self.viteDevServer.start();
      try { await self.ctx.storage.put('vite-config', { root: vfsRoot, aliases: viteConfig.alias, define: viteDefine, injectBasename: viteConfig.injectBasename, basePath: previewBasePath }); } catch {}

      ctx.stdout.write('\n\x1b[1;36m  Nimbus Vite Dev Server v2.0\x1b[0m\n\n');
      ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Preview:    \x1b[36m' + previewBasePath + '/\x1b[0m\n');
      ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Root:       ' + vfsRoot + '\n');
      if (viteConfig.port) ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Port:       ' + viteConfig.port + '\n');
      ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Transforms: .ts .tsx .jsx (React JSX automatic)\n');
      if (viteConfig.alias) ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Aliases:    ' + Object.keys(viteConfig.alias).join(', ') + '\n');
      if (viteDefine) ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Define:     ' + Object.keys(viteDefine).join(', ') + '\n');
      const twCfg = [vfsRoot + '/tailwind.config.js', vfsRoot + '/tailwind.config.ts'].find(p => self.sqliteFs!.exists(p));
      if (twCfg) ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Tailwind:   edge-vendored Play CDN \x1b[2m(detected)\x1b[0m\n');
      ctx.stdout.write('\n  \x1b[2mRun \x1b[0mvite stop\x1b[2m to stop.\x1b[0m\n\n');
      return 0;
    });

    // ── nimbus-wrangler / wrangler command: Worker dev server ─────────────
    //
    // `wrangler` is registered as a transparent alias for `nimbus-wrangler`
    // so projects with `"dev": "wrangler dev"` in package.json Just Work.
    // The shared handler below takes an extra `invokedAs` flag so we can
    // - print a one-shot "DO-in-DO mode" banner on the first wrangler
    //   invocation per session (so users know they're getting a compat
    //   layer, not real wrangler)
    // - silently strip wrangler-specific flags (--ip, --port, etc.) that
    //   have no meaning inside a DO.
    const wranglerHandler = (invokedAs: 'wrangler' | 'nimbus-wrangler') =>
      async (ctx: any): Promise<number> => {
        const rawArgs: string[] = ctx.args || [];

        // Filter wrangler-only flags early (works for both invocation paths;
        // a no-op for nimbus-wrangler since it doesn't accept them anyway).
        const { args, ignored } = filterWranglerFlags(rawArgs);

        if (args.includes('--help') || args.includes('-h') || args.length === 0) {
          ctx.stdout.write(`Usage: ${invokedAs} dev [options]\n\n`);
          ctx.stdout.write('Run your Cloudflare Worker locally on the actual CF runtime\n');
          ctx.stdout.write('(DO-in-DO via env.LOADER — workerd in a workerd).\n\n');
          ctx.stdout.write('Commands:\n');
          ctx.stdout.write('  dev           Start the dev server\n');
          ctx.stdout.write('  stop          Stop the dev server\n\n');
          ctx.stdout.write('Options:\n');
          ctx.stdout.write('  --root <dir>  Project root (default: cwd)\n\n');
          if (invokedAs === 'wrangler') {
            ctx.stdout.write('Note: \x1b[2minside Nimbus, `wrangler` is an alias for\x1b[0m \x1b[36mnimbus-wrangler\x1b[0m.\n');
            ctx.stdout.write('Most real-wrangler flags (--ip, --port, --local, --log-level, ...)\n');
            ctx.stdout.write('are silently ignored because the DO provides its own routing.\n');
          }
          return 0;
        }

        if (args[0] === 'stop') {
          if (self.nimbusWrangler?.isRunning) {
            self.nimbusWrangler.stop();
            ctx.stdout.write('\x1b[33mWorker dev server stopped.\x1b[0m\n');
          } else {
            ctx.stdout.write('No Worker dev server running.\n');
          }
          return 0;
        }

        if (args[0] !== 'dev') {
          ctx.stderr.write(
            `Unknown command: ${args[0]}. Use "${invokedAs} dev" or "${invokedAs} --help".\n`,
          );
          return 1;
        }

        // First-run banner — only when invoked as `wrangler`, and only once
        // per session. Makes it OBVIOUS to the user that they're not running
        // real wrangler, and that Nimbus is doing something different.
        if (invokedAs === 'wrangler' && !self.wranglerAliasBannerShown) {
          ctx.stdout.write(
            '\x1b[2m\u2388  wrangler (Nimbus DO-in-DO mode) — bundling via esbuild-wasm, running via env.LOADER\x1b[0m\n',
          );
          self.wranglerAliasBannerShown = true;
        }

        // Report ignored flags (also one-shot — if user sees it once per
        // session that's enough to spot a typo; no need to spam on rebuilds).
        if (ignored.length > 0 && invokedAs === 'wrangler') {
          ctx.stdout.write(
            '\x1b[2m   ignored wrangler flags: ' + ignored.join(' ') + '\x1b[0m\n',
          );
        }

        // Lazy-init esbuild
        if (!self.esbuildService) {
          self.ensureSqliteFs();
          self.esbuildService = new EsbuildService(self.sqliteFs!);
        }

        // Parse --root flag; default to the shell cwd so `npm run dev` from
        // a project directory picks up that project's wrangler.jsonc.
        let root = ctx.cwd || '/home/user';
        for (let i = 1; i < args.length; i++) {
          if (args[i] === '--root' && args[i + 1]) root = args[i + 1];
        }

        // Stop existing
        if (self.nimbusWrangler?.isRunning) self.nimbusWrangler.stop();

        const vfsRoot = root.replace(/^\/+/, '');

        // Pre-flight: read the wrangler config ourselves and call out any
        // binding fields nimbus-wrangler can't provide. NimbusWrangler will
        // still try to bundle + load, but user sees up-front why their
        // Worker may fail when it tries to access a missing binding.
        const unsupportedFields = detectUnsupportedWranglerConfig(self.sqliteFs!, vfsRoot);

        ctx.stdout.write('\n');
        ctx.stdout.write('\x1b[1;35m  ' + (invokedAs === 'wrangler' ? 'Wrangler' : 'Nimbus Wrangler') + ' Dev\x1b[0m\n\n');

        if (unsupportedFields.length > 0) {
          ctx.stderr.write(
            '\x1b[33m\u26A0\x1b[0m  \x1b[1mNimbus-incompatible wrangler.jsonc fields detected:\x1b[0m\n',
          );
          for (const f of unsupportedFields) {
            ctx.stderr.write('   - \x1b[33m' + f + '\x1b[0m\n');
          }
          ctx.stderr.write(
            '   These bindings are NOT provisioned inside nimbus-wrangler. Your Worker\n' +
            '   will get \x1b[2mundefined\x1b[0m when it tries to access them, which typically\n' +
            '   causes a runtime TypeError. The bundle will still build and load.\n' +
            '   \x1b[2mDeploy with real wrangler to get the real bindings.\x1b[0m\n\n',
          );
        }

        self.nimbusWrangler = new NimbusWrangler({
          vfs: self.sqliteFs!,
          esbuild: self.esbuildService!,
          env: self.env,
          // Supervisor DO ctx — required for ctx.facets.get() when
          // synthesizing durable_objects bindings on the inner Worker.
          ctx: self.ctx,
          root: vfsRoot,
          onLog: (msg) => {
            if (self.terminal) {
              try { self.terminal.write(msg); } catch {}
            }
          },
          onHmrMessage: (msg) => {
            if (self.terminal) {
              try { self.terminal.ws.send(JSON.stringify({ type: 'hmr', data: msg })); } catch {}
            }
          },
        });

        const ok = await self.nimbusWrangler.start();
        if (!ok) {
          ctx.stderr.write('  \x1b[31mFailed to start Worker dev server.\x1b[0m\n');
          return 1;
        }

        const cfg = self.nimbusWrangler.stats;
        const workerBase = (self.sessionBasePath || '') + '/worker';
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Worker:   \x1b[36m' + workerBase + '/\x1b[0m\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Name:     ' + cfg.name + '\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Entry:    ' + cfg.main + '\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Root:     ' + cfg.root + '\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Reload:   on file change\n\n');
        ctx.stdout.write('  \x1b[2mRun \x1b[0m' + invokedAs + ' stop\x1b[2m to stop.\x1b[0m\n\n');
        return 0;
      };

    registry.register('nimbus-wrangler', wranglerHandler('nimbus-wrangler'));
    registry.register('wrangler', wranglerHandler('wrangler'));

    // ── npm-fast command: parallel npm install (v2 — batched writes) ────
    registry.register('npm-fast', async (ctx: any) => {
      const args: string[] = ctx.args || [];

      if (args.includes('--help') || args.includes('-h') || args.length === 0) {
        ctx.stdout.write('Usage: npm-fast install <packages...>\n\n');
        ctx.stdout.write('Nimbus npm v2 — batched VFS writes, content-addressed cache.\n');
        ctx.stdout.write('Handles 100+ dependency projects without crashing.\n');
        return 0;
      }

      if (args[0] !== 'install' && args[0] !== 'i') {
        ctx.stderr.write('Only "npm-fast install" is supported. Use "npm" for other commands.\n');
        return 1;
      }

      const packages = args.slice(1).filter((a: string) => !a.startsWith('-'));
      if (packages.length === 0) {
        ctx.stderr.write('Specify packages to install: npm-fast install react react-dom\n');
        return 1;
      }

      self.ensureSqliteFs();
      const cwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');

      // Ensure package.json exists
      const pkgJsonPath = cwd + '/package.json';
      if (!self.sqliteFs!.exists(pkgJsonPath)) {
        self.sqliteFs!.writeFile(pkgJsonPath, '{"name":"project","version":"1.0.0","dependencies":{}}\n');
      }

      ctx.stdout.write('\x1b[36mNimbus npm v2 (batched writes)\x1b[0m\n');

      self.ensureNpmInstaller((msg: string) => {
        ctx.stdout.write('[npm] ' + msg + '\n');
      });
      const result = await self.npmInstaller!.install(cwd, { packages });

      if (result.failed.length > 0) {
        ctx.stderr.write('\x1b[31mFailed: ' + result.failed.join(', ') + '\x1b[0m\n');
      }

      ctx.stdout.write(
        `\n\x1b[32madded ${result.installed.length} packages (${result.totalFiles} files) in ${(result.elapsed / 1000).toFixed(1)}s\x1b[0m\n`
      );
      if (result.cachedHits > 0) {
        ctx.stdout.write(`\x1b[2m  (${result.cachedHits} from cache)\x1b[0m\n`);
      }
      return result.failed.length > 0 ? 1 : 0;
    });

    // ── Set up environment ──
    const env: Record<string, string> = {
      HOME: '/home/user',
      USER: 'user',
      SHELL: '/bin/sh',
      HOSTNAME: DEFAULT_HOSTNAME,
      TERM: 'xterm-256color',
      PWD: '/home/user',
      PATH: '/usr/local/bin:/usr/bin:/bin:/home/user/.local/bin',
      PS1: `\x1b[1;32muser@${DEFAULT_HOSTNAME}\x1b[0m:\x1b[1;34m\\w\x1b[0m$ `,
      NODE_ENV: 'development',
      LANG: 'en_US.UTF-8',
      EDITOR: 'nano',
      NIMBUS_VERSION: NIMBUS_VERSION,
      TMPDIR: '/tmp',
      XDG_CONFIG_HOME: '/home/user/.config',
      XDG_DATA_HOME: '/home/user/.local/share',
      npm_config_prefix: '/usr/local',
    };

    // ── Create shell ──
    const processRegistry = new ProcessRegistry();
    this.shell = new Shell(this.terminal, this.kernel.vfs, registry, env, processRegistry);

    // ── Heredoc support (<<) — all logic lives in shell-features.ts ──
    HeredocHandler.install(this.shell, this.terminal, this.sqliteFs!);

    // ── Wire npm/npx with shellExecute ──
    const shell = this.shell;
    const shellExecute = async (cmd: string, cmdCtx: any): Promise<number> => {
      const result = await shell.execute(cmd, {
        cwd: cmdCtx.cwd,
        env: cmdCtx.env,
        onStdout: (d: string) => cmdCtx.stdout.write(d),
        onStderr: (d: string) => cmdCtx.stderr.write(d),
      });
      return result.exitCode;
    };

    // ── Fix 3: tracked shell.execute — wires output into processTable +
    //   ProcessLogStore so scripts that bypass the facet pipeline (like
    //   npm-run fallthrough) still show up in `ps`, `logs`, and exit
    //   dumps. Mirrors the instrumentation `_rpcStdout` / `_rpcStderr`
    //   already provide for facet processes.
    //
    //   Also honours the `longRunning` flag: pass `longRunning=true` for
    //   npm run dev / start so the `[started (long-running): pid=N ...]`
    //   banner matches the existing facet UX.
    //   Note: `self` is declared earlier in this method (line ~1359).
    const shellExecuteTracked = async (
      cmd: string,
      cmdCtx: any,
      opts: { longRunning?: boolean } = {},
    ): Promise<number> => {
      const argv = cmd.split(/\s+/).filter(Boolean);
      const entry = self.processTable.spawn(cmd, argv, cmdCtx.cwd || '/home/user');
      const pid = entry.pid;
      const startedAt = Date.now();

      // Spawn banner — matches facet-manager.ts onSpawn format.
      if (self.terminal) {
        const label = opts.longRunning ? 'started (long-running)' : 'started';
        self.terminal.write(
          `\x1b[2m[shell ${label}: pid=${pid} cmd="${cmd}"]\x1b[0m\r\n`,
        );
      }
      // Structured spawn event for the tabs UI (mirrors the facet-manager
      // onSpawn hook). Long-running shell commands like `vite` and
      // `wrangler dev` trigger auto-open of a log tab.
      notifyTerminalEvent(self.terminal, {
        type: 'spawn', pid, command: cmd, longRunning: !!opts.longRunning,
      });

      // Wrap the caller-supplied streams so every chunk is both displayed
      // AND captured in the ring buffer keyed by this PID.
      const tee = (stream: 'stdout' | 'stderr', target: { write: (d: string) => void }) => (d: string) => {
        try { self.processLogs.append(pid, stream, String(d)); } catch {}
        try { target.write(d); } catch {}
      };

      let exitCode = 1;
      try {
        const result = await shell.execute(cmd, {
          cwd: cmdCtx.cwd,
          env: cmdCtx.env,
          onStdout: tee('stdout', cmdCtx.stdout),
          onStderr: tee('stderr', cmdCtx.stderr),
        });
        exitCode = result.exitCode;
      } catch (e: any) {
        // Surface the error in the terminal AND the ring buffer — the
        // whole reason this path exists is to stop silent failures.
        const msg = (e && (e.stack || e.message)) || String(e);
        tee('stderr', cmdCtx.stderr)('shellExecuteTracked error: ' + msg + '\n');
        exitCode = 1;
      } finally {
        try { self.processTable.exit(pid, exitCode); } catch {}
        try {
          if (!self.processLogs.getExit(pid)) {
            self.processLogs.markExit(pid, exitCode);
          }
        } catch {}

        // Structured exit for the tabs UI. Always fires (the UI doesn't
        // know which tabs are open, and client-side dedupe is trivial).
        // Include the command so the UI can backfill a tab for pids it
        // never saw a spawn event for (e.g. evals routed past onSpawn).
        notifyTerminalEvent(self.terminal, { type: 'exit', pid, code: exitCode, command: cmd });

        // Fix 5 trace + Fix 4 dump both read this state; invoke the
        // session helper so semantics stay in one place.
        try { self._emitShellExecDone(pid, cmd, exitCode, Date.now() - startedAt); } catch {}
      }
      return exitCode;
    };
    // Register core npm with enhanced `npm run <script>` support
    const coreNpmCmd = createNpmCommand(registry, shellExecute, kernel);
    registry.register('npm', async (ctx: any) => {
      const args: string[] = ctx.args || [];
      const sub = args[0];

      // npm run <script> / npm test / npm start — parse package.json and execute
      if (sub === 'run' || sub === 'run-script' || sub === 'test' || sub === 'start') {
        const scriptName = sub === 'test' ? 'test' : sub === 'start' ? 'start' : args[1];
        if (!scriptName) {
          // npm run (no script) — list available scripts
          const pkgPath = (ctx.cwd || '/home/user').replace(/^\/+/, '') + '/package.json';
          try {
            const pkg = JSON.parse(sqliteFs.readFileString(pkgPath));
            if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
              ctx.stdout.write('Lifecycle scripts:\n');
              for (const [name, cmd] of Object.entries(pkg.scripts)) {
                ctx.stdout.write(`  ${name}\n    ${cmd}\n`);
              }
            } else {
              ctx.stdout.write('No scripts found in package.json\n');
            }
          } catch { ctx.stderr.write('npm ERR! no package.json found\n'); return 1; }
          return 0;
        }

        const pkgPath = (ctx.cwd || '/home/user').replace(/^\/+/, '') + '/package.json';
        try {
          const pkg = JSON.parse(sqliteFs.readFileString(pkgPath));
          const script = pkg.scripts?.[scriptName];
          if (!script) {
            ctx.stderr.write(`npm ERR! Missing script: "${scriptName}"\n`);
            if (pkg.scripts) {
              ctx.stderr.write('npm ERR! Available scripts:\n');
              for (const name of Object.keys(pkg.scripts)) ctx.stderr.write(`  - ${name}\n`);
            }
            return 1;
          }

          // ── node_modules preflight ────────────────────────────────────
          // If the script invokes a known bundler/framework CLI (vite, next,
          // webpack, tsc, ...) and node_modules is missing, HARD-FAIL before
          // running it — the tool would crash with a cryptic "command not
          // found" / "cannot find package" error that's less helpful.
          // For custom/unknown scripts (e.g. `echo hi`), emit a warning but
          // continue — the user's intent might not need deps at all.
          // Bypass with --force / --no-install-check in the script args, or
          // by setting NIMBUS_SKIP_INSTALL_CHECK=1 in env.
          const scriptArgs = args.slice(sub === 'run' || sub === 'run-script' ? 2 : 1);
          const bypassRunCheck =
            scriptArgs.includes('--force') ||
            scriptArgs.includes('--no-install-check') ||
            ctx.env?.NIMBUS_SKIP_INSTALL_CHECK === '1';
          if (!bypassRunCheck) {
            const projDir = (ctx.cwd || '/home/user').replace(/^\/+/, '');
            const guard = checkNodeModulesGuard(sqliteFs, projDir);
            if (guard.missing) {
              const bundler = detectBundlerBin(script);
              if (bundler) {
                // Hard fail: script needs a bundler binary that lives in node_modules/.bin.
                ctx.stderr.write(
                  '\x1b[31m\u2718\x1b[0m \x1b[1mnode_modules/ not found\x1b[0m — ' +
                  `script "${scriptName}" runs \x1b[36m${bundler}\x1b[0m which needs installed dependencies ` +
                  `(${guard.depCount} declared).\n` +
                  '  Run \x1b[36mnpm install\x1b[0m first,\n' +
                  '  or re-run with \x1b[36mnpm run ' + scriptName + ' -- --force\x1b[0m to skip this check.\n'
                );
                return 1;
              }
              // Soft warning: script might not need deps; let it try.
              ctx.stderr.write(
                '\x1b[33m\u26A0\x1b[0m  node_modules/ not found (' + guard.depCount + ' deps declared) — ' +
                'proceeding anyway. Run \x1b[36mnpm install\x1b[0m if the script fails.\n\n'
              );
            }
          }

          ctx.stdout.write(`\n> ${pkg.name || 'project'}@${pkg.version || '1.0.0'} ${scriptName}\n`);
          ctx.stdout.write(`> ${script}\n\n`);

          // ── Shell-composite detection ──────────────────────────────────
          // Scripts like `cd packages/cf-backend && vite dev` or
          // `NODE_ENV=prod node build.js | tee log` need the full shell
          // parser (operators, builtins like cd/export, pipes, redirects,
          // env-var prefixes, globs, heredocs). The naive whitespace split
          // below can only handle a single bare command — for anything
          // else it mis-identifies the first token (e.g. "cd") as the
          // command name, fails to resolve it in the registry, and emits
          // a misleading "cd: command not found".
          //
          // `shellExecuteTracked` routes through `shell.execute` which
          // IS the full shell (same path as interactive terminal input),
          // so composite scripts behave identically to typing them at
          // the prompt.
          //
          // Metacharacters checked:
          //   &&  ||  |  ;           operator chains + pipes
          //   > <                    redirects (covers >> and <<)
          //   ` $(                   command substitution
          //   ^NAME=                 leading env-var prefix (VAR=x cmd)
          // Single-command scripts (no metacharacters) still take the
          // fast registry path below for better stdout wiring + clearer
          // "unsupported" / "command not found" messages.
          const scriptTrim = script.trim();
          const hasShellMeta =
            /(\&\&|\|\||[|;<>`]|\$\()/.test(scriptTrim) ||
            /^[A-Za-z_][A-Za-z0-9_]*=/.test(scriptTrim);
          if (hasShellMeta) {
            const longRunningComposite =
              scriptName === 'dev' || scriptName === 'start' ||
              scriptName === 'serve' || scriptName === 'watch';
            return await shellExecuteTracked(scriptTrim, {
              ...ctx,
              env: {
                ...ctx.env,
                npm_lifecycle_event: scriptName,
                npm_package_name: pkg.name || '',
              },
            }, { longRunning: longRunningComposite });
          }

          // Parse script into command + args (single-command fast path).
          const scriptParts = scriptTrim.split(/\s+/);
          const cmdName = scriptParts[0];
          const cmdArgs = scriptParts.slice(1);
          // Try to resolve via registry — same path as direct terminal input
          const resolved = await registry.resolve(cmdName);
          if (resolved) {
            // Call with the SAME ctx (stdout wired to terminal)
            return await resolved({
              ...ctx,
              args: cmdArgs,
              env: { ...ctx.env, npm_lifecycle_event: scriptName, npm_package_name: pkg.name || '' },
            });
          }

          // ── Fix 1: deterministic "unsupported command" hint ────────────
          // A command not registered in the shell (and therefore about to
          // fall through to `shell.execute`, whose "command not found"
          // message silently vanishes into a buffered string) typically
          // means one of:
          //   a) The project expects a tool like `wrangler` that Nimbus
          //      skips during `npm install` (see SKIP_PACKAGES in
          //      src/npm-resolver.ts). There may be a `.bin` shim if the
          //      user installed it manually, but it tries to spawn workerd
          //      via `child_process.spawn` which isn't available in a DO
          //      isolate. Running it just hangs or crashes silently.
          //   b) The project uses a genuinely unknown command. Surface
          //      that too so the user sees SOMETHING rather than a silent
          //      prompt.
          const projDirForBin = (ctx.cwd || '/home/user').replace(/^\/+/, '');
          const binShimPath = projDirForBin + '/node_modules/.bin/' + cmdName;
          const hasBinShim = sqliteFs.exists(binShimPath);
          const unsupported = NIMBUS_UNSUPPORTED_BINS[cmdName];
          if (unsupported) {
            ctx.stderr.write(
              '\x1b[31m\u2718\x1b[0m \x1b[1m' + cmdName + '\x1b[0m is not supported inside Nimbus.\n' +
              '  ' + unsupported.reason + '\n' +
              (unsupported.alternative
                ? '  \x1b[2mTry:\x1b[0m \x1b[36m' + unsupported.alternative + '\x1b[0m\n'
                : '') +
              (hasBinShim
                ? '  \x1b[2m(Found node_modules/.bin/' + cmdName + ' — it installed, but it cannot run here.)\x1b[0m\n'
                : '')
            );
            return 127;
          }
          // Known POSIX shell builtins are handled by shell.execute, not
          // by Nimbus's command registry or by node_modules/.bin shims.
          // A single-command script like `cd target-dir` (degenerate but
          // occasionally seen) or `true` / `:` (exit-0 no-op placeholders)
          // would otherwise trip the "command not found" branch below
          // with a misleading "not a built-in Nimbus command" message.
          // Route them through shellExecuteTracked so the shell's own
          // builtin handler runs.
          const SHELL_BUILTINS = new Set([
            'cd', 'export', 'unset', 'set', 'source', '.', 'alias',
            'unalias', 'eval', 'exec', 'exit', 'return', 'shift',
            'pwd', 'read', 'true', 'false', ':', 'test', '[',
          ]);
          if (SHELL_BUILTINS.has(cmdName)) {
            const longRunningBuiltin =
              scriptName === 'dev' || scriptName === 'start' ||
              scriptName === 'serve' || scriptName === 'watch';
            return await shellExecuteTracked(scriptTrim, {
              ...ctx,
              env: {
                ...ctx.env,
                npm_lifecycle_event: scriptName,
                npm_package_name: pkg.name || '',
              },
            }, { longRunning: longRunningBuiltin });
          }
          if (!hasBinShim) {
            // Command not registered, no bin shim, not a shell builtin.
            // Tell the user explicitly.
            ctx.stderr.write(
              '\x1b[31m\u2718\x1b[0m \x1b[1m' + cmdName + ': command not found\x1b[0m\n' +
              '  Script "' + scriptName + '" wants to run: \x1b[36m' + script + '\x1b[0m\n' +
              '  "' + cmdName + '" is not a built-in Nimbus command and no\n' +
              '  \x1b[2mnode_modules/.bin/' + cmdName + '\x1b[0m shim was found.\n' +
              '  Check your package.json scripts or install the missing package.\n'
            );
            return 127;
          }

          // Has a .bin shim (shell.execute would try to exec it via the
          // PATH-lookup in @lifo-sh/core). Route through shellExecuteTracked
          // so stdout/stderr land in the terminal AND the ring buffer, AND
          // the process shows up in `ps`/`logs` for post-mortem. Long-
          // running flag is set for dev/start scripts so the banner reads
          // "started (long-running)" and exit dumps always fire (Fix 4).
          const longRunning = scriptName === 'dev' || scriptName === 'start' ||
                              scriptName === 'serve' || scriptName === 'watch';
          return await shellExecuteTracked(script, {
            ...ctx,
            env: { ...ctx.env, npm_lifecycle_event: scriptName, npm_package_name: pkg.name || '' },
          }, { longRunning });
        } catch (e: any) {
          ctx.stderr.write(`npm ERR! ${e?.message || e}\n`);
          return 1;
        }
      }

      // npm ls — list installed packages
      if (sub === 'ls' || sub === 'list') {
        const pkgPath = (ctx.cwd || '/home/user').replace(/^\/+/, '') + '/package.json';
        const nmDir = (ctx.cwd || '/home/user').replace(/^\/+/, '') + '/node_modules';
        try {
          const pkg = JSON.parse(sqliteFs.readFileString(pkgPath));
          ctx.stdout.write(`${pkg.name || 'project'}@${pkg.version || '1.0.0'} ${ctx.cwd}\n`);
          const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
          const names = Object.keys(deps);
          for (let i = 0; i < names.length; i++) {
            const isLast = i === names.length - 1;
            const prefix = isLast ? '└── ' : '├── ';
            const name = names[i];
            let version = deps[name];
            // Try to read actual installed version
            try {
              const installed = JSON.parse(sqliteFs.readFileString(nmDir + '/' + name + '/package.json'));
              version = installed.version;
            } catch {}
            ctx.stdout.write(`${prefix}${name}@${version}\n`);
          }
        } catch { ctx.stderr.write('npm ERR! no package.json found\n'); return 1; }
        return 0;
      }

      // npm init / npm init -y
      if (sub === 'init') {
        const cwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');
        const pkgPath = cwd + '/package.json';
        if (sqliteFs.exists(pkgPath) && !args.includes('-y') && !args.includes('--yes')) {
          ctx.stderr.write('package.json already exists. Use -y to overwrite.\n');
          return 1;
        }
        const name = cwd.split('/').pop() || 'project';
        const pkg = {
          name, version: '1.0.0', description: '', main: 'index.js',
          type: 'module',
          scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview', test: 'echo "no test"' },
          keywords: [], author: '', license: 'MIT', dependencies: {}, devDependencies: {},
        };
        sqliteFs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
        ctx.stdout.write('Wrote to ' + pkgPath + '\n');
        return 0;
      }

      // npm uninstall <pkg>
      if (sub === 'uninstall' || sub === 'un' || sub === 'remove' || sub === 'rm') {
        const packages = args.slice(1).filter(a => !a.startsWith('-'));
        if (packages.length === 0) { ctx.stderr.write('Usage: npm uninstall <pkg>\n'); return 1; }
        const cwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');
        const nmDir = cwd + '/node_modules';
        for (const pkg of packages) {
          const pkgDir = nmDir + '/' + pkg;
          // Recursively delete package directory
          const deleteRecursive = (dir: string) => {
            try {
              for (const e of sqliteFs.readdir(dir)) {
                const fp = dir + '/' + e.name;
                if (e.type === 'directory') deleteRecursive(fp);
                else try { sqliteFs.unlink(fp); } catch {}
              }
              try { sqliteFs.rmdir(dir); } catch {}
            } catch {}
          };
          deleteRecursive(pkgDir);
          ctx.stdout.write('removed ' + pkg + '\n');
        }
        // Update package.json
        const pkgPath = cwd + '/package.json';
        try {
          const pkgJson = JSON.parse(sqliteFs.readFileString(pkgPath));
          for (const pkg of packages) {
            delete pkgJson.dependencies?.[pkg];
            delete pkgJson.devDependencies?.[pkg];
          }
          sqliteFs.writeFile(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n');
        } catch {}
        return 0;
      }

      // npm install (no args or with packages) — use NpmInstaller v2 (batched writes)
      if (sub === 'install' || sub === 'i' || sub === 'add') {
        const explicitPkgs = args.slice(1).filter((a: string) => !a.startsWith('-'));
        self.ensureSqliteFs();
        const installCwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');

        // Ensure package.json exists for bare `npm install`
        if (explicitPkgs.length === 0) {
          const pkgJsonPath = installCwd + '/package.json';
          if (!sqliteFs.exists(pkgJsonPath)) {
            ctx.stderr.write('npm ERR! no package.json found\n');
            return 1;
          }
        }

        const pkgLabel = explicitPkgs.length > 0
          ? `${explicitPkgs.length} packages`
          : 'dependencies from package.json';
        ctx.stdout.write(`\x1b[36mInstalling ${pkgLabel} (npm v2 — batched writes)...\x1b[0m\n`);

        self.ensureNpmInstaller((msg: string) => {
          ctx.stdout.write('[npm] ' + msg + '\n');
        });

        try {
          const result = await self.npmInstaller!.install(installCwd, {
            packages: explicitPkgs.length > 0 ? explicitPkgs : undefined,
          });

          if (result.failed?.length > 0) {
            ctx.stderr.write('\x1b[31mFailed: ' + result.failed.join(', ') + '\x1b[0m\n');
          }
          ctx.stdout.write(
            `\n\x1b[32madded ${result.installed?.length || 0} packages (${result.totalFiles || 0} files) in ${((result.elapsed || 0) / 1000).toFixed(1)}s\x1b[0m\n`
          );
          if (result.cachedHits > 0) {
            ctx.stdout.write(`\x1b[2m  (${result.cachedHits} from cache)\x1b[0m\n`);
          }
          return result.failed?.length > 0 ? 1 : 0;
        } catch (e: any) {
          ctx.stderr.write(`\x1b[31mnpm install failed: ${e?.message}\x1b[0m\n`);
          return 1;
        }
      }

      // Fall through to core npm for other subcommands
      return coreNpmCmd(ctx);
    });
    // npx: check node_modules/.bin first, then built-in commands, then fallback to core
    const coreNpxCmd = createNpxCommand(registry, shellExecute);
    registry.register('npx', async (ctx: any) => {
      const npxArgs: string[] = ctx.args || [];
      const cmd = npxArgs[0];
      if (!cmd) { ctx.stderr.write('Usage: npx <command> [args...]\n'); return 1; }

      // Check if it's a built-in command (vite, esbuild, etc.)
      const resolved = await registry.resolve(cmd);
      if (resolved) {
        return await resolved({ ...ctx, args: npxArgs.slice(1) });
      }

      // Fall through to core npx
      return coreNpxCmd(ctx);
    });

    // ── Register process commands (enhanced with facet process tracking) ──
    registry.register('ps', async (ctx: any) => {
      ctx.stdout.write('  PID  STATUS              COMMAND\n');
      for (const proc of self.processTable.getAll()) {
        // Prefer log-store exit info over ProcessTable's: the store has
        // the authoritative code and survives reap. For `running`, rely
        // on ProcessTable (store has no "running" concept).
        let status: string;
        if (proc.state === 'running') {
          status = '\x1b[32mrunning\x1b[0m';
        } else if (proc.state === 'killed') {
          status = `\x1b[33mkilled(${proc.exitCode ?? 137})\x1b[0m`;
        } else {
          // 'exited' — distinguish clean vs crashed.
          const code = proc.exitCode ?? 0;
          status = code === 0
            ? `\x1b[2mexited(0)\x1b[0m`
            : `\x1b[31mcrashed(${code})\x1b[0m`;
        }
        ctx.stdout.write(`  ${String(proc.pid).padStart(3)}  ${status.padEnd(26)}  ${proc.command}\n`);
      }
      // Show vite dev server
      if (self.viteDevServer?.isRunning) {
        ctx.stdout.write('  \x1b[33m---\x1b[0m  \x1b[32mrunning\x1b[0m                     vite dev server (' + self.viteBasePath + '/)\n');
      }
      if (self.processTable.getAll().length === 0 && !self.viteDevServer?.isRunning) {
        ctx.stdout.write('  (no processes)\n');
      }
      return 0;
    });

    // ── `logs <pid>` — tail per-process ring buffer ──
    // Flags:
    //   -f / --follow     stream new chunks until the process exits
    //   -n / --lines N    number of lines from the tail (default 200)
    //   --bytes N         max bytes from the tail (overrides --lines)
    //   --plain           strip ANSI escapes on output (keeps buffer raw)
    registry.register('logs', async (ctx: any) => {
      const args: string[] = ctx.args || [];
      const follow = args.includes('-f') || args.includes('--follow');
      const plain = args.includes('--plain');

      let lines = 200;
      let bytes: number | undefined;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if ((a === '-n' || a === '--lines') && args[i + 1]) {
          const n = parseInt(args[i + 1], 10);
          if (!isNaN(n) && n > 0) lines = n;
          i++;
        } else if (a === '--bytes' && args[i + 1]) {
          const n = parseInt(args[i + 1], 10);
          if (!isNaN(n) && n > 0) bytes = n;
          i++;
        }
      }

      const pidArg = args.find(a => /^\d+$/.test(a));
      if (!pidArg) {
        ctx.stderr.write('usage: logs [-f] [-n LINES | --bytes N] [--plain] <pid>\n');
        return 1;
      }
      const pid = parseInt(pidArg, 10);

      if (!self.processLogs.has(pid)) {
        ctx.stderr.write(`no logs for pid ${pid}\n`);
        return 1;
      }

      // Paint a single chunk for live-stream (follow-mode) rendering.
      // `--plain` strips ANSI per chunk — safe for live output because
      // individual streamed chunks from the RPC layer never split an
      // escape sequence (the RPC boundary always delivers a complete
      // write call). Backfill is different (see below).
      const renderChunk = (c: LogChunk) => {
        let data = c.data;
        if (plain) data = stripAnsi(data);
        if (c.stream === 'stderr' && !plain) {
          return `\x1b[31m${data}\x1b[0m`;
        }
        return data;
      };

      // Backfill. Concatenate same-stream consecutive chunks BEFORE
      // stripping so that any ANSI escape split across chunk boundaries
      // (by the 4 KB splitter inside ProcessLogStore) gets rejoined and
      // stripped cleanly instead of leaking `1m` / `[31m` fragments.
      const tailOpts = bytes !== undefined ? { bytes } : { lines };
      const chunks = self.processLogs.tail(pid, tailOpts);
      let group: LogChunk[] = [];
      const flushGroup = () => {
        if (group.length === 0) return;
        const stream = group[0].stream;
        let data = group.map(c => c.data).join('');
        if (plain) data = stripAnsi(data);
        if (stream === 'stderr' && !plain) {
          ctx.stdout.write(`\x1b[31m${data}\x1b[0m`);
        } else {
          ctx.stdout.write(data);
        }
        group = [];
      };
      for (const c of chunks) {
        if (group.length > 0 && group[group.length - 1].stream !== c.stream) {
          flushGroup();
        }
        group.push(c);
      }
      flushGroup();

      if (!follow) {
        // Footer only when process has exited already.
        const exit = self.processLogs.getExit(pid);
        if (exit) {
          ctx.stdout.write(
            `\r\n\x1b[2m[process exited with code ${exit.code}${
              exit.reason ? ` (${exit.reason})` : ''
            }]\x1b[0m\r\n`,
          );
        }
        return 0;
      }

      // Follow mode: subscribe to live appends, poll for exit.
      const entry = self.processTable.get(pid);
      const alreadyExited =
        !entry || entry.state !== 'running' || self.processLogs.getExit(pid);
      if (alreadyExited) {
        const exit = self.processLogs.getExit(pid);
        if (exit) {
          ctx.stdout.write(
            `\r\n\x1b[2m[process exited with code ${exit.code}${
              exit.reason ? ` (${exit.reason})` : ''
            }]\x1b[0m\r\n`,
          );
        }
        return 0;
      }

      return await new Promise<number>((resolve) => {
        let done = false;
        const finish = (code: number) => {
          if (done) return;
          done = true;
          unsub();
          unsubExit();
          resolve(code);
        };
        const unsub = self.processLogs.subscribe(pid, (c) => {
          ctx.stdout.write(renderChunk(c));
        });
        const unsubExit = self.processLogs.subscribeExit(pid, (exit) => {
          ctx.stdout.write(
            `\r\n\x1b[2m[process exited with code ${exit.code}${
              exit.reason ? ` (${exit.reason})` : ''
            }]\x1b[0m\r\n`,
          );
          finish(0);
        });
        // TOCTOU: the process may have exited between our `alreadyExited`
        // check above and these subscribe calls. Re-check now that the
        // exit subscriber is wired — if exit already set, the subscribe
        // callback never fires, so synthesize the footer ourselves.
        const exitNow = self.processLogs.getExit(pid);
        if (exitNow) {
          ctx.stdout.write(
            `\r\n\x1b[2m[process exited with code ${exitNow.code}${
              exitNow.reason ? ` (${exitNow.reason})` : ''
            }]\x1b[0m\r\n`,
          );
          finish(0);
          return;
        }
        // If ctx exposes an AbortSignal (Ctrl+C wired by the shell),
        // honor it. Otherwise, follow-mode ends only on process exit.
        if (ctx.signal && typeof ctx.signal.addEventListener === 'function') {
          ctx.signal.addEventListener('abort', () => finish(130));
        }
      });
    });

    registry.register('jobs', async (ctx: any) => {
      const running = self.processTable.getRunning();
      if (running.length === 0 && !self.viteDevServer?.isRunning) {
        ctx.stdout.write('No background jobs.\n');
        return 0;
      }
      for (let i = 0; i < running.length; i++) {
        ctx.stdout.write(`[${i + 1}]  Running    ${running[i].command} (pid ${running[i].pid})\n`);
      }
      if (self.viteDevServer?.isRunning) {
        ctx.stdout.write(`[${running.length + 1}]  Running    vite dev server\n`);
      }
      return 0;
    });

    registry.register('kill', async (ctx: any) => {
      const pidArg = ctx.args[0];
      if (!pidArg) { ctx.stderr.write('Usage: kill <pid>\n'); return 1; }
      const pid = parseInt(pidArg);
      if (isNaN(pid)) { ctx.stderr.write('kill: invalid pid\n'); return 1; }
      if (self.facetManager?.kill(pid)) {
        ctx.stdout.write(`Process ${pid} killed.\n`);
        return 0;
      }
      ctx.stderr.write(`kill: no such process: ${pid}\n`);
      return 1;
    });

    registry.register('top', createTopCommand(processRegistry));
    registry.register('watch', createWatchCommand(registry));
    registry.register('help', createHelpCommand(registry));

    // ── Rehydrate globally-installed npm packages ──
    try {
      rehydrateGlobalPackages(this.kernel.vfs, registry);
    } catch {}

    // ── Show MOTD ──
    try {
      const motd = this.sqliteFs!.readFileString('etc/motd');
      this.terminal.write(motd + '\r\n');
    } catch {}

    // ── Starter-app hint (only if seed sentinel still exists) ──
    // We check the live VFS, not a static file, so that if the user deletes
    // ~/.nimbus-seeded (or ~/app) the hint stops appearing on next login.
    try {
      if (hasSeededProject(this.sqliteFs!) && this.sqliteFs!.exists(SEED_PROJECT_DIR)) {
        this.terminal.write(
          '\x1b[2mStarter app ready at \x1b[36m~/app\x1b[0m\x1b[2m — try:\x1b[0m\r\n' +
          '  \x1b[36mcd app && npm install && npm run dev\x1b[0m\r\n\r\n'
        );
      }
    } catch {}

    // ── Start shell ──
    this.shell.start();

    (async () => {
      try { await this.shell!.sourceFile('/etc/profile'); } catch {}
      try { await this.shell!.sourceFile('/home/user/.nimbusrc'); } catch {}
    })();

    ws.send(JSON.stringify({ type: 'ready' }));
  }

  // ── Filesystem seeding ────────────────────────────────────────────────

  private seedFilesystem() {
    const fs = this.sqliteFs!;
    const dirs = [
      'bin', 'etc', 'home', 'home/user', 'home/user/.config',
      'tmp', 'var', 'var/log', 'usr', 'usr/bin', 'usr/lib',
      'usr/lib/node_modules', 'usr/share', 'usr/share/pkg',
      'usr/share/pkg/node_modules', 'opt',
      'home/user/projects',
    ];
    for (const dir of dirs) {
      if (!fs.exists(dir)) fs.mkdir(dir, { recursive: true });
    }

    if (!fs.exists('etc/hostname')) {
      fs.writeFile('etc/hostname', DEFAULT_HOSTNAME + '\n');
    }
    if (!fs.exists('etc/os-release')) {
      fs.writeFile('etc/os-release',
        `NAME="Nimbus"\nVERSION="${NIMBUS_VERSION}"\nID=nimbus\n` +
        'PRETTY_NAME="Nimbus — Cloud Dev Environment"\n'
      );
    }
    if (!fs.exists('etc/profile')) {
      fs.writeFile('etc/profile', 'export PATH=/usr/bin:/bin\nexport EDITOR=nano\n');
    }
    if (!fs.exists('home/user/.nimbusrc')) {
      fs.writeFile('home/user/.nimbusrc',
        '# Nimbus shell config\nalias ll="ls -la"\nalias la="ls -a"\nalias l="ls -1"\n'
      );
    }
    if (!fs.exists('etc/motd')) {
      fs.writeFile('etc/motd',
        '\x1b[1;36m' +
        '╔════════════════════════════════════════════════╗\r\n' +
        `║  Nimbus v${NIMBUS_VERSION} — Cloud Dev Environment          ║\r\n` +
        '║  node · npm · esbuild · vite · wrangler dev   ║\r\n' +
        '║  10 GB VFS · Dynamic Workers · HMR             ║\r\n' +
        '╚════════════════════════════════════════════════╝\x1b[0m\r\n'
      );
    }
    if (!fs.exists('home/user/hello.js')) {
      fs.writeFile('home/user/hello.js',
        'console.log("Hello from Nimbus!");\n' +
        'console.log("Executed in a Dynamic Worker isolate");\n' +
        'console.log("Platform:", process.platform, "| PID:", process.pid);\n' +
        'console.log("2 + 2 =", 2 + 2);\n'
      );
    }
    if (!fs.exists('home/user/welcome.txt')) {
      fs.writeFile('home/user/welcome.txt',
        `Welcome to Nimbus v${NIMBUS_VERSION}!\n\n` +
        'Cloud-native dev environment on Cloudflare Workers.\n\n' +
        '  node hello.js          — run in isolated dynamic worker\n' +
        '  npm install <pkg>      — install npm packages\n' +
        '  esbuild src/app.ts     — transform TypeScript/JSX\n' +
        '  vite                   — start dev server with HMR\n' +
        '  nimbus-wrangler dev      — run Cloudflare Worker locally\n' +
        '  df                     — filesystem + cache stats\n'
      );
    }

    // ── Starter app (Vite + React + TS + Tailwind + Router) ──
    // Idempotent: guarded by shouldSeedProject() which checks both a
    // sentinel file and the project dir. Safe to call on every boot.
    try {
      seedProject(fs, { log: (msg) => console.log(msg) });
    } catch (e: any) {
      console.error('[nimbus] seedProject failed:', e?.message || e);
    }
  }

  // ── WebSocket lifecycle ───────────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      // HMR clients: route messages to the facet via HmrBridge.
      // We identify HMR sockets by the attachment tag set at accept time.
      const attach = (ws as any).deserializeAttachment?.();
      if (attach?.kind === 'cirrus-hmr') {
        const data = typeof message === 'string' ? message : dec.decode(message);
        this.cirrusReal?.deliverHmrClientMessage(attach.clientId, data);
        return;
      }
      // W9: process-logs sockets are output-only by contract. Drop
      // any inbound frame; never let it parse-fail to the shell.
      if (attach?.kind === 'process-logs') {
        return;
      }
      const data = typeof message === 'string' ? message : dec.decode(message);
      const msg = JSON.parse(data);
      if (this.terminal) this.terminal.handleMessage(msg);
    } catch (e: any) {
      // Never let a message parsing error crash the DO
      console.error('[nimbus] webSocketMessage error:', e?.message);
    }
  }

  /**
   * Classify a closing/erroring WebSocket by its serialized attachment.
   * Shell sockets carry `{kind:'shell'}` (set at the /ws upgrade site);
   * HMR sockets carry `{kind:'cirrus-hmr', clientId}` (set at :1240).
   * Any other (undefined/unknown) attachment falls back to 'shell' to
   * preserve pre-F1 behaviour for legacy accept sites.
   */
  private _wsKind(ws: WebSocket): { kind: string; clientId?: string } {
    try {
      const att = (ws as any).deserializeAttachment?.();
      if (att && typeof att === 'object' && typeof att.kind === 'string') {
        return att as { kind: string; clientId?: string };
      }
    } catch { /* deserializeAttachment is optional */ }
    return { kind: 'shell' };
  }

  async webSocketClose(ws: WebSocket, _code?: number, _reason?: string, _wasClean?: boolean) {
    // Audit F1: discriminate by socket kind. Previously BOTH parameters
    // were absent and every close — including preview-iframe HMR sockets
    // closed by `vite stop` / navigation — nulled the session's
    // shell/terminal/kernel, silently freezing the user's terminal tab.
    const att = this._wsKind(ws);
    // W9: process-logs sockets close routinely (user closes a log tab).
    // Don't touch shell/terminal — and don't bother flushing here either
    // because process-logs ws close doesn't imply session lifecycle.
    if (att.kind === 'process-logs') {
      return;
    }
    if (att.kind === 'cirrus-hmr') {
      // HMR socket closed. Detach from the bridge + drop from the map.
      // Do NOT touch shell/terminal/kernel — the user's terminal tab
      // is still alive and has nothing to do with this HMR close.
      try {
        const clientId = att.clientId || this._cirrusHmrWsClients?.get(ws);
        this._cirrusHmrWsClients?.delete(ws);
        if (clientId) this.cirrusReal?.detachHmrClient(clientId);
      } catch { /* best-effort */ }
      return;
    }

    // Shell (or unknown legacy) socket close. Dev servers (vite,
    // wrangler dev) + long-running facets must still survive the
    // terminal reconnect (see 607e472 — do NOT kill running processes
    // here). Only reap per-tab state.
    if (this.sqliteFs) {
      // Audit C1: flushAll() now throws when any chunk failed both
      // its first attempt and the one-shot retry. Log loudly and
      // clear so the next close doesn't re-throw.
      try {
        this.sqliteFs.flushAll();
      } catch (e: any) {
        console.error('[nimbus] webSocketClose: flushAll failed —', e?.message || e);
        try { this.sqliteFs.clearWriteFailures(); } catch {}
      }
    }
    // W5 Lever 5: persist the OOM ring on close so cf-tail-style
    // forensics survive DO hibernation. Gated on ctx.waitUntil so
    // the close handler doesn't hang on storage. Skipped if ring
    // is empty / unchanged.
    this._w5SafePersistRing();
    // W9: flush any pending log writes so a hibernation cycle right
    // after this close doesn't strand the in-memory ring. Synchronous
    // SQL writes wrapped in transactionSync — fast (microseconds for
    // typical buffer sizes); blocking is safer than racing waitUntil
    // because flush() is what makes the logs survive.
    this._w9FlushOnClose();
    this.shell = null;
    this.terminal = null;
    this.kernel = null;
    // Reset the one-shot "wrangler alias" banner so a reconnecting user
    // sees it again — terminal-lifetime state, not session-lifetime.
    this.wranglerAliasBannerShown = false;
  }

  /**
   * W9: synchronous flush of the process-log ring on session close.
   * Wraps `processLogs.flush()` in a try/catch so a flush failure
   * doesn't take down the close handler. Cheap when there's nothing
   * dirty (idempotent inside the store).
   */
  private _w9FlushOnClose(): void {
    try {
      this.processLogs.flush();
    } catch (e: any) {
      console.warn('[nimbus/W9] flush-on-close failed:', e?.message);
    }
  }

  async webSocketError(ws: WebSocket, _error?: any) {
    // Audit F1: same discriminator as webSocketClose. A socket error
    // on an HMR WS must not take down the terminal tab.
    const att = this._wsKind(ws);
    // W9: process-logs error — same drop-and-return policy as close.
    if (att.kind === 'process-logs') {
      return;
    }
    if (att.kind === 'cirrus-hmr') {
      try {
        const clientId = att.clientId || this._cirrusHmrWsClients?.get(ws);
        this._cirrusHmrWsClients?.delete(ws);
        if (clientId) this.cirrusReal?.detachHmrClient(clientId);
      } catch { /* best-effort */ }
      return;
    }

    if (this.sqliteFs) {
      try {
        this.sqliteFs.flushAll();
      } catch (e: any) {
        console.error('[nimbus] webSocketError: flushAll failed —', e?.message || e);
        try { this.sqliteFs.clearWriteFailures(); } catch {}
      }
    }
    // W5 Lever 5: persist OOM ring (same rationale as webSocketClose).
    // Also synthesize a DiagFailure for the WS error itself if one
    // hasn't already been recorded. Helps when a session vanishes
    // without ever recording an explicit failure.
    if (_error) {
      try {
        recordFailure({
          at: Date.now(),
          phase: 'ws',
          cause: 'unknown',
          rssEstimateBytes: this._diagPeakRss,
          heapUsedBytes: this._diagPeakHeapUsed,
          lruBytes: 0, inFlightBytes: 0,
          lastRpcFrame: getLastRpcFrame(),
          lastFacetId: getLastFacetId(),
          message: (_error as any)?.message ?? String(_error),
        });
      } catch { /* fail-soft */ }
    }
    this._w5SafePersistRing();
    // W9: same flush rationale as webSocketClose. An error on the shell
    // socket commonly precedes hibernation by milliseconds.
    this._w9FlushOnClose();
    this.shell = null;
    this.terminal = null;
    this.kernel = null;
  }

  /** W5 Lever 5: bridge between _w5PersistRing (which returns a
   *  Promise) and ctx.waitUntil. Skipped silently if ctx.waitUntil
   *  isn't available (test contexts). */
  private _w5SafePersistRing(): void {
    try {
      const p = this._w5PersistRing();
      if (p && typeof (this.ctx as any).waitUntil === 'function') {
        try { (this.ctx as any).waitUntil(p); } catch { /* best-effort */ }
      }
    } catch (e: any) {
      console.warn('[nimbus/W5] _w5SafePersistRing threw:', e?.message);
    }
  }
}

// ── Inner-Worker loopback bindings ────────────────────────────────────
//
// These WorkerEntrypoint classes are top-level exports so that ctx.exports
// auto-populates Service Bindings for them (enable_ctx_exports compat
// flag is already enabled via default compatibility_date 2026-04-01).
//
// They are re-exported from src/index.ts so wrangler detects them as
// reachable from the entry file and bundles their classes.
//
// Usage pattern (in nimbus-wrangler.ts):
//   ctx.exports.NimbusAssetsRPC({ props: { vfsRoot, assetsDir } })
// produces a Service Binding stub that can be placed in the inner
// Worker's `env` under whatever binding name the user declared in
// wrangler.jsonc's `assets.binding` (typically "ASSETS").

/**
 * Assets binding shim. The inner Worker calls `env.ASSETS.fetch(request)`
 * and we serve the file from VFS under `<vfsRoot>/<assetsDir>/<pathname>`.
 *
 * Props (passed via ctx.props when this binding is constructed):
 *   vfsRoot   — project root in VFS (e.g. "home/user/myapp")
 *   assetsDir — directory declared in wrangler.jsonc.assets.directory
 *               (e.g. "./public" → we trim the leading ./)
 *
 * The hostname on the incoming Request is irrelevant (Workers Assets
 * convention); only pathname matters. Path traversal (`..`) is clamped.
 * Directories resolve to their `index.html` child; missing files fall
 * back to the assetsDir root `index.html` (SPA convention), then 404.
 *
 * The VFS is read from the supervisor DO via the class property
 * `_nimbusVfsResolver` set by NimbusSession at construction. WorkerEntrypoint
 * instances don't have direct access to the supervisor's SqliteVFS, so we
 * reach it through the supervisor stub (env.NIMBUS_SESSION.idFromString).
 * For Phase 1, we use a simpler approach: the props carry a supervisor
 * DO id so we can round-trip through an RPC method that reads the file.
 */
export class NimbusAssetsRPC extends WorkerEntrypoint {
  /**
   * Fetch a static asset. Called by the inner Worker as
   * `env.ASSETS.fetch(request)`. The request URL's pathname is used to
   * resolve a file under the configured assets directory.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const propsAny = (this.ctx as any).props || {};
    const vfsRoot = String(propsAny.vfsRoot || '');
    const assetsDir = String(propsAny.assetsDir || '').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
    const doId = String(propsAny.doId || '');

    // Normalize pathname: no leading /, drop .. segments entirely.
    let clean = url.pathname.replace(/^\/+/, '');
    const parts = clean.split('/').filter((p) => p && p !== '..' && p !== '.');
    clean = parts.join('/');

    // Resolve the supervisor DO stub so we can call its VFS read RPC.
    const ns = (this.env as any).NIMBUS_SESSION;
    if (!ns || !doId) {
      return new Response('ASSETS binding not wired: missing NIMBUS_SESSION or doId', { status: 500 });
    }
    const stub = ns.get(ns.idFromString(doId));

    // Candidate VFS paths, tried in order. The assetsDir is relative to
    // the project root in VFS. Trailing-slash and bare dir → index.html.
    const base = (vfsRoot ? vfsRoot + '/' : '') + (assetsDir ? assetsDir + '/' : '');
    const candidates: string[] = [];
    if (clean) {
      candidates.push(base + clean);
      if (!clean.endsWith('.html') && !clean.includes('.')) {
        candidates.push(base + clean.replace(/\/+$/, '') + '/index.html');
      }
    } else {
      candidates.push(base + 'index.html');
    }
    // SPA fallback: any unmatched path serves the top-level index.html.
    candidates.push(base + 'index.html');

    for (const candidate of candidates) {
      try {
        const bytes = await stub._rpcReadFileBytes(candidate);
        if (bytes && bytes.byteLength !== undefined) {
          return new Response(bytes, {
            status: 200,
            headers: {
              'Content-Type': mimeTypeForPath(candidate),
              'Cache-Control': 'no-store',
            },
          });
        }
      } catch { /* try next */ }
    }

    return new Response('Not found', { status: 404 });
  }
}

/**
 * Pick a sensible content-type from a filename. Conservative list; the
 * inner Worker can always override via the response it constructs
 * (which Workers Assets won't touch for env.ASSETS.fetch results).
 */
function mimeTypeForPath(path: string): string {
  const i = path.lastIndexOf('.');
  if (i < 0) return 'application/octet-stream';
  const ext = path.slice(i + 1).toLowerCase();
  switch (ext) {
    case 'html': case 'htm': return 'text/html; charset=utf-8';
    case 'css':              return 'text/css; charset=utf-8';
    case 'js': case 'mjs':   return 'application/javascript; charset=utf-8';
    case 'json':             return 'application/json; charset=utf-8';
    case 'svg':              return 'image/svg+xml';
    case 'png':              return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'webp':             return 'image/webp';
    case 'gif':              return 'image/gif';
    case 'ico':              return 'image/x-icon';
    case 'woff':             return 'font/woff';
    case 'woff2':            return 'font/woff2';
    case 'txt':              return 'text/plain; charset=utf-8';
    case 'xml':              return 'application/xml; charset=utf-8';
    case 'wasm':             return 'application/wasm';
    case 'map':              return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

/**
 * Worker Loader binding shim.
 *
 * Option A — return the raw WorkerStub from RPC — was attempted first
 * and failed at runtime with:
 *   "Could not serialize object of type \"WorkerStub\". This type does
 *    not support serialization."
 *
 * Option B — proxy the stub via chained WorkerEntrypoint classes — is
 * implemented here. The three classes below mirror the three hops a
 * caller makes:
 *
 *   env.LOADER.load(code)              → NimbusLoaderRPC.load     (returns NimbusLoadedWorker)
 *   .getEntrypoint(name?)              → NimbusLoadedWorker.getEntrypoint (returns NimbusLoadedEntrypoint)
 *   .fetch(request)                    → NimbusLoadedEntrypoint.fetch
 *
 * Each class is a WorkerEntrypoint, so Service Binding stubs for them
 * pass across the isolate boundary cleanly. The outer WorkerStub lives
 * at a module-level Map keyed by a random id that's carried in
 * ctx.props so subsequent hops can look it up from the outer side.
 *
 * Depth cap (ctx.props.depth) prevents infinite nesting: Nimbus-in-
 * Nimbus-in-Nimbus is fine; five levels deep is almost certainly a
 * runaway and we throw a clear error. Default limit is 4; overridable
 * via the NIMBUS_INNER_LOADER_DEPTH env var on the outermost session.
 */

/**
 * Module-level map of loaded worker CODE (not stubs), keyed by a random
 * id. WorkerStubs are I/O objects tied to a request context, so they
 * can't be stashed for later use ("Cannot perform I/O on behalf of a
 * different request"). Storing the code instead lets each new outer
 * request re-load the worker in its own context via env.LOADER.get(id)
 * — workerd caches by id so repeated loads are essentially free.
 *
 * Map entries live as long as the outer DO isolate; inner stubs that
 * reference them die with the DO, so GC isn't needed.
 */
const _NIMBUS_LOADED_CODES: Map<string, any> = new Map();

function _genStubId(): string {
  return 'ldr-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Look up the stored code by key and create a fresh outer WorkerStub
 * in the CURRENT request context. Uses LOADER.get(id, cb) so repeated
 * calls reuse the same dynamic worker rather than spawning new ones.
 */
function _resolveStubInCurrentContext(outerLoader: any, key: string): any | null {
  const code = _NIMBUS_LOADED_CODES.get(key);
  if (!code) return null;
  return outerLoader.get(key, async () => code);
}

/** Hop 1: env.LOADER.{load,get} forwarded to the outer loader. */
export class NimbusLoaderRPC extends WorkerEntrypoint {
  private _currentDepth(): number {
    const d = (this.ctx as any).props?.depth;
    return typeof d === 'number' && d >= 0 ? d : 0;
  }

  private _maxDepth(): number {
    const raw = (this.env as any)?.NIMBUS_INNER_LOADER_DEPTH;
    const parsed = raw ? parseInt(String(raw), 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
  }

  private _assertDepthOk(): void {
    const depth = this._currentDepth();
    const max = this._maxDepth();
    if (depth >= max) {
      throw new Error(
        `Nimbus: refusing to spawn inner Worker Loader (depth=${depth + 1}, max=${max}). ` +
        `Set NIMBUS_INNER_LOADER_DEPTH to raise the cap or break the recursion.`,
      );
    }
  }

  /**
   * Inner: env.LOADER.load(code). Stashes the CODE (not a stub — stubs
   * are I/O-bound to the calling request context) and returns a
   * NimbusLoadedWorker RPC stub. Each downstream call re-loads the
   * worker in its own request context via LOADER.get(key, cb).
   */
  load(code: any): any {
    this._assertDepthOk();
    const outerLoader = (this.env as any)?.LOADER;
    if (!outerLoader) throw new Error('Nimbus: outer env.LOADER missing');
    // Validate by loading once in THIS context (fails fast on bad code).
    // The stub is discarded; downstream calls re-load fresh in their
    // own context.
    outerLoader.load(code);
    const key = _genStubId();
    _NIMBUS_LOADED_CODES.set(key, code);
    const ctxExports = (this.ctx as any)?.exports;
    if (!ctxExports?.NimbusLoadedWorker) {
      throw new Error('Nimbus: ctx.exports.NimbusLoadedWorker unavailable');
    }
    return ctxExports.NimbusLoadedWorker({
      props: { key, depth: (this.ctx as any).props?.depth || 0 },
    });
  }

  /**
   * Inner: env.LOADER.get(id, callback). The inner's callback returns
   * a code object; we treat `id` as the outer cache key (prefixed so
   * it doesn't collide with load()-generated keys).
   */
  async get(id: string, callback: () => any): Promise<any> {
    this._assertDepthOk();
    const outerLoader = (this.env as any)?.LOADER;
    if (!outerLoader) throw new Error('Nimbus: outer env.LOADER missing');
    const key = 'get:' + id;
    if (!_NIMBUS_LOADED_CODES.has(key)) {
      const code = await callback();
      _NIMBUS_LOADED_CODES.set(key, code);
    }
    const ctxExports = (this.ctx as any)?.exports;
    if (!ctxExports?.NimbusLoadedWorker) {
      throw new Error('Nimbus: ctx.exports.NimbusLoadedWorker unavailable');
    }
    return ctxExports.NimbusLoadedWorker({
      props: { key, depth: (this.ctx as any).props?.depth || 0 },
    });
  }
}

/** Hop 2: the returned "worker" stub. Exposes .getEntrypoint(). */
export class NimbusLoadedWorker extends WorkerEntrypoint {
  /**
   * Returns a NimbusLoadedEntrypoint stub that carries the code key +
   * entrypoint name forward. The actual outer-side load + fetch happens
   * inside NimbusLoadedEntrypoint.fetch() so all outer hops run in a
   * SINGLE outer request context (the cross-request-I/O limitation is
   * real — stubs created in one outer request can't be used by another).
   */
  getEntrypoint(name?: string): any {
    const propsAny = (this.ctx as any).props || {};
    const ctxExports = (this.ctx as any)?.exports;
    if (!ctxExports?.NimbusLoadedEntrypoint) {
      throw new Error('Nimbus: ctx.exports.NimbusLoadedEntrypoint unavailable');
    }
    return ctxExports.NimbusLoadedEntrypoint({
      props: { key: propsAny.key, name: name || null, depth: propsAny.depth },
    });
  }

  /**
   * Pass-through to outer worker.getDurableObjectClass(name). The
   * returned stub is tied to THIS method's outer request context; if
   * the caller (the inner worker) uses the class in a later request
   * it will fail the cross-request-I/O check. For Phase 3 DO binding
   * synthesis we resolve classes directly from nimbus-wrangler's own
   * request context (which is the build-time context), not through
   * this method.
   */
  getDurableObjectClass(name: string): any {
    const propsAny = (this.ctx as any).props || {};
    const outerLoader = (this.env as any)?.LOADER;
    if (!outerLoader) throw new Error('Nimbus: outer env.LOADER missing');
    const outer = _resolveStubInCurrentContext(outerLoader, propsAny.key);
    if (!outer) throw new Error('Nimbus: loaded worker code missing (key=' + propsAny.key + ')');
    return outer.getDurableObjectClass(name);
  }
}

/** Hop 3: a named-or-default entrypoint. Exposes .fetch(). */
export class NimbusLoadedEntrypoint extends WorkerEntrypoint {
  /**
   * Forward fetch() to the outer worker's entrypoint. All three outer
   * hops (load → getEntrypoint → fetch) run in the same outer request
   * context (this method's invocation), which sidesteps the
   * cross-request-I/O limitation.
   */
  async fetch(request: Request): Promise<Response> {
    const propsAny = (this.ctx as any).props || {};
    const outerLoader = (this.env as any)?.LOADER;
    if (!outerLoader) return new Response('Nimbus: outer env.LOADER missing', { status: 500 });
    const outer = _resolveStubInCurrentContext(outerLoader, propsAny.key);
    if (!outer) return new Response('Nimbus: loaded worker code missing', { status: 502 });
    const ep = propsAny.name ? outer.getEntrypoint(propsAny.name) : outer.getEntrypoint();
    return ep.fetch(request);
  }
}

// ── Durable Object binding synthesis ────────────────────────────────────
//
// The inner-DO class registry was extracted to ./inner-do-registry.ts in
// Arc A Phase 3 to break the import cycle:
//   index.ts -> nimbus-session.ts -> nimbus-wrangler.ts -> nimbus-session.ts
// nimbus-wrangler.ts now consumes registerInnerDoClass/clearInnerDoClasses
// directly from the leaf, and this file consumes getInnerDoClass via the
// imports at the top. The Map identity is preserved across the isolate
// (still process-scoped module-level state).
//
// Inner Worker code:
//   const stub = env.MY_DO.get(env.MY_DO.idFromName('x'));
//   await stub.fetch(req);
// We synthesize env.MY_DO as a NimbusDurableObjectNamespace
// WorkerEntrypoint stub. Its .get() returns a NimbusDOStub that — on
// fetch() — resolves the class from the registry and invokes
// ctx.facets.get(facetName, {class, id}).fetch(req) in the same outer
// request context.

/**
 * `env.MY_DO` shim — a DurableObjectNamespace-like WorkerEntrypoint.
 *
 * Usage from inner Worker:
 *   const id   = await env.MY_DO.idFromName('x');   // AWAIT required
 *   const stub = env.MY_DO.get(id);
 *   await stub.fetch(request);
 *
 * IMPORTANT: unlike the real DurableObjectNamespace, idFromName /
 * newUniqueId / idFromString here return **Promises**, because they're
 * RPC-backed WorkerEntrypoint methods. The inner caller MUST `await`
 * them before passing the result to `.get()`. Workers RPC pipelining
 * does not currently allow passing an RpcPromise as a method argument
 * — the no-await form fails with:
 *     "Could not serialize object of type \"RpcPromise\"."
 *
 * Typical real-Worker code written for Cloudflare's synchronous
 * DurableObjectNamespace needs a one-word change (add `await`).
 *
 * idFromName produces prefix `name:` (deterministic FNV-style hash);
 * newUniqueId uses `uniq:` (random). The prefixes keep the two id
 * spaces distinct so a name-derived id can't collide with a random
 * one.
 */
export class NimbusDurableObjectNamespace extends WorkerEntrypoint {
  /** Stable string id derived from a name. Hash is deterministic. */
  idFromName(name: string): string {
    // Simple 64-bit-ish FNV-style hash → hex. Stable across runs;
    // distinct names → distinct strings; same name → same string.
    let h1 = 0xdeadbeef ^ name.length;
    let h2 = 0x41c6ce57 ^ name.length;
    for (let i = 0; i < name.length; i++) {
      const ch = name.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const high = (h1 >>> 0).toString(16).padStart(8, '0');
    const low = (h2 >>> 0).toString(16).padStart(8, '0');
    return 'name:' + high + low;
  }

  /** Fresh random id (matches DurableObjectNamespace.newUniqueId()). */
  newUniqueId(): string {
    return 'uniq:' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  /** Accept-through for an already-formatted id. */
  idFromString(s: string): string {
    return s;
  }

  /** Return a stub bound to the given id. */
  get(id: string): any {
    const ctxExports = (this.ctx as any)?.exports;
    if (!ctxExports?.NimbusDOStub) throw new Error('Nimbus: ctx.exports.NimbusDOStub unavailable');
    const propsAny = (this.ctx as any).props || {};
    return ctxExports.NimbusDOStub({
      props: {
        bindingName: propsAny.bindingName,
        supervisorDoId: propsAny.supervisorDoId,
        id: String(id),
      },
    });
  }
}

/**
 * A Durable-Object-namespace-stub for a specific id. Exposes fetch()
 * and will, if we later need it, forward RPC method calls through a
 * dispatch helper. The important invariant: EVERY call resolves the
 * inner DO class via getInnerDoClass() (./inner-do-registry.js) and
 * spins up / attaches to a facet via the supervisor's ctx.facets in
 * the SAME outer request context — never reusing stubs across requests.
 */
export class NimbusDOStub extends WorkerEntrypoint {
  /**
   * Resolve the supervisor DO from env.NIMBUS_SESSION and route through
   * its _rpcInnerDoFetch RPC method, which runs ctx.facets.get(...) in
   * its own context and forwards the request.
   */
  async fetch(request: Request): Promise<Response> {
    const propsAny = (this.ctx as any).props || {};
    const ns = (this.env as any)?.NIMBUS_SESSION;
    if (!ns) return new Response('Nimbus: env.NIMBUS_SESSION unavailable', { status: 500 });
    const supervisorDoId = String(propsAny.supervisorDoId || '');
    if (!supervisorDoId) return new Response('Nimbus: supervisorDoId missing', { status: 500 });
    const bindingName = String(propsAny.bindingName || '');
    const id = String(propsAny.id || '');
    const stub = ns.get(ns.idFromString(supervisorDoId));
    // Forward the full request (method, body, headers preserved) by
    // serializing what's needed and reconstructing on the other side.
    // The supervisor reconstitutes the Request from these fields and
    // invokes the facet.
    const body = request.method !== 'GET' && request.method !== 'HEAD'
      ? await request.arrayBuffer()
      : null;
    const headerList: [string, string][] = [];
    request.headers.forEach((v, k) => { headerList.push([k, v]); });
    const res = await stub._rpcInnerDoFetch({
      bindingName,
      id,
      method: request.method,
      url: request.url,
      headers: headerList,
      body,
    });
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
}
