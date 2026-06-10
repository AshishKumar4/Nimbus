/**
 * facets/manager.ts — Lifecycle for isolated user-runtime workers.
 *
 * `node script.js` from the shell prompt has to run somewhere isolated
 * — same memory bound as the supervisor (128 MiB) but separate so a
 * runaway script can't take the supervisor down. The script also needs
 * supervisor-owned services: VFS writes, stdout/stderr, process exit,
 * child-process brokering, and preview port routing.
 *
 * One-shot commands use a stateless dynamic Worker entrypoint:
 *   1. LOADER.load(makeConfig)        — isolated dynamic worker
 *   2. worker.getEntrypoint().fetch() — executes the script
 *   3. SUPERVISOR RPC                 — streams output and VFS writes
 *
 * Long-running processes use a dynamic Worker entrypoint that stays
 * registered in ProcessTable and PortRegistry until exit or kill.
 */

import type { ProcessEntry } from '../runtime/process-table.js';
import { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import { generateShimsCode } from '../runtime/node-shims.js';
import { getRealNodeImportsCode } from '../_shared/real-node-imports.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { PortRegistry } from '../runtime/port-registry.js';
import { getCtxExports } from '../session/ctx-exports.js';
import { prefetchForRequire } from '../runtime/require-resolver.js';
import { hasTopLevelModuleSyntax } from '../runtime/javascript-ast.js';
import { bindImportMetaResolve, importMetaDefines } from '../runtime/import-meta-transform.js';
import { recordFailure, getLastRpcFrame, getLastFacetId } from '../observability/oom-discriminator.js';
import { classifyError } from '../observability/oom-classify.js';
import { EsbuildService } from '../runtime/esbuild-service.js';
import { disposeRpcResource, disposeRpcResources } from '../_shared/rpc-dispose.js';
import type { WorkerCode } from '../loaders/vendor/types.js';
import {
  DEFAULT_FACET_BUNDLE_PROFILE,
  type FacetBundleProfile,
} from '../runtime/bundle-profile.js';
import {
  CF_COMPAT_DATE, FACET_TIMEOUT_MS,
  VFS_BUNDLE_MAX_FILES, VFS_BUNDLE_MAX_BYTES,
  BUNDLE_MAX_ENCODED_BYTES,
} from '../constants.js';

/** Result returned from a facet execution */
export interface FacetExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * Files written by the script (path → content), to be flushed back to VFS.
   *
   * binary-fs wave: cells may be string | Uint8Array. After JSON.parse on
   * the result envelope (NodeProcess.run returns JSON.stringify; the
   * LOADER.load fallback uses Response.json) Uint8Array becomes a
   * {"0":n,"1":n,...} object — _reviveVfsWriteCell reconstitutes the
   * bytes.
   */
  vfsWrites?: Record<string, string | Uint8Array | Record<string, number>>;
}

/**
 * Detect & restore a Uint8Array that's been JSON-mangled to a
 * {"0":n,"1":n,...} object during the result-envelope round-trip.
 * String inputs and already-Uint8Array inputs pass through unchanged.
 *
 * Heuristic: a plain object whose keys are dense non-negative integers
 * starting at 0 and whose values are byte-sized integers is treated as
 * a serialized Uint8Array. False-positive risk is negligible because
 * (a) only `__vfsWrites` cells reach this path and (b) the only types
 * that ever land in `__vfsWrites` are string and Uint8Array.
 */
function _reviveVfsWriteCell(v: unknown): string | Uint8Array {
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 0) return new Uint8Array(0);
    // Quick bail-out: not all keys are non-negative integers.
    let maxIdx = -1;
    for (const k of keys) {
      const n = Number(k);
      if (!Number.isInteger(n) || n < 0) return String(v);
      if (n > maxIdx) maxIdx = n;
    }
    // Dense check: keys.length === maxIdx + 1
    if (keys.length !== maxIdx + 1) return String(v);
    const out = new Uint8Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const b = o[String(i)];
      if (typeof b !== 'number' || b < 0 || b > 255) return String(v);
      out[i] = b;
    }
    return out;
  }
  return String(v);
}

// ── Code generators ─────────────────────────────────────────────────────

const SHIMS = generateShimsCode();

interface LoadedWorkerEntrypointStub {
  startProcess?: (args?: unknown) => Promise<unknown>;
  handleHttpRequest?: (request: Request) => Promise<Response>;
  fetch?(request: Request): Promise<Response>;
}

interface LoadedWorkerStub {
  getEntrypoint(): LoadedWorkerEntrypointStub;
}

interface NimbusWorkerLoader {
  load(code: WorkerCode): LoadedWorkerStub;
  get(id: string, getCodeCallback: () => Promise<WorkerCode>): LoadedWorkerStub;
}

interface FacetManagerEnv {
  LOADER: NimbusWorkerLoader;
}

interface ProcessRpcResources {
  readonly resources: unknown[];
  readonly releaseOnReportExit: boolean;
}

interface NimbusCtxExports {
  SupervisorRPC?: (options: { props: { doId: string; pid: number } }) => unknown;
  NimbusLoadedEntrypoint?: (options: {
    props: {
      key: string;
      name: string | null;
      depth: number;
      code: unknown;
      supervisor: { doId: string; pid: number };
    };
  }) => LoadedWorkerEntrypointStub;
}

function getNimbusCtxExports(): NimbusCtxExports {
  const ctxExports = getCtxExports();
  if (!ctxExports || typeof ctxExports !== 'object') {
    throw new Error('Nimbus: ctx.exports unavailable');
  }
  return ctxExports as NimbusCtxExports;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNimbusWorkerLoader(value: unknown): value is NimbusWorkerLoader {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  return typeof Reflect.get(value, 'load') === 'function' && typeof Reflect.get(value, 'get') === 'function';
}

function parseFacetManagerEnv(env: unknown): FacetManagerEnv {
  const loader = ((typeof env === 'object' || typeof env === 'function') && env !== null)
    ? Reflect.get(env, 'LOADER')
    : undefined;
  if (!isNimbusWorkerLoader(loader)) {
    throw new Error('FacetManager requires an env.LOADER binding with load() and get()');
  }
  return { LOADER: loader };
}

async function createLoadedWorkerEntrypoint(
  ctxExports: NimbusCtxExports,
  code: unknown,
  supervisor: { doId: string; pid: number },
  name: string | null = null,
  key = `nimbus-process:${supervisor.doId}:${supervisor.pid}`,
): Promise<LoadedWorkerEntrypointStub> {
  if (!ctxExports.NimbusLoadedEntrypoint) {
    throw new Error('Nimbus: ctx.exports.NimbusLoadedEntrypoint unavailable');
  }
  return await ctxExports.NimbusLoadedEntrypoint({
    props: {
      key,
      name,
      depth: 0,
      code,
      supervisor,
    },
  });
}

export const ENTRYPOINT_PROMISE_TRACKER = `
function __makeEntrypointPromiseTracker() {
  const __tracked = new Set();
  const __origThen = Promise.prototype.then;
  const __origCatch = Promise.prototype.catch;
  const __origFinally = Promise.prototype.finally;
  let __active = false;
  const __track = (p) => {
    if (!p || typeof p.then !== "function") return p;
    __tracked.add(p);
    try {
      __origThen.call(p, () => { __tracked.delete(p); }, () => { __tracked.delete(p); });
    } catch {
      __tracked.delete(p);
    }
    return p;
  };
  return {
    start() {
      __active = true;
      try {
        Promise.prototype.then = function(...args) {
          const __next = __origThen.apply(this, args);
          if (__active) __track(__next);
          return __next;
        };
        Promise.prototype.catch = function(...args) {
          const __next = __origCatch.apply(this, args);
          if (__active) __track(__next);
          return __next;
        };
        Promise.prototype.finally = function(...args) {
          const __next = __origFinally.apply(this, args);
          if (__active) __track(__next);
          return __next;
        };
      } catch {
        __active = false;
      }
    },
    stop() {
      __active = false;
      try {
        Promise.prototype.then = __origThen;
        Promise.prototype.catch = __origCatch;
        Promise.prototype.finally = __origFinally;
      } catch {}
    },
    track: __track,
    // Drain floating entry promises until they settle, the process exits,
    // or a wall-clock deadline is hit. \`minPasses\` guarantees a minimum
    // number of ticks so freshly-scheduled work (microtasks that haven't
    // registered yet) gets a chance to surface. The deadline — not a fixed
    // tick count — bounds genuinely-pending promises (servers, intervals);
    // a fixed tiny pass cap previously abandoned legitimate multi-tick
    // async entrypoints (e.g. create-vite's clack-driven scaffold) before
    // their synchronous file writes ran.
    async drain(exitPromise, deadlineMs = 5000, minPasses = 0) {
      const __exit = {};
      const __start = Date.now();
      for (let __pass = 0; (__tracked.size > 0 || __pass < minPasses) && Date.now() - __start < deadlineMs; __pass++) {
        if (exitPromise && typeof exitPromise.then === "function") {
          const __result = await Promise.race([
            new Promise((resolve) => setTimeout(() => resolve(null), 0)),
            exitPromise.then(() => __exit, () => __exit),
          ]);
          if (__result === __exit) return;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    },
  };
}
`;

const ENTRYPOINT_STARTUP_DRAIN = `
async function __nimbusDrainEntrypointStartup(__entryResult, __entryPromises) {
  if (__entryResult && typeof __entryResult.then === "function") {
    const __exit = {};
    const __result = await Promise.race([
      __entryResult.then(() => null),
      __nimbusProcessExitPromise.then(() => __exit, () => __exit),
    ]);
    if (__result === __exit) return;
  }
  await __entryPromises.drain(__nimbusProcessExitPromise, 8000, 4);
}
`;

/**
 * Static `import * as __real_X from 'node:X'` block. Prepended to generated
 * runtime workers so the shims can forward to workerd's real `node:*` builtins.
 * See src/_shared/real-node-imports.ts for the rationale and matrix.
 */
const REAL_NODE_IMPORTS = getRealNodeImportsCode();

/**
 * Generate vite dev server facet code.
 * Long-running dynamic worker that serves files via SUPERVISOR RPC.
 * Transforms TS/TSX/JSX via SUPERVISOR.transform() (esbuild in supervisor).
 */
function generateViteFacetCode(root: string, basePath: string): string {
  const safeRoot = JSON.stringify(root);
  const safeBase = JSON.stringify(basePath);
  return `
const ROOT = ${safeRoot};
const BASE = ${safeBase};

const MIME = {
  '.html':'text/html;charset=utf-8', '.js':'application/javascript;charset=utf-8',
  '.mjs':'application/javascript;charset=utf-8', '.ts':'application/javascript;charset=utf-8',
  '.tsx':'application/javascript;charset=utf-8', '.jsx':'application/javascript;charset=utf-8',
  '.css':'text/css;charset=utf-8', '.json':'application/json;charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg',
  '.ico':'image/x-icon', '.woff2':'font/woff2', '.txt':'text/plain;charset=utf-8',
};

const HMR_CLIENT = '<script type="module">window.addEventListener("message",e=>{if(e.data?.type==="nimbus-hmr"){if(e.data.event==="full-reload")location.reload();if(e.data.event==="css-update")document.querySelectorAll("link[rel=stylesheet]").forEach(l=>{l.href=l.href.split("?")[0]+"?t="+Date.now();})}});console.log("[nimbus-hmr] connected");</script>';

function disposeRpcResult(value) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  const dispose = value[Symbol.dispose];
  if (typeof dispose === 'function') { try { dispose.call(value); } catch {} }
}

async function useRpcResult(promise, use) {
  const value = await promise;
  try { return await use(value); }
  finally { disposeRpcResult(value); }
}

function ext(p) { const i = p.lastIndexOf('.'); return i > 0 ? p.substring(i) : ''; }
function strip(p) { return p.replace(/^\\/+/,''); }

export default {
  async fetch(request, workerEnv) {
    const sup = workerEnv?.SUPERVISOR;
    const url = new URL(request.url);
    let pathname = url.pathname;
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

    try {
      // / or /index.html → serve HTML with HMR + path rewriting
      if (pathname === '/' || pathname === '/index.html') {
        const htmlPath = strip(ROOT + '/index.html');
        let html = sup ? await sup.readFile(htmlPath) : null;
        if (!html) return new Response('<!DOCTYPE html><html><body><h1>No index.html</h1></body></html>', { headers: {...headers, 'Content-Type': 'text/html;charset=utf-8'} });
        // Inject HMR client
        if (html.includes('</head>')) html = html.replace('</head>', HMR_CLIENT + '</head>');
        else html = HMR_CLIENT + html;
        // Rewrite absolute paths to include basePath
        if (BASE && BASE !== '/') {
          html = html.replace(/(\\s(?:src|href|action)=)(["'])(\\/((?!\\/)[^"']*))(\\2)/gi, (m,attr,q,path) => {
            if (path.startsWith(BASE+'/') || path === BASE) return m;
            return attr + q + BASE + path + q;
          });
        }
        // Detect importmap (skip bare import rewriting if present)
        const hasImportmap = html.includes('"importmap"');
        return new Response(html, { headers: {...headers, 'Content-Type': 'text/html;charset=utf-8'}, status: 200 });
      }

      // Static/transformed file serving
      const vfsPath = strip(ROOT + pathname);
      const e = ext(pathname);

      // TS/TSX/JSX → transform via SUPERVISOR.transform()
      if (e === '.ts' || e === '.tsx' || e === '.jsx') {
        let code = sup ? await sup.readFile(vfsPath) : null;
        if (!code) return new Response('Not found: ' + pathname, { status: 404, headers });
        // Detect JSX framework
        const hasPreact = code.includes('from "preact"') || code.includes("from 'preact'");
        const loader = e === '.tsx' ? 'tsx' : e === '.jsx' ? 'jsx' : 'ts';
        if (sup) {
          try {
            const result = await useRpcResult(sup.transform(code, loader), (value) => value);
            if (result) code = result.code;
          } catch {}
        }
        return new Response(code, { headers: {...headers, 'Content-Type': 'application/javascript;charset=utf-8'} });
      }

      // CSS
      if (e === '.css') {
        const css = sup ? await sup.readFile(vfsPath) : null;
        if (!css) return new Response('Not found', { status: 404, headers });
        return new Response(css, { headers: {...headers, 'Content-Type': 'text/css;charset=utf-8'} });
      }

      // JS files
      if (e === '.js' || e === '.mjs') {
        const code = sup ? await sup.readFile(vfsPath) : null;
        if (!code) return new Response('Not found', { status: 404, headers });
        return new Response(code, { headers: {...headers, 'Content-Type': 'application/javascript;charset=utf-8'} });
      }

      // Other files
      if (sup) {
        const content = await sup.readFile(vfsPath);
        if (content) {
          const ct = MIME[e] || 'application/octet-stream';
          return new Response(content, { headers: {...headers, 'Content-Type': ct} });
        }
      }

      // SPA fallback
      const accept = request.headers.get('Accept') || '';
      if (!pathname.includes('.') && (accept.includes('text/html') || accept.includes('*/*'))) {
        // Recurse to serve index.html
        return this.fetch(new Request(url.origin + '/', request), workerEnv);
      }

      return new Response('Not found: ' + pathname, { status: 404, headers });
    } catch (e) {
      return new Response('Vite facet error: ' + (e?.message || e), { status: 500, headers });
    }
  }
};
`;
}

/**
 * Generate one-shot runtime code with a plain fetch handler.
 */
function generateEntrypointCode(userCode: string, vfsState: FacetVfsState): string {
  const safeCode = JSON.stringify(userCode);
  const safeBundle = _serializeBundleForFacet(vfsState.bundle);
  const safeManifest = JSON.stringify(vfsState.manifest);
  return `
${REAL_NODE_IMPORTS}

const USER_CODE = ${safeCode};
const __NimbusHostResponse = globalThis.Response;

function __mkCompiledFn(code) {
  function renameIfDeclared(name) {
    const re = new RegExp("(?:^|\\\\n|;)\\\\s*(?:const|let|var|function|class)\\\\s+" + name + "\\\\b", "m");
    return re.test(code) ? name + "__nimbus_unused" : name;
  }
  const baseParams = [
    "exports", "require", "module",
    renameIfDeclared("__filename"),
    renameIfDeclared("__dirname"),
  ];
  return new Function(...baseParams, code);
}

let __compiledFn = null;
let __entryCompileFailure = null;
try {
  __compiledFn = __mkCompiledFn(USER_CODE);
} catch (__e) {
  __entryCompileFailure = (__e && __e.stack) || (__e && __e.message) || String(__e);
}

// VFS bundle + manifest + pre-compiled modules — all at module level (startup time).
const __MODULE_VFS_BUNDLE = ${safeBundle};
const __MODULE_VFS_MANIFEST = ${safeManifest};
const __compiledModules = new Map();
const __compileFailures = new Map();
for (const [__p, __c] of Object.entries(__MODULE_VFS_BUNDLE)) {
  if (__p.endsWith(".js") || __p.endsWith(".mjs") || __p.endsWith(".cjs")) {
    try {
      __compiledModules.set(__p, __mkCompiledFn(__c));
    } catch (__e) {
      __compileFailures.set(__p, __e && __e.message ? __e.message : String(__e));
    }
  }
}

class __ProcessExit extends Error {
  constructor(code) { super("process.exit(" + code + ")"); this.code = code; }
}

export default {
  async fetch(request, workerEnv) {
    const args = await request.json();
    const { argv, env, cwd: _cwd, filename, dirname, stdin, captureOutput } = args;
    const __vfsBundle = __MODULE_VFS_BUNDLE;
    const __vfsManifest = __MODULE_VFS_MANIFEST;
    const __supervisor = workerEnv?.SUPERVISOR || null;
    const __pendingIO = [];
    // Fix 6 orphan counters (same as NodeProcess.run) — count RPC writes
    // that get dropped during isolate teardown so reportExit can report them.
    let __rpcDrops = 0;
    let __rpcDropBytes = 0;
    let __rpcLastError = "";
    const __onRpcDrop = (bytes, e) => {
      __rpcDrops++;
      __rpcDropBytes += bytes | 0;
      if (e) { __rpcLastError = (e && e.message) || String(e); }
    };
    let __rpcWriteChain = Promise.resolve();
    const __queueRpcWrite = (method, s) => {
      const __task = __rpcWriteChain
        .then(() => __supervisor[method](s))
        .catch((e) => __onRpcDrop(s.length, e));
      __rpcWriteChain = __task.then(() => {}, () => {});
      __pendingIO.push(__task);
    };
    let cwd = _cwd || "/home/user";
    let stdout = "", stderr = "";
    let exitCode = 0;
    const __vfsWrites = {};
    const __vfsDirs = {};

${SHIMS}

${ENTRYPOINT_PROMISE_TRACKER}
${ENTRYPOINT_STARTUP_DRAIN}

    // Override console AND process.stdout/stderr for live SUPERVISOR streaming
    if (__supervisor && !captureOutput) {
      __consoleMod.log = (...a) => { const s = __utilMod.format(...a) + "\\n"; stdout += s; __queueRpcWrite("stdout", s); };
      __consoleMod.error = (...a) => { const s = __utilMod.format(...a) + "\\n"; stderr += s; __queueRpcWrite("stderr", s); };
      __consoleMod.warn = __consoleMod.error;
      __consoleMod.info = __consoleMod.log;
      __consoleMod.debug = __consoleMod.log;
      __processMod.stdout.write = (d, enc, cb) => { if (typeof enc === "function") cb = enc; const s = String(d); stdout += s; __queueRpcWrite("stdout", s); if (typeof cb === "function") queueMicrotask(cb); return true; };
      __processMod.stderr.write = (d, enc, cb) => { if (typeof enc === "function") cb = enc; const s = String(d); stderr += s; __queueRpcWrite("stderr", s); if (typeof cb === "function") queueMicrotask(cb); return true; };
    }

    try { globalThis.console = __consoleMod; } catch {}
    try { globalThis.process = __processMod; } catch {}
    try { globalThis.Buffer = __BufferMod; } catch {}
    try { globalThis.global = globalThis; } catch {}

    const mod = { exports: {} };
    // G2 (runtime-pkg wave): see corresponding comment in NodeProcess.run.
    __require.main = mod;
    try {
      if (__entryCompileFailure) throw new Error(__entryCompileFailure);
      if (!__compiledFn) throw new Error("entrypoint compile failed");
      const __entryPromises = __makeEntrypointPromiseTracker();
      let __entryResult;
      __entryPromises.start();
      try {
        __entryResult = __compiledFn(
          mod.exports, __require, mod, filename || "/home/user/script.js", dirname || "/home/user"
        );
      } finally {
        __entryPromises.stop();
      }
      __entryPromises.track(__entryResult);
      await __nimbusDrainEntrypointStartup(__entryResult, __entryPromises);
      if (__nimbusProcessExitCode !== null) exitCode = __nimbusProcessExitCode;
      if (__nimbusLiveStdinPump && !__nimbusAttachedTty) await __nimbusLiveStdinPump;
    } catch (e) {
      if (e instanceof __ProcessExit) { exitCode = e.code; }
      else {
        const trace = (e && e.stack) || (e && e.message) || String(e);
        stderr += trace + "\\n";
        exitCode = 1;
        if (__supervisor && !captureOutput) {
          try { __pendingIO.push(__supervisor.stderr(trace + "\\n").catch((e2) => __onRpcDrop((trace || "").length + 1, e2))); } catch {}
        }
      }
    }

    async function __drainPendingIO(maxPasses = 12) {
      let __settledIO = 0;
      for (let __pass = 0; __pass < maxPasses; __pass++) {
        await new Promise(r => setTimeout(r, 0));
        if (__pendingIO.length <= __settledIO) break;
        const __slice = __pendingIO.slice(__settledIO);
        __settledIO = __pendingIO.length;
        await Promise.allSettled(__slice);
      }
    }

    await __drainPendingIO();

    const __failedWrites = {};
    if (__supervisor && Object.keys(__vfsWrites).length > 0) {
      for (const [path, content] of Object.entries(__vfsWrites)) {
        __pendingIO.push(__supervisor.writeFile(path, content).catch(() => { __failedWrites[path] = content; }));
      }
    }
    await __drainPendingIO();

    // Drain child_process output before reporting process exit.
    try {
      if (__childProcessMod && typeof __childProcessMod.__cpDrainAllChildren === "function") {
        await __childProcessMod.__cpDrainAllChildren();
      }
    } catch (e) { /* best-effort */ }

    // Report exit after draining so the ring buffer is complete before
    // the supervisor decides whether to emit a dump. Fix 6: include an
    // orphan-drop tail if RPC writes were lost during teardown.
    if (__supervisor) {
      let __tail = "";
      if (__rpcDrops > 0) {
        __tail = "[orphan output: " + __rpcDrops + " dropped RPC write(s), ~" +
                 __rpcDropBytes + " bytes lost" +
                 (__rpcLastError ? "; last error: " + __rpcLastError : "") + "]\\n";
      }
      try { await __supervisor.reportExit(exitCode, __tail); } catch {}
    }

    return __NimbusHostResponse.json({
      exitCode,
      stdout: (__supervisor && !captureOutput) ? "" : stdout,
      stderr: (__supervisor && !captureOutput) ? "" : stderr,
      vfsWrites: __supervisor ? __failedWrites : __vfsWrites,
    });
  }
};
`;
}

/**
 * Generate a long-running Node entrypoint.
 *
 * Same core shim/VFS machinery as foreground node execution, but the
 * compiled user entry is booted once and the exported entrypoint keeps
 * serving HTTP requests from the shimmed http.Server registry.
 */
function generateLongRunningNodeCode(
  userCode: string,
  vfsState: FacetVfsState,
  opts: {
    argv?: string[];
    env?: Record<string, string>;
    cwd?: string;
    filename?: string;
    dirname?: string;
    stdin?: string;
    attachedTty?: boolean;
  },
): string {
  const safeCode = JSON.stringify(userCode);
  const safeArgs = JSON.stringify({
    argv: opts.argv || [],
    env: opts.env || {},
    cwd: opts.cwd || '/home/user',
    filename: opts.filename || '<script>',
    dirname: opts.dirname || opts.cwd || '/home/user',
    stdin: opts.stdin || '',
    attachedTty: opts.attachedTty === true,
  });
  const safeBundle = _serializeBundleForFacet(vfsState.bundle);
  const safeManifest = JSON.stringify(vfsState.manifest);
  return `
import { WorkerEntrypoint } from "cloudflare:workers";
${REAL_NODE_IMPORTS}

const USER_CODE = ${safeCode};
const __NIMBUS_ARGS = ${safeArgs};
const __NimbusHostResponse = globalThis.Response;

function __mkCompiledFn(code) {
  function renameIfDeclared(name) {
    const re = new RegExp("(?:^|\\\\n|;)\\\\s*(?:const|let|var|function|class)\\\\s+" + name + "\\\\b", "m");
    return re.test(code) ? name + "__nimbus_unused" : name;
  }
  const baseParams = [
    "exports", "require", "module",
    renameIfDeclared("__filename"),
    renameIfDeclared("__dirname"),
  ];
  return new Function(...baseParams, code);
}

let __compiledFn = null;
let __entryCompileFailure = null;
try {
  __compiledFn = __mkCompiledFn(USER_CODE);
} catch (__e) {
  __entryCompileFailure = (__e && __e.stack) || (__e && __e.message) || String(__e);
}

const __MODULE_VFS_BUNDLE = ${safeBundle};
const __MODULE_VFS_MANIFEST = ${safeManifest};
const __compiledModules = new Map();
const __compileFailures = new Map();
for (const [__p, __c] of Object.entries(__MODULE_VFS_BUNDLE)) {
  if (__p.endsWith(".js") || __p.endsWith(".mjs") || __p.endsWith(".cjs")) {
    try {
      __compiledModules.set(__p, __mkCompiledFn(__c));
    } catch (__e) {
      __compileFailures.set(__p, __e && __e.message ? __e.message : String(__e));
    }
  }
}

class __ProcessExit extends Error {
  constructor(code) { super("process.exit(" + code + ")"); this.code = code; }
}

let __nimbusStarted = false;
let __nimbusStarting = null;
let __nimbusRuntime = null;
let __nimbusAttachedLifecycle = null;

async function __nimbusFlushRuntime() {
  const rt = __nimbusRuntime;
  if (!rt) return;
  if (rt.supervisor && Object.keys(rt.vfsWrites).length > 0) {
    for (const [path, content] of Object.entries(rt.vfsWrites)) {
      rt.pendingIO.push(rt.supervisor.writeFile(path, content).catch(() => {}));
    }
  }
  for (let pass = 0; pass < 12; pass++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (rt.pendingIO.length <= rt.settledIO) break;
    const slice = rt.pendingIO.slice(rt.settledIO);
    rt.settledIO = rt.pendingIO.length;
    await Promise.allSettled(slice);
  }
}

async function __nimbusEnsureStarted(workerEnv, workerCtx) {
  if (__nimbusStarted) return;
  if (__nimbusStarting) return __nimbusStarting;
  __nimbusStarting = (async () => {
    const args = __NIMBUS_ARGS;
    const { argv, env, cwd: _cwd, filename, dirname, stdin, captureOutput, attachedTty } = args;
    const __vfsBundle = __MODULE_VFS_BUNDLE;
    const __vfsManifest = __MODULE_VFS_MANIFEST;
    const __supervisor = workerEnv?.SUPERVISOR || null;
    const __pendingIO = [];
    let __rpcDrops = 0;
    let __rpcDropBytes = 0;
    let __rpcLastError = "";
    const __onRpcDrop = (bytes, e) => {
      __rpcDrops++;
      __rpcDropBytes += bytes | 0;
      if (e) __rpcLastError = (e && e.message) || String(e);
    };
    let __rpcWriteChain = Promise.resolve();
    const __queueRpcWrite = (method, s) => {
      const __task = __rpcWriteChain
        .then(() => __supervisor[method](s))
        .catch((e) => __onRpcDrop(s.length, e));
      __rpcWriteChain = __task.then(() => {}, () => {});
      __pendingIO.push(__task);
    };
    let cwd = _cwd || "/home/user";
    let stdout = "", stderr = "";
    let exitCode = 0;
    const __vfsWrites = {};
    const __vfsDirs = {};

${SHIMS}

${ENTRYPOINT_PROMISE_TRACKER}
${ENTRYPOINT_STARTUP_DRAIN}

    if (__supervisor && !captureOutput) {
      __consoleMod.log = (...a) => { const s = __utilMod.format(...a) + "\\n"; stdout += s; __queueRpcWrite("stdout", s); };
      __consoleMod.error = (...a) => { const s = __utilMod.format(...a) + "\\n"; stderr += s; __queueRpcWrite("stderr", s); };
      __consoleMod.warn = __consoleMod.error;
      __consoleMod.info = __consoleMod.log;
      __consoleMod.debug = __consoleMod.log;
      __processMod.stdout.write = (d, enc, cb) => { if (typeof enc === "function") cb = enc; const s = String(d); stdout += s; __queueRpcWrite("stdout", s); if (typeof cb === "function") queueMicrotask(cb); return true; };
      __processMod.stderr.write = (d, enc, cb) => { if (typeof enc === "function") cb = enc; const s = String(d); stderr += s; __queueRpcWrite("stderr", s); if (typeof cb === "function") queueMicrotask(cb); return true; };
    }

    try { globalThis.console = __consoleMod; } catch {}
    try { globalThis.process = __processMod; } catch {}
    try { globalThis.Buffer = __BufferMod; } catch {}
    try { globalThis.global = globalThis; } catch {}
    if (attachedTty) {
      try { __processMod.stdin.__nimbusStartLivePump?.(); } catch {}
    }

    const mod = { exports: {} };
    __require.main = mod;
    let __attachedCompletion = null;
    let __attachedExplicitExit = false;
    try {
      if (__entryCompileFailure) throw new Error(__entryCompileFailure);
      if (!__compiledFn) throw new Error("entrypoint compile failed");
      const __entryPromises = __makeEntrypointPromiseTracker();
      let __entryResult;
      __entryPromises.start();
      try {
        __entryResult = __compiledFn(
          mod.exports, __require, mod, filename || "/home/user/script.js", dirname || "/home/user"
        );
      } finally {
        __entryPromises.stop();
      }
      __entryPromises.track(__entryResult);
      if (__entryResult && typeof __entryResult.then === "function") {
        if (attachedTty) __attachedCompletion = __entryResult;
      }
      if (attachedTty) {
        await __entryPromises.drain(__nimbusProcessExitPromise, 1000, 8);
      } else {
        await __nimbusDrainEntrypointStartup(__entryResult, __entryPromises);
        if (__nimbusProcessExitCode !== null) exitCode = __nimbusProcessExitCode;
      }
    } catch (e) {
      if (e instanceof __ProcessExit) {
        __attachedExplicitExit = true;
        exitCode = e.code;
      } else {
        const trace = (e && e.stack) || (e && e.message) || String(e);
        stderr += trace + "\\n";
        exitCode = 1;
        if (__supervisor && !captureOutput) {
          try { __pendingIO.push(__supervisor.stderr(trace + "\\n").catch((e2) => __onRpcDrop((trace || "").length + 1, e2))); } catch {}
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    __nimbusRuntime = {
      supervisor: __supervisor,
      pendingIO: __pendingIO,
      settledIO: 0,
      vfsWrites: __vfsWrites,
    };
    await __nimbusFlushRuntime();

    if (attachedTty && !__attachedExplicitExit) {
      const __attachedLifecycle = (async () => {
        if (__attachedCompletion) {
          const __exitMarker = {};
          const __result = await Promise.race([
            __attachedCompletion.then(() => null),
            __nimbusProcessExitPromise.then(() => __exitMarker),
          ]);
          if (__result === __exitMarker) return;
        } else {
          await __nimbusProcessExitPromise;
        }
        await __nimbusFlushRuntime();
        if (__supervisor && !__nimbusProcessExitReported) {
          await __supervisor.reportExit(0, "");
        }
      })().catch(async (e) => {
        if (e instanceof __ProcessExit) {
          await __nimbusFlushRuntime();
          if (!__nimbusProcessExitReported) {
            __nimbusReportProcessExit(e.code, "");
          }
          return;
        }
        const trace = (e && e.stack) || (e && e.message) || String(e);
        stderr += trace + "\\n";
        if (__supervisor) {
          try { await __supervisor.stderr(trace + "\\n"); } catch {}
          await __supervisor.reportExit(1, trace + "\\n");
        }
      });
      __nimbusAttachedLifecycle = __attachedLifecycle;
      workerCtx.waitUntil(__attachedLifecycle);
    } else if (attachedTty && __attachedExplicitExit && __supervisor) {
      if (!__nimbusProcessExitReported) await __supervisor.reportExit(exitCode, stderr);
    }

    if (__rpcDrops > 0 && __supervisor) {
      const tail = "[orphan output: " + __rpcDrops + " dropped RPC write(s), ~" +
        __rpcDropBytes + " bytes lost" +
        (__rpcLastError ? "; last error: " + __rpcLastError : "") + "]\\n";
      try { await __supervisor.stderr(tail); } catch {}
    }
    if (exitCode !== 0) {
      if (__supervisor && !__nimbusProcessExitReported) {
        await __supervisor.reportExit(exitCode, stderr || ("exit " + exitCode + "\\n"));
      }
      throw new Error(stderr || ("long-running node startup exited " + exitCode));
    }
    __nimbusStarted = true;
  })();
  return __nimbusStarting;
}

async function __nimbusDispatchHttp(req, workerEnv, workerCtx) {
  const url = new URL(req.url);
  await __nimbusEnsureStarted(workerEnv, workerCtx);
  const ports = globalThis.__portRegistry;
  const hinted = Number(req.headers.get("X-Nimbus-Port") || 0);
  const server = ports && (ports.get(hinted) || ports.values().next().value);
  if (!server || typeof server._handleRequest !== "function") {
    return new __NimbusHostResponse("Nimbus: no HTTP server is listening in this process", { status: 502 });
  }
  const headers = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  let body = "";
  if (req.method !== "GET" && req.method !== "HEAD") body = await req.text();
  const res = server._handleRequest(url.pathname + url.search, req.method, headers, body);
  if (!res._ended) {
    await new Promise((resolve) => {
      try { res.on("finish", resolve); } catch { resolve(); }
      setTimeout(resolve, 5000);
    });
  }
  await __nimbusFlushRuntime();
  return new __NimbusHostResponse((res._body || []).join(""), { status: res.statusCode || 200, headers: res.headers || {} });
}

export class NimbusNodeProcess extends WorkerEntrypoint {
  async startProcess() {
    await __nimbusEnsureStarted(this.env, this.ctx);
    if (__nimbusAttachedLifecycle) await __nimbusAttachedLifecycle;
    return { ok: true };
  }
  async fetch(req) { return __nimbusDispatchHttp(req, this.env, this.ctx); }
  async handleHttpRequest(req) { return __nimbusDispatchHttp(req, this.env, this.ctx); }
}
export default NimbusNodeProcess;
`;
}

// ── VFS bundler ─────────────────────────────────────────────────────────

/**
 * Result of preparing facet VFS state.
 *   - bundle:   path → utf8 content for the files reachable from the
 *               entry's require() chain plus a greedy oversample of
 *               every installed package's package.json + main entry.
 *               Content cap is on the JSON-encoded payload, not the raw
 *               byte sum (W2.6a §2.3 — workerd's per-module text-size
 *               budget applies to the JSON-stringified literal embedded
 *               in the dynamic worker module text, NOT the raw content
 *
 *   - manifest: path → child names map for directory listings (uncapped,
 *               unchanged from W2.5b). Walks the SqliteVFS regardless of
 *               the content cap so that fs.readdirSync / fs.statSync(dir)
 *               inside the facet see the *true* directory shape rather
 *               than just the subset that fit in the content bundle.
 *
 * Sizing: a manifest entry is one short string per file/dir name. For
 * 1928 files / 319 dirs (fastify install) total manifest JSON is ~50 KiB
 * — three orders of magnitude smaller than the content bundle.
 */
interface FacetVfsState {
  // hardening-r5: bundle cells may be Uint8Array for binary content
  // (images, wasm modules, sqlite blobs, etc.). Pre-fix every cell was
  // forced through vfs.readFileString() which UTF-8-decoded binary
  // bytes ≥ 0x80 to U+FFFD; the JSON-embedded module form then
  // serialized U+FFFD as 3 bytes (EF BF BD), and a cross-process
  // read returned 3× the original byte count. See
  // for the canonical 256→512 byte demo.
  bundle: Record<string, string | Uint8Array>;
  manifest: Record<string, string[]>;
  /** Diagnostics: how many files survived the cap (post-greedy-oversample). */
  reachableCount: number;
  /** Diagnostics: was the bundle truncated by the encoded-size cap? */
  truncated: boolean;
}

/**
 * hardening-r5: read a file from the VFS and decide whether to keep it
 * as a string (valid UTF-8 text — the hot path for source code,
 * package.json, configs) or as Uint8Array bytes (binary — wasm
 * modules, images, sqlite blobs, etc.).
 *
 * Strategy: read bytes, attempt a fatal UTF-8 decode. If decode
 * succeeds the file IS valid UTF-8 and the string round-trips
 * losslessly through JSON; return string. If decode throws (any
 * invalid byte sequence) return Uint8Array.
 *
 * Throws on read errors (caller wraps in try/catch — matches the
 * pre-fix readFileString contract).
 */
function _readBundleCell(
  vfs: { readFile(p: string): Uint8Array },
  path: string,
): string | Uint8Array {
  const bytes = vfs.readFile(path);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes;
  }
}

/**
 * hardening-r5: byte-length of a bundle cell for budget accounting.
 * Strings counted as char-length (a slight under-count for non-ASCII
 * but matches the pre-fix behaviour); Uint8Array counted as byteLength.
 */
function _bundleCellLength(cell: string | Uint8Array): number {
  return typeof cell === 'string' ? cell.length : cell.byteLength;
}

/**
 * hardening-r5: emit a JS expression that, when evaluated inside the
 * facet's module-init context, yields a `Record<string, string |
 * Uint8Array>` with binary cells revived from base64. Strings stay as
 * JSON strings (the hot path). Binary cells become `{ __b64: "..." }`
 * markers and are revived by a tiny inline loop.
 *
 * The output is a SELF-EXECUTING IIFE expression so it can be substituted
 * directly into `const __MODULE_VFS_BUNDLE = ${expr};` template slots.
 */
function _serializeBundleForFacet(bundle: Record<string, string | Uint8Array>): string {
  const strCells: Record<string, string> = {};
  const binCells: Record<string, string> = {};
  for (const [k, v] of Object.entries(bundle)) {
    if (typeof v === 'string') {
      strCells[k] = v;
    } else {
      // Uint8Array → base64. btoa requires a binary string; we build it
      // 8K chars at a time to avoid String.fromCharCode argument-count
      // limits on large files (~1MB+).
      let bin = '';
      const CHUNK = 8192;
      for (let i = 0; i < v.byteLength; i += CHUNK) {
        bin += String.fromCharCode.apply(
          null,
          Array.from(v.subarray(i, Math.min(i + CHUNK, v.byteLength))),
        );
      }
      binCells[k] = btoa(bin);
    }
  }
  // The IIFE revives binary cells in-place. atob → binary string →
  // Uint8Array (Uint8Array.from(str, c=>c.charCodeAt(0))).
  // Note: when binCells is empty (the overwhelming common case —
  // source code is all text) the IIFE collapses to a JSON literal,
  // costing only the IIFE wrapper bytes (~30) per facet boot.
  return `(function(){const __b=${JSON.stringify(strCells)};const __x=${JSON.stringify(binCells)};for(const __k in __x){__b[__k]=Uint8Array.from(atob(__x[__k]),__c=>__c.charCodeAt(0));}return __b;})()`;
}

const MANIFEST_MAX_DEPTH = 12;

/**
 * Build the manifest pass — uncapped path→child-names map. UNCHANGED
 * from W2.5b; this is the W2.5b root-cause fix and continues to keep
 * fs.readdirSync / fs.statSync honest regardless of which subset of
 * file CONTENT we ship.
 */
function buildManifest(
  vfs: SqliteVFS,
  cwd: string,
  scriptPath?: string,
): Record<string, string[]> {
  const manifest: Record<string, string[]> = {};
  function walk(dirPath: string, depth = 0) {
    if (depth > MANIFEST_MAX_DEPTH) return;
    const stripped = dirPath.replace(/^\/+/, '');
    if (stripped in manifest) return;
    let entries: { name: string; type: string }[];
    try { entries = vfs.readdir(stripped); }
    catch { return; }
    manifest[stripped] = entries.map((e) => e.name);
    for (const entry of entries) {
      if (entry.type === 'directory') {
        const childPath = stripped ? stripped + '/' + entry.name : entry.name;
        walk(childPath, depth + 1);
      }
    }
  }
  const cwdStripped = cwd.replace(/^\/+/, '');
  walk(cwdStripped, 0);
  const nmDir = cwdStripped + '/node_modules';
  if (vfs.exists(nmDir) && vfs.isDirectory(nmDir)) {
    walk(nmDir, 0);
  }
  // ── Bin-target package root (e.g. /tmp/.npx-cache/node_modules/<pkg>/) ──
  //
  // When the entry script lives in a node_modules outside cwd (npx-cache
  // packages, globally-installed bins, etc.), buildManifest's cwd walk
  // misses the package's sibling files. The bin's index.js gets
  // require-walked + greedy-added to the BUNDLE, but the MANIFEST
  // (which is the source of truth for `fs.readdirSync`) was empty for
  // those paths — so `readdirSync('/tmp/.npx-cache/.../template-X')`
  // returned [] and `create-vite` scaffolded zero files.
  //
  // Walk the innermost `node_modules/<pkg>/` of `scriptPath` so its
  // entire package tree is enumerable via readdir. Bounded by
  // MANIFEST_MAX_DEPTH; same depth budget as the cwd walk.
  if (scriptPath) {
    const sp = scriptPath.replace(/^\/+/, '');
    const segs = sp.split('/');
    let nmIdx = -1;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i] === 'node_modules') { nmIdx = i; break; }
    }
    if (nmIdx >= 0) {
      const isScoped = segs[nmIdx + 1]?.startsWith('@');
      const pkgEnd = isScoped ? nmIdx + 3 : nmIdx + 2;
      if (pkgEnd <= segs.length) {
        const pkgRoot = segs.slice(0, pkgEnd).join('/');
        if (vfs.exists(pkgRoot) && vfs.isDirectory(pkgRoot)) {
          walk(pkgRoot, 0);
        }
      }
    }
  }
  return manifest;
}

/**
 * Greedy-oversample every installed package's main entry. The static
 * prefetch via require-resolver covers the require() chain literally
 * present in source; greedy oversampling adds a safety net for dynamic
 * patterns the regex misses (jest/`bindings`/`import-local` style
 * computed-path requires). Bounded to package.json + 1 main-entry file
 * per package — sub-agent §Q3 quantified the worst-case cumulative
 * budget impact (~322 KiB for fastify, ~1.7 MiB for ts-jest).
 */
// can verify the hash-chunk + shared/ oversample directly. Pre-X.5-C this
// was a file-local helper. Adding the named export is a pure surface
// addition — no callers other than buildPrefetchBundle (same file) and
// the new probe.
export function greedyAddMainEntries(
  vfs: SqliteVFS,
  cwd: string,
  bundle: Record<string, string | Uint8Array>,
  budgetState: { totalBytes: number; fileCount: number },
): { added: number } {
  let added = 0;
  const cwdStripped = cwd.replace(/^\/+/, '');
  const nmDir = cwdStripped + '/node_modules';
  if (!(vfs.exists(nmDir) && vfs.isDirectory(nmDir))) return { added };

  const exts = ['', '.js', '.cjs', '.mjs', '/index.js', '/index.cjs'];

  function addOne(path: string): boolean {
    const stripped = path.replace(/^\/+/, '');
    if (stripped in bundle) return false;
    if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES) return false;
    if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES) return false;
    try {
      if (!vfs.exists(stripped) || vfs.isDirectory(stripped)) return false;
      // hardening-r5: preserve binary content as Uint8Array.
      const content = _readBundleCell(vfs, stripped);
      const cellLen = _bundleCellLength(content);
      if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES) return false;
      bundle[stripped] = content;
      budgetState.totalBytes += cellLen;
      budgetState.fileCount++;
      added++;
      return true;
    } catch { return false; }
  }

  // X.5-C Fix #2 helper: walk a (possibly nested) exports value and
  // collect every string-leaf path. unbuild-shaped packages like pathe
  // nest two deep — `exports."."`.{require,import}.{types,default} —
  // and the previous one-level loop only caught the inner string leaves
  // when default was at the top, missing the unbuild shape entirely.
  function collectExportLeaves(node: any, out: Set<string>): void {
    if (typeof node === 'string') { out.add(node); return; }
    if (!node || typeof node !== 'object') return;
    // Order matters for the "most likely usable" leaf: prefer require
    // (most CJS-friendly), then default, then node, then import. We add
    // ALL of them to the candidate set — addPkgEntry will probe each.
    for (const k of ['require', 'node', 'default', 'import']) {
      if (k in node) collectExportLeaves(node[k], out);
    }
  }

  function addPkgEntry(pkgDir: string) {
    addOne(pkgDir + '/package.json');
    let meta: any;
    try { meta = JSON.parse(vfs.readFileString(pkgDir + '/package.json')); }
    catch { meta = null; }
    const candidates = new Set<string>();
    if (meta) {
      if (typeof meta.main === 'string') candidates.add(meta.main);
      if (typeof meta.module === 'string') candidates.add(meta.module);
      const exp = meta.exports;
      if (typeof exp === 'string') candidates.add(exp);
      else if (exp && typeof exp === 'object') {
        const dot = (exp as any)['.'];
        // X.5-C Fix #2: walk nested condition trees recursively. Without
        // this, packages with two-level exports (pathe, magic-string,
        // most unbuild-emitted libs) miss their actual entry leaf and
        // greedyAddMainEntries falls back to /index.js probing — which
        // doesn't exist for those packages.
        collectExportLeaves(dot, candidates);
      }
    }
    if (candidates.size === 0) candidates.add('index.js');
    for (const rel of candidates) {
      const norm = rel.replace(/^\.\//, '');
      const base = pkgDir + '/' + norm;
      let landed = false;
      const tries = /\.[a-z]+$/.test(norm) ? [base] : exts.map((e) => base + e);
      for (const candidate of tries) {
        if (vfs.exists(candidate.replace(/^\/+/, '')) &&
            !vfs.isDirectory(candidate.replace(/^\/+/, ''))) {
          if (addOne(candidate)) { landed = true; break; }
        }
      }
      if (landed) {
        // X.5-C Fix #2: when an entry lands, also pull in sibling files
        // that match unbuild's hash-chunk pattern (`<base>.<hash>.cjs|mjs|js`)
        // AND walk one level into a `shared/` subdir if the package has
        // one. The unbuild bundler emits chunked CJS like:
        //   dist/index.cjs        (entry)
        //   dist/shared/<base>.<hash>.cjs  (chunk required by entry)
        //
        // Without this, even when Fix #1 lets the prefetch walker reach
        // the entry, the package's required chunks land OUTSIDE the
        // walker's MAX_FILES/MAX_BYTES budget on big trees (nuxt 516
        // pkgs / 10k+ files). The greedy oversample is the defensive
        // safety net for hash-chunk reachability.
        const entryDir = base.replace(/\/[^/]+$/, '');
        try {
          const sibs = vfs.readdir(entryDir);
          for (const sib of sibs) {
            if (sib.type !== 'file') continue;
            // Hash-chunk pattern: <name>.<hash>.<cjs|mjs|js>. Hash must
            // be 6+ chars AND look like a hash, not an English word —
            // either contain digits/underscore/dash, or contain BOTH
            // uppercase AND lowercase letters (real bundler hashes are
            // mixed-case base64-shaped: `BSlhyZSM`, `M-eThtNZ`, ...). This
            // discriminator keeps us from false-positiving on common
            // suffixes that happen to be 6+ chars all-lowercase like
            // `minified`, `modern`, `production`, `compiled`.
            const hashMatch = sib.name.match(/\.([A-Za-z0-9_-]{6,})\.(cjs|mjs|js)$/);
            if (!hashMatch) continue;
            const seg = hashMatch[1];
            const hasDigitOrDash = /[0-9_-]/.test(seg);
            const hasMixedCase = /[A-Z]/.test(seg) && /[a-z]/.test(seg);
            if (!hasDigitOrDash && !hasMixedCase) continue;
            addOne(entryDir + '/' + sib.name);
          }
          // Walk one level into `shared/` — unconditionally, since the
          // pattern is well-known across unbuild/rolldown/rollup chunked
          // outputs. Bounded by addOne's budget checks; readdir of a
          // typical shared/ dir returns 1-5 files.
          const sharedDir = entryDir + '/shared';
          const sharedStripped = sharedDir.replace(/^\/+/, '');
          if (vfs.exists(sharedStripped) && vfs.isDirectory(sharedStripped)) {
            for (const sh of vfs.readdir(sharedDir)) {
              if (sh.type !== 'file') continue;
              if (!/\.(cjs|mjs|js)$/.test(sh.name)) continue;
              addOne(sharedDir + '/' + sh.name);
            }
          }
        } catch { /* unreadable dir — drop sibling oversample, entry
                       file is enough */ }
        break;
      }
    }
  }

  try {
    for (const pkg of vfs.readdir(nmDir)) {
      if (pkg.type !== 'directory') continue;
      const pkgDir = nmDir + '/' + pkg.name;
      if (pkg.name.startsWith('@')) {
        try {
          for (const sub of vfs.readdir(pkgDir)) {
            if (sub.type === 'directory') addPkgEntry(pkgDir + '/' + sub.name);
          }
        } catch { /* ignore */ }
      } else {
        addPkgEntry(pkgDir);
      }
    }
  } catch { /* ignore */ }
  return { added };
}

/**
 * X.5-Z3: scan every JS source already in `bundle` for static
 * `fs.readFileSync(path.resolve(__dirname, "<rel>"))` shapes and pull
 * the matched asset files (.css / .html / .htm / .svg / .txt / .json)
 * into the bundle. The motivating case is jsdom's
 * `lib/jsdom/living/css/helpers/computed-style.js:16-19`, which loads
 * `default-stylesheet.css` at module-eval time:
 *
 *   const defaultStyleSheet = fs.readFileSync(
 *     path.resolve(__dirname, "../../../browser/default-stylesheet.css"),
 *     { encoding: "utf-8" },
 *   );
 *
 * The fs shim's `readFileSync` (`src/node-shims.ts:202-215`) consults
 * only `__vfsBundle` + `__vfsWrites`; runtime asset files that the
 * require-graph walker doesn't reach (it's bounded to .js/.mjs/.cjs)
 * are absent from the bundle and ENOENT at runtime. This helper closes
 * that gap as a sibling of `greedyAddMainEntries` (W2.6a) +
 * `transformEsmInBundle` (W3.5 Fix B).
 *
 * Pattern matched: literal-only, conservative.
 *
 *   fs.readFileSync(path.resolve(__dirname, "<rel>"), …)
 *   readFileSync(path.resolve(__dirname, "<rel>"), …)
 *
 * `<rel>` is a string literal (single, double, OR backtick — provided
 * the backtick form has no `${}` interpolation). Template-literal,
 * variable, and concatenation forms are **deliberately skipped** —
 * they're an unbounded class. Comment-stripped first to avoid
 * matching the pattern inside `//` / `/* *​/`.
 *
 * Returns the count of asset files added (for diagnostics). Errors
 * are swallowed: missing assets, unreadable VFS, and non-string
 * readFile inputs are silent skips.
 *
 * Same budget shape as `greedyAddMainEntries` — shares the same
 * VFS_BUNDLE_MAX_FILES / VFS_BUNDLE_MAX_BYTES caps via the
 * `budgetState` counter.
 */
export function addStaticReadFileAssets(
  vfs: SqliteVFS,
  cwd: string,
  bundle: Record<string, string | Uint8Array>,
  budgetState: { totalBytes: number; fileCount: number },
): { added: number } {
  let added = 0;
  // Asset extensions covered. Conservative whitelist — txt/json are
  // also legit runtime-loaded assets (e.g. mime-db json, license.txt).
  // .json is already typically reachable via `require('./x.json')` so
  // it's mostly defensive here.
  const ASSET_EXT = /\.(css|html|htm|svg|txt|json)$/i;
  // Match the static-literal shape. The capture groups are:
  //   1 = the relative path string literal contents (no quote chars).
  // Shape:
  //   readFileSync(  path.resolve(  __dirname  ,  "rel"  )
  //   fs.readFileSync(path.resolve(__dirname, "rel"), …)
  //   node:path / "node:path" forms also covered by allowing optional
  //   leading `\w+\.` prefix on the resolve target.
  // Quote chars supported: ' " `. For backtick we additionally check
  // there's no `${` in the captured body (template-literal interpolation
  // is rejected).
  const RX = /(?:\bfs\s*\.)?readFileSync\s*\(\s*(?:[\w$.]+\s*\.\s*)?resolve\s*\(\s*__dirname\s*,\s*(['"`])([^'"`]+)\1\s*[\),]/g;

  function addOneAsset(absPath: string): boolean {
    const stripped = absPath.replace(/^\/+/, '');
    if (stripped in bundle) return false;
    if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES) return false;
    if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES) return false;
    try {
      if (!vfs.exists(stripped) || vfs.isDirectory(stripped)) return false;
      // hardening-r5: preserve binary content as Uint8Array.
      const content = _readBundleCell(vfs, stripped);
      const cellLen = _bundleCellLength(content);
      if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES) return false;
      bundle[stripped] = content;
      budgetState.totalBytes += cellLen;
      budgetState.fileCount++;
      added++;
      return true;
    } catch { return false; }
  }

  // Snapshot the keys first — we mutate `bundle` during the loop.
  const sourceKeys = Object.keys(bundle).filter((k) =>
    k.endsWith('.js') || k.endsWith('.mjs') || k.endsWith('.cjs'),
  );

  for (const sourcePath of sourceKeys) {
    const src = bundle[sourcePath];
    if (!src || src.length === 0) continue;
    // hardening-r5: skip binary cells (a .js extension on a binary file
    // is rare but possible — defensive guard prevents .replace() throwing
    // on a Uint8Array).
    if (typeof src !== 'string') continue;
    // Strip line + block comments before regex-matching so the pattern
    // doesn't fire inside `// fs.readFileSync(...)` etc.
    const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Quick reject: skip files that don't even contain readFileSync.
    if (stripped.indexOf('readFileSync') < 0) continue;
    const sourceDir = sourcePath.includes('/')
      ? sourcePath.substring(0, sourcePath.lastIndexOf('/'))
      : '';
    RX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RX.exec(stripped)) !== null) {
      const quote = match[1];
      const rel = match[2];
      // Reject template-literal interpolation inside backticks.
      if (quote === '`' && rel.indexOf('${') >= 0) continue;
      // Reject any form that looks dynamic (defensive — RX already
      // requires literal but absolute paths starting with `/` would
      // bypass the __dirname-relative semantics; allow them since
      // they're literal and unambiguous).
      if (!ASSET_EXT.test(rel)) continue;
      // Resolve relative to the source file's directory (the runtime's
      // __dirname for that source). Match runtime resolution: leading
      // `./` strips, `..` walks up.
      let resolved: string;
      if (rel.startsWith('/')) {
        resolved = rel.replace(/^\/+/, '');
      } else {
        const parts = (sourceDir + '/' + rel).split('/');
        const out: string[] = [];
        for (const seg of parts) {
          if (seg === '' || seg === '.') continue;
          if (seg === '..') { if (out.length > 0) out.pop(); continue; }
          out.push(seg);
        }
        resolved = out.join('/');
      }
      addOneAsset(resolved);
    }
  }

  return { added };
}

/**
 * X.5-U: scan every JS source already in `bundle` for static
 * readFileSync of a `__dirname`-relative dotfile or "digest/hash/version/
 * sha/md5"-shaped sentinel, AND match the SWC/TypeScript-compiled
 * `(0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, "<rel>"))`
 * call shape that X.5-Z3's `addStaticReadFileAssets` regex misses.
 *
 * Motivating case: ts-jest@29.x's
 * `package/dist/legacy/config/config-set.js:105`:
 *
 *   var fs_1 = require("fs");
 *   var path_1 = require("path");
 *   exports.MY_DIGEST = (0, fs_1.readFileSync)(
 *     (0, path_1.resolve)(__dirname, '../../../.ts-jest-digest'), 'utf8');
 *
 * The install pipeline writes `.ts-jest-digest` to VFS correctly
 * (manifest pass at buildManifest enumerates it). But the runtime
 * fs shim's readFileSync (`src/node-shims.ts:202-215`) consults
 * `__vfsBundle` only, and none of the existing bundle-population
 * passes — `prefetchForRequire` (require-graph), `greedyAddMainEntries`
 * (pkg main entries), `addStaticReadFileAssets` (X.5-Z3, restricted to
 * `.css|html|svg|txt|json` and to direct `path.resolve(__dirname,…)`)
 * — picks the dotfile up. Result: ENOENT at facet runtime even though
 * `fs.readdirSync` and `fs.statSync` both see the file via the manifest.
 *
 * Bounded heuristic: filename must EITHER start with `.` (dotfile) OR
 * match `/digest|hash|version|sha|md5/i` (small-metadata-sentinel
 * pattern). Without this gate, an unconstrained "match any
 * __dirname-relative readFileSync filename" would pull arbitrary large
 * runtime-loaded files (compiled WASM, JSON dictionaries, …) on
 * packages that read them via this exact shape — bundle bloat with no
 * payoff. The heuristic narrows to the ts-jest class. Trade-off
 * documented; future packages outside this shape can extend the
 * predicate.
 *
 * Quote chars supported: `'`, `"`, and backticks WITHOUT `${}`
 * interpolation. Dynamic specifiers (variable, concatenation,
 * interpolation) are deliberately skipped.
 *
 * Same budget shape as `greedyAddMainEntries` /
 * `addStaticReadFileAssets` — shares the same VFS_BUNDLE_MAX_FILES /
 * VFS_BUNDLE_MAX_BYTES caps via `budgetState`. Returns the count of
 * files added (for diagnostics).
 *
 * Errors are swallowed: missing assets, unreadable VFS, and
 * non-string readFile inputs are silent skips — matches Z3 posture.
 */
export function addStaticReadFileDotfilesAndCompiled(
  vfs: SqliteVFS,
  cwd: string,
  bundle: Record<string, string | Uint8Array>,
  budgetState: { totalBytes: number; fileCount: number },
): { added: number } {
  let added = 0;

  // The heuristic gate. Filenames matching either branch are eligible.
  //   - Leading `.` covers `.ts-jest-digest`, `.cache-marker`, `.lintstagedrc`-ish
  //     sentinel files. Note: `package.json` etc are NOT dotfiles.
  //   - `digest|hash|version|sha|md5` covers compiled-loose sentinel
  //     filenames like `version.txt`, `git-sha`, `build-hash`, …
  //     (Phase B regression matrix §5: bounded to the actual class.)
  const FILENAME_GATE = /(^\.[^/]+$|digest|hash|version|sha|md5)/i;

  // Match shapes:
  //   readFileSync(path.resolve(__dirname, "<rel>"))                  (X.5-Z3)
  //   fs.readFileSync(path.resolve(__dirname, "<rel>"))               (X.5-Z3)
  //   (0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, "<rel>")) (X.5-U new — SWC)
  //   readFileSync(path.join(__dirname, "<rel>"))                     (X.5-U new — join also)
  //   readFileSync((0, path_1.resolve)(__dirname, "<rel>"))            (mixed)
  //
  // Strategy: anchor the ENTIRE call on `readFileSync` (with optional
  // `(0, x.y)` wrap or `x.` prefix), then look for either `resolve` OR
  // `join` (with optional `(0, x.y)` wrap or `x.` prefix), then
  // `__dirname` and the literal. Capture group 1 = quote, group 2 =
  // body.
  //
  // The regex is permissive about whitespace + parens because
  // SWC/TypeScript emit varies (extra parens in some output flags,
  // tighter spacing in production). Tested against:
  //   ts-jest@29.1.4/dist/legacy/config/config-set.js:105
  //   synth `(0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, "X"))`
  //   plain `fs.readFileSync(path.resolve(__dirname, "X"))`
  //   plain `readFileSync(path.join(__dirname, "X"))`
  const RX = new RegExp(
    // optional `(0, ` wrap then `<x.>?readFileSync` or bare `readFileSync`
    '(?:\\(\\s*0\\s*,\\s*)?(?:[\\w$]+\\s*\\.\\s*)?readFileSync\\s*\\)?\\s*\\(' +
      // call args: optional outer paren, optional `(0, ` wrap then
      // `<x.>?(resolve|join)` then required `(`
      '\\s*(?:\\(\\s*0\\s*,\\s*)?(?:[\\w$]+\\s*\\.\\s*)?(?:resolve|join)\\s*\\)?\\s*\\(' +
      // required __dirname
      '\\s*__dirname\\s*,\\s*' +
      // literal: ' " ` (no ${ for backtick)
      '([\'"`])([^\'"`]+)\\1',
    'g',
  );

  function addOneAsset(absPath: string): boolean {
    const stripped = absPath.replace(/^\/+/, '');
    if (stripped in bundle) return false;
    if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES) return false;
    if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES) return false;
    try {
      if (!vfs.exists(stripped) || vfs.isDirectory(stripped)) return false;
      // hardening-r5: preserve binary content as Uint8Array.
      const content = _readBundleCell(vfs, stripped);
      const cellLen = _bundleCellLength(content);
      if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES) return false;
      bundle[stripped] = content;
      budgetState.totalBytes += cellLen;
      budgetState.fileCount++;
      added++;
      return true;
    } catch { return false; }
  }

  // Snapshot keys; we mutate `bundle` during the loop.
  const sourceKeys = Object.keys(bundle).filter((k) =>
    k.endsWith('.js') || k.endsWith('.mjs') || k.endsWith('.cjs'),
  );

  for (const sourcePath of sourceKeys) {
    const src = bundle[sourcePath];
    if (!src || src.length === 0) continue;
    // hardening-r5: skip binary cells (a .js extension on a binary file
    // is rare but possible — defensive guard prevents .replace() throwing
    // on a Uint8Array).
    if (typeof src !== 'string') continue;
    // Strip line + block comments before regex-matching so the pattern
    // doesn't fire inside `// fs.readFileSync(...)` etc.
    const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Quick reject: skip files that don't even contain readFileSync.
    if (stripped.indexOf('readFileSync') < 0) continue;
    const sourceDir = sourcePath.includes('/')
      ? sourcePath.substring(0, sourcePath.lastIndexOf('/'))
      : '';
    RX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RX.exec(stripped)) !== null) {
      const quote = match[1];
      const rel = match[2];
      // Reject template-literal interpolation inside backticks.
      if (quote === '`' && rel.indexOf('${') >= 0) continue;

      // Resolve relative to the source file's __dirname (matches runtime).
      let resolved: string;
      if (rel.startsWith('/')) {
        resolved = rel.replace(/^\/+/, '');
      } else {
        const parts = (sourceDir + '/' + rel).split('/');
        const out: string[] = [];
        for (const seg of parts) {
          if (seg === '' || seg === '.') continue;
          if (seg === '..') { if (out.length > 0) out.pop(); continue; }
          out.push(seg);
        }
        resolved = out.join('/');
      }

      // Apply the bounded-heuristic gate on the BASENAME so we don't
      // overshoot. Z3's `ASSET_EXT` filter overlaps but doesn't cover
      // dotfiles or no-extension sentinels, which is X.5-U's class.
      const slash = resolved.lastIndexOf('/');
      const basename = slash >= 0 ? resolved.slice(slash + 1) : resolved;
      if (!FILENAME_GATE.test(basename)) continue;

      addOneAsset(resolved);
    }
  }

  return { added };
}

/**
 * G3 (runtime-pkg wave) — bin-target sibling oversample.
 *
 * When the entry script lives at `node_modules/<pkg>/...` (typical
 * shape: cli.js, bin/foo, dist/index.js), bins commonly do
 * `readFileSync(path.join(__dirname, '<rel>'))` to load assets that
 * the static walker can't see (computed paths, package-internal
 * data files, .cow / .pem / .wasm / .ttf / etc.).
 *
 * Pre-fix: addStaticReadFileAssets only covers a hardcoded ASSET_EXT
 * whitelist (.css/.html/.htm/.svg/.txt/.json). Cowsay's `.cow` files
 * ENOENT at runtime.
 *
 * Fix shape: when entry is inside a `node_modules/<pkg>` directory,
 * walk that pkg dir's contents and pull runtime package files under
 * VFS_BUNDLE_MAX_BYTES, capped at `MAX_PKG_FILES` per-pkg so a
 * 1000-file barrel package can't blow the bundle budget. Scaffold
 * bundle profile keeps full package-template access for `create-*`
 * initializers.
 *
 * Runtime profile skips docs/examples/source maps/images, while scaffold
 * profile preserves initializer template trees.
 *
 * Caller already passed the `cwd` and the `scriptPath`; we only act
 * if scriptPath is /<...>/node_modules/<pkg>/... — anything else
 * (user scripts, npx-cache files outside node_modules, eval) is
 * a no-op.
 */
function addBinTargetSiblings(
  vfs: SqliteVFS,
  scriptPath: string | undefined,
  bundle: Record<string, string | Uint8Array>,
  budgetState: { totalBytes: number; fileCount: number },
  bundleProfile: FacetBundleProfile,
): { added: number } {
  if (!scriptPath) return { added: 0 };
  const stripped = scriptPath.replace(/^\/+/, '');
  // Find the *innermost* node_modules/<pkg> root. Handles scoped
  // packages (`@org/name`) too.
  const segs = stripped.split('/');
  let nmIdx = -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i] === 'node_modules') { nmIdx = i; break; }
  }
  if (nmIdx < 0) return { added: 0 };
  const isScoped = segs[nmIdx + 1]?.startsWith('@');
  const pkgEnd = isScoped ? nmIdx + 3 : nmIdx + 2;
  if (pkgEnd > segs.length) return { added: 0 };
  const pkgRoot = segs.slice(0, pkgEnd).join('/');

  // npm-create-fix wave (2026-05-12): scaffold profile needs this cap
  // high enough to cover
  // multi-template scaffolds. create-vite ships 242 files + 74 dirs (316
  // visit entries) across 21 template-* subdirs; the 200-cap exhausted
  // BFS budget before late-alphabetical template files (vanilla, vue, etc.)
  // were bundled, causing readFileSync ENOENT in the facet and silent
  // partial scaffolding (only .gitignore + index.html materialized for
  // `npm create vite@latest test-vite -- --template vanilla`).
  //
  // 1000 covers the documented create-* family (create-vite ~316, create-
  // nuxt ~700, create-react-router ~400). Still well below the global
  // VFS_BUNDLE_MAX_FILES = 4000 (constants.ts:74) and the
  // VFS_BUNDLE_MAX_BYTES = 24 MiB content cap, both of which retain the
  // defense against pathological 4000+ file barrel packages.
  //
  // for the prior wave's empirical investigation (243 manifest entries,
  // only 140/243 readable pre-bump on prod 11df6ca).
  const MAX_PKG_FILES = 1000;

  // BFS walk pkgRoot. Skip nested `node_modules` (those are
  // separate packages with their own walk if/when they become
  // entry points).
  let added = 0;
  let visited = 0;
  const queue: string[] = [pkgRoot];
  while (queue.length > 0 && visited < MAX_PKG_FILES) {
    const dir = queue.shift()!;
    let entries: { name: string; type: string }[];
    try { entries = vfs.readdir(dir); } catch { continue; }
    for (const e of entries) {
      if (visited >= MAX_PKG_FILES) break;
      visited++;
      if (e.name === 'node_modules') continue;
      if (e.name === '.git') continue;
      const child = dir + '/' + e.name;
      if (e.type === 'directory') {
        if (!shouldVisitBinPackageDirectory(pkgRoot, child, bundleProfile)) continue;
        queue.push(child);
        continue;
      }
      // File. Skip if already in bundle (the static walker beat us
      // to it) or outside this profile's package-data policy.
      if (!shouldIncludeBinPackageFile(pkgRoot, child, bundleProfile)) continue;
      if (bundle[child] !== undefined) continue;
      if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES) return { added };
      if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES) return { added };
      // hardening-r5: preserve binary content as Uint8Array.
      let content: string | Uint8Array;
      try { content = _readBundleCell(vfs, child); } catch { continue; }
      const cellLen = _bundleCellLength(content);
      if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES) return { added };
      bundle[child] = content;
      budgetState.totalBytes += cellLen;
      budgetState.fileCount++;
      added++;
    }
  }
  return { added };
}

const RUNTIME_PACKAGE_EXCLUDED_ROOT_DIRS = new Set([
  'docs',
  'doc',
  'examples',
  'example',
  'test',
  'tests',
  '__tests__',
  'coverage',
  '.github',
]);

const RUNTIME_PACKAGE_EXCLUDED_FILE_SUFFIXES = [
  '.map',
  '.d.ts',
  '.d.ts.map',
  '.tsbuildinfo',
  '.md',
  '.markdown',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.mp4',
  '.mov',
  '.webm',
];

function shouldIncludeBinPackageFile(
  pkgRoot: string,
  path: string,
  bundleProfile: FacetBundleProfile,
): boolean {
  if (bundleProfile === 'scaffold') return true;

  if (RUNTIME_PACKAGE_EXCLUDED_ROOT_DIRS.has(binPackageRootSegment(pkgRoot, path))) return false;

  const lower = binPackageRelativePath(pkgRoot, path).toLowerCase();
  for (const suffix of RUNTIME_PACKAGE_EXCLUDED_FILE_SUFFIXES) {
    if (lower.endsWith(suffix)) return false;
  }
  return true;
}

function shouldVisitBinPackageDirectory(
  pkgRoot: string,
  path: string,
  bundleProfile: FacetBundleProfile,
): boolean {
  if (bundleProfile === 'scaffold') return true;
  return !RUNTIME_PACKAGE_EXCLUDED_ROOT_DIRS.has(binPackageRootSegment(pkgRoot, path));
}

function binPackageRootSegment(pkgRoot: string, path: string): string {
  const rel = binPackageRelativePath(pkgRoot, path);
  const firstSlash = rel.indexOf('/');
  return firstSlash >= 0 ? rel.slice(0, firstSlash) : rel;
}

function binPackageRelativePath(pkgRoot: string, path: string): string {
  return path.startsWith(pkgRoot + '/') ? path.slice(pkgRoot.length + 1) : path;
}

function addCwdProjectFiles(
  vfs: SqliteVFS,
  cwd: string,
  bundle: Record<string, string | Uint8Array>,
  budgetState: { totalBytes: number; fileCount: number },
): { added: number } {
  const root = (cwd || '/home/user').replace(/^\/+/, '').replace(/\/+$/, '') || 'home/user';
  const MAX_PROJECT_FILES = 512;
  const SKIP_DIRS = new Set(['node_modules', '.git', '.nimbus']);
  let added = 0;
  let visited = 0;
  const queue: string[] = [root];

  while (queue.length > 0 && visited < MAX_PROJECT_FILES) {
    const dir = queue.shift()!;
    let entries: { name: string; type: string }[];
    try { entries = vfs.readdir(dir); } catch { continue; }
    for (const e of entries) {
      if (visited >= MAX_PROJECT_FILES) break;
      visited++;
      if (e.name === '.' || e.name === '..') continue;
      if (e.type === 'directory' && SKIP_DIRS.has(e.name)) continue;
      const child = dir + '/' + e.name;
      if (e.type === 'directory') {
        queue.push(child);
        continue;
      }
      if (bundle[child] !== undefined) continue;
      if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES) return { added };
      if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES) return { added };
      let content: string | Uint8Array;
      try { content = _readBundleCell(vfs, child); } catch { continue; }
      const cellLen = _bundleCellLength(content);
      if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES) return { added };
      bundle[child] = content;
      budgetState.totalBytes += cellLen;
      budgetState.fileCount++;
      added++;
    }
  }
  return { added };
}

/**
 * shell compatibility (2026-05-11): scan entry code (and any already-bundled
 * .js/.mjs/.cjs sources) for ABSOLUTE-PATH string literals that look
 * like file reads. For every candidate that exists on the SqliteVFS,
 * pull it into the bundle so the facet's __vfsBundle can serve it.
 *
 * Pre-fix: `node -e 'fs.readFileSync("/home/user/x.txt")'` returned
 * ENOENT for files the shell could `cat`. The facet's bundle never
 * included `/home/user/x.txt` because no static scanner matched the
 * shape (greedy/dotfile/asset all required `path.resolve(__dirname,
 * "rel")` or `node_modules` pkg-root containment).
 *
 * Match policy:
 *   - String literals matching `/[^"`']+/` (slash-prefixed, no quotes
 *     inside), length 2-512 chars.
 *   - Reject paths under prefixes we don't mount (`/proc`, `/sys`,
 *     `/dev`, `/lib`, `/lib64`) — wouldn't resolve.
 *   - Reject paths containing `*` `?` `[` `]` `${` (glob/template).
 *   - File must exist on VFS, be a file (not a dir).
 *   - Defer to budgetState caps so we don't blow VFS_BUNDLE_MAX_BYTES.
 *
 * Quick-reject: only files containing readFileSync / createReadStream
 * / openSync / readFile in source are scanned. Entry code is always
 * scanned (it's the user's intent).
 */
function addEntryAbsPathReads(
  vfs: SqliteVFS,
  entryCode: string,
  bundle: Record<string, string | Uint8Array>,
  budgetState: { totalBytes: number; fileCount: number },
): { added: number } {
  let added = 0;
  // Capture absolute-path string literals. The path may not contain
  // the quote char; the surrounding regex strips line/block comments
  // first to avoid commented-out matches.
  // Path char set: alnum + dot + dash + slash + underscore. This
  // excludes spaces, glob chars, template syntax — all dynamic.
  const RX = /(['"`])(\/[A-Za-z0-9._\-\/]{1,510})\1/g;
  const REJECT_PREFIX = /^\/(proc|sys|dev|lib|lib64|boot|root)(\/|$)/;

  function tryAdd(absPath: string): void {
    if (!absPath || absPath.length < 2 || absPath.length > 512) return;
    if (REJECT_PREFIX.test(absPath)) return;
    const stripped = absPath.replace(/^\/+/, '');
    if (stripped in bundle) return;
    if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES) return;
    if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES) return;
    try {
      if (!vfs.exists(stripped) || vfs.isDirectory(stripped)) return;
      // hardening-r5: preserve binary content as Uint8Array.
      const content = _readBundleCell(vfs, stripped);
      const cellLen = _bundleCellLength(content);
      if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES) return;
      bundle[stripped] = content;
      budgetState.totalBytes += cellLen;
      budgetState.fileCount++;
      added++;
    } catch { /* swallow — file may be binary, race-deleted, etc. */ }
  }

  function scanOne(src: string): void {
    if (!src) return;
    // Strip line + block comments so we don't match commented-out reads.
    const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    RX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RX.exec(stripped)) !== null) {
      const literal = m[2];
      // Skip if there's any unsafe char (defensive — RX already
      // forbids most). The check on the captured group is cheap.
      if (/[\?\*\[\]\{\}]/.test(literal)) continue;
      tryAdd(literal);
    }
  }

  // Always scan entry code.
  scanOne(entryCode);

  // Optionally scan bundled JS sources too — useful for transitive cases
  // where a require'd module hardcodes an absolute path. Use the same
  // budget-state so we don't blow caps.
  const sourceKeys = Object.keys(bundle).filter((k) =>
    k.endsWith('.js') || k.endsWith('.mjs') || k.endsWith('.cjs'),
  );
  for (const k of sourceKeys) {
    if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES) break;
    if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES) break;
    // hardening-r5: scanOne expects string. Binary cells (rare with a
    // .js extension but possible) are skipped — scanOne would throw on
    // a Uint8Array .replace() call.
    const cell = bundle[k];
    if (typeof cell !== 'string') continue;
    scanOne(cell);
  }
  return { added };
}

function looksLikeEsm(src: string): boolean {
  return hasTopLevelModuleSyntax(src);
}

/**
 * W3.5 Fix B — module-level cache for ESM→CJS transform results, keyed
 * by content hash. A cheap FNV-1a 32-bit hash is enough (collisions are
 * astronomically rare for the size of bundles we ship; on collision the
 * pre-compile would still succeed because the cached result is a valid
 * CJS rebuild of an equally-valid ESM input).
 *
 * Lives at module scope so warm exec invocations hit the cache without
 * paying the wasm cold-start cost again.
 */
const __esmTransformCache = new Map<string, string>();
function __cacheKey(src: string): string {
  // FNV-1a 32-bit. Only used for cache keys, NEVER for content
  // integrity. The ~30-byte string we return is a hex hash + length —
  // length disambiguates collisions across the rare 32-bit overlap.
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + ':' + src.length.toString(16);
}

/**
 * framework-fixes-F4 (2026-05-12): helper for the "esbuild unavailable
 * or fatally errored" paths. Walks the bundle for ESM-shaped files and
 * replaces each with a JS-valid diagnostic shim that throws an
 * informative Error at require-time. Mirrors the per-file catch in
 * transformEsmInBundle so the user gets the same actionable error
 * surface regardless of whether transform failed for the whole batch
 * or for one file.
 *
 * Does NOT touch non-ESM files (which the pre-compile loop handles
 * fine as-is).
 */
function _markBundleEsmAsFailed(
  bundle: Record<string, string | Uint8Array>,
  reason: string,
): void {
  for (const path of Object.keys(bundle)) {
    if (!path.endsWith('.js') && !path.endsWith('.mjs')) continue;
    const src = bundle[path];
    if (typeof src !== 'string') continue;
    if (!looksLikeEsm(src)) continue;
    const escapedReason = JSON.stringify(`esbuild transform failed for ${path}: ${reason}`);
    bundle[path] =
      '// framework-fixes-F4 diagnostic shim — esbuild rejected the ESM transform\n' +
      '(function () { throw new Error(' + escapedReason + '); })();\n';
  }
}

/**
 * Transform every ESM-shaped file in the bundle to CJS via esbuild.
 * Mutates `bundle` in place. Errors are swallowed (the file is left as
 * ESM source); the facet's pre-compile loop will record the SyntaxError
 * into __compileFailures and __loadModule will surface it (Fix C).
 *
 * Skips:
 *   - .json (esbuild can transform but there's no payoff and it's a
 *     no-op on our pre-compile loop too).
 *   - .cjs (already CJS; transform is a wash).
 *   - files that pass the regex sniff cleanly (heuristic: no top-level
 *     import/export → CJS-shaped already).
 *
 * Returns the count of files transformed (for diagnostics).
 */
async function transformEsmInBundle(
  bundle: Record<string, string | Uint8Array>,
  esbuild: EsbuildService,
): Promise<{ transformed: number; failed: number }> {
  let transformed = 0;
  let failed = 0;
  // Snapshot the keys first — esbuild calls await; never iterate-and-mutate.
  const candidates: string[] = [];
  for (const path of Object.keys(bundle)) {
    if (!path.endsWith('.js') && !path.endsWith('.mjs')) continue;
    const src = bundle[path];
    // hardening-r5: binary cells (rare for .js/.mjs but defensive) are
    // not ESM. Skip — looksLikeEsm + esbuild.transform expect strings.
    if (typeof src !== 'string') continue;
    if (!looksLikeEsm(src)) continue;
    candidates.push(path);
  }
  for (const path of candidates) {
    const src = bundle[path];
    if (typeof src !== 'string') continue;
    // `import.meta.url` substitution mirrors the sibling fix at
    // src/runtime/runtime-registry.ts:383-389 (framework-gaps-fix P5).
    // Without `define`, esbuild's CJS transform reduces `import.meta.url`
    // to undefined (single-pass) or preserves it literally — only to
    // SyntaxError at `new Function(...)` parse time (two-pass via
    // EsbuildService.transform's async-IIFE wrap → "Cannot use
    // 'import.meta' outside a module"). The substitution value is the
    // real `file:///<absolute-path>` URL — exactly what real Node returns
    // for an ESM module at that path.
    //
    // Note: cache key now incorporates the path because the transformed
    // output is path-specific (the URL literal is baked in). Two files
    // with identical source but different paths would otherwise share a
    // cache entry and the second file would get the first file's URL.
    const absUrl = 'file:///' + path.replace(/^\/+/, '');
    const key = __cacheKey(src + '\0' + absUrl);
    const cached = __esmTransformCache.get(key);
    if (cached) {
      bundle[path] = cached;
      transformed++;
      continue;
    }
    try {
      const t = await esbuild.transform(src, {
        loader: 'js',
        format: 'cjs',
        target: 'esnext',
        define: importMetaDefines(absUrl),
      });
      const code = bindImportMetaResolve(t.code, absUrl);
      bundle[path] = code;
      __esmTransformCache.set(key, code);
      transformed++;
    } catch (e: any) {
      // framework-fixes-F4 (2026-05-12): replace the source with a
      // JS-valid module that throws an INFORMATIVE Error when require'd.
      //
      // Pre-fix this catch swallowed the failure silently. The pre-
      // compile loop then re-saw the ESM source and emitted the
      // SyntaxError "Cannot use import statement outside a module" into
      // __compileFailures. __loadModule surfaced that as the user error
      // — but it told the user nothing about WHY esbuild rejected the
      // file (was it TLA at module scope? a TypeScript file mistyped
      // as .js? an unsupported syntax? our esbuild service not init?).
      //
      // Post-fix the replacement source is parseable CJS that, when
      // require()'d, throws a real Error carrying the esbuild reason.
      // The pre-compile loop succeeds, the file lands in
      // __compiledModules, and the failure surfaces at require time
      // with FULL diagnostic context. Net effect for users: the same
      // upstream tool still fails, but they now see WHY.
      //
      // Probe: tests/behavioral/npm-create/new/create-astro-diagnostic.mjs
      // asserts the user-visible error contains "esbuild transform" so
      // future diagnostic regressions are caught.
      const reason = (e && e.message) ? String(e.message).replace(/\n/g, ' ') : String(e);
      const escapedReason = JSON.stringify(`esbuild transform failed for ${path}: ${reason}`);
      // Build a valid CJS module that throws on load. Use IIFE to keep
      // module-scope flat (no TLA, no top-level await). Esbuild-cache
      // this so repeated submits don't re-run the same transform.
      const diagnosticSrc =
        '// framework-fixes-F4 diagnostic shim — esbuild rejected the ESM transform\n' +
        '(function () { throw new Error(' + escapedReason + '); })();\n';
      bundle[path] = diagnosticSrc;
      __esmTransformCache.set(key, diagnosticSrc);
      failed++;
    }
  }
  return { transformed, failed };
}

/**
 * W2.6a: build the prefetch bundle for FacetManager.exec.
 *
 * Replaces the legacy whole-tree-with-cap walk that pre-W2.5b shipped
 * up to 500 files / 4 MiB of node_modules content (whichever ran out
 * first) with a static reachable-set walk via require-resolver.ts. The
 * shipped bundle is now bounded by what the user's require() chain
 * actually reaches PLUS a greedy oversample of every installed pkg's
 * package.json + main entry (dynamic-require survival).
 *
 * Cap is on the JSON-encoded size of the final payload, not on raw
 * content byte sum. The dynamic worker module embeds the bundle as
 * `const __MODULE_VFS_BUNDLE = ${JSON.stringify(bundle)}`, so workerd's
 * per-module text-size limit applies to the encoded form.
 *
 * W3.5: now async to allow the optional ESM→CJS pre-pass via esbuild.
 * If `esbuild` is not provided, the pass is skipped (preserves prior
 * behaviour for code paths that don't have esbuild handy).
 *
 */
async function buildPrefetchBundle(
  vfs: SqliteVFS,
  scriptPath: string | undefined,
  cwd: string,
  entryCode: string,
  esbuild?: EsbuildService,
  bundleProfile: FacetBundleProfile = DEFAULT_FACET_BUNDLE_PROFILE,
): Promise<FacetVfsState> {
  // 1. Static reachable-set walk from entry.
  const prefetch = prefetchForRequire(vfs, entryCode || '', cwd, scriptPath);
  const bundle: Record<string, string | Uint8Array> = { ...prefetch.bundle };
  let totalBytes = 0;
  let fileCount = 0;
  for (const k of Object.keys(bundle)) {
    totalBytes += bundle[k].length;
    fileCount++;
  }
  let truncated = prefetch.truncated;

  // 2. Greedy oversample — every installed pkg's pkg.json + main.
  //    Catches dynamic-require / `bindings()` / plugin-loader cases the
  //    regex prefetch misses. Bounded by VFS_BUNDLE_MAX_BYTES.
  const budgetState = { totalBytes, fileCount };
  const greedy = greedyAddMainEntries(vfs, cwd, bundle, budgetState);
  totalBytes = budgetState.totalBytes;
  fileCount = budgetState.fileCount;

  // 2.25 X.5-Z3: static-readFileSync asset prefetch. Scans every
  //      bundle .js/.mjs/.cjs source for the canonical jsdom shape:
  //
  //        fs.readFileSync(path.resolve(__dirname, "<rel>.css"), …)
  //
  //      and pulls the matched asset into the bundle. Without this,
  //      `default-stylesheet.css` (and similar runtime asset reads in
  //      tldts, parse5, lookup-table packages, mime-db, etc.) ENOENT
  //      at facet runtime even though the file is on VFS-disk + in
  const assetAdd = addStaticReadFileAssets(vfs, cwd, bundle, budgetState);
  void assetAdd;
  totalBytes = budgetState.totalBytes;
  fileCount = budgetState.fileCount;

  // 2.27 X.5-U: dotfile + SWC-shape readFileSync sentinel prefetch.
  //      Sibling of `addStaticReadFileAssets` (X.5-Z3) — same call shape,
  //      different match space. Covers the SWC/TS-compiled
  //      `(0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, "<rel>"))`
  //      pattern AND filenames outside the Z3 ASSET_EXT whitelist
  //      (dotfiles, no-extension sentinels, "digest/hash/version/sha/md5"
  //      shapes). Motivating case: ts-jest's `.ts-jest-digest`. See
  const dotAdd = addStaticReadFileDotfilesAndCompiled(vfs, cwd, bundle, budgetState);
  void dotAdd;
  totalBytes = budgetState.totalBytes;
  fileCount = budgetState.fileCount;

  // 2.30 G3 (runtime-pkg wave): bin-target sibling oversample. Pulls
  //      ALL files under the entry's package root (capped at 200) so
  //      bins like cowsay that readFileSync('cows/X.cow') at runtime
  //      find their data files. Existing greedy/asset/dotfile passes
  //      cover JS sources + a hardcoded ASSET_EXT list; this one
  //      catches custom extensions (.cow, .pem, .ttf, .wasm bundled
  //      as data, etc.) without needing a per-pkg whitelist.
  //      No-op when entry isn't inside node_modules.
  const binSiblingAdd = addBinTargetSiblings(vfs, scriptPath, bundle, budgetState, bundleProfile);
  void binSiblingAdd;
  totalBytes = budgetState.totalBytes;
  fileCount = budgetState.fileCount;

  // 2.34 project-data snapshot: sync Node fs cannot await the
  // supervisor. Include a bounded snapshot of the current working tree
  // for common relative project-file reads while skipping dependency
  // and Nimbus cache directories. Async fs still uses live supervisor
  // reads and child-process staleness fallback.
  const cwdProjectAdd = addCwdProjectFiles(vfs, cwd, bundle, budgetState);
  void cwdProjectAdd;
  totalBytes = budgetState.totalBytes;
  fileCount = budgetState.fileCount;

  // 2.35 shell compatibility: absolute-path readFileSync scanner.
  //
  // Pre-fix `node -e 'fs.readFileSync("/home/user/er.txt")'` returned
  // ENOENT even when the file existed on the SqliteVFS (verified via
  // `cat`/`ls`). Cause: buildPrefetchBundle's existing scanners
  // (greedy main entries, addStaticReadFileAssets, dotfiles, bin
  // siblings) all look at INSTALLED packages or relative-resolve
  // patterns inside the bundle's source files. They never scan the
  // user's ENTRY CODE for absolute-path string literals, so user
  // files like /home/user/data.json or /tmp/cache.bin never reached
  // the facet's __vfsBundle.
  //
  // Fix: scan entryCode + every JS source already in the bundle for
  // any string literal that LOOKS like an absolute path (`/x/y/z`,
  // optionally inside a readFileSync/createReadStream/open call).
  // For each candidate that exists on the VFS (and isn't already in
  // the bundle), pull it in within the byte budget.
  //
  // Defenses:
  //   - Only path-shaped strings (starts with `/`, length 1-512).
  //   - VFS file existence + non-dir check before adding.
  //   - Byte/file budget guards identical to other passes.
  //   - Skip paths under known-untrusted prefixes (`/proc`, `/sys`,
  //     `/dev` — we don't have these mounts; they'd never resolve).
  const absScanAdd = addEntryAbsPathReads(vfs, entryCode || '', bundle, budgetState);
  void absScanAdd;
  totalBytes = budgetState.totalBytes;
  fileCount = budgetState.fileCount;

  // 2.5 W3.5 Fix B: ESM→CJS transform pass. Walks `bundle`, sniffs each
  //     .js/.mjs for top-level import/export, runs esbuild's CJS transform
  //     on the matches, and replaces the value in-place. Without this,
  //     ESM files (e.g. tldts/dist/es6/index.js, @remix-run/react/dist/esm,
  //     @tailwindcss/vite, react-remove-scroll, astro) silently fail
  //     `new Function` at facet startup and surface as the misleading
  //     "file was not pre-bundled" at request time.
  if (esbuild) {
    try {
      await transformEsmInBundle(bundle, esbuild);
      // Recount bytes after the transform — CJS rebuilds can be larger
      // OR smaller than the ESM source. We don't try to thread totalBytes
      // through the transform because the eviction loop below recomputes
      // the encoded size from scratch anyway.
    } catch (e: any) {
      // framework-fixes-F4 (2026-05-12): the prior catch was silent.
      // Replace every detected-ESM source with the SAME diagnostic
      // shim transformEsmInBundle's per-file catch installs, so the
      // user sees "esbuild transform failed (service-level): <reason>"
      // instead of a bare "Cannot use import statement..." parse
      // error with no context.
      const reason = (e && e.message) ? String(e.message).replace(/\n/g, ' ') : String(e);
      _markBundleEsmAsFailed(bundle, `esbuild service unavailable: ${reason}`);
    }
  } else {
    // framework-fixes-F4 (2026-05-12): no esbuild service available at
    // all (lazy-init failed or never wired). Same diagnostic-shim
    // treatment so users see WHY the ESM file couldn't be transformed.
    _markBundleEsmAsFailed(bundle, 'esbuild service not initialized (likely lazy-init failure)');
  }

  // 3. Manifest pass — UNCHANGED from W2.5b. Decouples directory shape
  //    from content cap so fs.readdirSync remains honest even if the
  //    content for a given file was capped out.
  const manifest = buildManifest(vfs, cwd, scriptPath);

  // 4. JSON-encoded-size guard. Pre-check via TextEncoder.encode().length
  //    so we measure UTF-8 bytes (not UTF-16 code units), matching what
  //    workerd accounts against the per-module text-size budget. If the
  //    bundle exceeds the encoded ceiling, evict largest non-manifest
  //    files first (manifest stays — it's needed for readdirSync) and
  //    RECOMPUTE the encoded size after every eviction (sub-agent S2:
  //    naïve `encoded -= len(file) + len(key) + 6` accumulates 2-5% drift
  //    on JS-source-heavy bundles; recomputing is O(n) per eviction but
  //    bundles past the budget are rare and the count of evictions is
  //    bounded by the size of a few large files).
  const encoder = new TextEncoder();
  let encoded = encoder.encode(JSON.stringify({ bundle, manifest })).length;
  if (encoded > BUNDLE_MAX_ENCODED_BYTES) {
    truncated = true;
    const keysBySize = Object.keys(bundle).sort((a, b) => bundle[b].length - bundle[a].length);
    for (const k of keysBySize) {
      if (encoded <= BUNDLE_MAX_ENCODED_BYTES) break;
      delete bundle[k];
      fileCount--;
      encoded = encoder.encode(JSON.stringify({ bundle, manifest })).length;
    }
  }

  // Suppress lint: `greedy.added` is observed only via diagnostics.
  void greedy;

  return { bundle, manifest, reachableCount: fileCount, truncated };
}

// ── FacetManager ────────────────────────────────────────────────────────

/**
 * Optional hooks wired in by NimbusSession. Kept as callbacks so
 * FacetManager stays unaware of the session / log-store types.
 */
export interface FacetManagerHooks {
  /**
   * Fired when a process was terminated OUTSIDE the facet's own try/
   * finally (timeout via abort, explicit kill, etc.) — the facet never
   * runs its own `reportExit`, so the session side won't hear about the
   * exit unless we call it here.
   */
  onExternalExit?: (pid: number, code: number, reason: string) => void;
  /** Fired right after the supervisor's spawn — lets the session print a notification. */
  onSpawn?: (pid: number, command: string, longRunning: boolean) => void;
}

export interface LongRunningWorkerSpawnOptions {
  port?: number;
  modules?: Record<string, any>;
  compatibilityFlags?: string[];
}

const ROUTEABLE_PORT_ATTACH_TIMEOUT_MS = 1_000;

export class FacetManager {
  private ctx: DurableObjectState;
  private env: FacetManagerEnv;
  private processes: SessionProcessSupervisor;
  private portRegistry: PortRegistry;
  private vfs: SqliteVFS | null = null;
  private hooks: FacetManagerHooks;
  private processRpcResources = new Map<number, ProcessRpcResources>();
  private timedOutProcessIds = new Set<number>();
  /**
   * W3.5 Fix B: lazily-created EsbuildService for the ESM→CJS pre-pass
   * over the prefetch bundle. Created on first exec where vfs is set;
   * shared across subsequent execs (warm wasm).  Optional setter
   * `setEsbuildService` lets NimbusSession share its existing instance
   * to avoid double-init.
   */
  private esbuild: EsbuildService | null = null;

  constructor(
    ctx: DurableObjectState,
    env: unknown,
    processes: SessionProcessSupervisor,
    portRegistry: PortRegistry,
    hooks: FacetManagerHooks = {},
  ) {
    this.ctx = ctx;
    this.env = parseFacetManagerEnv(env);
    this.processes = processes;
    this.portRegistry = portRegistry;
    this.hooks = hooks;
  }

  setVfs(vfs: SqliteVFS) { this.vfs = vfs; }
  /**
   * W3.5 Fix B: hand the FacetManager a pre-warmed EsbuildService for
   * the ESM→CJS bundle pre-pass. NimbusSession already lazy-creates one
   * for the user-shell `node` runtime; sharing avoids paying init twice.
   */
  setEsbuildService(esbuild: EsbuildService) { this.esbuild = esbuild; }

  private trackProcessRpcResources(
    pid: number,
    resources: Iterable<unknown>,
    options: { releaseOnReportExit?: boolean } = {},
  ): void {
    this.releaseProcessRpcResources(pid);
    this.processRpcResources.set(pid, {
      resources: [...resources],
      releaseOnReportExit: options.releaseOnReportExit !== false,
    });
  }

  private releaseProcessRpcResources(pid: number): void {
    const tracked = this.processRpcResources.get(pid);
    if (!tracked) return;
    this.processRpcResources.delete(pid);
    disposeRpcResources(tracked.resources);
  }

  noteProcessReportedExit(pid: number, exitCode: number): void {
    this.portRegistry.unregisterByPid(pid);
    this.processes.exit(pid, exitCode);
    const tracked = this.processRpcResources.get(pid);
    if (tracked?.releaseOnReportExit) this.releaseProcessRpcResources(pid);
  }

  /** Execute one-shot JS code in an isolated dynamic Worker. */
  async exec(
    code: string,
    opts: {
      argv?: string[];
      env?: Record<string, string>;
      cwd?: string;
      filename?: string;
      dirname?: string;
      stdin?: string;
      /**
       * G4 (runtime-pkg wave): caller-supplied display label for the
       * process entry. When set, takes precedence over the
       * default `node ${filename}`. Used by the .bin handler in
       * init.ts so `tsc --version` shows up in `ps` as
       * `tsc --version` (the user's typed line) rather than
       * `node /home/user/proj/node_modules/typescript/bin/tsc`.
       *
       * Also: when `command` is provided AND `skipSpawn` is true,
       * the caller has already spawned the process entry (e.g. the
       * .bin wrapper that needs to allocate a PID before parsing
       * the shim). exec() reuses that PID instead of spawning a
       * second one — the G4 double-spawn fix.
       */
      command?: string;
      /** G4: caller already spawned the process entry; don't double-spawn. */
      skipSpawn?: boolean;
      /** G4: when skipSpawn is true, the PID the caller allocated. */
      callerPid?: number;
      bundleProfile?: FacetBundleProfile;
      /** Return stdout/stderr in the result while keeping supervisor RPC
       *  available for VFS and child_process operations. */
      captureOutput?: boolean;
    },
  ): Promise<FacetExecResult> {
    const command = opts.command
      || (opts.filename && opts.filename !== '<eval>'
        ? `node ${opts.filename}` : 'node -e ...');
    let entry: ProcessEntry;
    if (opts.skipSpawn && opts.callerPid != null) {
      // The caller already allocated the PID via the supervisor
      // (with their own user-facing label). Look up the full entry
      // from the table — _execWithTimeout etc. need the canonical
      // ProcessEntry shape. Do NOT reap() either: reaping would
      // clear the caller's just-spawned entry because its startTime
      // is recent (< 60s) but reap() ALSO drops 'running' entries
      // older than the threshold; in any case we don't want side
      // effects when the caller is delegating PID ownership.
      const found = this.processes.get(opts.callerPid);
      if (!found) {
        throw new Error(`facetMgr.exec skipSpawn: callerPid=${opts.callerPid} not in process table`);
      }
      entry = found;
    } else {
      this.processes.reap();
      entry = this.processes.spawn(command, opts.argv || [], opts.cwd || '/home/user');
      // Short foreground `node -e ...` helpers are quiet by design — only
      // notify for user-facing `node <file>` invocations, which covers the
      // real user intent (running scripts, wrangler, etc.).
      if (opts.filename && opts.filename !== '<eval>') {
        try { this.hooks.onSpawn?.(entry.pid, command, false); } catch {}
      }
    }

    // W3.5 Fix B: thread an EsbuildService into buildPrefetchBundle so
    // ESM source files (e.g. tldts/dist/es6/index.js, @remix-run/react,
    // @tailwindcss/vite, react-remove-scroll, astro) get transformed to
    // CJS before they hit the facet's `new Function` pre-compile loop.
    // Lazy-create one if NimbusSession didn't share its own.
    if (this.vfs && !this.esbuild) {
      try { this.esbuild = new EsbuildService(this.vfs as any); } catch { this.esbuild = null; }
    }
    const vfsState: FacetVfsState = this.vfs
      ? await buildPrefetchBundle(
          this.vfs,
          opts.filename,
          opts.cwd || '/home/user',
          code,
          this.esbuild || undefined,
          opts.bundleProfile,
        )
      : { bundle: {}, manifest: {}, reachableCount: 0, truncated: false };

    const abortController = new AbortController();
    try {
      const result = await this._execWithTimeout(
        this._execViaLoader(code, opts, entry, vfsState, abortController.signal),
        entry,
        () => abortController.abort(),
      );
      this.processes.exit(entry.pid, result.exitCode);
      if (result.exitCode !== 0) {
        this._w5RecordTermination(
          entry.pid, result.exitCode, 'runtime-worker',
          result.stderr || `exit ${result.exitCode}`,
        );
      }
      this._flushVfsWrites(result);
      return result;
    } catch (err: unknown) {
      // If the timeout already fired, it already called onExternalExit
      // with code 124 and reason "timeout…". Don't clobber that with a
      // generic exit code 1. (_reportExternalExit's guard separately
      // prevents double-dump; this stops ProcessTable from showing a
      // different exit code than the ring buffer's footer.)
      const timedOut = this.timedOutProcessIds.has(entry.pid);
      const exitCode = timedOut ? 124 : 1;
      const reason = timedOut ? 'timeout' : `runtime worker error: ${errorMessage(err)}`;
      this.processes.exit(entry.pid, exitCode);
      // W5 Lever 5: ring entry on every catch-path exit.
      this._w5RecordTermination(
        entry.pid, exitCode,
        timedOut ? 'rpc' : 'runtime-worker',
        reason,
      );
      // Non-timeout failure: route through external-exit so the log
      // store marks exit AND the tabs-UI structured event fires. The
      // timeout path already called onExternalExit from the timeout
      // handler; _reportExternalExit's getExit() guard dedupes.
      if (!timedOut) {
        try {
          this.hooks.onExternalExit?.(
            entry.pid, exitCode,
            reason,
          );
        } catch {}
      }
      return { exitCode, stdout: '', stderr: errorMessage(err) };
    } finally {
      this.timedOutProcessIds.delete(entry.pid);
    }
  }

  /**
   * W5 Lever 5: push a DiagFailure into the OOM ring for every facet
   * termination with a non-zero exit code. This is the supervisor side
   * oom-stress probe asserts that every termination has a matching
   * ring entry.
   *
   * Classification: parse the reason/stderr for SQLITE_NOMEM, OOM,
   * clone-refused, rpc_timeout signatures (oom-classify.ts). Code 124
   * always maps to rpc_timeout regardless of message.
   */
  private _w5RecordTermination(
    pid: number,
    exitCode: number,
    phase: string,
    reason: string,
  ): void {
    try {
      let cause = classifyError(reason);
      if (exitCode === 124 && cause === 'unknown') cause = 'rpc_timeout';
      recordFailure({
        at: Date.now(),
        phase,
        cause,
        rssEstimateBytes: 0,
        heapUsedBytes: 0,
        lruBytes: 0,
        inFlightBytes: 0,
        lastRpcFrame: getLastRpcFrame(),
        lastFacetId: getLastFacetId(),
        exitCode,
        pid,
        message: reason,
      });
    } catch (e: any) {
      // Fail-soft: telemetry must never break the exit path.
      console.warn('[facet-manager/W5] recordFailure threw:', e?.message);
    }
  }

  // ── One-shot dynamic Worker entrypoint ────────────────────────────────

  private async _execViaLoader(
    code: string,
    opts: { argv?: string[]; env?: Record<string, string>; cwd?: string; filename?: string; dirname?: string; stdin?: string; captureOutput?: boolean },
    entry: ProcessEntry,
    vfsState: FacetVfsState,
    signal: AbortSignal,
  ): Promise<FacetExecResult> {
    const workerCode = generateEntrypointCode(code, vfsState);

    // Pass SUPERVISOR binding for runtime-worker -> supervisor RPC.
    const ctxExports = getCtxExports();
    const supervisorBinding = ctxExports?.SupervisorRPC
      ? ctxExports.SupervisorRPC({ props: { doId: this.ctx.id.toString(), pid: entry.pid } })
      : undefined;

    const body = JSON.stringify({
      argv: opts.argv || [],
      env: opts.env || {},
      cwd: opts.cwd || '/home/user',
      filename: opts.filename || '<eval>',
      dirname: opts.dirname || '/home/user',
      stdin: opts.stdin || '',
      captureOutput: !!opts.captureOutput,
    });

    let worker: LoadedWorkerStub | undefined;
    let entrypoint: LoadedWorkerEntrypointStub | undefined;
    try {
      worker = this.env.LOADER.load({
        compatibilityDate: CF_COMPAT_DATE,
        compatibilityFlags: ['nodejs_compat', 'nodejs_compat_v2'],
        mainModule: 'runner.js',
        modules: { 'runner.js': workerCode },
        ...(supervisorBinding ? { env: { SUPERVISOR: supervisorBinding } } : {}),
      });

      entrypoint = worker.getEntrypoint();
      if (typeof entrypoint.fetch !== 'function') {
        throw new Error('Nimbus: one-shot runtime entrypoint has no fetch method');
      }
      const response = await entrypoint.fetch(new Request('http://nimbus-runtime.local/run', {
        method: 'POST',
        body,
        signal,
      }));
      try {
        return await response.json() as FacetExecResult;
      } finally {
        disposeRpcResource(response);
      }
    } finally {
      disposeRpcResource(entrypoint);
      disposeRpcResource(worker);
      disposeRpcResource(supervisorBinding);
    }
  }

  /** Flush files written by the script back to the supervisor's VFS. */
  private _flushVfsWrites(result: FacetExecResult) {
    if (!this.vfs || !result.vfsWrites) return;
    for (const [path, content] of Object.entries(result.vfsWrites)) {
      try {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
          const dir = parts.slice(0, i).join('/');
          if (dir && !this.vfs.exists(dir)) this.vfs.mkdir(dir, { recursive: true });
        }
        // binary-fs wave: __vfsWrites cells carry string | Uint8Array.
        // The hot path here is the LIVE SUPERVISOR.writeFile RPC inside
        // the facet — which preserves Uint8Array via structured-clone.
        // This `result.vfsWrites` carries only the FAILED-writes residue
        // (after JSON.parse), where Uint8Array gets serialized as a
        // {"0":...,"1":...} object. Detect that shape and reconstitute
        // bytes; otherwise pass through (string for source code, etc.).
        const restored = _reviveVfsWriteCell(content);
        this.vfs.writeFile(path, restored);
      } catch (e: any) {
        console.error('[nimbus] VFS write-back failed:', path, e?.message);
      }
    }
  }

  /** Execution timeout. */
  private async _execWithTimeout(
    promise: Promise<FacetExecResult>,
    entry: ProcessEntry,
    abort: () => void,
  ): Promise<FacetExecResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<FacetExecResult>((_, reject) => {
      timer = setTimeout(() => {
        this.timedOutProcessIds.add(entry.pid);
        abort();
        // The process cannot report exit after the request is cancelled, so
        // notify the session explicitly.
        try {
          this.hooks.onExternalExit?.(
            entry.pid,
            124, // conventional timeout exit code
            `timeout after ${FACET_TIMEOUT_MS / 1000}s`,
          );
        } catch {}
        reject(new Error(`Process timed out after ${FACET_TIMEOUT_MS / 1000}s`));
      }, FACET_TIMEOUT_MS);
    });
    // Always clear the timer; otherwise a successful run would still
    // trigger the timeout callback at FACET_TIMEOUT_MS, spuriously
    // marking the exit code as 124.
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Run npm install in a dedicated facet.
   * All writes go through SUPERVISOR.writeFile (live VFS),
   * progress streams via SUPERVISOR.stdout.
   */
  /**
   * Spawn a vite dev server facet.
   * Returns immediately with the facet stub for HTTP routing.
   */
  async spawnVite(root: string, basePath: string = '/preview'): Promise<{ pid: number; facetStub: any }> {
    const code = generateViteFacetCode(root, basePath);
    return await this.spawn(code, 'vite (' + root + ')', root);
  }

  /**
   * Spawn a long-running Node process with the same shimmed require/fs/http
   * environment used by foreground `node <script>` execution.
   */
  async spawnNode(
    code: string,
    opts: {
      argv?: string[];
      env?: Record<string, string>;
      cwd?: string;
      filename?: string;
      dirname?: string;
      command?: string;
      port?: number;
      attachedTty?: boolean;
      skipSpawn?: boolean;
      callerPid?: number;
      bundleProfile?: FacetBundleProfile;
    } = {},
  ): Promise<{ pid: number; facetStub: any }> {
    this.processes.reap();
    const command = opts.command || (opts.filename ? `node ${opts.filename}` : 'node <script>');
    const cwd = opts.cwd || '/home/user';
    let entry: ProcessEntry;
    if (opts.skipSpawn && opts.callerPid != null) {
      const found = this.processes.get(opts.callerPid);
      if (!found) {
        throw new Error(`facetMgr.spawnNode skipSpawn: callerPid=${opts.callerPid} not in process table`);
      }
      entry = found;
    } else {
      entry = this.processes.spawn(command, opts.argv || [], cwd);
    }
    this.processes.setLongRunning(entry.pid);
    if (opts.attachedTty) this.processes.setAttachedTty(entry.pid);
    if (!opts.skipSpawn) {
      try { this.hooks.onSpawn?.(entry.pid, command, true); } catch {}
    }

    if (this.vfs && !this.esbuild) {
      try { this.esbuild = new EsbuildService(this.vfs as any); } catch { this.esbuild = null; }
    }
    const vfsState: FacetVfsState = this.vfs
      ? await buildPrefetchBundle(this.vfs, opts.filename, cwd, code, this.esbuild || undefined, opts.bundleProfile)
      : { bundle: {}, manifest: {}, reachableCount: 0, truncated: false };
    const processEnv = opts.attachedTty
      ? {
          ...(opts.env || {}),
          NIMBUS_ATTACHED_TTY: '1',
          NIMBUS_CP_CHILD_PID: String(entry.pid),
          TERM: opts.env?.TERM || 'xterm-256color',
          COLORTERM: opts.env?.COLORTERM || 'truecolor',
          COLUMNS: opts.env?.COLUMNS || '80',
          LINES: opts.env?.LINES || '24',
          FORCE_COLOR: opts.env?.FORCE_COLOR || '1',
        }
      : opts.env;
    const workerCode = generateLongRunningNodeCode(code, vfsState, { ...opts, env: processEnv });

    const ctxExports = getNimbusCtxExports();
    const supervisor = { doId: this.ctx.id.toString(), pid: entry.pid };
    const supervisorBinding = ctxExports?.SupervisorRPC
      ? ctxExports.SupervisorRPC({ props: supervisor })
      : undefined;
    let worker: { getEntrypoint(): LoadedWorkerEntrypointStub } | undefined;
    let startStub: LoadedWorkerEntrypointStub | undefined;
    let routeStub: LoadedWorkerEntrypointStub | undefined;
    let resourcesTracked = false;

    try {
      const workerKey = `nimbus-process:${supervisor.doId}:${supervisor.pid}`;
      const workerConfig = {
        compatibilityDate: CF_COMPAT_DATE,
        compatibilityFlags: ['nodejs_compat', 'nodejs_compat_v2'],
        mainModule: 'worker.js',
        modules: { 'worker.js': workerCode },
        ...(supervisorBinding ? { env: { SUPERVISOR: supervisorBinding } } : {}),
      };
      const routeConfig = {
        compatibilityDate: CF_COMPAT_DATE,
        compatibilityFlags: ['nodejs_compat', 'nodejs_compat_v2'],
        mainModule: 'worker.js',
        modules: { 'worker.js': workerCode },
      };
      const loadedWorker: { getEntrypoint(): LoadedWorkerEntrypointStub } =
        this.env.LOADER.get(workerKey, async () => workerConfig);
      worker = loadedWorker;
      startStub = loadedWorker.getEntrypoint();
      routeStub = await createLoadedWorkerEntrypoint(ctxExports, routeConfig, supervisor, null, workerKey);
      this.trackProcessRpcResources(
        entry.pid,
        [routeStub, startStub, worker, supervisorBinding],
        { releaseOnReportExit: !opts.attachedTty },
      );
      resourcesTracked = true;
      this.portRegistry.bindFacetStub(entry.pid, routeStub);

      if (typeof startStub.startProcess !== 'function') {
        throw new Error('Nimbus: long-running node entrypoint has no startProcess method');
      }
      const startPromise = startStub.startProcess();
      if (opts.attachedTty) {
        this.ctx.waitUntil(
          startPromise
            .catch((e: unknown) => {
              const reason = 'long-running node process failed: ' + errorMessage(e);
              try { this.processes.exit(entry.pid, 1); } catch {}
              try { this._w5RecordTermination(entry.pid, 1, 'facet', reason); } catch {}
              try { this.hooks.onExternalExit?.(entry.pid, 1, reason); } catch {}
            })
            .finally(() => {
              this.releaseProcessRpcResources(entry.pid);
            }),
        );
      } else {
        await startPromise;
      }

      if (opts.port && opts.port > 0 && opts.port < 65536) {
        this.portRegistry.register(opts.port, entry.pid, routeStub);
      }
      return { pid: entry.pid, facetStub: startStub };
    } catch (e: unknown) {
      this.portRegistry.unregisterByPid(entry.pid);
      if (resourcesTracked) this.releaseProcessRpcResources(entry.pid);
      else disposeRpcResources([routeStub, startStub, worker, supervisorBinding]);
      this.processes.exit(entry.pid, 1);
      const reason = 'long-running node boot failed: ' + errorMessage(e);
      this._w5RecordTermination(
        entry.pid,
        1,
        'facet',
        reason,
      );
      try {
        this.hooks.onExternalExit?.(
          entry.pid,
          1,
          reason,
        );
      } catch {}
      throw e;
    }
  }

  /**
   * Spawn a long-running facet process.
   * Returns immediately with the process entry.
   * The facet stays alive and can handle HTTP requests via its fetch() method.
   * Used for: vite dev server, node HTTP servers, etc.
   *
   * @param workerCode The dynamic worker code (must export a default fetch handler)
   * @param command Display name for process listing
   * @returns Process entry with pid and facet stub
   */
  async spawn(
    workerCode: string,
    command: string,
    cwd: string,
    opts: { port?: number } = {},
  ): Promise<{ pid: number; facetStub: any }> {
    return await this.spawnWorker(workerCode, command, cwd, {
      port: opts.port,
      compatibilityFlags: ['nodejs_compat'],
    });
  }

  /**
   * Spawn a long-running dynamic Worker and register its routeable port.
   *
   * This is the shared primitive for any runtime that exposes
   * handleHttpRequest(Request): Node facets, Vite adapters, Python virtual
   * sockets, and future WASI socket servers should use
   * this path instead of each owning process-table and PortRegistry plumbing.
   */
  async spawnWorker(
    workerCode: string,
    command: string,
    cwd: string,
    opts: LongRunningWorkerSpawnOptions = {},
  ): Promise<{ pid: number; facetStub: any }> {
    this.processes.reap();
    const entry = this.processes.spawn(command, [], cwd);
    // child-process isolation gap #2: stamp the explicit longRunning flag on the
    // process_table entry so /api/processes returns longRunning=true
    // independent of the LONG_RUNNING_CMD_RE heuristic. Vite, wrangler,
    // node servers, --watch, etc. all flow through this primitive.
    this.processes.setLongRunning(entry.pid);
    // Long-running facets (vite, nimbus-wrangler, node servers) always
    // get a spawn notification — they're visible and users want to know
    // the PID for later `logs`/`kill`.
    try { this.hooks.onSpawn?.(entry.pid, command, true); } catch {}

    const ctxExports = getNimbusCtxExports();
    const supervisor = { doId: this.ctx.id.toString(), pid: entry.pid };
    const supervisorBinding = ctxExports?.SupervisorRPC
      ? ctxExports.SupervisorRPC({ props: supervisor })
      : undefined;

    const workerKey = `nimbus-process:${supervisor.doId}:${supervisor.pid}`;
    const workerConfig = {
      compatibilityDate: CF_COMPAT_DATE,
      compatibilityFlags: opts.compatibilityFlags || ['nodejs_compat'],
      mainModule: 'worker.js',
      modules: { 'worker.js': workerCode, ...(opts.modules || {}) },
      ...(supervisorBinding ? { env: { SUPERVISOR: supervisorBinding } } : {}),
    };
    const routeConfig = {
      compatibilityDate: CF_COMPAT_DATE,
      compatibilityFlags: opts.compatibilityFlags || ['nodejs_compat'],
      mainModule: 'worker.js',
      modules: { 'worker.js': workerCode, ...(opts.modules || {}) },
    };

    let worker: { getEntrypoint(): LoadedWorkerEntrypointStub } | undefined;
    let startStub: LoadedWorkerEntrypointStub | undefined;
    let routeStub: LoadedWorkerEntrypointStub | undefined;
    let resourcesTracked = false;
    try {
      const loadedWorker: { getEntrypoint(): LoadedWorkerEntrypointStub } =
        this.env.LOADER.get(workerKey, async () => workerConfig);
      worker = loadedWorker;
      startStub = loadedWorker.getEntrypoint();
      routeStub = await createLoadedWorkerEntrypoint(ctxExports, routeConfig, supervisor, null, workerKey);
      this.trackProcessRpcResources(entry.pid, [routeStub, startStub, worker, supervisorBinding]);
      resourcesTracked = true;
      this.portRegistry.bindFacetStub(entry.pid, routeStub);
      if (opts.port && opts.port > 0 && opts.port < 65536) {
        this.portRegistry.register(opts.port, entry.pid, routeStub);
      }
      return { pid: entry.pid, facetStub: startStub };
    } catch (e: unknown) {
      this.portRegistry.unregisterByPid(entry.pid);
      if (resourcesTracked) this.releaseProcessRpcResources(entry.pid);
      else disposeRpcResources([routeStub, startStub, worker, supervisorBinding]);
      this.processes.exit(entry.pid, 1);
      const reason = 'long-running worker boot failed: ' + errorMessage(e);
      this._w5RecordTermination(
        entry.pid,
        1,
        'facet',
        reason,
      );
      try {
        this.hooks.onExternalExit?.(
          entry.pid,
          1,
          reason,
        );
      } catch {}
      throw e;
    }
  }

  registerPort(pid: number, port: number, facetStub: any): void {
    if (port > 0 && port < 65536) {
      this.portRegistry.register(port, pid, facetStub);
    }
  }

  attachReservedPorts(pid: number, facetStub: any): number[] {
    return this.portRegistry.attachFacetStubByPid(pid, facetStub);
  }

  waitForRouteablePorts(
    pid: number,
    facetStub: any,
    timeoutMs = ROUTEABLE_PORT_ATTACH_TIMEOUT_MS,
  ): Promise<number[]> {
    return this.portRegistry.waitForRouteablePortsByPid(pid, facetStub, timeoutMs);
  }

  finishProcess(pid: number, exitCode: number, reason = 'exited'): void {
    this.portRegistry.unregisterByPid(pid);
    this.processes.exit(pid, exitCode);
    this.releaseProcessRpcResources(pid);
    if (exitCode !== 0) {
      this._w5RecordTermination(pid, exitCode, 'facet', reason);
      try { this.hooks.onExternalExit?.(pid, exitCode, reason); } catch {}
    }
  }

  /** Kill a running process by PID. */
  kill(pid: number): boolean {
    const entry = this.processes.get(pid);
    if (!entry || entry.state !== 'running') return false;
    try { (this.ctx as any).facets?.abort(`proc-${entry.pid}`, new Error('SIGKILL')); } catch {}
    try { (this.ctx as any).facets?.delete(`proc-${entry.pid}`); } catch {}
    this.portRegistry.unregisterByPid(pid);
    this.releaseProcessRpcResources(pid);
    const result = this.processes.kill(pid);
    if (result) {
      try { this.hooks.onExternalExit?.(pid, 137, 'killed'); } catch {}
    }
    return result;
  }

  get stats() { return this.processes.stats; }
}
