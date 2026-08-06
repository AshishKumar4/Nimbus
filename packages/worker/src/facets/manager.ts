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
import { fetchNodeShimsCode } from '../runtime/node-shims-artifact.js';
import { generateSqliteFacetPreamble } from '../runtime/sqlite-shim.js';
import { getRealNodeImportsCode } from '../_shared/real-node-imports.js';
import { VFS_WRITE_LEDGER_SOURCE } from '../_shared/vfs-write-ledger.js';
import type { CredentialedVfs, SqliteVFS, VfsStat } from '../vfs/sqlite-vfs.js';
import { vfsPathExtension } from '../vfs/path.js';
import type { PortRegistry } from '../runtime/port-registry.js';
import { getCtxExports } from '../session/ctx-exports.js';
import { prefetchForRequire } from '../runtime/require-resolver.js';
import { hasTopLevelModuleSyntax } from '../runtime/javascript-ast.js';
import { bindImportMetaResolve, importMetaDefines } from '../runtime/import-meta-transform.js';
import { recordFailure, getLastRpcFrame, getLastFacetId } from '../observability/oom-discriminator.js';
import { classifyError } from '../observability/oom-classify.js';
import { EsbuildService } from '../runtime/esbuild-service.js';
import { isExecDiagEnabled, recordExecTelemetry } from './exec-telemetry.js';
import { disposeRpcResource, disposeRpcResources } from '../_shared/rpc-dispose.js';
import { sqliteWasmModuleEntry, type OpencodeStageSpec } from './opencode-staging.js';
import {
  createLoadedWorkerEntrypoint,
  getNimbusCtxExports,
  ProcessFabric,
  ResidentProcessHandle,
  FACET_IMAGE_DIR,
  facetImageDigest,
  facetImagePath,
  type LoadedWorkerEntrypointStub,
  type ResidentBootSpec,
  type ResidentDiskReader,
  type StartContract,
} from '../loaders/process-fabric.js';
import {
  SQLITE_WASM_MODULE_NAME,
  type OpencodeRunnerOptions,
  type OpencodeRunnerMode,
} from '../runtime/opencode-facet-runner.js';
import { parsePortFromArgv, resolveLongRunningPort } from '../runtime/long-running-handle.js';
import type { WorkerCode } from '../loaders/vendor/types.js';
import {
  DEFAULT_FACET_BUNDLE_PROFILE,
  type FacetBundleProfile,
} from '../runtime/bundle-profile.js';
import {
  CF_COMPAT_DATE, FACET_TIMEOUT_MS,
  VFS_BUNDLE_MAX_FILES, VFS_BUNDLE_MAX_BYTES, CWD_SNAPSHOT_MAX_FILE_BYTES,
  BUNDLE_MAX_ENCODED_BYTES, MAX_RPC_SAFE_PAYLOAD_BYTES,
  PREFETCH_CACHE_MAX_BYTES,
} from '../constants.js';
import { CRED_KERNEL } from '../runtime/os-contracts.js';
import { acquireSupervisorAllocation } from '../observability/heavy-alloc-coord.js';
import {
  prefetchBundleStart,
  prefetchBundleEnd,
  setPrefetchCacheBytes,
} from '../observability/diag-counters.js';

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
  /**
   * VFS paths whose content the process read synchronously and did not have.
   *
   * The facet cannot serve those reads and cannot recover from them, so the
   * only place the knowledge is useful is here: the next bundle built for the
   * same entry stages them, and the miss stops recurring. Reported on every
   * exec, not behind the diag flag — a residency repair that only happens
   * when debugging is switched on is not a repair.
   */
  residencyMisses?: string[];
  /**
   * Exec telemetry, populated only when NIMBUS_DIAG_EXEC=1. drainPasses,
   * rpcWrites and fsRpcReads originate inside the facet (see
   * exec-telemetry.ts); the supervisor folds them with its own phase timings
   * before recording.
   */
  diag?: { drainPasses: number; rpcWrites: number; fsRpcReads: number };
}

/**
 * execStagedArtifact owns the process-table entry, so it returns the
 * authoritative pid alongside the exec result. The shell caller emits the
 * terminal exit / exec-done events against this pid instead of recovering it
 * by string-matching the command line in the process table.
 */
export interface StagedArtifactExecResult extends FacetExecResult {
  pid: number;
  /** For the resident server path: the loopback port the facet is bound to. */
  port?: number;
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
//
// The ~230 KiB node-compat shim source is staged as a static asset
// (scripts/bundle-node-shims.mjs) and fetched once per isolate via
// fetchNodeShimsCode — it no longer lives in the worker bundle (≤6 MiB
// gate). The codegen functions take it as the `shims` parameter; the async
// exec/spawn callers await the memoized fetch.

interface LoadedWorkerStub {
  getEntrypoint(): LoadedWorkerEntrypointStub;
}

interface NimbusWorkerLoader {
  load(code: WorkerCode): LoadedWorkerStub;
  get(id: string, getCodeCallback: () => Promise<WorkerCode>): LoadedWorkerStub;
}

interface FacetManagerEnv {
  LOADER: NimbusWorkerLoader;
  /**
   * Static-assets binding, used by the node:sqlite path to fetch the
   * sql.js wasm bytes (sqlite-wasm-bytes.ts) and hand them to the facet
   * via the Worker Loader module map. Absent in env shapes that never
   * route node:sqlite (e.g. some test harnesses); the sqlite attach is a
   * no-op then and the shim surfaces a clear unattached-module error.
   */
  ASSETS?: { fetch(req: Request): Promise<Response> };
}

interface ProcessRpcResources {
  readonly resources: unknown[];
  readonly releaseOnReportExit: boolean;
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
  const assetsCandidate = ((typeof env === 'object' || typeof env === 'function') && env !== null)
    ? Reflect.get(env, 'ASSETS')
    : undefined;
  const assets =
    assetsCandidate !== null &&
    typeof assetsCandidate === 'object' &&
    typeof Reflect.get(assetsCandidate, 'fetch') === 'function'
      ? (assetsCandidate as { fetch(req: Request): Promise<Response> })
      : undefined;
  return { LOADER: loader, ASSETS: assets };
}

/**
 * Reserve held back from a one-shot facet's lifetime so a program that runs
 * out of time is still alive to say so.
 *
 * A one-shot exec is ALREADY bounded: `_execWithTimeout` kills it at
 * FACET_TIMEOUT_MS with exit 124 and "[process killed: timeout after 30s]".
 * The entry drain must therefore not be a second, tighter, independent
 * timeout. Measured against a deployed Worker, floating async work of 5s /
 * 15s / 25s completes and 40s is killed by that outer bound at exactly 30s —
 * so the fixed 8s budget this used to carry was abandoning programs 22
 * seconds before anything actually required it.
 *
 * The drain therefore runs to the outer bound MINUS this reserve, which is
 * what buys the facet time to flush and report the honest "still in flight"
 * reason instead of the supervisor's generic kill. The reserve has to cover
 * the longest tail a facet can have after the drain: settling pending RPC,
 * writing back __vfsWrites (bounded by MAX_RPC_SAFE_PAYLOAD_BYTES; a 20 MiB
 * write-back measures ~1.5s), draining children, then reportExit.
 */
export const ONE_SHOT_EXIT_RESERVE_MS = 3_000;

/**
 * Budget used when the supervisor did not stamp an absolute deadline on the
 * payload. The deadline is the real bound — see `entryDeadlineAt` — because
 * it is measured from the supervisor's own timer rather than restarted when
 * the drain begins, so a slow module init cannot push the drain past the kill
 * and lose the honest message.
 */
export const ONE_SHOT_ENTRY_DEADLINE_MS = FACET_TIMEOUT_MS - ONE_SHOT_EXIT_RESERVE_MS;

/**
 * How long a RESIDENT facet settles its startup before answering its boot
 * call. It keeps running afterwards, so this is not a lifetime decision: the
 * budget only has to cover the entrypoint's own startup chain (binding a
 * port, first render). `spawnNode` awaits the boot, so a server's idle
 * keep-alive timer must not be allowed to hold the shell's prompt.
 */
export const RESIDENT_BOOT_SETTLE_MS = 1000;

/**
 * The event loop a generated entrypoint runs on.
 *
 * Node exits when its loop has no live HANDLES left — timers, sockets,
 * servers, requests in flight. A promise is not a handle: a program whose
 * last act leaves `new Promise(() => {})` unsettled prints its output and
 * exits 0. Counting unsettled promises as work was a real divergence from
 * that — such a program burned the whole facet lifetime and was then
 * reported as having not finished.
 *
 * Three kinds of handle, each owned by the shim that creates them:
 *
 *   - macrotask TIMERS and intervals (`__nimbusPendingTimers`), from the
 *     timer tracker below.
 *   - ASYNC OPERATIONS in flight (`__nimbusPendingOps`): a fetch, a response
 *     body read, an fs/child_process RPC. `await` resolves through
 *     PerformPromiseThen and surfaces nowhere else, so this counter is how
 *     awaited work is seen at all. See the shim's __nimbusTrackOp.
 *   - listening SERVERS (`__portRegistry`), open until the program closes
 *     them.
 *
 * The bound is a REAL wall-clock deadline, armed as a timer rather than
 * compared against `Date.now()`: a `setTimeout(0)` turn in workerd costs
 * ~5µs, so the pass budget this loop used to carry (50k) expired after
 * ~150ms and silently overrode every longer deadline the callers declared —
 * anything slower than that, including an ordinary network fetch, was
 * abandoned mid-flight and reported as a clean exit.
 *
 * The loop subscribes to the exit promise ONCE — a per-pass
 * `exitPromise.then()` allocates a promise every iteration — and yields
 * through the raw setTimeout so its own ticks don't inflate the timer count
 * it watches.
 */
export const ENTRYPOINT_EVENT_LOOP = `
function __nimbusHandleCount(__name) {
  const __value = globalThis[__name];
  return typeof __value === "number" ? __value : 0;
}

// Work an entrypoint's STARTUP has to settle before it can be called booted.
function __nimbusPendingStartupWork() {
  return __nimbusHandleCount("__nimbusPendingTimers") + __nimbusHandleCount("__nimbusPendingOps");
}

// The above, plus the handles a program holds open on purpose. A bound port
// keeps a Node process alive, and it keeps a one-shot facet alive too.
function __nimbusLiveHandles() {
  const __servers = globalThis.__portRegistry;
  const __bound = __servers && typeof __servers.size === "number" ? __servers.size : 0;
  return __nimbusPendingStartupWork() + __bound;
}

async function __nimbusRunEventLoop(__countHandles, __exitPromise, __deadlineMs, __minPasses) {
  let __exited = false;
  if (__exitPromise && typeof __exitPromise.then === "function") {
    __exitPromise.then(() => { __exited = true; }, () => { __exited = true; });
  }
  const __rawSetTimeout = (typeof globalThis.__nimbusRawSetTimeout === "function")
    ? globalThis.__nimbusRawSetTimeout
    : globalThis.setTimeout;
  const __rawClearTimeout = (typeof globalThis.__nimbusRawClearTimeout === "function")
    ? globalThis.__nimbusRawClearTimeout
    : globalThis.clearTimeout;
  let __expired = false;
  const __deadline = __rawSetTimeout(() => { __expired = true; }, __deadlineMs);
  let __pass = 0;
  while (!__exited && !__expired && (__pass < __minPasses || __countHandles() > 0)) {
    // The warm-up passes give a settling microtask chain its turns and cost
    // ~5µs each; past them the loop is waiting on wall-clock work, where
    // spinning at 0ms would burn the isolate's CPU for the whole deadline.
    await new Promise((resolve) => __rawSetTimeout(resolve, __pass < __minPasses ? 0 : 1));
    __pass++;
  }
  try { __rawClearTimeout(__deadline); } catch {}
  // \`pending\` is what the caller reports when it gives up: a one-shot program
  // still holding a handle did NOT finish, and exiting 0 would claim it did.
  return { passes: __pass, pending: __exited ? 0 : __countHandles() };
}

// An ESM entry's own evaluation promise (top-level await) is the one promise
// that IS a handle — the module has not finished loading until it settles.
// Answers true when process.exit won the race instead.
async function __nimbusAwaitEntryEvaluation(__entryResult) {
  if (!__entryResult || typeof __entryResult.then !== "function") return false;
  const __exit = {};
  const __raced = await Promise.race([
    __entryResult.then(() => null),
    __nimbusProcessExitPromise.then(() => __exit, () => __exit),
  ]);
  return __raced === __exit;
}

// A one-shot facet's lifetime IS the loop: it runs the program until Node
// would exit, or until the lifetime budget runs out.
async function __nimbusRunEntrypointToExit(__entryResult, __deadlineMs) {
  if (await __nimbusAwaitEntryEvaluation(__entryResult)) return { passes: 0, pending: 0 };
  return await __nimbusRunEventLoop(__nimbusLiveHandles, __nimbusProcessExitPromise, __deadlineMs, 4);
}

// A resident facet keeps running after the call that boots it returns, so it
// settles startup and nothing more. The handles it holds open deliberately —
// its listening port — are the point of it, not a reason to make the shell's
// prompt wait.
async function __nimbusSettleEntrypointStartup(__entryResult, __deadlineMs) {
  if (await __nimbusAwaitEntryEvaluation(__entryResult)) return { passes: 0, pending: 0 };
  return await __nimbusRunEventLoop(
    __nimbusPendingStartupWork, __nimbusProcessExitPromise, __deadlineMs, 4,
  );
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
  g.__nimbusRawClearTimeout = ct;
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

/**
 * The report a program owes when it finishes on an unanswered read.
 *
 * A facet has no synchronous I/O primitive, so a sync read of content that
 * was never staged into the process raises EAGAIN — honest, but a code no
 * program branches on, because it cannot arise from a POSIX regular file.
 * Whatever catch block receives it was written for a missing file, so the
 * reader proceeds on the answer it prepared for that. The result looks like
 * success and is not.
 *
 * So a run that ends with entries still in the shim's residency ledger is
 * failed here, and the files are named. Silence is the one outcome that must
 * not be available: the miss is either repaired (the next bundle stages what
 * the supervisor learned from the same ledger) or it is loud.
 *
 * Both generators call it — a one-shot exec folds it into its envelope, a
 * resident process into its final exit report — because a program's exit is
 * the only place that knows whether a miss was ever answered.
 */
const RESIDENCY_MISS_REPORT = `
const __NIMBUS_RESIDENCY_NAMED_MAX = 20;
function __nimbusResidencyMissReport() {
  const __missed = globalThis.__nimbusVfsResidencyMisses;
  if (!__missed || __missed.size === 0) return "";
  const __paths = [];
  for (const __k of __missed) __paths.push("/" + __k);
  const __named = __paths.slice(0, __NIMBUS_RESIDENCY_NAMED_MAX);
  const __rest = __paths.length - __named.length;
  return "node: " + __paths.length + " file(s) were read synchronously but their content was "
    + "never staged into the process, so every one of those reads failed and the program "
    + "carried on without the bytes. Failing rather than reporting a result built on them:\\n"
    + __named.map((__p) => "  " + __p + "\\n").join("")
    + (__rest > 0 ? "  ... and " + __rest + " more\\n" : "")
    + "The files exist and an async read (fs.promises.readFile) returns them now; the next "
    + "run of the same command stages them up front.\\n";
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
 * generated facet code statically imports it + prepares the glue factory
 * at module init; the engine itself boots lazily and synchronously on the
 * first DatabaseSync open (sqlite-shim.ts __getSQL).
 *
 * Matches `require("node:sqlite")` / `require("sqlite")` (CJS, the
 * resolver strips the node: prefix) and `from "node:sqlite"` (ESM). The
 * scan covers the entry code plus every JS/CJS source already in the
 * prefetch bundle so a transitive dependency that pulls in node:sqlite is
 * also caught.
 */
const NODE_SQLITE_IMPORT_RE =
  /(?:require\s*\(\s*['"](?:node:)?sqlite['"]\s*\)|from\s+['"]node:sqlite['"]|import\s+['"]node:sqlite['"])/;

function bundleUsesNodeSqlite(
  entryCode: string,
  bundle: FacetVfsBundle,
): boolean {
  if (NODE_SQLITE_IMPORT_RE.test(entryCode)) return true;
  for (const [path, cell] of Object.entries(bundle)) {
    if (typeof cell !== 'string') continue;
    if (!(path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs'))) continue;
    if (NODE_SQLITE_IMPORT_RE.test(cell)) return true;
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
const SQLITE_FACET_IMPORT =
  `import __nimbusSqliteWasmModule from "${SQLITE_WASM_MODULE_NAME}";\n` +
  `globalThis.__nimbusSqliteWasmModule = __nimbusSqliteWasmModule;\n` +
  generateSqliteFacetPreamble();

/**
 * A generated facet's module map: its main module plus whatever side modules
 * the VFS bundle had to be partitioned across.
 */
interface GeneratedNodeFacetCode {
  code: string;
  modules: Record<string, string>;
}

/**
 * Generate one-shot runtime code with a plain fetch handler.
 */
function generateEntrypointCode(
  userCode: string,
  vfsState: FacetVfsState,
  usesSqlite: boolean,
  shims: string,
): GeneratedNodeFacetCode {
  const safeCode = JSON.stringify(userCode);
  const bundleSource = vfsState.bundleSource
    ?? buildFacetVfsBundleSource(vfsState.bundle, vfsState.bundleSideModulesRequired);
  const safeManifest = vfsState.serializedManifest ?? JSON.stringify(vfsState.manifest);
  const safeMetadata = vfsState.serializedMetadata ?? JSON.stringify(vfsState.metadata);
  return {
    code: `
${bundleSource.imports}
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
const __MODULE_VFS_BUNDLE = ${bundleSource.expression};
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
    const { argv, env, cwd: _cwd, filename, dirname, stdin, captureOutput, cred, diag: __diag, entryDeadlineAt, vfsCursor } = args;
    // The cursor this facet's bundle was read at. Without it the first
    // ACQUIRE carries a null epoch, which the authority can only answer
    // with a poison — so the first timer, fetch or frame threw the whole
    // resident set away and tried to refetch it in one turn.
    if (vfsCursor) globalThis.__nimbusVfsCursor = { epoch: vfsCursor.epoch, rev: vfsCursor.rev };
    // What is left of this facet's lifetime, measured from the supervisor's
    // own timeout timer rather than from whenever the drain happens to start
    // — a slow module init must not be able to push the drain past the kill
    // and lose the honest reason. Same shape as the git network facet's
    // phaseDeadline.
    const __entryBudgetMs = Number.isFinite(entryDeadlineAt)
      ? Math.max(0, Number(entryDeadlineAt) - Date.now())
      : ${ONE_SHOT_ENTRY_DEADLINE_MS};
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
    const __nimbusDeferProcessExitReport = true;
${VFS_WRITE_LEDGER_SOURCE}
    const __vfsDirs = {};

${ENTRYPOINT_TIMER_TRACKER}
${shims}

${ENTRYPOINT_EVENT_LOOP}
${RESIDENCY_MISS_REPORT}

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
      if (__entryCompileFailure) throw new Error(__entryCompileFailure);
      if (!__compiledFn) throw new Error("entrypoint compile failed");
      const __entryResult = __compiledFn(
        mod.exports, __require, mod, filename || "/home/user/script.js", dirname || "/home/user"
      );
      const __drain = await __nimbusRunEntrypointToExit(__entryResult, __entryBudgetMs);
      __drainPasses = __drain.passes;
      if (__nimbusProcessExitCode !== null) exitCode = __nimbusProcessExitCode;
      // This facet's lifetime IS the event loop, so a handle still open when
      // the deadline passes is work that will never run. Reporting exit 0
      // there is the silent-truncation failure: name the limit and fail.
      else if (__drain.pending > 0) {
        const __why = "node: reached the ${FACET_TIMEOUT_MS / 1000}s facet lifetime limit with " +
          __drain.pending + " operation(s) still in flight; the rest of the program did not run. " +
          "A program that needs longer than ${FACET_TIMEOUT_MS / 1000}s has to run as a " +
          "long-running process (node --watch, or a server), which is not bound by it.\\n";
        stderr += __why;
        exitCode = 1;
        if (__supervisor && !captureOutput) __queueRpcWrite("stderr", __why);
      }
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

    // Sited before the drain, like the lifetime-limit diagnostic above, so
    // the queued stderr write is one of the writes the drain settles rather
    // than an orphan dropped at teardown.
    if (globalThis.__nimbusVfsResidencySettle) {
      try { await globalThis.__nimbusVfsResidencySettle(); } catch {}
    }
    const __residencyReport = __nimbusResidencyMissReport();
    if (__residencyReport) {
      stderr += __residencyReport;
      if (exitCode === 0) exitCode = 1;
      if (__supervisor && !captureOutput) __queueRpcWrite("stderr", __residencyReport);
    }

    await __drainPendingIO();

    if (__supervisor) {
      try {
        await __nimbusDrainVfsWrites(__supervisor);
      } catch (e) {
        const trace = (e && e.stack) || (e && e.message) || String(e);
        stderr += trace + "\\n";
        exitCode = 1;
        if (!captureOutput) {
          try {
            await __supervisor.stderr(trace + "\\n");
          } catch {}
        }
      }
    }

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
      vfsWrites: __supervisor ? {} : __vfsWrites,
      // Unconditional, unlike diag: the supervisor stages these paths into
      // the next bundle for the same entry, so withholding them behind a
      // debug flag would leave the miss to repeat forever.
      residencyMisses: [...(globalThis.__nimbusVfsResidencyMisses || [])],
      ...(__diag ? { diag: { drainPasses: __drainPasses, rpcWrites: __rpcWriteCount, fsRpcReads: globalThis.__nimbusFsRpcReads || 0 } } : {}),
    });
  }
};
`,
    modules: bundleSource.modules,
  };
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
    cred: ProcessEntry['cred'];
  },
  usesSqlite: boolean,
  shims: string,
): GeneratedNodeFacetCode {
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
  const bundleSource = vfsState.bundleSource
    ?? buildFacetVfsBundleSource(vfsState.bundle, vfsState.bundleSideModulesRequired);
  const safeManifest = JSON.stringify(vfsState.manifest);
  const safeMetadata = JSON.stringify(vfsState.metadata);
  return {
    code: `
${bundleSource.imports}
import { DurableObject } from "cloudflare:workers";
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

const __MODULE_VFS_BUNDLE = ${bundleSource.expression};
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
  const __pendingDrain = rt.pendingDrainChain.then(async () => {
    const __vfsTasks = [];
    if (rt.supervisor && Object.keys(rt.vfsWrites).length > 0) {
      for (const path of Object.keys(rt.vfsWrites)) {
        __vfsTasks.push(rt.flushVfsWrite(
          path,
          (content, snapshot) =>
            rt.persistVfsWrite(rt.supervisor, path, content, snapshot),
        ));
      }
    }
    const __vfsOutcomes = await Promise.allSettled([
      ...__vfsTasks,
      rt.drainVfsMutations(),
    ]);
    for (let pass = 0; pass < 12; pass++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (rt.pendingIO.length <= rt.settledIO) break;
      const slice = rt.pendingIO.slice(rt.settledIO);
      rt.settledIO = rt.pendingIO.length;
      await Promise.allSettled(slice);
    }
    if (rt.settledIO === rt.pendingIO.length) {
      rt.pendingIO.length = 0;
      rt.settledIO = 0;
    }
    const __vfsFailure = __vfsOutcomes.find((outcome) => outcome.status === "rejected");
    if (__vfsFailure) throw __vfsFailure.reason;
  });
  rt.pendingDrainChain = __pendingDrain.catch(() => {});
  await __pendingDrain;
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
    const __nimbusDeferProcessExitReport = true;
${VFS_WRITE_LEDGER_SOURCE}
    const __vfsDirs = {};

${ENTRYPOINT_TIMER_TRACKER}
${shims}

${ENTRYPOINT_EVENT_LOOP}
${RESIDENCY_MISS_REPORT}

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
      if (__entryCompileFailure) throw new Error(__entryCompileFailure);
      if (!__compiledFn) throw new Error("entrypoint compile failed");
      const __entryResult = __compiledFn(
        mod.exports, __require, mod, filename || "/home/user/script.js", dirname || "/home/user"
      );
      if (attachedTty) {
        // An attached entry owns the terminal until it returns, so its own
        // completion is awaited by the exit lifecycle below, never here.
        if (__entryResult && typeof __entryResult.then === "function") {
          __attachedCompletion = __entryResult;
        }
        await __nimbusRunEventLoop(
          __nimbusPendingStartupWork, __nimbusProcessExitPromise, ${RESIDENT_BOOT_SETTLE_MS}, 8,
        );
      } else {
        await __nimbusSettleEntrypointStartup(__entryResult, ${RESIDENT_BOOT_SETTLE_MS});
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
      flushVfsWrite: __nimbusFlushVfsWrite,
      persistVfsWrite: __nimbusPersistVfsWrite,
      drainVfsMutations: __nimbusDrainVfsMutations,
      pendingDrainChain: Promise.resolve(),
    };
    await __nimbusFlushRuntime();

    const __nimbusReportFinalExit = async (code, reason) => {
      if (!__supervisor || __nimbusProcessExitReported) return;
      // Every resident exit path funnels through here, so the unanswered-read
      // report is sited once and cannot be reached around.
      if (globalThis.__nimbusVfsResidencySettle) {
      try { await globalThis.__nimbusVfsResidencySettle(); } catch {}
    }
    const __residencyReport = __nimbusResidencyMissReport();
      if (__residencyReport) {
        stderr += __residencyReport;
        if (Number(code ?? 0) === 0) code = 1;
        try { await __supervisor.stderr(__residencyReport); } catch {}
      }
      await __supervisor.reportExit(code, reason || "");
      __nimbusProcessExitReported = true;
    };
    const __nimbusReportLifecycleFailure = async (e) => {
      const trace = (e && e.stack) || (e && e.message) || String(e);
      stderr += trace + "\\n";
      if (__supervisor) {
        try { await __supervisor.stderr(trace + "\\n"); } catch {}
        await __nimbusReportFinalExit(1, trace + "\\n");
      }
    };

    if (__attachedExplicitExit) {
      await __nimbusReportFinalExit(exitCode, stderr);
    } else {
      const __residentExitLifecycle = (async () => {
        let finalCode = 0;
        if (attachedTty && __attachedCompletion) {
          const __exitMarker = {};
          const __result = await Promise.race([
            __attachedCompletion.then(() => null),
            __nimbusProcessExitPromise.then((code) => {
              finalCode = Number(code ?? 0);
              return __exitMarker;
            }),
          ]);
          if (__result !== __exitMarker) {
            finalCode = Number(__nimbusProcessExitCode ?? 0);
          }
        } else {
          finalCode = Number(await __nimbusProcessExitPromise);
        }
        await __nimbusFlushRuntime();
        await __nimbusReportFinalExit(finalCode, "");
      })().catch(async (e) => {
        if (e instanceof __ProcessExit) {
          try {
            await __nimbusFlushRuntime();
            await __nimbusReportFinalExit(e.code, "");
          } catch (flushError) {
            await __nimbusReportLifecycleFailure(flushError);
          }
          return;
        }
        await __nimbusReportLifecycleFailure(e);
      });
      workerCtx.waitUntil(__residentExitLifecycle);
      if (attachedTty) {
        __nimbusAttachedLifecycle = __residentExitLifecycle;
      }
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
  // (independent of the response stream), then make pending synchronous
  // file-content writes durable before returning the response.
  await __nimbusFlushRuntime();
  const response = await globalThis.__nimbusServeHttp(req);
  try {
    await __nimbusFlushRuntime();
  } catch (e) {
    try { await response.body?.cancel(); } catch {}
    throw e;
  }
  return response;
}

export class NimbusProcess extends DurableObject {
  async startProcess() {
    await __nimbusEnsureStarted(this.env, this.ctx);
    if (__nimbusAttachedLifecycle) await __nimbusAttachedLifecycle;
    return { ok: true };
  }
  async fetch(req) { return __nimbusDispatchHttp(req, this.env, this.ctx); }
  async handleHttpRequest(req) { return __nimbusDispatchHttp(req, this.env, this.ctx); }
}
`,
    modules: bundleSource.modules,
  };
}

// ── VFS bundler ─────────────────────────────────────────────────────────

/**
 * Result of preparing facet VFS state.
 *   - bundle:   path → content for the complete static require closure
 *               plus bounded optional snapshot enrichment for dynamic
 *               requires and synchronous filesystem reads. Required files
 *               are never removed to satisfy an enrichment budget.
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
type FacetVfsDenial = { error: 'EACCES' };
type FacetVfsBundle = Record<string, string | Uint8Array | FacetVfsDenial>;
type FacetVfsMetadata = Pick<VfsStat, 'type' | 'size' | 'mode' | 'uid' | 'gid'>;

interface FacetVfsState {
  // hardening-r5: bundle cells may be Uint8Array for binary content
  // (images, wasm modules, sqlite blobs, etc.). Pre-fix every cell was
  // forced through vfs.readFileString() which UTF-8-decoded binary
  // bytes ≥ 0x80 to U+FFFD; the JSON-embedded module form then
  // serialized U+FFFD as 3 bytes (EF BF BD), and a cross-process
  // read returned 3× the original byte count. See
  // for the canonical 256→512 byte demo.
  bundle: FacetVfsBundle;
  manifest: Record<string, string[]>;
  metadata: Record<string, FacetVfsMetadata>;
  /**
   * The VFS cursor these cells were read at.
   *
   * Without it a facet's first ACQUIRE carries a null epoch, which the
   * authority can only answer with a poison — "drop everything" — so the
   * first timer, fetch or frame in every facet threw away the entire resident
   * set and tried to refetch it in one turn. Stamping the bundle with the
   * cursor it was actually built at makes that first ACQUIRE an ordinary
   * delta, which is what it always was.
   */
  cursor?: { epoch: string; rev: number };
  /** Diagnostics: how many files survived the cap (post-greedy-oversample). */
  reachableCount: number;
  /** Diagnostics: was the bundle truncated by the encoded-size cap? */
  truncated: boolean;
  /** Telemetry: served from the prefetch-bundle cache (no VFS walk). */
  cacheHit?: boolean;
  /**
   * Identity of the bundle these cells came from, so a residency miss the
   * process reports can be filed against the exact build that missed. Carried
   * on the state rather than recomputed at the exec site, where the inputs
   * would have to be threaded through a second time and could drift.
   */
  bundleKey?: string;
  /**
   * Memoized Worker Loader source for the bundle. Oversized bundles are
   * split across bounded side modules so the complete require closure does
   * not exceed the main module's text-size ceiling.
   */
  bundleSource?: FacetVfsBundleSource;
  /** Memoized `JSON.stringify(manifest)`, cached for the same reason. */
  serializedManifest?: string;
  serializedMetadata?: string;
  /** Move the bundle out of the main module when combined state exceeds its ceiling. */
  bundleSideModulesRequired?: boolean;
  /**
   * Memoized `bundleUsesNodeSqlite(entryCode, bundle)`. Answered while the raw
   * cells are still in hand so `releaseSerializedSources` can drop them — it is
   * the only thing anything downstream still wanted them for.
   */
  usesNodeSqlite?: boolean;
}

/**
 * Drop the raw forms of everything that has been serialized, in place.
 *
 * `bundleSource`, `serializedManifest` and `serializedMetadata` are total
 * encodings of `bundle`, `manifest` and `metadata` — no caller can distinguish
 * a state carrying both from one carrying only the serialized halves, because
 * `generateEntrypointCode` reads the serialized halves and nothing else does.
 * Holding both doubles the cost of a cached entry for its whole lifetime, and
 * that lifetime spans execs.
 *
 * Only for states that are about to be RETAINED. `spawnNode` and
 * `_stageOpencodeFacet` build their own uncached states and genuinely re-read
 * the raw cells (`_serializeBundleForFacet`, `assertStagedBundleFitsRpcPayload`);
 * neither goes through here.
 */
export function releaseSerializedSources(vfsState: FacetVfsState): void {
  if (vfsState.bundleSource) vfsState.bundle = {};
  if (vfsState.serializedManifest !== undefined) vfsState.manifest = {};
  if (vfsState.serializedMetadata !== undefined) vfsState.metadata = {};
}

interface FacetVfsBundleSource {
  expression: string;
  imports: string;
  modules: Record<string, string>;
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

type BundleCellSize = [path: string, bytes: number];

/**
 * Supervisor-heap cost of a FacetVfsState the prefetch LRU is holding on to.
 *
 * A cached entry retains the raw bundle AND the serialized forms built from
 * it — source modules, manifest, metadata — so the memoization that saves the
 * rebuild costs roughly twice the bundle. Counting only the raw cells would
 * under-report the cache by about half, which is how a count-bounded LRU came
 * to look affordable.
 */
function retainedVfsStateBytes(state: FacetVfsState): number {
  let bytes = 0;
  for (const [path, cell] of Object.entries(state.bundle)) {
    bytes += path.length;
    if (typeof cell === 'string' || cell instanceof Uint8Array) bytes += _bundleCellLength(cell);
  }
  const source = state.bundleSource;
  if (source) {
    bytes += source.expression.length + source.imports.length;
    for (const moduleSource of Object.values(source.modules)) bytes += moduleSource.length;
  }
  bytes += state.serializedManifest?.length ?? 0;
  bytes += state.serializedMetadata?.length ?? 0;
  return bytes;
}

/**
 * UTF-8 byte length of `JSON.stringify(value)` — computed, for the string
 * case, without building the string. A source cell can be megabytes on its
 * own, and the point of the incremental accounting is that sizing the
 * snapshot never allocates a second copy of anything in it.
 *
 * Uint8Array has no JSON representation of its own: JSON.stringify expands
 * it to `{"0":byte,"1":byte,...}`. Materializing that form while merely
 * sizing a binary cell can allocate more than twelve times the file's raw
 * bytes, so count its punctuation and decimal digits directly too.
 *
 * Other values here are the small manifest object or a permission-denial
 * marker and can take the direct route.
 */
function _jsonEncodedBytes(value: unknown): number {
  if (value instanceof Uint8Array) {
    let bytes = 2; // the surrounding braces
    let indexDigits = 1;
    let nextIndexWidth = 10;
    for (let index = 0; index < value.byteLength; index++) {
      if (index === nextIndexWidth) {
        indexDigits++;
        nextIndexWidth *= 10;
      }
      if (index > 0) bytes += 1; // comma
      // `"index":byte`: quotes + decimal key + colon + decimal byte.
      const byte = value[index];
      const byteDigits = byte < 10 ? 1 : byte < 100 ? 2 : 3;
      bytes += 3 + indexDigits + byteDigits;
    }
    return bytes;
  }
  if (typeof value !== 'string') {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  }
  let bytes = 2; // the surrounding quotes
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) { bytes += 2; continue; }          // " \
    if (code < 0x20) {
      // \b \t \n \f \r get a two-character escape; every other C0 gets \u00XX.
      bytes += (code === 8 || code === 9 || code === 10 || code === 12 || code === 13) ? 2 : 6;
      continue;
    }
    if (code < 0x80) { bytes += 1; continue; }
    if (code < 0x800) { bytes += 2; continue; }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      // A well-formed pair is one 4-byte code point; a lone surrogate is
      // escaped as \uXXXX (JSON.stringify is well-formed since ES2019).
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; } else { bytes += 6; }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) { bytes += 6; continue; }
    bytes += 3;
  }
  return bytes;
}

/** `{"bundle":` + `,"manifest":` + `}` — the frame around the two members. */
const ENCODED_PAYLOAD_FRAME_BYTES = 23;

/**
 * Running UTF-8 byte length of `JSON.stringify({ bundle, manifest })`,
 * accumulated one cell at a time.
 *
 * Measuring it by materializing the payload — `encode(stringify(...))`,
 * which the eviction loop used to redo after every single eviction — puts
 * several full copies of a multi-megabyte bundle in the supervisor DO at
 * once. On a working tree carrying one large data file that is enough to
 * reset the DO, which drops the shell's WebSocket server-side without
 * closing it and wedges the user's terminal with no error anywhere.
 *
 * JSON object serialization is `{` + `"key":value` joined by `,` + `}`, so
 * the total is a sum of independent per-cell terms: exact, incremental, and
 * never holding more than one cell's worth of scratch.
 */
export function encodedBundleSize(bundle: FacetVfsBundle, manifest: Record<string, string[]>) {
  const cells = new Map<string, number>();
  let cellSum = 0;
  const manifestBytes = _jsonEncodedBytes(manifest);
  const self = {
    add(path: string, cell: FacetVfsBundle[string]): void {
      if (cells.has(path)) return;
      const bytes = _jsonEncodedBytes(path) + 1 + _jsonEncodedBytes(cell);
      cells.set(path, bytes);
      cellSum += bytes;
    },
    remove(path: string): void {
      const bytes = cells.get(path);
      if (bytes === undefined) return;
      cells.delete(path);
      cellSum -= bytes;
    },
    get bytes(): number {
      const separators = Math.max(0, cells.size - 1);
      return ENCODED_PAYLOAD_FRAME_BYTES + 2 + cellSum + separators + manifestBytes;
    },
  };
  for (const [path, cell] of Object.entries(bundle)) self.add(path, cell);
  return self;
}

/**
 * Bounded `path (N bytes)` listing, largest first. A snapshot diagnostic has
 * to name the files it is talking about — the facet's own error for a missing
 * one is an unattributable "Cannot find module" — without printing a bundle
 * that can run to thousands of entries.
 */
function describeBundleCells(cells: BundleCellSize[], limit = 8): string {
  const shown = [...cells].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const rest = cells.length - shown.length;
  return shown.map(([path, bytes]) => `${path} (${bytes} bytes)`).join(', ')
    + (rest > 0 ? `, +${rest} more` : '');
}

/**
 * hardening-r5: emit a JS expression that revives binary cells from base64
 * and preserves permission-denial cells alongside ordinary strings.
 *
 * The output is a SELF-EXECUTING IIFE expression so it can be substituted
 * directly into `const __MODULE_VFS_BUNDLE = ${expr};` template slots.
 */
function _serializeBundleForFacet(bundle: FacetVfsBundle): string {
  const strCells: Record<string, string> = {};
  const binCells: Record<string, string> = {};
  const deniedPaths: string[] = [];
  for (const [k, v] of Object.entries(bundle)) {
    if (typeof v === 'string') {
      strCells[k] = v;
    } else if (v instanceof Uint8Array) {
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
    } else {
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

const FACET_VFS_MODULE_PREFIX = '__nimbus_vfs_bundle_';
const FACET_VFS_MODULE_SOURCE_MARGIN = 1024;

function _encodedSourceBytes(source: string): number {
  return new TextEncoder().encode(source).length;
}

function _facetBundleModuleSource(bundle: FacetVfsBundle): string {
  return `export default ${_serializeBundleForFacet(bundle)};`;
}

/**
 * Serialize a VFS bundle for Worker Loader without dropping required files.
 *
 * Small bundles remain inline. Large bundles are partitioned into side
 * modules below the existing per-module encoded ceiling and merged during
 * module evaluation. A single oversized cell is split into ordered fragments;
 * the merge expression concatenates those fragments back to the original
 * string or Uint8Array before module precompilation begins.
 */
export function buildFacetVfsBundleSource(
  bundle: FacetVfsBundle,
  forceSideModules = false,
): FacetVfsBundleSource {
  const inlineExpression = _serializeBundleForFacet(bundle);
  if (
    !forceSideModules
    && _encodedSourceBytes(inlineExpression) <= BUNDLE_MAX_ENCODED_BYTES
  ) {
    return { expression: inlineExpression, imports: '', modules: {} };
  }
  if (Object.keys(bundle).length === 0) {
    return { expression: inlineExpression, imports: '', modules: {} };
  }

  const maxModuleBytes = BUNDLE_MAX_ENCODED_BYTES - FACET_VFS_MODULE_SOURCE_MARGIN;
  type BundlePiece = [path: string, cell: FacetVfsBundle[string]];

  function sourceBytes(path: string, cell: FacetVfsBundle[string]): number {
    return _encodedSourceBytes(_facetBundleModuleSource({ [path]: cell }));
  }

  function splitCell(path: string, cell: FacetVfsBundle[string]): BundlePiece[] {
    if (sourceBytes(path, cell) <= maxModuleBytes) return [[path, cell]];
    if (typeof cell !== 'string' && !(cell instanceof Uint8Array)) {
      throw new Error(`Nimbus: VFS denial cell path exceeds facet module limit: ${path}`);
    }

    const pieces: BundlePiece[] = [];
    let offset = 0;
    while (offset < cell.length) {
      let low = 1;
      let high = cell.length - offset;
      let fittingLength = 0;
      while (low <= high) {
        const middle = low + Math.floor((high - low) / 2);
        const candidate = typeof cell === 'string'
          ? cell.slice(offset, offset + middle)
          : cell.subarray(offset, offset + middle);
        if (sourceBytes(path, candidate) <= maxModuleBytes) {
          fittingLength = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (fittingLength === 0) {
        throw new Error(`Nimbus: VFS bundle path exceeds facet module limit: ${path}`);
      }
      const fragment = typeof cell === 'string'
        ? cell.slice(offset, offset + fittingLength)
        : cell.subarray(offset, offset + fittingLength);
      pieces.push([path, fragment]);
      offset += fittingLength;
    }
    return pieces;
  }

  const chunks: FacetVfsBundle[] = [];
  let chunk: FacetVfsBundle = {};
  let estimatedBytes = 0;

  function flushChunk(): void {
    if (Object.keys(chunk).length === 0) return;
    chunks.push(chunk);
    chunk = {};
    estimatedBytes = 0;
  }

  for (const [path, cell] of Object.entries(bundle)) {
    for (const [piecePath, pieceCell] of splitCell(path, cell)) {
      const pieceBytes = sourceBytes(piecePath, pieceCell);
      if (
        piecePath in chunk
        || (estimatedBytes > 0 && estimatedBytes + pieceBytes > maxModuleBytes)
      ) {
        flushChunk();
      }
      chunk[piecePath] = pieceCell;
      estimatedBytes += pieceBytes;
    }
  }
  flushChunk();

  const modules: Record<string, string> = {};
  const imports: string[] = [];
  const aliases: string[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const moduleName = `${FACET_VFS_MODULE_PREFIX}${index}.js`;
    const alias = `__nimbusVfsBundle${index}`;
    const source = _facetBundleModuleSource(chunks[index]);
    if (_encodedSourceBytes(source) > BUNDLE_MAX_ENCODED_BYTES) {
      throw new Error(`Nimbus: generated VFS side module exceeds encoded limit: ${moduleName}`);
    }
    modules[moduleName] = source;
    imports.push(`import ${alias} from "${moduleName}";`);
    aliases.push(alias);
  }

  const expression =
    `(function(__parts){const __out={};for(const __part of __parts){` +
    `for(const [__k,__v] of Object.entries(__part)){const __prev=__out[__k];` +
    `if(__prev===undefined){__out[__k]=__v;}` +
    `else if(typeof __prev==="string"&&typeof __v==="string"){__out[__k]=__prev+__v;}` +
    `else if(__prev instanceof Uint8Array&&__v instanceof Uint8Array){` +
    `const __joined=new Uint8Array(__prev.length+__v.length);__joined.set(__prev);` +
    `__joined.set(__v,__prev.length);__out[__k]=__joined;}` +
    `else{throw new Error("Nimbus: invalid split VFS bundle cell: "+__k);}}}` +
    `return __out;})([${aliases.join(',')}])`;

  return {
    expression,
    imports: imports.join('\n'),
    modules,
  };
}

/**
 * A staged spec crosses the fabric as ONE RPC payload, so its snapshot has
 * no side-module relief: `MAX_RPC_SAFE_PAYLOAD_BYTES` is a hard physical
 * ceiling, not a policy knob that can be raised. Base64-reviving binary
 * cells inflates the serialized form ~4/3 over the raw bytes the encoded-size
 * pass measured, so the payload can clear that pass and still not fit.
 *
 * Fail here, naming the cells that dominate the snapshot. Shipping a
 * shortened one instead would surface inside the facet as an
 * unattributable ENOENT or "Cannot find module" — neither require() nor
 * readFileSync can go back to the supervisor for what was left out.
 */
export function assertStagedBundleFitsRpcPayload(
  serialized: string,
  bundle: FacetVfsBundle,
): void {
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes <= MAX_RPC_SAFE_PAYLOAD_BYTES) return;
  const cells: BundleCellSize[] = Object.entries(bundle)
    .map(([path, cell]) => [
      path,
      typeof cell === 'string' || cell instanceof Uint8Array ? _bundleCellLength(cell) : 0,
    ]);
  throw new Error(
    `Nimbus: staged facet VFS snapshot serializes to ${bytes} bytes, over the `
      + `${MAX_RPC_SAFE_PAYLOAD_BYTES}-byte RPC payload ceiling. Largest members: `
      + `${describeBundleCells(cells)}`,
  );
}

/**
 * FNV-1a 32-bit hash, returned as an unsigned hex string. Used only to
 * fold the (possibly large) entry code into a compact, collision-resistant
 * prefetch-bundle cache-key component — not a security primitive.
 */
function _fnv1a(s: string): string {
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
function buildManifest(
  vfs: CredentialedVfs,
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
  // ── The path from the root down to the working directory ──────────────
  //
  // One level each, before the deep walks, so that every directory on that
  // chain is ENUMERATED rather than merely mentioned. It is what makes a
  // synchronous "not there" honest for the shape programs probe most: node's
  // resolver walks upward asking for `<dir>/node_modules` at every level, and
  // a config lookup asks for a dotfile directory in $HOME. Those paths mostly
  // do not exist, and answering that requires having listed the directory
  // they would be in — otherwise the only honest answer is a refusal, and the
  // resolver pays a round trip per rung to hear it.
  //
  // Cheap by construction: one readdir per component, names only, and the
  // recursion below each stops immediately.
  {
    const segments = cwdStripped ? cwdStripped.split('/') : [];
    for (let i = 0; i < segments.length; i++) {
      walk(segments.slice(0, i).join('/'), MANIFEST_MAX_DEPTH);
    }
  }
  walk(cwdStripped, 0);
  const nmDir = cwdStripped + '/node_modules';
  if (vfs.exists(nmDir) && vfs.isDirectory(nmDir)) {
    walk(nmDir, 0);
  }
  // ── Bin-target package + hoisted dependency roots ─────────────────────
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
  // entire package tree is enumerable via readdir. Also walk that
  // `node_modules` directory itself: global npm bins resolve hoisted
  // transitive dependencies as siblings of the bin's own package.
  // Bounded by MANIFEST_MAX_DEPTH; same depth budget as the cwd walk.
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
      const nodeModulesRoot = segs.slice(0, nmIdx + 1).join('/');
      if (vfs.exists(nodeModulesRoot) && vfs.isDirectory(nodeModulesRoot)) {
        walk(nodeModulesRoot, 0);
      }
    }
  }
  return manifest;
}

function buildVfsMetadata(
  vfs: CredentialedVfs,
  manifest: Record<string, string[]>,
  bundle: FacetVfsBundle,
): Record<string, FacetVfsMetadata> {
  const paths = new Set(Object.keys(bundle));
  for (const [directory, children] of Object.entries(manifest)) {
    paths.add(directory);
    for (const child of children) {
      paths.add(directory ? `${directory}/${child}` : child);
    }
  }

  const metadata: Record<string, FacetVfsMetadata> = {};
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
    } catch {
      // The credentialed lookup is authoritative; inaccessible ancestors do
      // not reveal whether a leaf exists.
    }
  }
  return metadata;
}

function addUnreadableDenialCells(
  vfs: CredentialedVfs,
  bundle: FacetVfsBundle,
  metadata: Record<string, FacetVfsMetadata>,
): void {
  for (const [path, stat] of Object.entries(metadata)) {
    if (stat.type === 'directory' || path in bundle) continue;
    try {
      vfs.access(path, 0o4);
    } catch (error: unknown) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'EACCES'
      ) {
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
export function greedyAddMainEntries(
  vfs: CredentialedVfs,
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
        // The static walker cannot discover computed hash-chunk imports, so
        // the greedy oversample is the safety net for their reachability.
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
  vfs: CredentialedVfs,
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
  vfs: CredentialedVfs,
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
export function addBinTargetSiblings(
  vfs: CredentialedVfs,
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
  // nuxt ~700, create-react-router ~400). Still well below the optional
  // enrichment budget of 4000 files / 24 MiB, which retains the defense
  // against pathological package trees.
  //
  // for the prior wave's empirical investigation (243 manifest entries,
  // only 140/243 readable pre-bump on prod 11df6ca).
  const MAX_PKG_FILES = 1000;

  // BFS walk pkgRoot. Skip nested `node_modules` (those are
  // separate packages with their own walk if/when they become
  // entry points).
  // Phase 1 — enumerate candidates and their sizes. Nothing is read here, so
  // an unread multi-MiB cell costs a stat rather than a transfer.
  let visited = 0;
  const candidates: { path: string; size: number }[] = [];
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
      let size: number;
      try { size = vfs.lstat(child).size; } catch { continue; }
      if (size > BIN_PACKAGE_SPECULATIVE_MAX_FILE_BYTES) continue;
      candidates.push({ path: child, size });
    }
  }

  // Phase 2 — admit smallest first.
  //
  // The budget is shared with every other pass, so whatever this walk spends
  // is denied to the rest. Ordering by size maximizes the number of files
  // admitted per byte, and the files a program actually reads at runtime are
  // the small ones: typescript's 51 `lib.*.d.ts` cells total 3.3 MiB and are
  // all read, while its single `lib/typescript.js` is 8.69 MiB and is not.
  // In readdir order the latter could exhaust the budget before the former
  // was reached.
  candidates.sort((a, b) => a.size - b.size);

  let added = 0;
  for (const candidate of candidates) {
    if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES) break;
    if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES) break;
    // hardening-r5: preserve binary content as Uint8Array.
    let content: string | Uint8Array;
    try { content = _readBundleCell(vfs, candidate.path); } catch { continue; }
    const cellLen = _bundleCellLength(content);
    // A cell that does not fit must not abandon the walk: smallest-first
    // ordering means everything after it is smaller and may still fit.
    if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES) continue;
    bundle[candidate.path] = content;
    budgetState.totalBytes += cellLen;
    budgetState.fileCount++;
    added++;
  }
  return { added };
}

/**
 * Stage the paths an earlier run of the same entry read synchronously and did
 * not have.
 *
 * The speculative passes are all proxies for intent — a call shape, a package
 * layout, a filename — and each one silently drops whatever its author did
 * not think of. A miss is the opposite: direct evidence, from the program
 * itself, that the bundle was wrong about one specific path. So the only
 * policy here is a budget. There is no extension rule and no per-file size
 * rule; a file that does not fit inside the bundle's memory bound is one no
 * policy can stage, and the facet says so by name when it is read again.
 *
 * Admitted smallest-first for the same reason as the entry-package walk: the
 * budget is shared, so ordering by size maximizes the number of misses a
 * fixed number of bytes repairs.
 */
export function addObservedReads(
  vfs: CredentialedVfs,
  observed: ReadonlySet<string> | undefined,
  bundle: Record<string, string | Uint8Array>,
  requiredPaths: Set<string>,
  budgetState: { totalBytes: number; fileCount: number },
): { added: number } {
  if (!observed || observed.size === 0) return { added: 0 };

  const candidates: { path: string; size: number }[] = [];
  for (const path of observed) {
    if (path === '' || bundle[path] !== undefined) continue;
    let stat: { size: number; type?: string };
    try { stat = vfs.lstat(path); } catch { continue; }
    if (stat.type === 'directory') continue;
    candidates.push({ path, size: stat.size });
  }
  candidates.sort((a, b) => a.size - b.size);

  let added = 0;
  for (const candidate of candidates) {
    if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES) break;
    if (budgetState.totalBytes + candidate.size > VFS_BUNDLE_MAX_BYTES) continue;
    let content: string | Uint8Array;
    try { content = _readBundleCell(vfs, candidate.path); } catch { continue; }
    const cellLen = _bundleCellLength(content);
    if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES) continue;
    bundle[candidate.path] = content;
    requiredPaths.add(candidate.path);
    budgetState.totalBytes += cellLen;
    budgetState.fileCount++;
    added++;
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

/**
 * Suffixes never *read* at runtime — consumed only by tooling that does not
 * run inside a facet. Excluding them is safe because no program can observe
 * the difference.
 *
 * This list deliberately no longer guesses at content. It previously carried
 * `.d.ts` and `.md`, and both were wrong the same way: the walk that consults
 * it visits ONLY the entry package's own tree (see `addBinTargetSiblings`),
 * which is precisely the package most likely to read its own data at runtime.
 * `.d.ts` stripped TypeScript's `lib.*.d.ts` — the single unsatisfiable read
 * behind every `TS2318` — and `.md` stripped pi's `CHANGELOG.md`. "`.d.ts` is
 * type-only metadata" holds for every package except the one whose runtime
 * data happens to be `.d.ts`, and this walk only ever looks at that one.
 *
 * Size, not extension, is what bounds this walk now.
 */
const RUNTIME_PACKAGE_EXCLUDED_FILE_SUFFIXES = [
  '.map',
  '.tsbuildinfo',
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

/**
 * Per-file ceiling for the speculative entry-package walk.
 *
 * Everything the entry package needs in order to *run* arrives through the
 * require closure, which is uncapped and never evicted. This walk exists only
 * to catch data files the static walker cannot see, and data files are small.
 * Multi-MiB cells in a package tree are overwhelmingly alternative bundles —
 * typescript ships an 8.69 MiB `lib/typescript.js` that is never read — rather
 * than data.
 *
 * So one speculative guess must not spend the budget every later invocation
 * then carries: the same reasoning as `CWD_SNAPSHOT_MAX_FILE_BYTES`, applied
 * to the package tree.
 */
const BIN_PACKAGE_SPECULATIVE_MAX_FILE_BYTES = 4 * 1024 * 1024;

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
  vfs: CredentialedVfs,
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
      // Skip an oversized file before reading it: this walk guesses at what
      // the program might read, and one guess must not spend the budget (or
      // the supervisor's headroom) that every later invocation then carries.
      try { if (vfs.lstat(child).size > CWD_SNAPSHOT_MAX_FILE_BYTES) continue; } catch { continue; }
      let content: string | Uint8Array;
      try { content = _readBundleCell(vfs, child); } catch { continue; }
      const cellLen = _bundleCellLength(content);
      if (cellLen > CWD_SNAPSHOT_MAX_FILE_BYTES) continue;
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
  vfs: CredentialedVfs,
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
    if (!isBundleModuleCandidate(path)) continue;
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
 * The set of bundle entries the facet's startup pre-compile loop turns into
 * functions, minus the ones already in the right format. Everything the loop
 * compiles must pass through the ESM→CJS transform first: a file the loop
 * compiles but this pass skipped reaches `new Function` as ESM source and
 * dies there, and request-time codegen is blocked so nothing can recover it.
 *
 * Extensionless entries are in the set for the same reason the pre-compile
 * loop takes them — that is the shape of nearly every npm `bin` script.
 * `.json` is data and `.cjs` is CommonJS by definition; neither needs the
 * transform. Content, not the path, decides from here: `looksLikeEsm` parses.
 */
function isBundleModuleCandidate(path: string): boolean {
  const ext = vfsPathExtension(path);
  return ext === '.js' || ext === '.mjs' || ext === '';
}

/**
 * Transform every ESM-shaped file in the bundle to CJS via esbuild.
 * Mutates `bundle` in place. Errors are swallowed (the file is left as
 * ESM source); the facet's pre-compile loop will record the SyntaxError
 * into __compileFailures and __loadModule will surface it (Fix C).
 *
 * Candidate set is `isBundleModuleCandidate`; within it, files with no
 * top-level import/export are already CJS-shaped and left alone.
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
    if (!isBundleModuleCandidate(path)) continue;
    const src = bundle[path];
    // hardening-r5: binary cells are not ESM. Skip — looksLikeEsm +
    // esbuild.transform expect strings.
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
 * The static walker supplies the complete known require closure. Separate
 * file and byte budgets bound optional enrichment for dynamic require and
 * synchronous filesystem patterns without removing required files.
 *
 * Optional files are evicted against the exact JSON-encoded payload size.
 * If required content still exceeds the per-module encoded ceiling, Worker
 * Loader side modules carry the bundle without truncating the closure.
 *
 * W3.5: now async to allow the optional ESM→CJS pre-pass via esbuild.
 * If `esbuild` is not provided, the pass is skipped (preserves prior
 * behaviour for code paths that don't have esbuild handy).
 *
 */
export async function buildPrefetchBundle(
  vfs: CredentialedVfs,
  scriptPath: string | undefined,
  cwd: string,
  entryCode: string,
  esbuild?: EsbuildService,
  bundleProfile: FacetBundleProfile = DEFAULT_FACET_BUNDLE_PROFILE,
  observedReads?: ReadonlySet<string>,
): Promise<FacetVfsState> {
  // This build accumulates raw VFS contents in the supervisor heap, and did it
  // with nothing watching: the estimator read 9.4 MiB while these bytes were
  // resetting the DO three times. Take the budget the enrichment passes are
  // allowed to spend, so a build queues behind other heavy work instead of
  // racing it, and attribute it so it lands under `prefetchBundleBytes` rather
  // than in the unattributed remainder.
  const lease = await acquireSupervisorAllocation(VFS_BUNDLE_MAX_BYTES);
  prefetchBundleStart(VFS_BUNDLE_MAX_BYTES);
  try {
    return await _buildPrefetchBundle(
      vfs, scriptPath, cwd, entryCode, esbuild, bundleProfile, observedReads,
    );
  } finally {
    prefetchBundleEnd(VFS_BUNDLE_MAX_BYTES);
    lease.release();
  }
}

async function _buildPrefetchBundle(
  vfs: CredentialedVfs,
  scriptPath: string | undefined,
  cwd: string,
  entryCode: string,
  esbuild?: EsbuildService,
  bundleProfile: FacetBundleProfile = DEFAULT_FACET_BUNDLE_PROFILE,
  observedReads?: ReadonlySet<string>,
): Promise<FacetVfsState> {
  // Read the cursor BEFORE the walk: a mutation that lands while the bundle
  // is being assembled must be reported as invalidated, not silently missed.
  const cursor = { epoch: vfs.epoch, rev: vfs.revision() };

  // 1. Static reachable-set walk from entry.
  const prefetch = prefetchForRequire(vfs, entryCode || '', cwd, scriptPath);
  const bundle: Record<string, string | Uint8Array> = { ...prefetch.bundle };
  const requiredPaths = new Set(Object.keys(prefetch.bundle));
  let truncated = false;
  const budgetState = { totalBytes: 0, fileCount: 0 };

  // 1.5 Observed reads. Every pass below this line guesses what a program
  //     will read — from a call shape, a package layout, a string literal —
  //     and each of them is wrong for whatever it did not anticipate. These
  //     paths are not a guess: an earlier run of the same entry asked for
  //     them synchronously and the bundle did not have them. So they are
  //     admitted first, ahead of every guess, and they join the required set
  //     rather than the evictable one, because a file evicted here misses
  //     again on the next run and the loop never closes.
  const observedAdd = addObservedReads(vfs, observedReads, bundle, requiredPaths, budgetState);
  void observedAdd;

  // 2. Greedy oversample — every installed pkg's pkg.json + main.
  //    Catches dynamic-require / `bindings()` / plugin-loader cases the
  //    regex prefetch misses. Its budget is independent from the complete
  //    static require closure, which is correctness-critical.
  const greedy = greedyAddMainEntries(vfs, cwd, bundle, budgetState);

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

  // 2.27 X.5-U: dotfile + SWC-shape readFileSync sentinel prefetch.
  //      Sibling of `addStaticReadFileAssets` (X.5-Z3) — same call shape,
  //      different match space. Covers the SWC/TS-compiled
  //      `(0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, "<rel>"))`
  //      pattern AND filenames outside the Z3 ASSET_EXT whitelist
  //      (dotfiles, no-extension sentinels, "digest/hash/version/sha/md5"
  //      shapes). Motivating case: ts-jest's `.ts-jest-digest`. See
  const dotAdd = addStaticReadFileDotfilesAndCompiled(vfs, cwd, bundle, budgetState);
  void dotAdd;

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

  // 2.34 project-data snapshot: sync Node fs cannot await the
  // supervisor. Include a bounded snapshot of the current working tree
  // for common relative project-file reads while skipping dependency
  // and Nimbus cache directories. Async fs still uses live supervisor
  // reads and child-process staleness fallback.
  const cwdProjectAdd = addCwdProjectFiles(vfs, cwd, bundle, budgetState);
  void cwdProjectAdd;

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

  // 4. JSON-encoded-size guard, measured in UTF-8 bytes (not UTF-16 code
  //    units) because that is what workerd charges against the per-module
  //    text-size budget. Only OPTIONAL enrichment is evictable, largest
  //    first; the manifest and the static require closure stay.
  //
  //    Evicting an enrichment file is a real loss — the sync fs reads it
  //    exists for cannot fall back to the supervisor — so the paths that
  //    went are named rather than silently dropped.
  const size = encodedBundleSize(bundle, manifest);
  if (size.bytes > BUNDLE_MAX_ENCODED_BYTES) {
    const evictable = Object.keys(bundle)
      .filter((path) => !requiredPaths.has(path))
      .sort((a, b) => _bundleCellLength(bundle[b]) - _bundleCellLength(bundle[a]));
    const evicted: BundleCellSize[] = [];
    for (const k of evictable) {
      if (size.bytes <= BUNDLE_MAX_ENCODED_BYTES) break;
      evicted.push([k, _bundleCellLength(bundle[k])]);
      delete bundle[k];
      size.remove(k);
    }
    if (evicted.length > 0) {
      truncated = true;
      console.warn(
        `[facet-manager] prefetch snapshot exceeded ${BUNDLE_MAX_ENCODED_BYTES} encoded `
          + `bytes; evicted ${evicted.length} optional file(s). They still exist and `
          + `async reads still return them; synchronous reads raise EAGAIN: `
          + `${describeBundleCells(evicted)}`,
      );
    }
  }

  const fileCount = Object.keys(bundle).length;
  const metadata = buildVfsMetadata(vfs, manifest, bundle);
  addUnreadableDenialCells(vfs, bundle, metadata);
  // Denial cells land after the eviction pass, so account for them before
  // deciding where the bundle has to live.
  for (const [path, cell] of Object.entries(bundle)) size.add(path, cell);
  const bundleSideModulesRequired = size.bytes > BUNDLE_MAX_ENCODED_BYTES;

  // Suppress lint: `greedy.added` is observed only via diagnostics.
  void greedy;

  return {
    bundle,
    manifest,
    metadata,
    cursor,
    reachableCount: fileCount,
    truncated,
    bundleSideModulesRequired,
  };
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
  /** Inline modules: source text, or small wasm carried by value. */
  modules?: Record<string, string | { wasm: ArrayBuffer }>;
  /**
   * Module name → VFS path of a wasm image the process's host materializes
   * for itself. Runtime images belong here, not in `modules`: ruby's is
   * 34.3 MiB, past what any single RPC value may carry.
   */
  vfsWasmModules?: Record<string, string>;
  compatibilityFlags?: string[];
  /** Forwarded verbatim to the runner's startProcess. */
  startArgs?: unknown;
}

const ROUTEABLE_PORT_ATTACH_TIMEOUT_MS = 1_000;

export class FacetManager {
  private ctx: DurableObjectState;
  private env: FacetManagerEnv;
  private processes: SessionProcessSupervisor;
  private portRegistry: PortRegistry;
  private vfs: SqliteVFS | null = null;
  private hooks: FacetManagerHooks;
  /**
   * The resident-process scheduler (loaders/process-fabric.ts). Every
   * long-lived process — staged opencode, node servers, python/ruby socket
   * servers — is booted through it, and it is the only code that knows which
   * workerd process a facet landed in.
   */
  private processFabric: ProcessFabric;
  /** NIMBUS_DEBUG=1: placement diagnostics into the process log store. */
  private debugEnabled = false;
  private processRpcResources = new Map<number, ProcessRpcResources>();
  /** pid → the boot images its facet loads from; the image sweep's root set. */
  private residentImages = new Map<number, string[]>();
  private timedOutProcessIds = new Set<number>();
  // attach-pid → serve-pid: the resident serve facet a bare-`opencode` dual
  // spawn created as an OS-child of the attach TUI. When the attach process
  // exits (reported / killed), its serve facet is torn down with it.
  private _pairedServeFacet = new Map<number, number>();
  /**
   * W3.5 Fix B: lazily-created EsbuildService for the ESM→CJS pre-pass
   * over the prefetch bundle. Created on first exec where vfs is set;
   * shared across subsequent execs (warm wasm).  Optional setter
   * `setEsbuildService` lets NimbusSession share its existing instance
   * to avoid double-init.
   */
  private esbuild: EsbuildService | null = null;

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
  private prefetchBundleCache = new Map<string, {
    revision: number;
    vfsState: FacetVfsState;
    /** Retained supervisor-heap cost of this entry; the LRU's real bound. */
    bytes: number;
  }>();
  private static readonly PREFETCH_CACHE_MAX = 16;
  /** Live sum of the entries' `bytes`, mirrored to the diag gauge on change. */
  private prefetchCacheBytes = 0;

  /**
   * What each entry was observed to read and not have, keyed exactly like the
   * prefetch cache above so a profile can only ever seed the bundle it was
   * measured against.
   *
   * Lifetime is the supervisor incarnation's, same as the cache — a restart
   * costs one more loud failure and then relearns. Persisting it would be a
   * schema and a migration bought with nothing the in-memory form does not
   * already deliver for the case that matters: running the command again.
   */
  private residencyProfiles = new Map<string, Set<string>>();
  private static readonly RESIDENCY_PROFILE_MAX_ENTRIES = 16;
  /**
   * A program that reads a directory of data files misses once per file, so
   * the cap has to clear a real working set. Past it the profile stops
   * growing and the surplus stays loud — a bounded map that admits the first
   * N is honest; an unbounded one in a Durable Object is a leak.
   */
  private static readonly RESIDENCY_PROFILE_MAX_PATHS = 4096;

  // NOTE: the opencode artifact sources (entry bundle, chunk pack, TUI worker
  // sources, wasm sidecars) are never materialized on the spawn path — this
  // manager only builds the small OpencodeStageSpec (argv/env/VFS snapshot).
  // facets/opencode-staging.ts assembles the module map inside the
  // Worker-Loader cache-miss callback, so the sources exist only while a facet
  // is actually loading.

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
    this.processFabric = new ProcessFabric(ctx, env, () => this._residentDisk());
    const debugVar = ((typeof env === 'object' || typeof env === 'function') && env !== null)
      ? Reflect.get(env, 'NIMBUS_DEBUG')
      : undefined;
    this.debugEnabled = debugVar === '1' || debugVar === 'true';
  }

  setVfs(vfs: SqliteVFS) {
    this.vfs = vfs;
    // The image store owns its directory, so it creates it on the way up
    // rather than on first write. Creating it lazily made the store perturb
    // the filesystem view every manifest is built from: the root listing
    // gained an entry the moment an image was written, so the next spawn of
    // an identical program generated different text and addressed a different
    // image. A directory that exists before the first walk is stable.
    try { vfs.as(CRED_KERNEL).mkdir(FACET_IMAGE_DIR, { recursive: true, mode: 0o755 }); }
    catch { /* a session whose disk is not writable has no images to store */ }
  }
  /**
   * W3.5 Fix B: hand the FacetManager a pre-warmed EsbuildService for
   * the ESM→CJS bundle pre-pass. NimbusSession already lazy-creates one
   * for the user-shell `node` runtime; sharing avoids paying init twice.
   */
  setEsbuildService(esbuild: EsbuildService) { this.esbuild = esbuild; }

  /**
   * buildPrefetchBundle wrapped in a global-revision-keyed cache. On a hit
   * (same key AND the VFS hasn't been mutated since) it returns the memoized
   * bundle + pre-built facet source, skipping the full VFS walk + esbuild
   * pass + source construction. See `prefetchBundleCache` for the
   * correctness argument behind the conservative global-revision watermark.
   *
   * The bundle source and manifest are computed once on the miss path and
   * stored so subsequent hits skip rebuilding them too.
   */
  private async _buildPrefetchBundleCached(
    vfs: CredentialedVfs,
    scriptPath: string | undefined,
    cwd: string,
    entryCode: string,
    credKey: string,
    bundleProfile?: FacetBundleProfile,
  ): Promise<FacetVfsState> {
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

    const vfsState = await buildPrefetchBundle(
      vfs, scriptPath, cwd, entryCode, this.esbuild || undefined, bundleProfile,
      this.residencyProfiles.get(key),
    );
    vfsState.bundleKey = key;
    vfsState.bundleSource = buildFacetVfsBundleSource(
      vfsState.bundle,
      vfsState.bundleSideModulesRequired,
    );
    vfsState.serializedManifest = JSON.stringify(vfsState.manifest);
    vfsState.serializedMetadata = JSON.stringify(vfsState.metadata);
    // The only consumer of the raw cells past this point is a single boolean,
    // so answer it now rather than hold ~17 MB (pi) to answer it later.
    vfsState.usesNodeSqlite = bundleUsesNodeSqlite(entryCode, vfsState.bundle);
    vfsState.cacheHit = false;

    // Serialization is total: bundleSource/serializedManifest/serializedMetadata
    // carry every byte the raw cells and objects do, and generateEntrypointCode
    // reads only the serialized forms. Retaining both doubled what an entry
    // costs for its whole lifetime — measured for pi at 502af77, per entry:
    // raw 17,253,610 + source 18,262,324 + manifest 600,060 + metadata
    // 3,841,244 = 39,957,238 B, of which the raw halves are 21,694,914 B held
    // to answer `usesNodeSqlite`. Dropping them is a pure release: nothing
    // downstream of this method reads them, and a cache MISS rebuilds from the
    // VFS rather than from anything discarded here.
    //
    // Released BEFORE admission so the byte bound prices what the entry costs
    // from here on, not the peak it passed through on the way in.
    releaseSerializedSources(vfsState);
    this._admitPrefetchCacheEntry(key, revision, vfsState);
    return vfsState;
  }

  /**
   * Admit an entry and evict, oldest first, until the LRU is inside BOTH its
   * entry count and its byte bound.
   *
   * The count alone bounded nothing — each entry holds a raw bundle plus its
   * serialized source, manifest and metadata, so sixteen of them could hold
   * several times the supervisor ceiling. That is the same defect that let
   * pi's 44 MB boot payload through: a thing sized by count when what matters
   * is bytes.
   */
  /**
   * File what a process could not read against the bundle that failed it.
   *
   * A miss the supervisor never hears about is a miss the next run repeats,
   * so this is the whole of the repair: record the path, then drop the cached
   * bundle for that key so the next build is a real one and stages it. The
   * program that hit the miss is already gone — nothing here rescues it, and
   * nothing here needs to, because the facet failed loudly on the way out.
   */
  private _recordResidencyMisses(key: string | undefined, misses: string[] | undefined): void {
    if (!key || !misses || misses.length === 0) return;
    let profile = this.residencyProfiles.get(key);
    if (profile) this.residencyProfiles.delete(key);
    else profile = new Set<string>();
    this.residencyProfiles.set(key, profile);

    let learned = 0;
    for (const path of misses) {
      if (profile.size >= FacetManager.RESIDENCY_PROFILE_MAX_PATHS) break;
      if (typeof path !== 'string' || path === '' || profile.has(path)) continue;
      profile.add(path);
      learned++;
    }
    for (const oldest of this.residencyProfiles.keys()) {
      if (this.residencyProfiles.size <= FacetManager.RESIDENCY_PROFILE_MAX_ENTRIES) break;
      this.residencyProfiles.delete(oldest);
    }
    if (learned === 0) return;

    const cached = this.prefetchBundleCache.get(key);
    if (!cached) return;
    this.prefetchBundleCache.delete(key);
    this.prefetchCacheBytes -= cached.bytes;
    setPrefetchCacheBytes(this.prefetchCacheBytes);
  }

  private _admitPrefetchCacheEntry(
    key: string,
    revision: number,
    vfsState: FacetVfsState,
  ): void {
    const previous = this.prefetchBundleCache.get(key);
    if (previous) this.prefetchCacheBytes -= previous.bytes;
    const bytes = retainedVfsStateBytes(vfsState);
    this.prefetchBundleCache.delete(key);
    this.prefetchBundleCache.set(key, { revision, vfsState, bytes });
    this.prefetchCacheBytes += bytes;
    for (const [oldest, entry] of this.prefetchBundleCache) {
      if (
        this.prefetchBundleCache.size <= FacetManager.PREFETCH_CACHE_MAX
        && this.prefetchCacheBytes <= PREFETCH_CACHE_MAX_BYTES
      ) break;
      // The entry just admitted is the one the caller is about to use; a
      // bundle bigger than the whole bound evicts everything else and stays.
      if (oldest === key) continue;
      this.prefetchBundleCache.delete(oldest);
      this.prefetchCacheBytes -= entry.bytes;
    }
    setPrefetchCacheBytes(this.prefetchCacheBytes);
  }

  /**
   * Build the Worker Loader module-map fragment that carries the sql.js
   * WebAssembly.Module into a facet, when that facet imports node:sqlite.
   * Returns `{}` for the common case (no sqlite) so the spread is free.
   * Delegates to the shared per-isolate memoizer in opencode-staging.ts.
   */
  private sqliteModuleEntry(
    usesSqlite: boolean,
  ): Promise<Record<string, { wasm: ArrayBuffer }>> {
    return sqliteWasmModuleEntry(this.env, usesSqlite);
  }

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

  private revokeProcessVfsWriters(pid: number): void {
    this.vfs?.revokeAppendWriters(pid);
  }

  /**
   * True while a resident facet holds this pid — it was adopted through the
   * bin-spawn contract and now owns the process lifecycle, reporting its own
   * exit. A caller that launched the command must not record an exit for it.
   */
  hasResidentProcess(pid: number): boolean {
    return this.processRpcResources.has(pid);
  }

  noteProcessReportedExit(pid: number, exitCode: number): void {
    this.portRegistry.unregisterByPid(pid);
    this.processes.exit(pid, exitCode);
    const tracked = this.processRpcResources.get(pid);
    if (tracked?.releaseOnReportExit) {
      this.releaseProcessRpcResources(pid);
      this.revokeProcessVfsWriters(pid);
    } else if (!tracked) {
      this.revokeProcessVfsWriters(pid);
    }
    this._teardownPairedServeFacet(pid);
  }

  /**
   * Tear down the serve facet a dual (`opencode`) spawn paired with this pid.
   * Called when the attach TUI exits (reported / killed) so the OS-child serve
   * facet never outlives its foreground process.
   */
  private _teardownPairedServeFacet(attachPid: number): void {
    const servePid = this._pairedServeFacet.get(attachPid);
    if (servePid === undefined) return;
    this._pairedServeFacet.delete(attachPid);
    try { this.kill(servePid); } catch {}
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
      try { this.esbuild = new EsbuildService(this.vfs); } catch { this.esbuild = null; }
    }
    const diagOn = isExecDiagEnabled();
    const __bundleStart = diagOn ? Date.now() : 0;
    const processVfs = this.vfs?.as(entry.cred);
    const credKey = `${entry.cred.uid}:${entry.cred.gid}:${entry.cred.groups.join(',')}`;
    const vfsState: FacetVfsState = processVfs
      ? await this._buildPrefetchBundleCached(
          processVfs,
          opts.filename,
          opts.cwd || '/home/user',
          code,
          credKey,
          opts.bundleProfile,
        )
      : { bundle: {}, manifest: {}, metadata: {}, reachableCount: 0, truncated: false };
    const bundleMs = diagOn ? Date.now() - __bundleStart : 0;
    const diagSink = diagOn ? { loadMs: 0, runMs: 0, moduleMapBytes: 0 } : undefined;

    const abortController = new AbortController();
    try {
      const result = await this._execWithTimeout(
        this._execViaLoader(code, opts, entry, vfsState, abortController.signal, diagSink),
        entry,
        () => abortController.abort(),
      );
      this._flushVfsWrites(result, entry.pid);
      this._recordResidencyMisses(vfsState.bundleKey, result.residencyMisses);
      this.processes.exit(entry.pid, result.exitCode);
      if (result.exitCode !== 0) {
        this._w5RecordTermination(
          entry.pid, result.exitCode, 'runtime-worker',
          result.stderr || `exit ${result.exitCode}`,
        );
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
          fsRpcReads: result.diag?.fsRpcReads ?? 0,
          cacheHit: vfsState.cacheHit ?? false,
          exitCode: result.exitCode,
          at: Date.now(),
        });
      }
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
    diagSink?: { loadMs: number; runMs: number; moduleMapBytes: number },
  ): Promise<FacetExecResult> {
    // Answered by _buildPrefetchBundleCached while the raw cells were still in
    // hand; re-deriving it here is what forced them to be retained.
    const usesSqlite = vfsState.usesNodeSqlite ?? bundleUsesNodeSqlite(code, vfsState.bundle);
    const [sqliteModules, shims] = await Promise.all([
      this.sqliteModuleEntry(usesSqlite),
      fetchNodeShimsCode(this.env),
    ]);
    const generatedWorker = generateEntrypointCode(code, vfsState, usesSqlite, shims);
    const workerCode = generatedWorker.code;

    // Pass SUPERVISOR binding for runtime-worker -> supervisor RPC.
    const ctxExports = getCtxExports();
    const writerId = crypto.randomUUID();
    let supervisorBinding: ReturnType<NonNullable<typeof ctxExports>['SupervisorRPC']> | undefined;
    let writerActivated = false;

    const body = JSON.stringify({
      argv: opts.argv || [],
      env: opts.env || {},
      cwd: opts.cwd || '/home/user',
      filename: opts.filename || '<eval>',
      dirname: opts.dirname || '/home/user',
      stdin: opts.stdin || '',
      captureOutput: !!opts.captureOutput,
      cred: { ...entry.cred, groups: [...entry.cred.groups] },
      // Absolute wall-clock instant the entry drain must stop at, derived
      // from the same FACET_TIMEOUT_MS the supervisor's kill timer uses. It
      // is stamped here rather than computed facet-side so the budget tracks
      // the real remaining lifetime; everything still to happen before the
      // facet runs (module map build, LOADER.load, the RPC hop) only makes
      // this earlier than the kill, which is the safe direction.
      entryDeadlineAt: Date.now() + FACET_TIMEOUT_MS - ONE_SHOT_EXIT_RESERVE_MS,
      vfsCursor: vfsState.cursor,
      ...(diagSink ? { diag: true } : {}),
    });

    if (diagSink) {
      diagSink.moduleMapBytes = new TextEncoder().encode(workerCode).length;
      for (const source of Object.values(generatedWorker.modules)) {
        diagSink.moduleMapBytes += new TextEncoder().encode(source).length;
      }
      for (const m of Object.values(sqliteModules)) {
        diagSink.moduleMapBytes += m.wasm.byteLength;
      }
    }

    let worker: LoadedWorkerStub | undefined;
    let entrypoint: LoadedWorkerEntrypointStub | undefined;
    try {
      if (ctxExports?.SupervisorRPC) {
        this._activateProcessVfsWriter(entry.pid, writerId);
        writerActivated = true;
        supervisorBinding = ctxExports.SupervisorRPC({
          props: {
            doId: this.ctx.id.toString(),
            pid: entry.pid,
            writerId,
          },
        });
      }
      const __loadStart = diagSink ? Date.now() : 0;
      worker = this.env.LOADER.load({
        compatibilityDate: CF_COMPAT_DATE,
        compatibilityFlags: ['nodejs_compat', 'nodejs_compat_v2'],
        mainModule: 'runner.js',
        modules: { 'runner.js': workerCode, ...generatedWorker.modules, ...sqliteModules },
        ...(supervisorBinding ? { env: { SUPERVISOR: supervisorBinding } } : {}),
      });

      entrypoint = worker.getEntrypoint();
      if (typeof entrypoint.fetch !== 'function') {
        throw new Error('Nimbus: one-shot runtime entrypoint has no fetch method');
      }
      if (diagSink) diagSink.loadMs = Date.now() - __loadStart;
      const __runStart = diagSink ? Date.now() : 0;
      const response = await entrypoint.fetch(new Request('http://nimbus-runtime.local/run', {
        method: 'POST',
        body,
        signal,
      }));
      try {
        const result = await response.json() as FacetExecResult;
        if (diagSink) diagSink.runMs = Date.now() - __runStart;
        return result;
      } finally {
        disposeRpcResource(response);
      }
    } finally {
      // A one-shot facet is unkeyed (LOADER.load) and cannot be re-resolved
      // into a later request's context, so it can never be a routeable target
      // (server scripts are promoted to the keyed long-running facet instead).
      // But its http shim still calls SUPERVISOR.registerPort on listen(); drop
      // any such reservation here so a dead facet leaves no stale null-stub port.
      this.portRegistry.unregisterByPid(entry.pid);
      disposeRpcResource(entrypoint);
      disposeRpcResource(worker);
      disposeRpcResource(supervisorBinding);
      if (writerActivated) this.vfs?.revokeAppendWriter(entry.pid, writerId);
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
  async execStagedArtifact(
    artifact: string,
    opts: Omit<OpencodeRunnerOptions, 'cred' | 'vfsBundle' | 'vfsManifest' | 'vfsMetadata' | 'shimsCode' | 'mode'> & { command?: string; attachedTty?: boolean },
  ): Promise<StagedArtifactExecResult> {
    const mode: OpencodeRunnerMode = opts.attachedTty === true ? 'attached' : 'oneshot';
    const staged = await this._stageOpencodeFacet(artifact, opts, mode);

    if (mode === 'attached') {
      return await this._execStagedArtifactAttached(staged.pid, staged.command, staged.stageSpec);
    }

    // One-shot: run through a keyed, stage-carrying NimbusLoadedEntrypoint —
    // the ~23 MB module map is assembled inside the stateless entrypoint on
    // the Worker-Loader cache-miss path (with SUPERVISOR bound to THIS call's
    // context, which stays open for the whole run), never in this DO.
    const writerId = crypto.randomUUID();
    const supervisor = { doId: this.ctx.id.toString(), pid: staged.pid, writerId };
    const ctxExports = getNimbusCtxExports();
    let entrypoint: LoadedWorkerEntrypointStub | undefined;
    let writerActivated = false;
    try {
      this._activateProcessVfsWriter(staged.pid, writerId);
      writerActivated = true;
      entrypoint = await createLoadedWorkerEntrypoint(ctxExports, supervisor, staged.stageSpec);
      if (typeof entrypoint.fetch !== 'function') {
        throw new Error('Nimbus: opencode runner entrypoint has no fetch method');
      }
      const response = await entrypoint.fetch(
        new Request('http://nimbus-runtime.local/run', { method: 'POST' }),
      );
      try {
        const result = await response.json() as FacetExecResult;
        this._flushVfsWrites(result, staged.pid);
        this.processes.exit(staged.pid, result.exitCode);
        return { ...result, pid: staged.pid };
      } finally {
        disposeRpcResource(response);
      }
    } catch (e) {
      this.processes.exit(staged.pid, 1);
      throw e;
    } finally {
      disposeRpcResource(entrypoint);
      if (writerActivated) this.vfs?.revokeAppendWriter(staged.pid, writerId);
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
  private async _stageOpencodeFacet(
    artifact: string,
    opts: { argv: string[]; env: Record<string, string>; cwd: string; stdin?: string; command?: string },
    mode: OpencodeRunnerMode,
  ): Promise<{ pid: number; command: string; stageSpec: OpencodeStageSpec }> {
    if (artifact !== 'opencode') {
      throw new Error(`Nimbus: unknown staged artifact '${artifact}'`);
    }
    if (!this.env.ASSETS) {
      throw new Error(
        'staged opencode artifact requires an env.ASSETS binding; this Nimbus ' +
          'deployment is missing the static-assets binding',
      );
    }

    const command = opts.command || `opencode ${opts.argv.join(' ')}`.trim();
    const attached = mode === 'attached';
    const entry = this.processes.spawn(command, ['opencode', ...opts.argv], opts.cwd);
    const pid = entry.pid;
    // attached TUI + headless serve are resident long-running processes; only the
    // attached TUI grabs the terminal (raw-mode stdin + live geometry).
    if (mode !== 'oneshot') this.processes.setLongRunning(pid);
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
    const vfsState: FacetVfsState = processVfs
      ? await buildPrefetchBundle(processVfs, undefined, opts.cwd, '', this.esbuild || undefined)
      : { bundle: {}, manifest: {}, metadata: {}, reachableCount: 0, truncated: false };

    const vfsBundle = _serializeBundleForFacet(vfsState.bundle);
    assertStagedBundleFitsRpcPayload(vfsBundle, vfsState.bundle);

    const stageSpec: OpencodeStageSpec = {
      mode,
      argv: opts.argv,
      env: runnerEnv,
      cred: { ...entry.cred, groups: [...entry.cred.groups] },
      cwd: opts.cwd,
      stdin: opts.stdin ?? '',
      vfsBundle,
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
  private async _execStagedArtifactAttached(
    pid: number,
    command: string,
    stageSpec: OpencodeStageSpec,
  ): Promise<StagedArtifactExecResult> {
    let handle: ResidentProcessHandle | undefined;
    try {
      // The opencode runner holds its startProcess open for the process's
      // whole life, so that one call IS the lifecycle.
      const workerKey = `nimbus-process:${this.ctx.id.toString()}:${pid}`;
      handle = await this.processFabric.startResidentProcess({
        startContract: 'lifetime',
        pid,
        workerKey,
        boot: { kind: 'staged', stage: stageSpec },
        onWriterActivated: (writerId) => {
          this._activateProcessVfsWriter(pid, writerId);
        },
        onWriterRetired: (writerId) => {
          this.vfs?.revokeAppendWriter(pid, writerId);
        },
      });
      this._noteProcessPlacement(pid, handle);
      this.trackProcessRpcResources(
        pid,
        [handle],
        { releaseOnReportExit: false },
      );
      this.ctx.waitUntil(
        handle.done
          .catch((e: unknown) => {
            // A pid that is already terminal (killed by session teardown, or
            // exited via its own reportExit) rejects the held-open call as a
            // teardown ECHO — recording it again would double-count the
            // termination with a misleading code-1 entry.
            const entry = this.processes.get(pid);
            if (!entry || entry.state !== 'running') return;
            const reason = 'opencode TUI process failed: ' + errorMessage(e);
            try { this.processes.exit(pid, 1); } catch {}
            try { this._w5RecordTermination(pid, 1, 'facet', reason); } catch {}
            try { this.hooks.onExternalExit?.(pid, 1, reason); } catch {}
          })
          .finally(() => {
            this.releaseProcessRpcResources(pid);
          }),
      );
      return { pid, exitCode: 0, stdout: '', stderr: '', vfsWrites: {} };
    } catch (e) {
      this.releaseProcessRpcResources(pid);
      handle?.kill();
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
  async execStagedArtifactServer(
    artifact: string,
    opts: { argv: string[]; env: Record<string, string>; cwd: string; command?: string; port?: number },
  ): Promise<StagedArtifactExecResult> {
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
  async execStagedArtifactDual(
    artifact: string,
    opts: { argv: string[]; env: Record<string, string>; cwd: string; command?: string },
  ): Promise<StagedArtifactExecResult> {
    const port = this._allocateLoopbackPort();
    // (a) resident serve facet on the allocated loopback port.
    const serveStaged = await this._stageOpencodeFacet(
      artifact,
      {
        argv: ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'],
        env: opts.env,
        cwd: opts.cwd,
        command: `opencode serve --port ${port}`,
      },
      'server',
    );
    const servePid = serveStaged.pid;
    try {
      await this._runOpencodeServerFacet(serveStaged, port);
      // (b) health-gate: wait for the server to answer /doc through the loopback
      // router (fail loud with the server's log tail on timeout / early exit).
      await this._awaitOpencodeServerReady(servePid, port);
    } catch (e) {
      try { this.kill(servePid); } catch {}
      throw e;
    }

    // (c) attach the interactive TUI to the ready server on the user's terminal.
    let attach: StagedArtifactExecResult;
    try {
      attach = await this.execStagedArtifact(artifact, {
        argv: ['attach', `http://127.0.0.1:${port}`],
        env: opts.env,
        cwd: opts.cwd,
        stdin: '',
        command: opts.command || 'opencode',
        attachedTty: true,
      });
    } catch (e) {
      try { this.kill(servePid); } catch {}
      throw e;
    }

    // Tie their lifecycles: when the attach TUI exits (reported / killed), tear
    // down the serve facet too.
    this._pairedServeFacet.set(attach.pid, servePid);
    return attach;
  }

  private async _runOpencodeServerFacet(
    staged: { pid: number; command: string; stageSpec: OpencodeStageSpec },
    port: number,
  ): Promise<StagedArtifactExecResult> {
    const { pid, stageSpec } = staged;
    let handle: ResidentProcessHandle | undefined;
    let resourcesTracked = false;
    try {
      const workerKey = `nimbus-process:${this.ctx.id.toString()}:${pid}`;
      // The module map is assembled on the Worker-Loader cache-miss path, so
      // the artifact sources exist only while this facet is loading.
      handle = await this.processFabric.startResidentProcess({
        startContract: 'lifetime',
        pid,
        workerKey,
        boot: { kind: 'staged', stage: stageSpec },
        onWriterActivated: (writerId) => {
          this._activateProcessVfsWriter(pid, writerId);
        },
        onWriterRetired: (writerId) => {
          this.vfs?.revokeAppendWriter(pid, writerId);
        },
      });
      this._noteProcessPlacement(pid, handle);
      // The handle's route target resolves the RUNNING facet wherever it is
      // hosted; binding it for the pid before the port is announced is what
      // lets the shim's listen()→SUPERVISOR.registerPort back-fill.
      this.portRegistry.bindFacetStub(pid, handle.routeTarget);
      this.trackProcessRpcResources(pid, [handle], { releaseOnReportExit: false });
      resourcesTracked = true;
      this.ctx.waitUntil(
        handle.done
          .catch((e: unknown) => {
            const current = this.processes.get(pid);
            if (!current || current.state !== 'running') return;
            const reason = 'opencode serve process failed: ' + errorMessage(e);
            try { this.processes.exit(pid, 1); } catch {}
            try { this._w5RecordTermination(pid, 1, 'facet', reason); } catch {}
            try { this.hooks.onExternalExit?.(pid, 1, reason); } catch {}
          })
          .finally(() => {
            this.releaseProcessRpcResources(pid);
          }),
      );
      this.portRegistry.register(port, pid);
      return { pid, exitCode: 0, stdout: '', stderr: '', vfsWrites: {} };
    } catch (e) {
      this.portRegistry.unregisterByPid(pid);
      if (resourcesTracked) this.releaseProcessRpcResources(pid);
      else handle?.kill();
      this.processes.exit(pid, 1);
      const reason = 'opencode serve boot failed: ' + errorMessage(e);
      this._w5RecordTermination(pid, 1, 'facet', reason);
      try { this.hooks.onExternalExit?.(pid, 1, reason); } catch {}
      throw e;
    }
  }

  /**
   * NIMBUS_DEBUG live evidence (log-tail channel) of where a resident process
   * was scheduled. The manager logs an opaque description; only the fabric
   * knows what a placement is.
   */
  private _noteProcessPlacement(pid: number, handle: ResidentProcessHandle): void {
    if (!this.debugEnabled) return;
    try {
      this.processes.appendOutput(pid, 'stderr', `[nimbus-debug] process hosted on ${handle.describePlacement()}\n`);
    } catch { /* best-effort */ }
  }

  /**
   * The reader the fabric completes a boot spec's by-path members with.
   *
   * Reads as CRED_KERNEL because that is who WROTE them: the generated images
   * are kernel-owned (`_materializeFacetImages`) and the runtime wasm images
   * are installed by the kernel. Uncached because these are the session's
   * largest files — a ruby interpreter image is 34.3 MiB — and pinning one in
   * the VFS content LRU for the life of the session is what once crashed the
   * supervisor.
   */
  private _residentDisk(): ResidentDiskReader {
    const vfs = this.vfs;
    if (!vfs) {
      throw new Error('Nimbus: a resident process needs a session filesystem to boot');
    }
    const fs = vfs.as(CRED_KERNEL);
    return { readFile: (path) => fs.readFileUncached(path) };
  }

  /**
   * Materialize generated module sources in the content-addressed image store
   * and return the `vfsTextModules` map naming them.
   *
   * A resident process's module map is sized by the user's disk, so it does
   * not ride inside the boot spec — see ResidentCodeSpec.vfsTextModules.
   * Writing it here, once, is what lets the session stop holding it: after
   * this returns, the only thing it keeps is a path.
   *
   * The store is written by the kernel and read by the process, so nothing
   * here depends on which credential spawned what. Digest collisions are the
   * hash's problem; everything else is idempotent — an image already present
   * at its own digest is already the bytes we were about to write.
   */
  private async _materializeFacetImages(
    pid: number,
    modules: Record<string, string>,
  ): Promise<Record<string, string>> {
    const vfs = this.vfs;
    if (!vfs) {
      throw new Error(
        'Nimbus: a resident process needs a session filesystem to materialize its boot image',
      );
    }
    const fs = vfs.as(CRED_KERNEL);
    const images: Record<string, string> = {};
    const sources = new Map<string, string>();
    for (const [moduleName, source] of Object.entries(modules)) {
      const path = facetImagePath(await facetImageDigest(source));
      images[moduleName] = path;
      sources.set(path, source);
    }
    // Everything below runs without awaiting, so this process joins the
    // sweep's root set before a concurrent spawn can sweep what it just wrote.
    this.residentImages.set(pid, [...sources.keys()]);
    fs.mkdir(FACET_IMAGE_DIR, { recursive: true, mode: 0o755 });
    for (const [path, source] of sources) {
      const stored = path.replace(/^\/+/, '');
      const bytes = new TextEncoder().encode(source);
      // A whole-file write is atomic against the DO's single thread, so an
      // image already present at the right size cannot be a torn one, and
      // rewriting it would only cost the disk. Size is enough of a check here
      // because the reader verifies the digest before the loader sees it.
      if (fs.exists(stored) && fs.lstat(stored).size === bytes.byteLength) continue;
      fs.writeFile(stored, bytes, { mode: 0o644 });
    }
    this._sweepFacetImages(fs);
    return images;
  }

  /**
   * Drop every image no running process boots from.
   *
   * Content addressing means a changed program writes a NEW image rather than
   * replacing one, so a watch loop — or simply a session that runs a few
   * different programs — would otherwise leave one bundle-sized file behind
   * per distinct version. The root set is the process table, which is exact:
   * an image is live for precisely as long as the process that boots from it.
   * Nothing is left for a TTL or an eviction heuristic to guess at, and after
   * a DO reset the table is empty so every orphan goes.
   */
  private _sweepFacetImages(fs: CredentialedVfs): void {
    const live = new Set<string>();
    for (const [pid, paths] of this.residentImages) {
      if (this.processes.get(pid)?.state === 'running') {
        for (const path of paths) live.add(path);
      } else {
        this.residentImages.delete(pid);
      }
    }
    let entries: { name: string }[];
    try { entries = fs.readdir(FACET_IMAGE_DIR); } catch { return; }
    for (const entry of entries) {
      if (live.has(`/${FACET_IMAGE_DIR}/${entry.name}`)) continue;
      try { fs.unlink(`${FACET_IMAGE_DIR}/${entry.name}`); } catch { /* already gone */ }
    }
  }

  /**
   * The one way this manager boots a resident process. Every resident process
   * is a facet of this session; there is nothing to place and nothing here
   * decides anything about where a program runs.
   */
  private async _startResidentProcess(
    pid: number,
    spec: {
      startContract: StartContract;
      boot: ResidentBootSpec;
      startArgs?: unknown;
    },
  ): Promise<ResidentProcessHandle> {
    const handle = await this.processFabric.startResidentProcess({
      pid,
      workerKey: `nimbus-process:${this.ctx.id.toString()}:${pid}`,
      onWriterActivated: (writerId) => {
        this._activateProcessVfsWriter(pid, writerId);
      },
      onWriterRetired: (writerId) => {
        this.vfs?.revokeAppendWriter(pid, writerId);
      },
      ...spec,
    });
    this._noteProcessPlacement(pid, handle);
    return handle;
  }

  private _activateProcessVfsWriter(pid: number, writerId: string): void {
    const entry = this.processes.get(pid);
    if (!entry || entry.state !== 'running') {
      throw new Error(`Nimbus: cannot activate append writer for non-running process ${pid}`);
    }
    // ProcessTable PIDs are monotonic within a generation and generation-strided
    // across resets, so this live entry is the sole positive authority root.
    this.vfs?.activateAppendWriter(pid, writerId);
  }

  /** Allocate a free loopback port for a resident server facet (from 4096 up). */
  private _allocateLoopbackPort(): number {
    for (let port = 4096; port < 4096 + 4096; port++) {
      if (!this.portRegistry.has(port)) return port;
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
  private async _awaitOpencodeServerReady(
    pid: number,
    port: number,
    timeoutMs = 30000,
    pollTimeoutMs = 2000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastPoll = 'no poll completed';
    while (Date.now() < deadline) {
      const proc = this.processes.get(pid);
      if (!proc || proc.state !== 'running') {
        throw new Error(
          `opencode serve (pid ${pid}) exited before becoming ready on port ${port}\n` +
            this._processLogTail(pid),
        );
      }
      if (this.portRegistry.has(port)) {
        // Cap each poll at pollTimeoutMs and abandon it on overrun: a request
        // that reaches the facet mid-boot can hang until the dispatcher's 30s
        // header timeout (live-measured 2026-07-16), and awaiting it unbounded
        // starves the loop — one wedged poll must not consume the readiness
        // budget while the server comes up behind it.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const pollPromise = this.portRegistry
          .routeRequest(port, new Request(`http://127.0.0.1:${port}/doc`), '/doc')
          .catch((e: unknown) => { lastPoll = 'error: ' + errorMessage(e); return null; });
        const res = await Promise.race([
          pollPromise,
          new Promise<null>((r) => { timer = setTimeout(() => r(null), pollTimeoutMs); }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        // The gate only needs the status; cancel the (streamed) body so the
        // relay pipe and its facet-side resources release — including polls
        // this race abandoned that resolve later.
        const discardBody = (r: Response | null) => { if (r) r.body?.cancel().catch(() => {}); };
        if (res) {
          discardBody(res);
          if (res.status === 200) {
            await this._warmOpencodeServer(port);
            return;
          }
          lastPoll = `status ${res.status}`;
        } else {
          void pollPromise.then(discardBody);
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      `opencode serve (pid ${pid}) did not become ready on port ${port} within ` +
        `${timeoutMs}ms (last poll: ${lastPoll})\n${this._processLogTail(pid)}`,
    );
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
  private async _warmOpencodeServer(port: number, perRequestTimeoutMs = 25000): Promise<void> {
    for (const path of ['/config/providers', '/agent']) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // ONE deadline bounds the whole leg — headers AND body drain. An
        // unbounded drain here wedged the dual spawn when a cold providers
        // body finished slowly.
        const responseRef: { current: Response | null } = { current: null };
        const leg = this.portRegistry
          .routeRequest(port, new Request(`http://127.0.0.1:${port}${path}`), path)
          .then(async (r) => {
            responseRef.current = r;
            if (r) await r.text();
          })
          .catch(() => {});
        await Promise.race([
          leg,
          new Promise<void>((r) => { timer = setTimeout(() => r(), perRequestTimeoutMs); }),
        ]);
        responseRef.current?.body?.cancel().catch(() => {});
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }

  /** Recent stderr/stdout tail for a pid, for fail-loud diagnostics. */
  private _processLogTail(pid: number, lines = 40): string {
    try {
      const chunks = this.processes.tailLogs(pid, { lines });
      const text = chunks.map((c) => c.data).join('');
      return text ? `--- ${chunks.length ? 'log tail' : ''} ---\n${text}` : '(no output captured)';
    } catch {
      return '(no output captured)';
    }
  }

  /** Flush files written by the script back to the supervisor's VFS. */
  private _flushVfsWrites(result: FacetExecResult, pid: number) {
    if (!this.vfs || !result.vfsWrites) return;
    const vfs = this.vfs.as(this.processes.cred(pid));
    for (const [path, content] of Object.entries(result.vfsWrites)) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (dir && !vfs.exists(dir)) vfs.mkdir(dir, { recursive: true });
      }
      // No-supervisor fallback: these are full sync-write cells, not failed
      // append residues. A write-back error is the command's error and must
      // propagate before a successful process exit is recorded.
      const restored = _reviveVfsWriteCell(content);
      vfs.writeFile(path, restored);
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
   * Spawn a long-running Node process with the same shimmed require/fs/http
   * environment used by foreground `node <script>` execution.
   *
   * A resident primitive: the process outlives the call, may bind a port, and
   * accumulates memory for as long as it runs.
   *
   * Its module map — the snapshot of the user's disk the facet is built from —
   * is the largest thing Nimbus generates, so it travels by VFS path rather
   * than inside the boot spec and is read only when the facet loads.
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
  ): Promise<{ pid: number }> {
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
      try { this.esbuild = new EsbuildService(this.vfs); } catch { this.esbuild = null; }
    }
    const processVfs = this.vfs?.as(entry.cred);
    const vfsState: FacetVfsState = processVfs
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
    const generatedWorker = generateLongRunningNodeCode(
      code,
      vfsState,
      { ...opts, env: processEnv, cred: entry.cred },
      usesSqlite,
      shims,
    );
    const workerCode = generatedWorker.code;

    let handle: ResidentProcessHandle | undefined;
    let resourcesTracked = false;

    try {
      handle = await this._startResidentProcess(entry.pid, {
        // The attached-TTY runner holds startProcess open for the process's
        // life; the server/watch runner returns once it is up.
        startContract: opts.attachedTty ? 'lifetime' : 'boot',
        boot: {
          kind: 'code',
          code: {
            compatibilityDate: CF_COMPAT_DATE,
            compatibilityFlags: ['nodejs_compat', 'nodejs_compat_v2'],
            mainModule: 'worker.js',
            // Only the sqlite sidecar rides by value: it is a fixed-size
            // asset of the worker's own, not of the user's disk.
            modules: sqliteModules,
            vfsTextModules: await this._materializeFacetImages(entry.pid, {
              'worker.js': workerCode,
              ...generatedWorker.modules,
            }),
          },
        },
      });
      this.trackProcessRpcResources(
        entry.pid,
        [handle],
        { releaseOnReportExit: !opts.attachedTty },
      );
      resourcesTracked = true;
      this.portRegistry.bindFacetStub(entry.pid, handle.routeTarget);

      if (opts.attachedTty) {
        this.ctx.waitUntil(
          handle.done
            .catch((e: unknown) => {
              // Teardown echo guard (same as the staged-artifact path): a pid
              // that is already terminal rejects the held-open call as an
              // ECHO of its own kill — don't double-record it as a code-1
              // failure.
              const current = this.processes.get(entry.pid);
              if (!current || current.state !== 'running') return;
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
        await handle.booted();
      }

      if (opts.port && opts.port > 0 && opts.port < 65536) {
        this.portRegistry.register(opts.port, entry.pid);
      }
      return { pid: entry.pid };
    } catch (e: unknown) {
      this.portRegistry.unregisterByPid(entry.pid);
      if (resourcesTracked) this.releaseProcessRpcResources(entry.pid);
      else handle?.kill();
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
   * Spawn a long-running dynamic Worker, boot it, and return its boot payload.
   *
   * The shared primitive for any runtime that serves over
   * handleHttpRequest(Request) — the python and ruby socket servers today.
   *
   * The interpreter image it carries is the memory that should not sit in the
   * session's own isolate — ruby's interpreter+stdlib alone is 34.3 MiB — and
   * a facet's envelope is independent of the session's, so it does not. It has
   * no readiness coupling back into the session: the runner answers
   * startProcess with its boot payload and the caller waits on that one
   * promise, so nothing polls the port to decide the process is up.
   */
  async spawnWorker(
    workerCode: string,
    command: string,
    cwd: string,
    opts: LongRunningWorkerSpawnOptions = {},
  ): Promise<{ pid: number; boot: unknown }> {
    this.processes.reap();
    const entry = this.processes.spawn(command, [], cwd);
    // Stamp the process-table entry so /api/processes exposes this as a
    // long-running process.
    this.processes.setLongRunning(entry.pid);
    // Resident facets always get a spawn notification — they're visible and
    // users want the PID for later `logs`/`kill`.
    try { this.hooks.onSpawn?.(entry.pid, command, true); } catch {}

    let handle: ResidentProcessHandle | undefined;
    let resourcesTracked = false;
    try {
      handle = await this._startResidentProcess(entry.pid, {
        // These runners answer startProcess with a boot payload (listening
        // port, or a completed non-server run) and stay resident after it.
        startContract: 'boot',
        startArgs: opts.startArgs,
        boot: {
          kind: 'code',
          code: {
            compatibilityDate: CF_COMPAT_DATE,
            compatibilityFlags: opts.compatibilityFlags || ['nodejs_compat'],
            mainModule: 'worker.js',
            modules: { 'worker.js': workerCode, ...(opts.modules || {}) },
            vfsWasmModules: opts.vfsWasmModules,
          },
        },
      });
      this.trackProcessRpcResources(entry.pid, [handle]);
      resourcesTracked = true;
      this.portRegistry.bindFacetStub(entry.pid, handle.routeTarget);
      if (opts.port && opts.port > 0 && opts.port < 65536) {
        this.portRegistry.register(opts.port, entry.pid);
      }
      return { pid: entry.pid, boot: await handle.booted() };
    } catch (e: unknown) {
      this.portRegistry.unregisterByPid(entry.pid);
      if (resourcesTracked) this.releaseProcessRpcResources(entry.pid);
      else handle?.kill();
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

  registerPort(pid: number, port: number): void {
    if (port > 0 && port < 65536) {
      this.portRegistry.register(port, pid);
    }
  }

  waitForRouteablePorts(
    pid: number,
    timeoutMs = ROUTEABLE_PORT_ATTACH_TIMEOUT_MS,
  ): Promise<number[]> {
    return this.portRegistry.waitForRouteablePortsByPid(pid, timeoutMs);
  }

  finishProcess(pid: number, exitCode: number, reason = 'exited'): void {
    this.portRegistry.unregisterByPid(pid);
    this.processes.exit(pid, exitCode);
    this.releaseProcessRpcResources(pid);
    this.revokeProcessVfsWriters(pid);
    this._teardownPairedServeFacet(pid);
    if (exitCode !== 0) {
      this._w5RecordTermination(pid, exitCode, 'facet', reason);
      try { this.hooks.onExternalExit?.(pid, exitCode, reason); } catch {}
    }
  }

  /** Kill a running process by PID. */
  kill(pid: number): boolean {
    const entry = this.processes.get(pid);
    if (!entry || entry.state !== 'running') return false;
    this.portRegistry.unregisterByPid(pid);
    this.releaseProcessRpcResources(pid);
    this.revokeProcessVfsWriters(pid);
    const result = this.processes.kill(pid);
    if (result) {
      try { this.hooks.onExternalExit?.(pid, 137, 'killed'); } catch {}
    }
    this._teardownPairedServeFacet(pid);
    return result;
  }

  get stats() { return this.processes.stats; }
}
