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
import { fetchNodeShimsCode } from '../runtime/node-shims-artifact.js';
import { generateSqliteFacetPreamble } from '../runtime/sqlite-shim.js';
import { getRealNodeImportsCode } from '../_shared/real-node-imports.js';
import { getCtxExports } from '../session/ctx-exports.js';
import { prefetchForRequire } from '../runtime/require-resolver.js';
import { hasTopLevelModuleSyntax } from '../runtime/javascript-ast.js';
import { bindImportMetaResolve, importMetaDefines } from '../runtime/import-meta-transform.js';
import { recordFailure, getLastRpcFrame, getLastFacetId } from '../observability/oom-discriminator.js';
import { classifyError } from '../observability/oom-classify.js';
import { EsbuildService } from '../runtime/esbuild-service.js';
import { isExecDiagEnabled, recordExecTelemetry } from './exec-telemetry.js';
import { disposeRpcResource, disposeRpcResources } from '../_shared/rpc-dispose.js';
import { sqliteWasmModuleEntry } from './opencode-staging.js';
import { SQLITE_WASM_MODULE_NAME, } from '../runtime/opencode-facet-runner.js';
import { parsePortFromArgv, resolveLongRunningPort } from '../runtime/long-running-handle.js';
import { DEFAULT_FACET_BUNDLE_PROFILE, } from '../runtime/bundle-profile.js';
import { CF_COMPAT_DATE, FACET_TIMEOUT_MS, VFS_BUNDLE_MAX_FILES, VFS_BUNDLE_MAX_BYTES, BUNDLE_MAX_ENCODED_BYTES, } from '../constants.js';
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
function _reviveVfsWriteCell(v) {
    if (typeof v === 'string')
        return v;
    if (v instanceof Uint8Array)
        return v;
    if (v && typeof v === 'object') {
        const o = v;
        const keys = Object.keys(o);
        if (keys.length === 0)
            return new Uint8Array(0);
        // Quick bail-out: not all keys are non-negative integers.
        let maxIdx = -1;
        for (const k of keys) {
            const n = Number(k);
            if (!Number.isInteger(n) || n < 0)
                return String(v);
            if (n > maxIdx)
                maxIdx = n;
        }
        // Dense check: keys.length === maxIdx + 1
        if (keys.length !== maxIdx + 1)
            return String(v);
        const out = new Uint8Array(keys.length);
        for (let i = 0; i < keys.length; i++) {
            const b = o[String(i)];
            if (typeof b !== 'number' || b < 0 || b > 255)
                return String(v);
            out[i] = b;
        }
        return out;
    }
    return String(v);
}
function getNimbusCtxExports() {
    const ctxExports = getCtxExports();
    if (!ctxExports || typeof ctxExports !== 'object') {
        throw new Error('Nimbus: ctx.exports unavailable');
    }
    return ctxExports;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isNimbusWorkerLoader(value) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
        return false;
    return typeof Reflect.get(value, 'load') === 'function' && typeof Reflect.get(value, 'get') === 'function';
}
function parseFacetManagerEnv(env) {
    const loader = ((typeof env === 'object' || typeof env === 'function') && env !== null)
        ? Reflect.get(env, 'LOADER')
        : undefined;
    if (!isNimbusWorkerLoader(loader)) {
        throw new Error('FacetManager requires an env.LOADER binding with load() and get()');
    }
    const assetsCandidate = ((typeof env === 'object' || typeof env === 'function') && env !== null)
        ? Reflect.get(env, 'ASSETS')
        : undefined;
    const assets = assetsCandidate !== null &&
        typeof assetsCandidate === 'object' &&
        typeof Reflect.get(assetsCandidate, 'fetch') === 'function'
        ? assetsCandidate
        : undefined;
    return { LOADER: loader, ASSETS: assets };
}
async function createLoadedWorkerEntrypoint(ctxExports, code, supervisor, name = null, key = `nimbus-process:${supervisor.doId}:${supervisor.pid}`, stage) {
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
            ...(stage ? { stage } : {}),
        },
    });
}
// `await` on a promise created inside an async entrypoint bypasses the
// monkey-patched Promise.prototype.then, so sequential awaited work (timers,
// retry backoffs, giget template fetches) leaves __tracked empty and the
// drain would exit early — abandoning real in-flight work (create-astro /
// nuxi settle their CLI through setTimeout-driven steps). The drain therefore
// also keeps going while __nimbusPendingTimers > 0. It subscribes to the exit
// promise ONCE (a per-pass exitPromise.then() would leak a never-settling
// tracked promise each iteration, which the timers-pending condition would
// spin on until OOM) and yields via the untracked raw setTimeout so its own
// ticks don't inflate the pending-timer count it watches.
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
    // Drain floating entry work until it settles, the process exits, or a
    // bound is hit. Two distinct kinds of pending work need different
    // treatment to match Node's event-loop semantics:
    //
    //   - Unsettled tracked PROMISES are microtask chains. Per Node a pending
    //     promise does NOT keep the process alive — only handles/timers do.
    //     A settling chain (create-vite's clack scaffold, c3 / create-astro
    //     streaming their project to the live VFS) must be allowed to finish,
    //     but a NEVER-settling chain
    //     (\`Promise.resolve().then(() => new Promise(() => {}))\`) must not
    //     pin the facet. So tracked promises are drained only up to a finite
    //     \`maxPromisePasses\` budget — generous enough for the multi-tick
    //     scaffolders, finite enough that a stuck chain still exits.
    //
    //   - Pending macrotask TIMERS/intervals (\`__timersPending\`) DO keep the
    //     loop alive (nuxi settles through setTimeout-driven steps).
    //
    // BOTH branches are bounded by the wall-clock deadline AND the pass
    // budget, because each bound covers the other's blind spot: workerd does
    // not advance \`Date.now()\` while an isolate spins without I/O (measured
    // \`elapsed=0\` across the whole drain), so a no-I/O drain loops forever
    // against a deadline that never trips — the pass budget is the frozen-
    // clock backstop. Under a live clock (host tests, drains interleaved with
    // real I/O) a setTimeout(0) pass costs ~1ms of clamped timer, so the 50k
    // budget alone would spin for tens of seconds — the deadline is the
    // live-clock bound, tripping long before the budget. Scaffolders settle
    // their multi-tick chains well inside both bounds, so a stuck chain, an
    // idle long-running server's keep-alive, a TTL timeout, or a \`--watch\`
    // poller ends the drain promptly instead of pinning the facet and the
    // shell prompt.
    async drain(exitPromise, deadlineMs = 5000, minPasses = 0) {
      const __start = Date.now();
      const __maxPromisePasses = 50000;
      const __timersPending = () => (typeof globalThis.__nimbusPendingTimers === "number" ? globalThis.__nimbusPendingTimers : 0);
      let __exited = false;
      if (exitPromise && typeof exitPromise.then === "function") {
        exitPromise.then(() => { __exited = true; }, () => { __exited = true; });
      }
      const __rawSetTimeout = (typeof globalThis.__nimbusRawSetTimeout === "function")
        ? globalThis.__nimbusRawSetTimeout
        : globalThis.setTimeout;
      let __pass = 0;
      for (
        ;
        !__exited
          && (__pass < minPasses
            || (__timersPending() > 0 && Date.now() - __start < deadlineMs && __pass < __maxPromisePasses)
            || (__tracked.size > 0 && Date.now() - __start < deadlineMs && __pass < __maxPromisePasses));
        __pass++
      ) {
        await new Promise((resolve) => __rawSetTimeout(resolve, 0));
      }
      return __pass;
    },
  };
}
`;
/**
 * Patch the global timer functions so the startup drain can tell when
 * macrotask work is still in flight. One-shot setTimeout decrements the
 * pending count when it fires or is cleared; setInterval counts as one
 * live handle until cleared (the drain deadline bounds genuinely-infinite
 * intervals). Without this the drain — which only follows promise chains
 * — abandons sequential awaited timer work and the facet exits before
 * timer-driven CLIs (create-astro, nuxi) finish scaffolding.
 */
const ENTRYPOINT_TIMER_TRACKER = `
(function(g){
  if (g.__nimbusTimerTrackerInstalled) return;
  g.__nimbusTimerTrackerInstalled = true; g.__nimbusPendingTimers = 0;
  const st = g.setTimeout, ct = g.clearTimeout, si = g.setInterval, ci = g.clearInterval;
  if (typeof st !== "function") return;
  g.__nimbusRawSetTimeout = st;
  const one = new Set(), iv = new Set();
  g.setTimeout = function(fn, ms, ...a){
    if (typeof fn !== "function") return st(fn, ms, ...a);
    let id; g.__nimbusPendingTimers++;
    id = st(function(){ if (one.delete(id)) g.__nimbusPendingTimers--; return fn.apply(this, arguments); }, ms, ...a);
    one.add(id); return id;
  };
  g.clearTimeout = function(id){ if (one.delete(id)) g.__nimbusPendingTimers--; return ct(id); };
  if (typeof si === "function") {
    g.setInterval = function(fn, ms, ...a){ const id = si(fn, ms, ...a); iv.add(id); g.__nimbusPendingTimers++; return id; };
    g.clearInterval = function(id){ if (iv.delete(id)) g.__nimbusPendingTimers--; return ci(id); };
  }
})(globalThis);
`;
const ENTRYPOINT_STARTUP_DRAIN = `
async function __nimbusDrainEntrypointStartup(__entryResult, __entryPromises) {
  if (__entryResult && typeof __entryResult.then === "function") {
    const __exit = {};
    const __result = await Promise.race([
      __entryResult.then(() => null),
      __nimbusProcessExitPromise.then(() => __exit, () => __exit),
    ]);
    if (__result === __exit) return 0;
  }
  return await __entryPromises.drain(__nimbusProcessExitPromise, 8000, 4);
}
`;
/**
 * Static `import * as __real_X from 'node:X'` block. Prepended to generated
 * runtime workers so the shims can forward to workerd's real `node:*` builtins.
 * See src/_shared/real-node-imports.ts for the rationale and matrix.
 */
const REAL_NODE_IMPORTS = getRealNodeImportsCode();
/**
 * Detect whether a facet bundle imports node:sqlite. When true, the
 * supervisor attaches the sql.js WebAssembly.Module to the facet's Worker
 * Loader module map (request-time WebAssembly.compile is blocked) and the
 * generated facet code statically imports it + boots the engine before
 * user code (node:sqlite's DatabaseSync constructor is synchronous, so the
 * wasm must be instantiated up front).
 *
 * Matches `require("node:sqlite")` / `require("sqlite")` (CJS, the
 * resolver strips the node: prefix) and `from "node:sqlite"` (ESM). The
 * scan covers the entry code plus every JS/CJS source already in the
 * prefetch bundle so a transitive dependency that pulls in node:sqlite is
 * also caught.
 */
const NODE_SQLITE_IMPORT_RE = /(?:require\s*\(\s*['"](?:node:)?sqlite['"]\s*\)|from\s+['"]node:sqlite['"]|import\s+['"]node:sqlite['"])/;
function bundleUsesNodeSqlite(entryCode, bundle) {
    if (NODE_SQLITE_IMPORT_RE.test(entryCode))
        return true;
    for (const [path, cell] of Object.entries(bundle)) {
        if (typeof cell !== 'string')
            continue;
        if (!(path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')))
            continue;
        if (NODE_SQLITE_IMPORT_RE.test(cell))
            return true;
    }
    return false;
}
/**
 * Module-init block prepended to facet code only when the bundle uses
 * node:sqlite. Two parts, both at module-eval time (where workerd permits
 * `new Function` and module imports):
 *   1. Static import of the pre-compiled sql.js WebAssembly.Module from
 *      the facet module map, parked on globalThis for the shim's boot.
 *   2. The sql.js glue-factory preamble (new Function at startup — request
 *      time codegen-from-strings is blocked).
 * Omitted otherwise (the import would fail — no sqlite.wasm in the map).
 */
const SQLITE_FACET_IMPORT = `import __nimbusSqliteWasmModule from "${SQLITE_WASM_MODULE_NAME}";\n` +
    `globalThis.__nimbusSqliteWasmModule = __nimbusSqliteWasmModule;\n` +
    generateSqliteFacetPreamble();
/**
 * Awaited before user code runs so the synchronous DatabaseSync
 * constructor finds an instantiated engine. No-op when sqlite isn't used
 * (the global is undefined and the expression short-circuits).
 */
const SQLITE_FACET_BOOT = `if (globalThis.__nimbusInitSqlite) { await globalThis.__nimbusInitSqlite(); }`;
/**
 * Generate one-shot runtime code with a plain fetch handler.
 */
function generateEntrypointCode(userCode, vfsState, usesSqlite, shims) {
    const safeCode = JSON.stringify(userCode);
    const safeBundle = vfsState.serializedBundle ?? _serializeBundleForFacet(vfsState.bundle);
    const safeManifest = vfsState.serializedManifest ?? JSON.stringify(vfsState.manifest);
    const safeMetadata = vfsState.serializedMetadata ?? JSON.stringify(vfsState.metadata);
    return `
${REAL_NODE_IMPORTS}
${usesSqlite ? SQLITE_FACET_IMPORT : ''}
const USER_CODE = ${safeCode};
const __NimbusHostResponse = globalThis.Response;

function __mkCompiledFn(code) {
  // Node strips a leading shebang from every module before evaluation;
  // bin scripts are commonly bundled verbatim with their
  // "#!/usr/bin/env node" line, which is a SyntaxError under new Function.
  if (typeof code === "string" && code.charCodeAt(0) === 35 && code.charCodeAt(1) === 33) {
    const __nl = code.indexOf("\\n");
    code = __nl >= 0 ? code.slice(__nl + 1) : "";
  }
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
const __MODULE_VFS_METADATA = ${safeMetadata};
const __compiledModules = new Map();
const __compileFailures = new Map();
for (const [__p, __c] of Object.entries(__MODULE_VFS_BUNDLE)) {
  // Precompile JS modules AND extensionless CJS entries (bin scripts and
  // shims). workerd forbids new Function at request time, so anything not
  // precompiled here surfaces the misleading "file was not pre-bundled".
  // .json is data; skip it (it loads via JSON.parse, not as a function).
  const __base = __p.slice(__p.lastIndexOf("/") + 1);
  const __dot = __base.lastIndexOf(".");
  const __ext = __dot > 0 ? __base.slice(__dot) : "";
  if (__ext === ".js" || __ext === ".mjs" || __ext === ".cjs" || __ext === "") {
    if (typeof __c !== "string") continue;
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
    const { argv, env, cwd: _cwd, filename, dirname, stdin, captureOutput, cred, diag: __diag } = args;
    let __drainPasses = 0;
    const __vfsBundle = __MODULE_VFS_BUNDLE;
    const __vfsManifest = __MODULE_VFS_MANIFEST;
    const __vfsMetadata = __MODULE_VFS_METADATA;
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
    let __rpcWriteCount = 0;
    const __queueRpcWrite = (method, s) => {
      __rpcWriteCount++;
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

${ENTRYPOINT_TIMER_TRACKER}
${shims}

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
    // undici's fetch (bundled by e.g. create-cloudflare) detaches
    // performance.markResourceTiming and calls it with no receiver,
    // which workerd rejects with "Illegal invocation" and crashes the
    // process from an unhandled fetch-timing callback. Rebind it so a
    // detached call keeps the correct receiver.
    try {
      const __perf = globalThis.performance;
      if (__perf && typeof __perf.markResourceTiming === "function") {
        __perf.markResourceTiming = __perf.markResourceTiming.bind(__perf);
      }
    } catch {}

    const mod = { exports: {} };
    // G2 (runtime-pkg wave): see corresponding comment in NodeProcess.run.
    __require.main = mod;
    try {
      ${usesSqlite ? SQLITE_FACET_BOOT : ''}
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
      __drainPasses = await __nimbusDrainEntrypointStartup(__entryResult, __entryPromises);
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
      ...(__diag ? { diag: { drainPasses: __drainPasses, rpcWrites: __rpcWriteCount } } : {}),
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
function generateLongRunningNodeCode(userCode, vfsState, opts, usesSqlite, shims) {
    const safeCode = JSON.stringify(userCode);
    const safeArgs = JSON.stringify({
        argv: opts.argv || [],
        env: opts.env || {},
        cwd: opts.cwd || '/home/user',
        filename: opts.filename || '<script>',
        dirname: opts.dirname || opts.cwd || '/home/user',
        stdin: opts.stdin || '',
        attachedTty: opts.attachedTty === true,
        cred: opts.cred,
    });
    const safeBundle = _serializeBundleForFacet(vfsState.bundle);
    const safeManifest = JSON.stringify(vfsState.manifest);
    const safeMetadata = JSON.stringify(vfsState.metadata);
    return `
import { WorkerEntrypoint } from "cloudflare:workers";
${REAL_NODE_IMPORTS}
${usesSqlite ? SQLITE_FACET_IMPORT : ''}
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
const __MODULE_VFS_METADATA = ${safeMetadata};
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
    const { argv, env, cwd: _cwd, filename, dirname, stdin, captureOutput, attachedTty, cred } = args;
    const __vfsBundle = __MODULE_VFS_BUNDLE;
    const __vfsManifest = __MODULE_VFS_MANIFEST;
    const __vfsMetadata = __MODULE_VFS_METADATA;
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
    let __rpcWriteCount = 0;
    const __queueRpcWrite = (method, s) => {
      __rpcWriteCount++;
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

${ENTRYPOINT_TIMER_TRACKER}
${shims}

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
    // undici's fetch (bundled by e.g. create-cloudflare) detaches
    // performance.markResourceTiming and calls it with no receiver,
    // which workerd rejects with "Illegal invocation" and crashes the
    // process from an unhandled fetch-timing callback. Rebind it so a
    // detached call keeps the correct receiver.
    try {
      const __perf = globalThis.performance;
      if (__perf && typeof __perf.markResourceTiming === "function") {
        __perf.markResourceTiming = __perf.markResourceTiming.bind(__perf);
      }
    } catch {}
    if (attachedTty) {
      try { __processMod.stdin.__nimbusStartLivePump?.(); } catch {}
    }

    const mod = { exports: {} };
    __require.main = mod;
    let __attachedCompletion = null;
    let __attachedExplicitExit = false;
    try {
      ${usesSqlite ? SQLITE_FACET_BOOT : ''}
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
  await __nimbusEnsureStarted(workerEnv, workerCtx);
  // Streaming dispatch lives in the node-shims http shim (globalThis.__nimbusServeHttp):
  // it returns the in-facet server's response as a streaming host Response the
  // moment headers are known, so SSE / chunked bodies flow live over the RPC
  // boundary instead of being buffered to "finish". Flush process stdout first
  // (independent of the response stream).
  await __nimbusFlushRuntime();
  return globalThis.__nimbusServeHttp(req);
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
function _readBundleCell(vfs, path) {
    const bytes = vfs.readFile(path);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        return bytes;
    }
}
/**
 * hardening-r5: byte-length of a bundle cell for budget accounting.
 * Strings counted as char-length (a slight under-count for non-ASCII
 * but matches the pre-fix behaviour); Uint8Array counted as byteLength.
 */
function _bundleCellLength(cell) {
    return typeof cell === 'string' ? cell.length : cell.byteLength;
}
/**
 * hardening-r5: emit a JS expression that revives binary cells from base64
 * and preserves permission-denial cells alongside ordinary strings.
 *
 * The output is a SELF-EXECUTING IIFE expression so it can be substituted
 * directly into `const __MODULE_VFS_BUNDLE = ${expr};` template slots.
 */
function _serializeBundleForFacet(bundle) {
    const strCells = {};
    const binCells = {};
    const deniedPaths = [];
    for (const [k, v] of Object.entries(bundle)) {
        if (typeof v === 'string') {
            strCells[k] = v;
        }
        else if (v instanceof Uint8Array) {
            // Uint8Array → base64. btoa requires a binary string; we build it
            // 8K chars at a time to avoid String.fromCharCode argument-count
            // limits on large files (~1MB+).
            let bin = '';
            const CHUNK = 8192;
            for (let i = 0; i < v.byteLength; i += CHUNK) {
                bin += String.fromCharCode.apply(null, Array.from(v.subarray(i, Math.min(i + CHUNK, v.byteLength))));
            }
            binCells[k] = btoa(bin);
        }
        else {
            deniedPaths.push(k);
        }
    }
    // The IIFE revives binary cells in-place. atob → binary string →
    // Uint8Array (Uint8Array.from(str, c=>c.charCodeAt(0))).
    // Note: when binCells is empty (the overwhelming common case —
    // source code is all text) the IIFE collapses to a JSON literal,
    // costing only the IIFE wrapper bytes (~30) per facet boot.
    return `(function(){const __b=${JSON.stringify(strCells)};const __x=${JSON.stringify(binCells)};const __d=${JSON.stringify(deniedPaths)};for(const __k in __x){__b[__k]=Uint8Array.from(atob(__x[__k]),__c=>__c.charCodeAt(0));}for(const __k of __d){__b[__k]={error:"EACCES"};}return __b;})()`;
}
/**
 * FNV-1a 32-bit hash, returned as an unsigned hex string. Used only to
 * fold the (possibly large) entry code into a compact, collision-resistant
 * prefetch-bundle cache-key component — not a security primitive.
 */
function _fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
}
const MANIFEST_MAX_DEPTH = 12;
/**
 * Build the manifest pass — uncapped path→child-names map. UNCHANGED
 * from W2.5b; this is the W2.5b root-cause fix and continues to keep
 * fs.readdirSync / fs.statSync honest regardless of which subset of
 * file CONTENT we ship.
 */
function buildManifest(vfs, cwd, scriptPath) {
    const manifest = {};
    function walk(dirPath, depth = 0) {
        if (depth > MANIFEST_MAX_DEPTH)
            return;
        const stripped = dirPath.replace(/^\/+/, '');
        if (stripped in manifest)
            return;
        let entries;
        try {
            entries = vfs.readdir(stripped);
        }
        catch {
            return;
        }
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
            if (segs[i] === 'node_modules') {
                nmIdx = i;
                break;
            }
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
function buildVfsMetadata(vfs, manifest, bundle) {
    const paths = new Set(Object.keys(bundle));
    for (const [directory, children] of Object.entries(manifest)) {
        paths.add(directory);
        for (const child of children) {
            paths.add(directory ? `${directory}/${child}` : child);
        }
    }
    const metadata = {};
    for (const path of paths) {
        try {
            const stat = vfs.lstat(path);
            metadata[path] = {
                type: stat.type,
                size: stat.size,
                mode: stat.mode,
                uid: stat.uid,
                gid: stat.gid,
            };
        }
        catch {
            // The credentialed lookup is authoritative; inaccessible ancestors do
            // not reveal whether a leaf exists.
        }
    }
    return metadata;
}
function addUnreadableDenialCells(vfs, bundle, metadata) {
    for (const [path, stat] of Object.entries(metadata)) {
        if (stat.type === 'directory' || path in bundle)
            continue;
        try {
            vfs.access(path, 0o4);
        }
        catch (error) {
            if (typeof error === 'object'
                && error !== null
                && 'code' in error
                && error.code === 'EACCES') {
                bundle[path] = { error: 'EACCES' };
            }
        }
    }
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
export function greedyAddMainEntries(vfs, cwd, bundle, budgetState) {
    let added = 0;
    const cwdStripped = cwd.replace(/^\/+/, '');
    const nmDir = cwdStripped + '/node_modules';
    if (!(vfs.exists(nmDir) && vfs.isDirectory(nmDir)))
        return { added };
    const exts = ['', '.js', '.cjs', '.mjs', '/index.js', '/index.cjs'];
    function addOne(path) {
        const stripped = path.replace(/^\/+/, '');
        if (stripped in bundle)
            return false;
        if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES)
            return false;
        if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES)
            return false;
        try {
            if (!vfs.exists(stripped) || vfs.isDirectory(stripped))
                return false;
            // hardening-r5: preserve binary content as Uint8Array.
            const content = _readBundleCell(vfs, stripped);
            const cellLen = _bundleCellLength(content);
            if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES)
                return false;
            bundle[stripped] = content;
            budgetState.totalBytes += cellLen;
            budgetState.fileCount++;
            added++;
            return true;
        }
        catch {
            return false;
        }
    }
    // X.5-C Fix #2 helper: walk a (possibly nested) exports value and
    // collect every string-leaf path. unbuild-shaped packages like pathe
    // nest two deep — `exports."."`.{require,import}.{types,default} —
    // and the previous one-level loop only caught the inner string leaves
    // when default was at the top, missing the unbuild shape entirely.
    function collectExportLeaves(node, out) {
        if (typeof node === 'string') {
            out.add(node);
            return;
        }
        if (!node || typeof node !== 'object')
            return;
        // Order matters for the "most likely usable" leaf: prefer require
        // (most CJS-friendly), then default, then node, then import. We add
        // ALL of them to the candidate set — addPkgEntry will probe each.
        for (const k of ['require', 'node', 'default', 'import']) {
            if (k in node)
                collectExportLeaves(node[k], out);
        }
    }
    function addPkgEntry(pkgDir) {
        addOne(pkgDir + '/package.json');
        let meta;
        try {
            meta = JSON.parse(vfs.readFileString(pkgDir + '/package.json'));
        }
        catch {
            meta = null;
        }
        const candidates = new Set();
        if (meta) {
            if (typeof meta.main === 'string')
                candidates.add(meta.main);
            if (typeof meta.module === 'string')
                candidates.add(meta.module);
            const exp = meta.exports;
            if (typeof exp === 'string')
                candidates.add(exp);
            else if (exp && typeof exp === 'object') {
                const dot = exp['.'];
                // X.5-C Fix #2: walk nested condition trees recursively. Without
                // this, packages with two-level exports (pathe, magic-string,
                // most unbuild-emitted libs) miss their actual entry leaf and
                // greedyAddMainEntries falls back to /index.js probing — which
                // doesn't exist for those packages.
                collectExportLeaves(dot, candidates);
            }
        }
        if (candidates.size === 0)
            candidates.add('index.js');
        for (const rel of candidates) {
            const norm = rel.replace(/^\.\//, '');
            const base = pkgDir + '/' + norm;
            let landed = false;
            const tries = /\.[a-z]+$/.test(norm) ? [base] : exts.map((e) => base + e);
            for (const candidate of tries) {
                if (vfs.exists(candidate.replace(/^\/+/, '')) &&
                    !vfs.isDirectory(candidate.replace(/^\/+/, ''))) {
                    if (addOne(candidate)) {
                        landed = true;
                        break;
                    }
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
                        if (sib.type !== 'file')
                            continue;
                        // Hash-chunk pattern: <name>.<hash>.<cjs|mjs|js>. Hash must
                        // be 6+ chars AND look like a hash, not an English word —
                        // either contain digits/underscore/dash, or contain BOTH
                        // uppercase AND lowercase letters (real bundler hashes are
                        // mixed-case base64-shaped: `BSlhyZSM`, `M-eThtNZ`, ...). This
                        // discriminator keeps us from false-positiving on common
                        // suffixes that happen to be 6+ chars all-lowercase like
                        // `minified`, `modern`, `production`, `compiled`.
                        const hashMatch = sib.name.match(/\.([A-Za-z0-9_-]{6,})\.(cjs|mjs|js)$/);
                        if (!hashMatch)
                            continue;
                        const seg = hashMatch[1];
                        const hasDigitOrDash = /[0-9_-]/.test(seg);
                        const hasMixedCase = /[A-Z]/.test(seg) && /[a-z]/.test(seg);
                        if (!hasDigitOrDash && !hasMixedCase)
                            continue;
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
                            if (sh.type !== 'file')
                                continue;
                            if (!/\.(cjs|mjs|js)$/.test(sh.name))
                                continue;
                            addOne(sharedDir + '/' + sh.name);
                        }
                    }
                }
                catch { /* unreadable dir — drop sibling oversample, entry
                               file is enough */
                }
                break;
            }
        }
    }
    try {
        for (const pkg of vfs.readdir(nmDir)) {
            if (pkg.type !== 'directory')
                continue;
            const pkgDir = nmDir + '/' + pkg.name;
            if (pkg.name.startsWith('@')) {
                try {
                    for (const sub of vfs.readdir(pkgDir)) {
                        if (sub.type === 'directory')
                            addPkgEntry(pkgDir + '/' + sub.name);
                    }
                }
                catch { /* ignore */ }
            }
            else {
                addPkgEntry(pkgDir);
            }
        }
    }
    catch { /* ignore */ }
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
export function addStaticReadFileAssets(vfs, cwd, bundle, budgetState) {
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
    function addOneAsset(absPath) {
        const stripped = absPath.replace(/^\/+/, '');
        if (stripped in bundle)
            return false;
        if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES)
            return false;
        if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES)
            return false;
        try {
            if (!vfs.exists(stripped) || vfs.isDirectory(stripped))
                return false;
            // hardening-r5: preserve binary content as Uint8Array.
            const content = _readBundleCell(vfs, stripped);
            const cellLen = _bundleCellLength(content);
            if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES)
                return false;
            bundle[stripped] = content;
            budgetState.totalBytes += cellLen;
            budgetState.fileCount++;
            added++;
            return true;
        }
        catch {
            return false;
        }
    }
    // Snapshot the keys first — we mutate `bundle` during the loop.
    const sourceKeys = Object.keys(bundle).filter((k) => k.endsWith('.js') || k.endsWith('.mjs') || k.endsWith('.cjs'));
    for (const sourcePath of sourceKeys) {
        const src = bundle[sourcePath];
        if (!src || src.length === 0)
            continue;
        // hardening-r5: skip binary cells (a .js extension on a binary file
        // is rare but possible — defensive guard prevents .replace() throwing
        // on a Uint8Array).
        if (typeof src !== 'string')
            continue;
        // Strip line + block comments before regex-matching so the pattern
        // doesn't fire inside `// fs.readFileSync(...)` etc.
        const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        // Quick reject: skip files that don't even contain readFileSync.
        if (stripped.indexOf('readFileSync') < 0)
            continue;
        const sourceDir = sourcePath.includes('/')
            ? sourcePath.substring(0, sourcePath.lastIndexOf('/'))
            : '';
        RX.lastIndex = 0;
        let match;
        while ((match = RX.exec(stripped)) !== null) {
            const quote = match[1];
            const rel = match[2];
            // Reject template-literal interpolation inside backticks.
            if (quote === '`' && rel.indexOf('${') >= 0)
                continue;
            // Reject any form that looks dynamic (defensive — RX already
            // requires literal but absolute paths starting with `/` would
            // bypass the __dirname-relative semantics; allow them since
            // they're literal and unambiguous).
            if (!ASSET_EXT.test(rel))
                continue;
            // Resolve relative to the source file's directory (the runtime's
            // __dirname for that source). Match runtime resolution: leading
            // `./` strips, `..` walks up.
            let resolved;
            if (rel.startsWith('/')) {
                resolved = rel.replace(/^\/+/, '');
            }
            else {
                const parts = (sourceDir + '/' + rel).split('/');
                const out = [];
                for (const seg of parts) {
                    if (seg === '' || seg === '.')
                        continue;
                    if (seg === '..') {
                        if (out.length > 0)
                            out.pop();
                        continue;
                    }
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
export function addStaticReadFileDotfilesAndCompiled(vfs, cwd, bundle, budgetState) {
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
        '([\'"`])([^\'"`]+)\\1', 'g');
    function addOneAsset(absPath) {
        const stripped = absPath.replace(/^\/+/, '');
        if (stripped in bundle)
            return false;
        if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES)
            return false;
        if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES)
            return false;
        try {
            if (!vfs.exists(stripped) || vfs.isDirectory(stripped))
                return false;
            // hardening-r5: preserve binary content as Uint8Array.
            const content = _readBundleCell(vfs, stripped);
            const cellLen = _bundleCellLength(content);
            if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES)
                return false;
            bundle[stripped] = content;
            budgetState.totalBytes += cellLen;
            budgetState.fileCount++;
            added++;
            return true;
        }
        catch {
            return false;
        }
    }
    // Snapshot keys; we mutate `bundle` during the loop.
    const sourceKeys = Object.keys(bundle).filter((k) => k.endsWith('.js') || k.endsWith('.mjs') || k.endsWith('.cjs'));
    for (const sourcePath of sourceKeys) {
        const src = bundle[sourcePath];
        if (!src || src.length === 0)
            continue;
        // hardening-r5: skip binary cells (a .js extension on a binary file
        // is rare but possible — defensive guard prevents .replace() throwing
        // on a Uint8Array).
        if (typeof src !== 'string')
            continue;
        // Strip line + block comments before regex-matching so the pattern
        // doesn't fire inside `// fs.readFileSync(...)` etc.
        const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        // Quick reject: skip files that don't even contain readFileSync.
        if (stripped.indexOf('readFileSync') < 0)
            continue;
        const sourceDir = sourcePath.includes('/')
            ? sourcePath.substring(0, sourcePath.lastIndexOf('/'))
            : '';
        RX.lastIndex = 0;
        let match;
        while ((match = RX.exec(stripped)) !== null) {
            const quote = match[1];
            const rel = match[2];
            // Reject template-literal interpolation inside backticks.
            if (quote === '`' && rel.indexOf('${') >= 0)
                continue;
            // Resolve relative to the source file's __dirname (matches runtime).
            let resolved;
            if (rel.startsWith('/')) {
                resolved = rel.replace(/^\/+/, '');
            }
            else {
                const parts = (sourceDir + '/' + rel).split('/');
                const out = [];
                for (const seg of parts) {
                    if (seg === '' || seg === '.')
                        continue;
                    if (seg === '..') {
                        if (out.length > 0)
                            out.pop();
                        continue;
                    }
                    out.push(seg);
                }
                resolved = out.join('/');
            }
            // Apply the bounded-heuristic gate on the BASENAME so we don't
            // overshoot. Z3's `ASSET_EXT` filter overlaps but doesn't cover
            // dotfiles or no-extension sentinels, which is X.5-U's class.
            const slash = resolved.lastIndexOf('/');
            const basename = slash >= 0 ? resolved.slice(slash + 1) : resolved;
            if (!FILENAME_GATE.test(basename))
                continue;
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
function addBinTargetSiblings(vfs, scriptPath, bundle, budgetState, bundleProfile) {
    if (!scriptPath)
        return { added: 0 };
    const stripped = scriptPath.replace(/^\/+/, '');
    // Find the *innermost* node_modules/<pkg> root. Handles scoped
    // packages (`@org/name`) too.
    const segs = stripped.split('/');
    let nmIdx = -1;
    for (let i = segs.length - 1; i >= 0; i--) {
        if (segs[i] === 'node_modules') {
            nmIdx = i;
            break;
        }
    }
    if (nmIdx < 0)
        return { added: 0 };
    const isScoped = segs[nmIdx + 1]?.startsWith('@');
    const pkgEnd = isScoped ? nmIdx + 3 : nmIdx + 2;
    if (pkgEnd > segs.length)
        return { added: 0 };
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
    const queue = [pkgRoot];
    while (queue.length > 0 && visited < MAX_PKG_FILES) {
        const dir = queue.shift();
        let entries;
        try {
            entries = vfs.readdir(dir);
        }
        catch {
            continue;
        }
        for (const e of entries) {
            if (visited >= MAX_PKG_FILES)
                break;
            visited++;
            if (e.name === 'node_modules')
                continue;
            if (e.name === '.git')
                continue;
            const child = dir + '/' + e.name;
            if (e.type === 'directory') {
                if (!shouldVisitBinPackageDirectory(pkgRoot, child, bundleProfile))
                    continue;
                queue.push(child);
                continue;
            }
            // File. Skip if already in bundle (the static walker beat us
            // to it) or outside this profile's package-data policy.
            if (!shouldIncludeBinPackageFile(pkgRoot, child, bundleProfile))
                continue;
            if (bundle[child] !== undefined)
                continue;
            if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES)
                return { added };
            if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES)
                return { added };
            // hardening-r5: preserve binary content as Uint8Array.
            let content;
            try {
                content = _readBundleCell(vfs, child);
            }
            catch {
                continue;
            }
            const cellLen = _bundleCellLength(content);
            if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES)
                return { added };
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
function shouldIncludeBinPackageFile(pkgRoot, path, bundleProfile) {
    if (bundleProfile === 'scaffold')
        return true;
    if (RUNTIME_PACKAGE_EXCLUDED_ROOT_DIRS.has(binPackageRootSegment(pkgRoot, path)))
        return false;
    const lower = binPackageRelativePath(pkgRoot, path).toLowerCase();
    for (const suffix of RUNTIME_PACKAGE_EXCLUDED_FILE_SUFFIXES) {
        if (lower.endsWith(suffix))
            return false;
    }
    return true;
}
function shouldVisitBinPackageDirectory(pkgRoot, path, bundleProfile) {
    if (bundleProfile === 'scaffold')
        return true;
    return !RUNTIME_PACKAGE_EXCLUDED_ROOT_DIRS.has(binPackageRootSegment(pkgRoot, path));
}
function binPackageRootSegment(pkgRoot, path) {
    const rel = binPackageRelativePath(pkgRoot, path);
    const firstSlash = rel.indexOf('/');
    return firstSlash >= 0 ? rel.slice(0, firstSlash) : rel;
}
function binPackageRelativePath(pkgRoot, path) {
    return path.startsWith(pkgRoot + '/') ? path.slice(pkgRoot.length + 1) : path;
}
function addCwdProjectFiles(vfs, cwd, bundle, budgetState) {
    const root = (cwd || '/home/user').replace(/^\/+/, '').replace(/\/+$/, '') || 'home/user';
    const MAX_PROJECT_FILES = 512;
    const SKIP_DIRS = new Set(['node_modules', '.git', '.nimbus']);
    let added = 0;
    let visited = 0;
    const queue = [root];
    while (queue.length > 0 && visited < MAX_PROJECT_FILES) {
        const dir = queue.shift();
        let entries;
        try {
            entries = vfs.readdir(dir);
        }
        catch {
            continue;
        }
        for (const e of entries) {
            if (visited >= MAX_PROJECT_FILES)
                break;
            visited++;
            if (e.name === '.' || e.name === '..')
                continue;
            if (e.type === 'directory' && SKIP_DIRS.has(e.name))
                continue;
            const child = dir + '/' + e.name;
            if (e.type === 'directory') {
                queue.push(child);
                continue;
            }
            if (bundle[child] !== undefined)
                continue;
            if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES)
                return { added };
            if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES)
                return { added };
            let content;
            try {
                content = _readBundleCell(vfs, child);
            }
            catch {
                continue;
            }
            const cellLen = _bundleCellLength(content);
            if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES)
                return { added };
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
function addEntryAbsPathReads(vfs, entryCode, bundle, budgetState) {
    let added = 0;
    // Capture absolute-path string literals. The path may not contain
    // the quote char; the surrounding regex strips line/block comments
    // first to avoid commented-out matches.
    // Path char set: alnum + dot + dash + slash + underscore. This
    // excludes spaces, glob chars, template syntax — all dynamic.
    const RX = /(['"`])(\/[A-Za-z0-9._\-\/]{1,510})\1/g;
    const REJECT_PREFIX = /^\/(proc|sys|dev|lib|lib64|boot|root)(\/|$)/;
    function tryAdd(absPath) {
        if (!absPath || absPath.length < 2 || absPath.length > 512)
            return;
        if (REJECT_PREFIX.test(absPath))
            return;
        const stripped = absPath.replace(/^\/+/, '');
        if (stripped in bundle)
            return;
        if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES)
            return;
        if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES)
            return;
        try {
            if (!vfs.exists(stripped) || vfs.isDirectory(stripped))
                return;
            // hardening-r5: preserve binary content as Uint8Array.
            const content = _readBundleCell(vfs, stripped);
            const cellLen = _bundleCellLength(content);
            if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES)
                return;
            bundle[stripped] = content;
            budgetState.totalBytes += cellLen;
            budgetState.fileCount++;
            added++;
        }
        catch { /* swallow — file may be binary, race-deleted, etc. */ }
    }
    function scanOne(src) {
        if (!src)
            return;
        // Strip line + block comments so we don't match commented-out reads.
        const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        RX.lastIndex = 0;
        let m;
        while ((m = RX.exec(stripped)) !== null) {
            const literal = m[2];
            // Skip if there's any unsafe char (defensive — RX already
            // forbids most). The check on the captured group is cheap.
            if (/[\?\*\[\]\{\}]/.test(literal))
                continue;
            tryAdd(literal);
        }
    }
    // Always scan entry code.
    scanOne(entryCode);
    // Optionally scan bundled JS sources too — useful for transitive cases
    // where a require'd module hardcodes an absolute path. Use the same
    // budget-state so we don't blow caps.
    const sourceKeys = Object.keys(bundle).filter((k) => k.endsWith('.js') || k.endsWith('.mjs') || k.endsWith('.cjs'));
    for (const k of sourceKeys) {
        if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES)
            break;
        if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES)
            break;
        // hardening-r5: scanOne expects string. Binary cells (rare with a
        // .js extension but possible) are skipped — scanOne would throw on
        // a Uint8Array .replace() call.
        const cell = bundle[k];
        if (typeof cell !== 'string')
            continue;
        scanOne(cell);
    }
    return { added };
}
function looksLikeEsm(src) {
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
const __esmTransformCache = new Map();
function __cacheKey(src) {
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
function _markBundleEsmAsFailed(bundle, reason) {
    for (const path of Object.keys(bundle)) {
        if (!path.endsWith('.js') && !path.endsWith('.mjs'))
            continue;
        const src = bundle[path];
        if (typeof src !== 'string')
            continue;
        if (!looksLikeEsm(src))
            continue;
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
async function transformEsmInBundle(bundle, esbuild) {
    let transformed = 0;
    let failed = 0;
    // Snapshot the keys first — esbuild calls await; never iterate-and-mutate.
    const candidates = [];
    for (const path of Object.keys(bundle)) {
        if (!path.endsWith('.js') && !path.endsWith('.mjs'))
            continue;
        const src = bundle[path];
        // hardening-r5: binary cells (rare for .js/.mjs but defensive) are
        // not ESM. Skip — looksLikeEsm + esbuild.transform expect strings.
        if (typeof src !== 'string')
            continue;
        if (!looksLikeEsm(src))
            continue;
        candidates.push(path);
    }
    for (const path of candidates) {
        const src = bundle[path];
        if (typeof src !== 'string')
            continue;
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
        }
        catch (e) {
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
            const diagnosticSrc = '// framework-fixes-F4 diagnostic shim — esbuild rejected the ESM transform\n' +
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
async function buildPrefetchBundle(vfs, scriptPath, cwd, entryCode, esbuild, bundleProfile = DEFAULT_FACET_BUNDLE_PROFILE) {
    // 1. Static reachable-set walk from entry.
    const prefetch = prefetchForRequire(vfs, entryCode || '', cwd, scriptPath);
    const bundle = { ...prefetch.bundle };
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
        }
        catch (e) {
            // framework-fixes-F4 (2026-05-12): the prior catch was silent.
            // Replace every detected-ESM source with the SAME diagnostic
            // shim transformEsmInBundle's per-file catch installs, so the
            // user sees "esbuild transform failed (service-level): <reason>"
            // instead of a bare "Cannot use import statement..." parse
            // error with no context.
            const reason = (e && e.message) ? String(e.message).replace(/\n/g, ' ') : String(e);
            _markBundleEsmAsFailed(bundle, `esbuild service unavailable: ${reason}`);
        }
    }
    else {
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
            if (encoded <= BUNDLE_MAX_ENCODED_BYTES)
                break;
            delete bundle[k];
            fileCount--;
            encoded = encoder.encode(JSON.stringify({ bundle, manifest })).length;
        }
    }
    const metadata = buildVfsMetadata(vfs, manifest, bundle);
    addUnreadableDenialCells(vfs, bundle, metadata);
    // Suppress lint: `greedy.added` is observed only via diagnostics.
    void greedy;
    return { bundle, manifest, metadata, reachableCount: fileCount, truncated };
}
const ROUTEABLE_PORT_ATTACH_TIMEOUT_MS = 1_000;
export class FacetManager {
    ctx;
    env;
    processes;
    portRegistry;
    vfs = null;
    hooks;
    processRpcResources = new Map();
    timedOutProcessIds = new Set();
    // attach-pid → serve-pid: the resident serve facet a bare-`opencode` dual
    // spawn created as an OS-child of the attach TUI. When the attach process
    // exits (reported / killed), its serve facet is torn down with it.
    _pairedServeFacet = new Map();
    /**
     * W3.5 Fix B: lazily-created EsbuildService for the ESM→CJS pre-pass
     * over the prefetch bundle. Created on first exec where vfs is set;
     * shared across subsequent execs (warm wasm).  Optional setter
     * `setEsbuildService` lets NimbusSession share its existing instance
     * to avoid double-init.
     */
    esbuild = null;
    /**
     * Prefetch-bundle cache. buildPrefetchBundle does a full VFS reachable-set
     * walk + greedy oversample + esbuild ESM→CJS pass on EVERY foreground
     * exec — dominant wall-clock on large node_modules. This memoizes the
     * result (including the serialized facet bundle + manifest) keyed on
     * (bundleProfile, cwd, scriptPath, entryCode identity).
     *
     * Correctness watermark: the GLOBAL SqliteVFS revision. buildPrefetchBundle
     * reads from paths that can lie anywhere in the VFS (addEntryAbsPathReads
     * pulls absolute-path literals like /tmp/x; buildManifest walks from '/'),
     * so a cwd-scoped subtree revision cannot guarantee invalidation. The
     * global revision bumps on ANY write, so the cache invalidates on every
     * mutation that could change any file the bundle reads — provably
     * conservative. Bounded to a small LRU; the working set per session is a
     * handful of bins (tsc/vite/eslint) plus repeated `node -e` shapes.
     */
    prefetchBundleCache = new Map();
    static PREFETCH_CACHE_MAX = 16;
    // NOTE: the opencode artifact sources (entry bundle, chunk pack, TUI worker
    // sources, wasm sidecars) are NEVER materialized on this manager — the
    // supervisor DO OOM-reset at the 128 MiB isolate cap when the dual
    // serve+attach spawn staged them here. facets/opencode-staging.ts assembles
    // the facet config inside NimbusLoadedEntrypoint (a stateless worker
    // isolate) on the Worker-Loader cache-miss path; this manager only builds
    // the small OpencodeStageSpec (argv/env/VFS snapshot).
    constructor(ctx, env, processes, portRegistry, hooks = {}) {
        this.ctx = ctx;
        this.env = parseFacetManagerEnv(env);
        this.processes = processes;
        this.portRegistry = portRegistry;
        this.hooks = hooks;
    }
    setVfs(vfs) { this.vfs = vfs; }
    /**
     * W3.5 Fix B: hand the FacetManager a pre-warmed EsbuildService for
     * the ESM→CJS bundle pre-pass. NimbusSession already lazy-creates one
     * for the user-shell `node` runtime; sharing avoids paying init twice.
     */
    setEsbuildService(esbuild) { this.esbuild = esbuild; }
    /**
     * buildPrefetchBundle wrapped in a global-revision-keyed cache. On a hit
     * (same key AND the VFS hasn't been mutated since) it returns the memoized
     * bundle + pre-serialized facet source, skipping the full VFS walk +
     * esbuild pass + re-serialization. See `prefetchBundleCache` for the
     * correctness argument behind the conservative global-revision watermark.
     *
     * The serialized bundle/manifest are computed once on the miss path (the
     * caller would build them anyway via generateEntrypointCode) and stored so
     * subsequent hits skip re-serialization too.
     */
    async _buildPrefetchBundleCached(vfs, scriptPath, cwd, entryCode, credKey, bundleProfile) {
        const profile = bundleProfile ?? DEFAULT_FACET_BUNDLE_PROFILE;
        const key = `${profile}\x00${credKey}\x00${cwd}\x00${scriptPath ?? ''}\x00${_fnv1a(entryCode)}`;
        const revision = vfs.revision();
        const cached = this.prefetchBundleCache.get(key);
        if (cached && cached.revision === revision) {
            // Refresh LRU recency.
            this.prefetchBundleCache.delete(key);
            this.prefetchBundleCache.set(key, cached);
            return { ...cached.vfsState, cacheHit: true };
        }
        const vfsState = await buildPrefetchBundle(vfs, scriptPath, cwd, entryCode, this.esbuild || undefined, bundleProfile);
        vfsState.serializedBundle = _serializeBundleForFacet(vfsState.bundle);
        vfsState.serializedManifest = JSON.stringify(vfsState.manifest);
        vfsState.serializedMetadata = JSON.stringify(vfsState.metadata);
        vfsState.cacheHit = false;
        this.prefetchBundleCache.set(key, { revision, vfsState });
        if (this.prefetchBundleCache.size > FacetManager.PREFETCH_CACHE_MAX) {
            const oldest = this.prefetchBundleCache.keys().next().value;
            if (oldest !== undefined)
                this.prefetchBundleCache.delete(oldest);
        }
        return vfsState;
    }
    /**
     * Build the Worker Loader module-map fragment that carries the sql.js
     * WebAssembly.Module into a facet, when that facet imports node:sqlite.
     * Returns `{}` for the common case (no sqlite) so the spread is free.
     * Delegates to the shared per-isolate memoizer in opencode-staging.ts.
     */
    sqliteModuleEntry(usesSqlite) {
        return sqliteWasmModuleEntry(this.env, usesSqlite);
    }
    trackProcessRpcResources(pid, resources, options = {}) {
        this.releaseProcessRpcResources(pid);
        this.processRpcResources.set(pid, {
            resources: [...resources],
            releaseOnReportExit: options.releaseOnReportExit !== false,
        });
    }
    releaseProcessRpcResources(pid) {
        const tracked = this.processRpcResources.get(pid);
        if (!tracked)
            return;
        this.processRpcResources.delete(pid);
        disposeRpcResources(tracked.resources);
    }
    noteProcessReportedExit(pid, exitCode) {
        this.portRegistry.unregisterByPid(pid);
        this.processes.exit(pid, exitCode);
        const tracked = this.processRpcResources.get(pid);
        if (tracked?.releaseOnReportExit)
            this.releaseProcessRpcResources(pid);
        this._teardownPairedServeFacet(pid);
    }
    /**
     * Tear down the serve facet a dual (`opencode`) spawn paired with this pid.
     * Called when the attach TUI exits (reported / killed) so the OS-child serve
     * facet never outlives its foreground process.
     */
    _teardownPairedServeFacet(attachPid) {
        const servePid = this._pairedServeFacet.get(attachPid);
        if (servePid === undefined)
            return;
        this._pairedServeFacet.delete(attachPid);
        try {
            this.kill(servePid);
        }
        catch { }
    }
    /** Execute one-shot JS code in an isolated dynamic Worker. */
    async exec(code, opts) {
        const command = opts.command
            || (opts.filename && opts.filename !== '<eval>'
                ? `node ${opts.filename}` : 'node -e ...');
        let entry;
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
        }
        else {
            this.processes.reap();
            entry = this.processes.spawn(command, opts.argv || [], opts.cwd || '/home/user');
            // Short foreground `node -e ...` helpers are quiet by design — only
            // notify for user-facing `node <file>` invocations, which covers the
            // real user intent (running scripts, wrangler, etc.).
            if (opts.filename && opts.filename !== '<eval>') {
                try {
                    this.hooks.onSpawn?.(entry.pid, command, false);
                }
                catch { }
            }
        }
        // W3.5 Fix B: thread an EsbuildService into buildPrefetchBundle so
        // ESM source files (e.g. tldts/dist/es6/index.js, @remix-run/react,
        // @tailwindcss/vite, react-remove-scroll, astro) get transformed to
        // CJS before they hit the facet's `new Function` pre-compile loop.
        // Lazy-create one if NimbusSession didn't share its own.
        if (this.vfs && !this.esbuild) {
            try {
                this.esbuild = new EsbuildService(this.vfs);
            }
            catch {
                this.esbuild = null;
            }
        }
        const diagOn = isExecDiagEnabled();
        const __bundleStart = diagOn ? Date.now() : 0;
        const processVfs = this.vfs?.as(entry.cred);
        const credKey = `${entry.cred.uid}:${entry.cred.gid}:${entry.cred.groups.join(',')}`;
        const vfsState = processVfs
            ? await this._buildPrefetchBundleCached(processVfs, opts.filename, opts.cwd || '/home/user', code, credKey, opts.bundleProfile)
            : { bundle: {}, manifest: {}, metadata: {}, reachableCount: 0, truncated: false };
        const bundleMs = diagOn ? Date.now() - __bundleStart : 0;
        const diagSink = diagOn ? { loadMs: 0, runMs: 0, moduleMapBytes: 0 } : undefined;
        const abortController = new AbortController();
        try {
            const result = await this._execWithTimeout(this._execViaLoader(code, opts, entry, vfsState, abortController.signal, diagSink), entry, () => abortController.abort());
            this.processes.exit(entry.pid, result.exitCode);
            if (result.exitCode !== 0) {
                this._w5RecordTermination(entry.pid, result.exitCode, 'runtime-worker', result.stderr || `exit ${result.exitCode}`);
            }
            if (diagOn && diagSink) {
                recordExecTelemetry({
                    command,
                    bundleMs,
                    loadMs: diagSink.loadMs,
                    runMs: diagSink.runMs,
                    drainPasses: result.diag?.drainPasses ?? 0,
                    moduleMapBytes: diagSink.moduleMapBytes,
                    rpcWrites: result.diag?.rpcWrites ?? 0,
                    cacheHit: vfsState.cacheHit ?? false,
                    exitCode: result.exitCode,
                    at: Date.now(),
                });
            }
            this._flushVfsWrites(result, entry.pid);
            return result;
        }
        catch (err) {
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
            this._w5RecordTermination(entry.pid, exitCode, timedOut ? 'rpc' : 'runtime-worker', reason);
            // Non-timeout failure: route through external-exit so the log
            // store marks exit AND the tabs-UI structured event fires. The
            // timeout path already called onExternalExit from the timeout
            // handler; _reportExternalExit's getExit() guard dedupes.
            if (!timedOut) {
                try {
                    this.hooks.onExternalExit?.(entry.pid, exitCode, reason);
                }
                catch { }
            }
            return { exitCode, stdout: '', stderr: errorMessage(err) };
        }
        finally {
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
    _w5RecordTermination(pid, exitCode, phase, reason) {
        try {
            let cause = classifyError(reason);
            if (exitCode === 124 && cause === 'unknown')
                cause = 'rpc_timeout';
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
        }
        catch (e) {
            // Fail-soft: telemetry must never break the exit path.
            console.warn('[facet-manager/W5] recordFailure threw:', e?.message);
        }
    }
    // ── One-shot dynamic Worker entrypoint ────────────────────────────────
    async _execViaLoader(code, opts, entry, vfsState, signal, diagSink) {
        const usesSqlite = bundleUsesNodeSqlite(code, vfsState.bundle);
        const [sqliteModules, shims] = await Promise.all([
            this.sqliteModuleEntry(usesSqlite),
            fetchNodeShimsCode(this.env),
        ]);
        const workerCode = generateEntrypointCode(code, vfsState, usesSqlite, shims);
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
            cred: { ...entry.cred, groups: [...entry.cred.groups] },
            ...(diagSink ? { diag: true } : {}),
        });
        if (diagSink) {
            diagSink.moduleMapBytes = new TextEncoder().encode(workerCode).length;
            for (const m of Object.values(sqliteModules)) {
                diagSink.moduleMapBytes += m.wasm.byteLength;
            }
        }
        let worker;
        let entrypoint;
        try {
            const __loadStart = diagSink ? Date.now() : 0;
            worker = this.env.LOADER.load({
                compatibilityDate: CF_COMPAT_DATE,
                compatibilityFlags: ['nodejs_compat', 'nodejs_compat_v2'],
                mainModule: 'runner.js',
                modules: { 'runner.js': workerCode, ...sqliteModules },
                ...(supervisorBinding ? { env: { SUPERVISOR: supervisorBinding } } : {}),
            });
            entrypoint = worker.getEntrypoint();
            if (typeof entrypoint.fetch !== 'function') {
                throw new Error('Nimbus: one-shot runtime entrypoint has no fetch method');
            }
            if (diagSink)
                diagSink.loadMs = Date.now() - __loadStart;
            const __runStart = diagSink ? Date.now() : 0;
            const response = await entrypoint.fetch(new Request('http://nimbus-runtime.local/run', {
                method: 'POST',
                body,
                signal,
            }));
            try {
                const result = await response.json();
                if (diagSink)
                    diagSink.runMs = Date.now() - __runStart;
                return result;
            }
            finally {
                disposeRpcResource(response);
            }
        }
        finally {
            // A one-shot facet is unkeyed (LOADER.load) and cannot be re-resolved
            // into a later request's context, so it can never be a routeable target
            // (server scripts are promoted to the keyed long-running facet instead).
            // But its http shim still calls SUPERVISOR.registerPort on listen(); drop
            // any such reservation here so a dead facet leaves no stale null-stub port.
            this.portRegistry.unregisterByPid(entry.pid);
            disposeRpcResource(entrypoint);
            disposeRpcResource(worker);
            disposeRpcResource(supervisorBinding);
        }
    }
    /**
     * Run a staged-artifact bundle (currently opencode) as an ESM mainModule.
     *
     * The bundle is ESM-only and imports node:sqlite, so it cannot use the
     * `new Function` CJS facet path. It rides into the Worker Loader module map
     * as a real ESM module; the generated runner (mainModule) installs the
     * Bun-global polyfill, seeds process state, imports the bundle, and returns
     * buffered stdout/stderr/exit. node:sqlite is supplied as an override map
     * module so the static import links.
     */
    async execStagedArtifact(artifact, opts) {
        const mode = opts.attachedTty === true ? 'attached' : 'oneshot';
        const staged = await this._stageOpencodeFacet(artifact, opts, mode);
        if (mode === 'attached') {
            return await this._execStagedArtifactAttached(staged.pid, staged.command, staged.stageSpec);
        }
        // One-shot: run through a keyed, stage-carrying NimbusLoadedEntrypoint —
        // the ~23 MB module map is assembled inside the stateless entrypoint on
        // the Worker-Loader cache-miss path (with SUPERVISOR bound to THIS call's
        // context, which stays open for the whole run), never in this DO.
        const supervisor = { doId: this.ctx.id.toString(), pid: staged.pid };
        const ctxExports = getNimbusCtxExports();
        let entrypoint;
        try {
            entrypoint = await createLoadedWorkerEntrypoint(ctxExports, undefined, supervisor, null, undefined, staged.stageSpec);
            if (typeof entrypoint.fetch !== 'function') {
                throw new Error('Nimbus: opencode runner entrypoint has no fetch method');
            }
            const response = await entrypoint.fetch(new Request('http://nimbus-runtime.local/run', { method: 'POST' }));
            try {
                const result = await response.json();
                this.processes.exit(staged.pid, result.exitCode);
                this._flushVfsWrites(result, staged.pid);
                return { ...result, pid: staged.pid };
            }
            finally {
                disposeRpcResource(response);
            }
        }
        catch (e) {
            this.processes.exit(staged.pid, 1);
            throw e;
        }
        finally {
            disposeRpcResource(entrypoint);
        }
    }
    /**
     * Prepare a staged-opencode spawn: spawn the process-table entry, snapshot
     * the VFS, and build the small OpencodeStageSpec. The artifact sources
     * (entry bundle, chunk pack, wasm sidecars — ~23 MB of module map) are NOT
     * materialized here: NimbusLoadedEntrypoint assembles them from the spec in
     * a stateless worker isolate on the Worker-Loader cache-miss path, so the
     * supervisor DO never carries them (it OOM-reset at the 128 MiB isolate cap
     * when it did — live-diagnosed 2026-07-16).
     */
    async _stageOpencodeFacet(artifact, opts, mode) {
        if (artifact !== 'opencode') {
            throw new Error(`Nimbus: unknown staged artifact '${artifact}'`);
        }
        if (!this.env.ASSETS) {
            throw new Error('staged opencode artifact requires an env.ASSETS binding; this Nimbus ' +
                'deployment is missing the static-assets binding');
        }
        const command = opts.command || `opencode ${opts.argv.join(' ')}`.trim();
        const attached = mode === 'attached';
        const entry = this.processes.spawn(command, ['opencode', ...opts.argv], opts.cwd);
        const pid = entry.pid;
        // attached TUI + headless serve are resident long-running processes; only the
        // attached TUI grabs the terminal (raw-mode stdin + live geometry).
        if (mode !== 'oneshot')
            this.processes.setLongRunning(pid);
        if (attached) {
            this.processes.setAttachedTty(pid);
            this.processes.openInput(pid);
        }
        // attached: opencode's shim TTY (node-shims.ts) keys raw-mode stdin and
        // columns/rows off these env vars, exactly like the long-running node path.
        const runnerEnv = attached
            ? {
                ...opts.env,
                NIMBUS_ATTACHED_TTY: '1',
                NIMBUS_CP_CHILD_PID: String(pid),
                TERM: opts.env.TERM || 'xterm-256color',
                COLORTERM: opts.env.COLORTERM || 'truecolor',
                COLUMNS: opts.env.COLUMNS || '80',
                LINES: opts.env.LINES || '24',
                FORCE_COLOR: opts.env.FORCE_COLOR || '1',
            }
            : opts.env;
        // Snapshot the working tree so opencode's sync fs reads resolve, and a
        // directory manifest so readdir/stat are coherent. opencode creates its
        // home dirs (~/.local/share/opencode, …) via fs.promises.mkdir; those and
        // other writes flush live through the SUPERVISOR RPC bridge.
        const processVfs = this.vfs?.as(entry.cred);
        const vfsState = processVfs
            ? await buildPrefetchBundle(processVfs, undefined, opts.cwd, '', this.esbuild || undefined)
            : { bundle: {}, manifest: {}, metadata: {}, reachableCount: 0, truncated: false };
        const stageSpec = {
            mode,
            argv: opts.argv,
            env: runnerEnv,
            cred: { ...entry.cred, groups: [...entry.cred.groups] },
            cwd: opts.cwd,
            stdin: opts.stdin ?? '',
            vfsBundle: _serializeBundleForFacet(vfsState.bundle),
            vfsManifest: JSON.stringify(vfsState.manifest),
            vfsMetadata: JSON.stringify(vfsState.metadata),
        };
        return { pid, command, stageSpec };
    }
    /**
     * Attached-TTY staged-artifact lifecycle (the interactive opencode TUI). Boots
     * the runner's startProcess() — which holds the facet open via ctx.waitUntil
     * while opencode's createCliRenderer loop streams ANSI frames to the terminal
     * RPC and the live stdin pump feeds keystrokes — and returns immediately with
     * the pid. The facet reports its own exit via SUPERVISOR.reportExit; resources
     * release on report-exit, the same contract the long-running node path uses.
     */
    async _execStagedArtifactAttached(pid, command, stageSpec) {
        let startStub;
        try {
            // Keyed, stage-carrying NimbusLoadedEntrypoint, exactly like the
            // long-running node path (spawnNode) but with the module map assembled
            // in the stateless entrypoint isolate; the startProcess RPC below stays
            // open for the process lifetime (its context owns the facet's
            // SUPERVISOR binding).
            const workerKey = `nimbus-process:${this.ctx.id.toString()}:${pid}`;
            const ctxExports = getNimbusCtxExports();
            startStub = await createLoadedWorkerEntrypoint(ctxExports, undefined, { doId: this.ctx.id.toString(), pid }, null, workerKey, stageSpec);
            if (typeof startStub.startProcess !== 'function') {
                throw new Error('Nimbus: opencode runner entrypoint has no startProcess method');
            }
            this.trackProcessRpcResources(pid, [startStub], { releaseOnReportExit: false });
            const startPromise = startStub.startProcess();
            this.ctx.waitUntil(startPromise
                .catch((e) => {
                // A pid that is already terminal (killed by session teardown, or
                // exited via its own reportExit) rejects the held-open call as a
                // teardown ECHO — recording it again would double-count the
                // termination with a misleading code-1 entry.
                const entry = this.processes.get(pid);
                if (!entry || entry.state !== 'running')
                    return;
                const reason = 'opencode TUI process failed: ' + errorMessage(e);
                try {
                    this.processes.exit(pid, 1);
                }
                catch { }
                try {
                    this._w5RecordTermination(pid, 1, 'facet', reason);
                }
                catch { }
                try {
                    this.hooks.onExternalExit?.(pid, 1, reason);
                }
                catch { }
            })
                .finally(() => {
                this.releaseProcessRpcResources(pid);
            }));
            return { pid, exitCode: 0, stdout: '', stderr: '', vfsWrites: {} };
        }
        catch (e) {
            this.releaseProcessRpcResources(pid);
            disposeRpcResource(startStub);
            this.processes.exit(pid, 1);
            throw e;
        }
    }
    /**
     * Run a headless `opencode serve` as a resident, routeable server facet. The
     * server binds a KNOWN loopback port (honouring an explicit --port/-p/env.PORT,
     * else an allocated free port injected into argv) so the in-session loopback
     * router and external `/port/<n>` both reach it. Returns immediately with the
     * pid once the facet is spawned + its route stub bound; readiness is gated by
     * the caller (dual path health-gates on `/doc`).
     */
    async execStagedArtifactServer(artifact, opts) {
        const explicit = parsePortFromArgv(opts.argv);
        const port = opts.port
            ?? resolveLongRunningPort({ argv: opts.argv, env: opts.env, fallback: this._allocateLoopbackPort() });
        // opencode's default `--port 0` binds an unroutable ephemeral port; when the
        // user gave no explicit port, inject the resolved one so the bind is known.
        const argv = explicit != null || opts.port != null
            ? opts.argv
            : [...opts.argv, '--port', String(port)];
        const staged = await this._stageOpencodeFacet(artifact, { ...opts, argv }, 'server');
        const result = await this._runOpencodeServerFacet(staged, port);
        return { ...result, port };
    }
    /**
     * Bare `opencode` (the interactive TUI) as a MULTI-ISOLATE process pair: a
     * headless `opencode serve` facet + an `opencode attach <url>` attached-TTY
     * facet, each in its own 128 MiB isolate, joined by the session loopback port
     * registry. The serve facet is an OS-child of the attach facet: it is health-
     * gated before attach launches, and torn down when the attach TUI exits.
     * Returns the ATTACH pid — the user-facing foreground process.
     */
    async execStagedArtifactDual(artifact, opts) {
        const port = this._allocateLoopbackPort();
        // (a) resident serve facet on the allocated loopback port.
        const serveStaged = await this._stageOpencodeFacet(artifact, {
            argv: ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'],
            env: opts.env,
            cwd: opts.cwd,
            command: `opencode serve --port ${port}`,
        }, 'server');
        const servePid = serveStaged.pid;
        try {
            await this._runOpencodeServerFacet(serveStaged, port);
            // (b) health-gate: wait for the server to answer /doc through the loopback
            // router (fail loud with the server's log tail on timeout / early exit).
            await this._awaitOpencodeServerReady(servePid, port);
        }
        catch (e) {
            try {
                this.kill(servePid);
            }
            catch { }
            throw e;
        }
        // (c) attach the interactive TUI to the ready server on the user's terminal.
        let attach;
        try {
            attach = await this.execStagedArtifact(artifact, {
                argv: ['attach', `http://127.0.0.1:${port}`],
                env: opts.env,
                cwd: opts.cwd,
                stdin: '',
                command: opts.command || 'opencode',
                attachedTty: true,
            });
        }
        catch (e) {
            try {
                this.kill(servePid);
            }
            catch { }
            throw e;
        }
        // Tie their lifecycles: when the attach TUI exits (reported / killed), tear
        // down the serve facet too.
        this._pairedServeFacet.set(attach.pid, servePid);
        return attach;
    }
    async _runOpencodeServerFacet(staged, port) {
        const { pid, stageSpec } = staged;
        const ctxExports = getNimbusCtxExports();
        const supervisor = { doId: this.ctx.id.toString(), pid };
        let startStub;
        let routeStub;
        let resourcesTracked = false;
        try {
            const workerKey = `nimbus-process:${supervisor.doId}:${pid}`;
            // Stage-carrying start stub: NimbusLoadedEntrypoint assembles the ~23 MB
            // module map in ITS stateless isolate on the Worker-Loader cache-miss
            // path (with SUPERVISOR bound to the held-open startProcess context) —
            // the supervisor DO never materializes the artifact sources.
            startStub = await createLoadedWorkerEntrypoint(ctxExports, undefined, supervisor, null, workerKey, stageSpec);
            // A re-resolvable, CODE-FREE NimbusLoadedEntrypoint route stub (keyed on
            // workerKey): the serve facet's port must resolve to a handler that can
            // be re-entered from a LATER routing request's context. It resolves the
            // already-loaded worker from the loader cache and fails loud on eviction
            // — re-loading from code would boot an empty isolate whose server isn't
            // listening. A poll racing the initial load simply errors (502) and is
            // retried by the readiness gate.
            routeStub = await createLoadedWorkerEntrypoint(ctxExports, undefined, supervisor, null, workerKey);
            this.trackProcessRpcResources(pid, [routeStub, startStub], { releaseOnReportExit: false });
            resourcesTracked = true;
            // Bind the route stub for the pid BEFORE boot so the shim's
            // listen()→SUPERVISOR.registerPort resolves against it; also reserve the
            // known port explicitly (belt-and-suspenders with the in-facet listen()).
            this.portRegistry.bindFacetStub(pid, routeStub);
            if (typeof startStub.startProcess !== 'function') {
                throw new Error('Nimbus: opencode serve runner entrypoint has no startProcess method');
            }
            const startPromise = startStub.startProcess();
            this.ctx.waitUntil(startPromise
                .catch((e) => {
                const current = this.processes.get(pid);
                if (!current || current.state !== 'running')
                    return;
                const reason = 'opencode serve process failed: ' + errorMessage(e);
                try {
                    this.processes.exit(pid, 1);
                }
                catch { }
                try {
                    this._w5RecordTermination(pid, 1, 'facet', reason);
                }
                catch { }
                try {
                    this.hooks.onExternalExit?.(pid, 1, reason);
                }
                catch { }
            })
                .finally(() => {
                this.releaseProcessRpcResources(pid);
            }));
            this.portRegistry.register(port, pid, routeStub);
            return { pid, exitCode: 0, stdout: '', stderr: '', vfsWrites: {} };
        }
        catch (e) {
            this.portRegistry.unregisterByPid(pid);
            if (resourcesTracked)
                this.releaseProcessRpcResources(pid);
            else
                disposeRpcResources([routeStub, startStub]);
            this.processes.exit(pid, 1);
            const reason = 'opencode serve boot failed: ' + errorMessage(e);
            this._w5RecordTermination(pid, 1, 'facet', reason);
            try {
                this.hooks.onExternalExit?.(pid, 1, reason);
            }
            catch { }
            throw e;
        }
    }
    /** Allocate a free loopback port for a resident server facet (from 4096 up). */
    _allocateLoopbackPort() {
        for (let port = 4096; port < 4096 + 4096; port++) {
            if (!this.portRegistry.has(port))
                return port;
        }
        return 4096;
    }
    /**
     * Poll `http://127.0.0.1:<port>/doc` through the loopback port router until it
     * answers 200, bounded by `timeoutMs`. Fails loud (with the server's log tail
     * and the last poll outcome) if the serve facet exits early or never becomes
     * ready. Each poll is individually capped at `pollTimeoutMs` so a request
     * wedged in the booting facet cannot starve the loop; the 30s default budget
     * covers the live-measured ~14s cold boot-to-serving time with margin.
     */
    async _awaitOpencodeServerReady(pid, port, timeoutMs = 30000, pollTimeoutMs = 2000) {
        const deadline = Date.now() + timeoutMs;
        let lastPoll = 'no poll completed';
        while (Date.now() < deadline) {
            const proc = this.processes.get(pid);
            if (!proc || proc.state !== 'running') {
                throw new Error(`opencode serve (pid ${pid}) exited before becoming ready on port ${port}\n` +
                    this._processLogTail(pid));
            }
            if (this.portRegistry.has(port)) {
                // Cap each poll at pollTimeoutMs and abandon it on overrun: a request
                // that reaches the facet mid-boot can hang until the dispatcher's 30s
                // header timeout (live-measured 2026-07-16), and awaiting it unbounded
                // starves the loop — one wedged poll must not consume the readiness
                // budget while the server comes up behind it.
                let timer;
                const pollPromise = this.portRegistry
                    .routeRequest(port, new Request(`http://127.0.0.1:${port}/doc`), '/doc')
                    .catch((e) => { lastPoll = 'error: ' + errorMessage(e); return null; });
                const res = await Promise.race([
                    pollPromise,
                    new Promise((r) => { timer = setTimeout(() => r(null), pollTimeoutMs); }),
                ]);
                if (timer !== undefined)
                    clearTimeout(timer);
                // The gate only needs the status; cancel the (streamed) body so the
                // relay pipe and its facet-side resources release — including polls
                // this race abandoned that resolve later.
                const discardBody = (r) => { if (r)
                    r.body?.cancel().catch(() => { }); };
                if (res) {
                    discardBody(res);
                    if (res.status === 200) {
                        await this._warmOpencodeServer(port);
                        return;
                    }
                    lastPoll = `status ${res.status}`;
                }
                else {
                    void pollPromise.then(discardBody);
                }
            }
            await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error(`opencode serve (pid ${pid}) did not become ready on port ${port} within ` +
            `${timeoutMs}ms (last poll: ${lastPoll})\n${this._processLogTail(pid)}`);
    }
    /**
     * Warm the serve facet's cold once-flight services before the attach TUI
     * fires its startup barrage. The TUI issues its five startup requests
     * concurrently; a COLD provider/agent init under that concurrency deadlocks
     * on its once-flight lock (facet timers only advance across I/O), and the
     * requests die at the dispatcher's 30s header timeout ("3 of 5 requests
     * failed"). A single sequential request per service completes the init
     * reliably (live-measured), so readiness for a TUI includes it. A warmup
     * failure is not fatal here — the TUI surfaces its own precise startup
     * error — but each leg is bounded so a wedged warmup cannot eat the boot.
     */
    async _warmOpencodeServer(port, perRequestTimeoutMs = 25000) {
        for (const path of ['/config/providers', '/agent']) {
            let timer;
            try {
                // ONE deadline bounds the whole leg — headers AND body drain. An
                // unbounded drain here wedged the dual spawn when a cold providers
                // body finished slowly.
                const responseRef = { current: null };
                const leg = this.portRegistry
                    .routeRequest(port, new Request(`http://127.0.0.1:${port}${path}`), path)
                    .then(async (r) => {
                    responseRef.current = r;
                    if (r)
                        await r.text();
                })
                    .catch(() => { });
                await Promise.race([
                    leg,
                    new Promise((r) => { timer = setTimeout(() => r(), perRequestTimeoutMs); }),
                ]);
                responseRef.current?.body?.cancel().catch(() => { });
            }
            finally {
                if (timer !== undefined)
                    clearTimeout(timer);
            }
        }
    }
    /** Recent stderr/stdout tail for a pid, for fail-loud diagnostics. */
    _processLogTail(pid, lines = 40) {
        try {
            const chunks = this.processes.tailLogs(pid, { lines });
            const text = chunks.map((c) => c.data).join('');
            return text ? `--- ${chunks.length ? 'log tail' : ''} ---\n${text}` : '(no output captured)';
        }
        catch {
            return '(no output captured)';
        }
    }
    /** Flush files written by the script back to the supervisor's VFS. */
    _flushVfsWrites(result, pid) {
        if (!this.vfs || !result.vfsWrites)
            return;
        const vfs = this.vfs.as(this.processes.cred(pid));
        for (const [path, content] of Object.entries(result.vfsWrites)) {
            try {
                const parts = path.split('/');
                for (let i = 1; i < parts.length; i++) {
                    const dir = parts.slice(0, i).join('/');
                    if (dir && !vfs.exists(dir))
                        vfs.mkdir(dir, { recursive: true });
                }
                // binary-fs wave: __vfsWrites cells carry string | Uint8Array.
                // The hot path here is the LIVE SUPERVISOR.writeFile RPC inside
                // the facet — which preserves Uint8Array via structured-clone.
                // This `result.vfsWrites` carries only the FAILED-writes residue
                // (after JSON.parse), where Uint8Array gets serialized as a
                // {"0":...,"1":...} object. Detect that shape and reconstitute
                // bytes; otherwise pass through (string for source code, etc.).
                const restored = _reviveVfsWriteCell(content);
                vfs.writeFile(path, restored);
            }
            catch (e) {
                console.error('[nimbus] VFS write-back failed:', path, e?.message);
            }
        }
    }
    /** Execution timeout. */
    async _execWithTimeout(promise, entry, abort) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                this.timedOutProcessIds.add(entry.pid);
                abort();
                // The process cannot report exit after the request is cancelled, so
                // notify the session explicitly.
                try {
                    this.hooks.onExternalExit?.(entry.pid, 124, // conventional timeout exit code
                    `timeout after ${FACET_TIMEOUT_MS / 1000}s`);
                }
                catch { }
                reject(new Error(`Process timed out after ${FACET_TIMEOUT_MS / 1000}s`));
            }, FACET_TIMEOUT_MS);
        });
        // Always clear the timer; otherwise a successful run would still
        // trigger the timeout callback at FACET_TIMEOUT_MS, spuriously
        // marking the exit code as 124.
        try {
            return await Promise.race([promise, timeout]);
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    /**
     * Spawn a long-running Node process with the same shimmed require/fs/http
     * environment used by foreground `node <script>` execution.
     */
    async spawnNode(code, opts = {}) {
        this.processes.reap();
        const command = opts.command || (opts.filename ? `node ${opts.filename}` : 'node <script>');
        const cwd = opts.cwd || '/home/user';
        let entry;
        if (opts.skipSpawn && opts.callerPid != null) {
            const found = this.processes.get(opts.callerPid);
            if (!found) {
                throw new Error(`facetMgr.spawnNode skipSpawn: callerPid=${opts.callerPid} not in process table`);
            }
            entry = found;
        }
        else {
            entry = this.processes.spawn(command, opts.argv || [], cwd);
        }
        this.processes.setLongRunning(entry.pid);
        if (opts.attachedTty)
            this.processes.setAttachedTty(entry.pid);
        if (!opts.skipSpawn) {
            try {
                this.hooks.onSpawn?.(entry.pid, command, true);
            }
            catch { }
        }
        if (this.vfs && !this.esbuild) {
            try {
                this.esbuild = new EsbuildService(this.vfs);
            }
            catch {
                this.esbuild = null;
            }
        }
        const processVfs = this.vfs?.as(entry.cred);
        const vfsState = processVfs
            ? await buildPrefetchBundle(processVfs, opts.filename, cwd, code, this.esbuild || undefined, opts.bundleProfile)
            : { bundle: {}, manifest: {}, metadata: {}, reachableCount: 0, truncated: false };
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
        const usesSqlite = bundleUsesNodeSqlite(code, vfsState.bundle);
        const [sqliteModules, shims] = await Promise.all([
            this.sqliteModuleEntry(usesSqlite),
            fetchNodeShimsCode(this.env),
        ]);
        const workerCode = generateLongRunningNodeCode(code, vfsState, { ...opts, env: processEnv, cred: entry.cred }, usesSqlite, shims);
        const ctxExports = getNimbusCtxExports();
        const supervisor = { doId: this.ctx.id.toString(), pid: entry.pid };
        const supervisorBinding = ctxExports?.SupervisorRPC
            ? ctxExports.SupervisorRPC({ props: supervisor })
            : undefined;
        let worker;
        let startStub;
        let routeStub;
        let resourcesTracked = false;
        try {
            const workerKey = `nimbus-process:${supervisor.doId}:${supervisor.pid}`;
            const workerConfig = {
                compatibilityDate: CF_COMPAT_DATE,
                compatibilityFlags: ['nodejs_compat', 'nodejs_compat_v2'],
                mainModule: 'worker.js',
                modules: { 'worker.js': workerCode, ...sqliteModules },
                ...(supervisorBinding ? { env: { SUPERVISOR: supervisorBinding } } : {}),
            };
            const routeConfig = {
                compatibilityDate: CF_COMPAT_DATE,
                compatibilityFlags: ['nodejs_compat', 'nodejs_compat_v2'],
                mainModule: 'worker.js',
                modules: { 'worker.js': workerCode, ...sqliteModules },
            };
            const loadedWorker = this.env.LOADER.get(workerKey, async () => workerConfig);
            worker = loadedWorker;
            startStub = loadedWorker.getEntrypoint();
            routeStub = await createLoadedWorkerEntrypoint(ctxExports, routeConfig, supervisor, null, workerKey);
            this.trackProcessRpcResources(entry.pid, [routeStub, startStub, worker, supervisorBinding], { releaseOnReportExit: !opts.attachedTty });
            resourcesTracked = true;
            this.portRegistry.bindFacetStub(entry.pid, routeStub);
            if (typeof startStub.startProcess !== 'function') {
                throw new Error('Nimbus: long-running node entrypoint has no startProcess method');
            }
            const startPromise = startStub.startProcess();
            if (opts.attachedTty) {
                this.ctx.waitUntil(startPromise
                    .catch((e) => {
                    // Teardown echo guard (same as the staged-artifact path): a pid
                    // that is already terminal rejects the held-open call as an
                    // ECHO of its own kill — don't double-record it as a code-1
                    // failure.
                    const current = this.processes.get(entry.pid);
                    if (!current || current.state !== 'running')
                        return;
                    const reason = 'long-running node process failed: ' + errorMessage(e);
                    try {
                        this.processes.exit(entry.pid, 1);
                    }
                    catch { }
                    try {
                        this._w5RecordTermination(entry.pid, 1, 'facet', reason);
                    }
                    catch { }
                    try {
                        this.hooks.onExternalExit?.(entry.pid, 1, reason);
                    }
                    catch { }
                })
                    .finally(() => {
                    this.releaseProcessRpcResources(entry.pid);
                }));
            }
            else {
                await startPromise;
            }
            if (opts.port && opts.port > 0 && opts.port < 65536) {
                this.portRegistry.register(opts.port, entry.pid, routeStub);
            }
            return { pid: entry.pid, facetStub: startStub };
        }
        catch (e) {
            this.portRegistry.unregisterByPid(entry.pid);
            if (resourcesTracked)
                this.releaseProcessRpcResources(entry.pid);
            else
                disposeRpcResources([routeStub, startStub, worker, supervisorBinding]);
            this.processes.exit(entry.pid, 1);
            const reason = 'long-running node boot failed: ' + errorMessage(e);
            this._w5RecordTermination(entry.pid, 1, 'facet', reason);
            try {
                this.hooks.onExternalExit?.(entry.pid, 1, reason);
            }
            catch { }
            throw e;
        }
    }
    /**
     * Spawn a long-running dynamic Worker and register its routeable port.
     *
     * This is the shared primitive for any runtime that exposes
     * handleHttpRequest(Request): Node facets, Vite adapters, Python virtual
     * sockets, and future WASI socket servers should use
     * this path instead of each owning process-table and PortRegistry plumbing.
     */
    async spawnWorker(workerCode, command, cwd, opts = {}) {
        this.processes.reap();
        const entry = this.processes.spawn(command, [], cwd);
        // Stamp the process-table entry so /api/processes exposes this as a
        // long-running process. Vite, wrangler, node servers, and --watch
        // all flow through this primitive.
        this.processes.setLongRunning(entry.pid);
        // Long-running facets (vite, nimbus-wrangler, node servers) always
        // get a spawn notification — they're visible and users want to know
        // the PID for later `logs`/`kill`.
        try {
            this.hooks.onSpawn?.(entry.pid, command, true);
        }
        catch { }
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
        let worker;
        let startStub;
        let routeStub;
        let resourcesTracked = false;
        try {
            const loadedWorker = this.env.LOADER.get(workerKey, async () => workerConfig);
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
        }
        catch (e) {
            this.portRegistry.unregisterByPid(entry.pid);
            if (resourcesTracked)
                this.releaseProcessRpcResources(entry.pid);
            else
                disposeRpcResources([routeStub, startStub, worker, supervisorBinding]);
            this.processes.exit(entry.pid, 1);
            const reason = 'long-running worker boot failed: ' + errorMessage(e);
            this._w5RecordTermination(entry.pid, 1, 'facet', reason);
            try {
                this.hooks.onExternalExit?.(entry.pid, 1, reason);
            }
            catch { }
            throw e;
        }
    }
    registerPort(pid, port, facetStub) {
        if (port > 0 && port < 65536) {
            this.portRegistry.register(port, pid, facetStub);
        }
    }
    waitForRouteablePorts(pid, facetStub, timeoutMs = ROUTEABLE_PORT_ATTACH_TIMEOUT_MS) {
        return this.portRegistry.waitForRouteablePortsByPid(pid, facetStub, timeoutMs);
    }
    finishProcess(pid, exitCode, reason = 'exited') {
        this.portRegistry.unregisterByPid(pid);
        this.processes.exit(pid, exitCode);
        this.releaseProcessRpcResources(pid);
        this._teardownPairedServeFacet(pid);
        if (exitCode !== 0) {
            this._w5RecordTermination(pid, exitCode, 'facet', reason);
            try {
                this.hooks.onExternalExit?.(pid, exitCode, reason);
            }
            catch { }
        }
    }
    /** Kill a running process by PID. */
    kill(pid) {
        const entry = this.processes.get(pid);
        if (!entry || entry.state !== 'running')
            return false;
        try {
            this.ctx.facets?.abort(`proc-${entry.pid}`, new Error('SIGKILL'));
        }
        catch { }
        try {
            this.ctx.facets?.delete(`proc-${entry.pid}`);
        }
        catch { }
        this.portRegistry.unregisterByPid(pid);
        this.releaseProcessRpcResources(pid);
        const result = this.processes.kill(pid);
        if (result) {
            try {
                this.hooks.onExternalExit?.(pid, 137, 'killed');
            }
            catch { }
        }
        this._teardownPairedServeFacet(pid);
        return result;
    }
    get stats() { return this.processes.stats; }
}
