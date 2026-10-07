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
import { ISOLATE_NETWORK } from '@nimbus-sh/core/_shared/workspace-network.js';
import { COMMONJS_CELL_IMPORTS, COMMONJS_CELL_RUNTIME_SOURCE, commonJsCellModuleName, commonJsCellReadsBack, commonJsEntryModuleName, declaresWrapperBinding, RUNTIME_INTERPRETER_MODULE, RUNTIME_INTERPRETER_OPS_MODULE, RUNTIME_INTERPRETER_PRIMORDIALS_MODULE, runtimeCodeModuleName, runtimeExpressionModule, runtimeFunctionModule, wrapCommonJsCell, } from '@nimbus-sh/core/_shared/commonjs-cell.js';
import { ReadAheadBudget, STDIN_SYNC_READ_BYTES } from '@nimbus-sh/core/runtime/stdin-read.js';
import { execIdField } from '@nimbus-sh/core/runtime/process-table.js';
import { exitCodeForSignal } from '@nimbus-sh/core/substrate/lifo/shell/signals.js';
import { fetchNodeFacetSources } from '../runtime/node-shims-artifact.js';
import { generateSqliteFacetPreamble } from '../runtime/sqlite-shim.js';
import { getRealNodeImportsCode } from '@nimbus-sh/core/_shared/real-node-imports.js';
import { VFS_CURSOR_SEED_SOURCE, serializeFacetVfsCursor, } from '@nimbus-sh/core/_shared/facet-vfs-cursor.js';
import { normalizeVfsPath, stripLeadingSlashes, vfsPathExtension } from '@nimbus-sh/core/vfs/path.js';
import { direntTypeOf } from '@nimbus-sh/core/vfs/dirent-type.js';
import { clearPortCapability, listPortReservations, readPortReservation, readPortReservationByOwner, releasePortReservation, restoreReservedPortCapability, } from '../session/port-capability.js';
import { deriveResidentOwner } from './resident-identity.js';
import { z } from 'zod/v4';
import { RESIDENT_OWNER_KEY_PREFIX, DURABLE_IMAGES_KEY_PREFIX } from '../session/keys.js';
import { PORT_CAPABILITY_KEY_PREFIX } from '../session/keys.js';
import { sessionIdentity, unbindPublicPortCapability } from '../router/public-directory.js';
import { prefetchForRequire, requireFsOverBridge, resolveDeferredImport, ClosureBoundExceededError, } from '@nimbus-sh/core/runtime/require-resolver.js';
import { findStaticFsReferences } from '@nimbus-sh/core/runtime/static-fs-refs.js';
import { packageScopeType } from '@nimbus-sh/core/runtime/require-resolution.js';
import { linkTargetOf, packageRootOf, planFacetData } from './data-plan.js';
import { principalTag, profilePrincipal, ReadProfile, verifiedEvidence, } from './read-profile.js';
/** What the shared read profile may add to one launch: an eighth of its module map's bytes. */
const READ_PROFILE_LAUNCH_BYTES = Math.floor(VFS_BUNDLE_MAX_BYTES / 8);
import { NpmCache } from '../npm/cache.js';
import { mayHaveDynamicImport } from '@nimbus-sh/core/runtime/dynamic-import-rewrite.js';
import { recordFailure, getLastRpcFrame, getLastFacetId } from '@nimbus-sh/platform/oom-discriminator.js';
import { utf8Length } from '@nimbus-sh/platform/utf8.js';
import { classifyError } from '@nimbus-sh/platform/oom-classify.js';
import { TurnBudget, PacedWork, turnChunkMaxBytes, withResolvers } from '@nimbus-sh/fabric/turn-budget.js';
import { onColdStart } from '@nimbus-sh/fabric/generation.js';
import { isDynamicWorkerDeadlock, suspendLaunchAdmission } from '@nimbus-sh/fabric/budgets.js';
import { FencedWork, FENCED_WORK_KEY_PREFIX, } from '@nimbus-sh/fabric/fenced-work.js';
import { rewriteProvidedCommonJsModules } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { bundleTypescriptLoader, esbuildDiagnosticShim, isBundleModuleCandidate, isTypescriptDeclarationFile, looksLikeEsm, needsBundleCellTransform, transformBundleCells, transformEntryScript, } from '@nimbus-sh/core/runtime/bundle-cell-transform.js';
import { TransformStore } from './transform-store.js';
import { DEFAULT_CJS_CONDITIONS, DEFAULT_ESM_CONDITIONS, resolvePackageEntry, parseResolvablePackageJson, } from '@nimbus-sh/core/_shared/exports-resolver.js';
import { isExecDiagEnabled, recordExecTelemetry } from './exec-telemetry.js';
import { LaunchLearningStore } from './launch-learning-store.js';
import { disposeRpcResource, disposeRpcResources } from '@nimbus-sh/platform/rpc-dispose.js';
import { SUPERVISOR_ANSWERING_SRC } from '@nimbus-sh/core/runtime/supervisor-answering.generated.js';
import { STOP_REPLAY_SOURCE } from '../runtime/stop-replay.js';
import { encodeBase64, OwnedPieces, ReplayOutputGate, StdinTaken, stopRecordOf } from '../runtime/stop-replay-host.js';
import { answerDigest, ReplayJournal } from '../runtime/stop-replay-journal.js';
import { REPLAY_FETCH_MAX_BYTES, REPLAY_PREFIX_MAX_BYTES, REPLAY_JOURNAL_MAX_ENTRIES, REPLAY_READ_RECEIPT_MAX_BYTES, STOP_LIMIT } from '../runtime/stop-replay-contracts.js';
import { openSupervisorDeliveries } from '@nimbus-sh/core/workspace/supervisor-delivery.js';
import { sqliteWasmModuleEntry } from './opencode-staging.js';
import { FACET_IMAGE_WRITE_SLICE_BYTES, ImageStore, } from '@nimbus-sh/fabric/image-store.js';
import { fetchStagedBindingAsset, NAPI_WASM_LOADER, NAPI_WASM_TRAMPOLINE, STAGED_BINDING_LOADER_MODULE, STAGED_BINDING_TRAMPOLINE_MODULE, stagedBinding, stagedBindingsFacetImport, stagedBindingsRequiredBy, } from '../runtime/staged-bindings.js';
import { encodeCommonJsPack, ProcessFabric, } from '@nimbus-sh/fabric/process-fabric.js';
import { createLoadedWorkerEntrypoint, getNimbusCtxExports, deleteFacetStorage, } from '@nimbus-sh/fabric/workerd-facet-host.js';
import { acquireDurableFacetSlot, freeDurableFacetSlot, } from './durable-slots.js';
import { persistDurableWorkerImage, purgeDurableWorkerImages, } from './durable-images.js';
import { SQLITE_WASM_MODULE_NAME, } from '../runtime/opencode-facet-runner.js';
import { parsePortFromArgv, resolveLongRunningPort } from '@nimbus-sh/core/runtime/long-running-handle.js';
import { DEFAULT_FACET_BUNDLE_PROFILE, } from '@nimbus-sh/core/runtime/bundle-profile.js';
import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS, VFS_BUNDLE_MAX_FILES, VFS_BUNDLE_MAX_BYTES, CWD_SNAPSHOT_MAX_FILE_BYTES, BUNDLE_MAX_ENCODED_BYTES, PREFETCH_CACHE_MAX_BYTES, FS_LIST_PAGE_LIMIT, } from '@nimbus-sh/core/constants.js';
import { LEDGER_ROW_BYTES } from '@nimbus-sh/core/runtime/storage-ledger.js';
import { ONE_SHOT_STORE_MEMORY_BYTES, RESIDENT_CHUNK_BYTES } from '../vfs/facet-resident-limits.js';
import { MAX_RPC_SAFE_PAYLOAD_BYTES } from '@nimbus-sh/platform/limits.js';
import { CRED_KERNEL, isNativeBinPath, launchNamedPaths } from '@nimbus-sh/core/runtime/os-contracts.js';
import { acquireSupervisorAllocation } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import { supervisorBindingProps } from '@nimbus-sh/fabric/supervisor-props.js';
import { streamedWasmImageDigest, wasmImageDigest } from './wasm-image-digest.js';
import { prefetchBundleStart, prefetchBundleEnd, setPrefetchCacheBytes, } from '@nimbus-sh/platform/diag-counters.js';
const launchAdapters = new WeakMap();
/** The exact type of `entry` in `dir` on a launch's fs, lstat'ing it where its listing could not type it. */
function launchEntryType(vfs, dir, entry) {
    return direntTypeOf(entry, () => vfs.stat(`${dir}/${entry.name}`, { followSymlinks: false }));
}
function filesOf(fs) {
    let files = launchAdapters.get(fs);
    if (files === undefined) {
        files = requireFsOverBridge(fs);
        launchAdapters.set(fs, files);
    }
    return files;
}
/**
 * What a launch names, which is where its process's listing walks the
 * mounts beyond SQLite (NimbusFilesystemAuthority.nameLaunch): its working
 * directory, its program and that program's directory, its arguments, the
 * files its module map holds, and the paths its code names statically.
 */
function* launchNames(cwd, program, argv, modules, refs) {
    const script = program !== undefined && program.startsWith('/') ? program : null;
    yield cwd;
    if (script !== null)
        yield script.slice(0, script.lastIndexOf('/')) || '/';
    yield* launchNamedPaths(cwd, script, argv);
    for (const path of modules)
        yield path;
    for (const found of refs) {
        for (const ref of found.exact)
            yield ref.path;
        for (const ref of found.cwdRelative)
            yield `${cwd}/${ref.path}`;
        yield* found.listed;
        for (const pattern of found.patterns)
            yield pattern.dir;
    }
}
// A piped stdin's largest single write to the process input channel, a
// quarter of that queue's bound (core/runtime/process-input.ts).
const STDIN_PIPE_PIECE_BYTES = 64 * 1024;
/** A run after a stop would load another module map than the run before it. */
class ReplayCodeChanged extends Error {
    constructor() {
        super('its code, or a file it holds in its module map, changed while it waited');
    }
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
    const chunkBytes = ((typeof env === 'object' || typeof env === 'function') && env !== null)
        ? Reflect.get(env, 'NIMBUS_LAUNCH_CHUNK_BYTES')
        : undefined;
    return {
        LOADER: loader,
        ASSETS: assets,
        NIMBUS_LAUNCH_CHUNK_BYTES: typeof chunkBytes === 'string' ? chunkBytes : undefined,
        rawEnv: env,
    };
}
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
 * that — such a program's drain used to end early and it was
 * reported as having not finished. A user-invoked program runs this loop
 * with NO deadline — Node itself has no wall-clock kill; the only endings
 * are the program's exit and a signal. Callers that still pass a finite
 * deadline (the resident boot settle) arm the expiry timer.
 *
 * Four kinds of handle, each owned by the shim that creates them:
 *
 *   - macrotask TIMERS and intervals (`__nimbusPendingTimers`), from the
 *     timer tracker below.
 *   - ASYNC OPERATIONS in flight (`__nimbusPendingOps`): a fetch, a response
 *     body read, an fs/child_process RPC. `await` resolves through
 *     PerformPromiseThen and surfaces nowhere else, so this counter is how
 *     awaited work is seen at all. See the shim's __nimbusTrackOp.
 *   - listening SERVERS (`__portRegistry`), open until the program closes
 *     them.
 *   - held CONNECTIONS (`__nimbusOpenSockets`): an HTTP exchange a server is
 *     answering, a WebSocket client, a tls.connect socket, until it closes
 *     (or is unref'd). Not startup work: a resident's boot does not wait on
 *     them.
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

// Binding a native listen(0) first awaits session-wide allocation. Until it
// binds, it is a referenced handle just like the eventual server; unref and
// close still remove its contribution. It is also startup work to settle.
function __nimbusPendingHttpListens() {
  let count = 0;
  const listeners = globalThis.__nimbusPendingHttpListeners;
  if (listeners) for (const server of listeners) if (!server.__nimbusUnrefed) count++;
  return count;
}

function __nimbusPendingStartupWork() {
  return __nimbusHandleCount("__nimbusPendingTimers") + __nimbusHandleCount("__nimbusPendingOps") + __nimbusPendingHttpListens();
}

// The above, plus the handles a program holds open on purpose. A bound port
// keeps a Node process alive, and it keeps a one-shot facet alive too.
function __nimbusLiveHandles() {
  const __servers = globalThis.__portRegistry;
  let __bound = 0;
  if (__servers && typeof __servers.values === "function") {
    for (const __server of __servers.values()) if (!__server?.__nimbusUnrefed) __bound++;
  }
  return __nimbusPendingStartupWork() + __bound + __nimbusHandleCount("__nimbusInputHandles")
    + __nimbusHandleCount("__nimbusOpenSockets");
}

async function __nimbusRunEventLoop(__countHandles, __exitPromise, __deadlineMs, __minPasses, __onPass) {
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
  let __pass = 0;
  // A user-invoked program runs until it exits or is killed — there is no
  // wall-clock deadline, so no expiry timer is armed at all. (Callers that
  // still pass a finite deadline get the timer for compatibility.)
  const __deadline = Number.isFinite(__deadlineMs)
    ? __rawSetTimeout(() => { __expired = true; }, __deadlineMs)
    : null;
  while (!__exited && !__expired && (__pass < __minPasses || __countHandles() > 0)) {
    // The warm-up passes give a settling microtask chain its turns and cost
    // ~5µs each; past them the loop is waiting on wall-clock work, where
    // spinning at 0ms would burn the isolate's CPU indefinitely.
    await new Promise((resolve) => __rawSetTimeout(resolve, __pass < __minPasses ? 0 : 1));
    __pass++;
    if (__onPass) __onPass();
  }
  if (__deadline !== null) { try { __rawClearTimeout(__deadline); } catch {} }
  // \`pending\` is what the caller reports when it gives up: a one-shot program
  // still holding a handle did NOT finish, and exiting 0 would claim it did.
  return { passes: __pass, pending: __exited ? 0 : __countHandles() };
}

// Whether the program's only remaining work is waiting on its children (the
// polls for their output and exit, __nimbusChildOps): no timer, socket,
// server, stdin read or fetch of its own. Said to the session when it
// changes (node-shims __nimbusReportBlocked), whose Dynamic Worker ledger
// refuses a child's launch only when every worker is held by a process in
// this state (fabric setProcessBlocked).
function __nimbusReportBlockedState() {
  const __children = __nimbusHandleCount("__nimbusChildOps");
  const __blocked = __children > 0 && __nimbusLiveHandles() === __children;
  if (typeof globalThis.__nimbusReportBlocked === "function") globalThis.__nimbusReportBlocked(__blocked);
}

// A one-shot facet's lifetime IS the loop: it runs the program until Node
// would exit, or until the lifetime budget runs out. One loop from the
// start, with the entry's evaluation (top-level await) counted as a handle
// while it is pending, so the program's state is reported throughout: a
// module whose top-level await waits on a child's close is blocked on that
// child as much as a callback would be. Once the evaluation settles, the
// loop gives a settling chain its warm-up turns again; a rejected
// evaluation is thrown once the loop ends.
async function __nimbusRunEntrypointToExit(__entryResult, __deadlineMs) {
  let __evaluating = Boolean(__entryResult) && typeof __entryResult.then === "function";
  let __failure = null;
  let __grace = 0;
  if (__evaluating) {
    __entryResult.then(
      () => { __evaluating = false; __grace = 4; },
      (error) => { __evaluating = false; __failure = { error }; },
    );
  }
  const __count = () => {
    if (__failure) return 0;
    if (__evaluating) return 1 + __nimbusLiveHandles();
    if (__grace > 0) { __grace--; return 1 + __nimbusLiveHandles(); }
    return __nimbusLiveHandles();
  };
  const __drain = await __nimbusRunEventLoop(__count, __nimbusProcessExitPromise, __deadlineMs, 4, __nimbusReportBlockedState);
  if (__failure && (typeof __nimbusProcessExitCode === "undefined" || __nimbusProcessExitCode === null)) throw __failure.error;
  return __drain;
}

// Whether the program holds no live handle once a settling chain has had the
// same four turns the one-shot loop gives it.
async function __nimbusHoldsNoHandle() {
  const __rawSetTimeout = (typeof globalThis.__nimbusRawSetTimeout === "function")
    ? globalThis.__nimbusRawSetTimeout
    : globalThis.setTimeout;
  for (let __pass = 0; __pass < 4; __pass++) await new Promise((resolve) => __rawSetTimeout(resolve, 0));
  return __nimbusLiveHandles() === 0;
}

// A resident process ends as Node's does: when it holds no live handle. It
// may serve for hours, so this does not poll: every place a handle is released
// (a timer firing or cleared, an operation settling, a server closed or
// unref'd, stdin let go) calls __nimbusHandleReleased, and a release that
// leaves none is the program's natural end.
function __nimbusNaturalExit() {
  return new Promise((resolve) => {
    let __checking = false;
    const __released = () => {
      if (__checking) return;
      __checking = true;
      __nimbusHoldsNoHandle().then((__none) => {
        __checking = false;
        if (!__none) return;
        if (globalThis.__nimbusHandleReleased === __released) globalThis.__nimbusHandleReleased = undefined;
        resolve();
      });
    };
    globalThis.__nimbusHandleReleased = __released;
    __released();
  });
}

// A resident facet keeps running after the call that boots it returns, so it
// settles startup and nothing more. The handles it holds open deliberately —
// its listening port — are the point of it, not a reason to make the shell's
// prompt wait. Its module's own evaluation is bounded by the same budget: a
// server entry that ends in a top-level await which never settles
// (\`await new Promise(() => {})\`, a dev server awaiting a listen that fails)
// is a running program in Node, and waiting on it here left the boot call —
// and every request routed to the facet, which waits for boot — hung
// forever. A rejection after the budget fails the process as Node's does.
async function __nimbusSettleEntrypointStartup(__entryResult, __deadlineMs) {
  const __startedAt = Date.now();
  if (__entryResult && typeof __entryResult.then === "function") {
    const __rawSetTimeout = (typeof globalThis.__nimbusRawSetTimeout === "function")
      ? globalThis.__nimbusRawSetTimeout
      : globalThis.setTimeout;
    const __rawClearTimeout = (typeof globalThis.__nimbusRawClearTimeout === "function")
      ? globalThis.__nimbusRawClearTimeout
      : globalThis.clearTimeout;
    const __exit = {};
    const __late = {};
    let __timer = null;
    const __raced = await Promise.race([
      __entryResult.then(() => null),
      __nimbusProcessExitPromise.then(() => __exit, () => __exit),
      new Promise((resolve) => { __timer = __rawSetTimeout(() => resolve(__late), __deadlineMs); }),
    ]).finally(() => { try { __rawClearTimeout(__timer); } catch {} });
    if (__raced === __exit) return { passes: 0, pending: 0 };
    if (__raced === __late) {
      __entryResult.then(undefined, (__error) => { queueMicrotask(() => { throw __error; }); });
      return { passes: 0, pending: __nimbusPendingStartupWork() };
    }
  }
  return await __nimbusRunEventLoop(
    __nimbusPendingStartupWork, __nimbusProcessExitPromise,
    Math.max(0, __deadlineMs - (Date.now() - __startedAt)), 4,
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
    // Counted once the timer exists: a delay the platform refuses throws, and
    // a caught throw leaves no timer to wait for.
    const id = st(function(){
      if (one.delete(id)) { g.__nimbusPendingTimers--; g.__nimbusHandleReleased?.(); }
      return fn.apply(this, arguments);
    }, ms, ...a);
    g.__nimbusPendingTimers++; one.add(id); return id;
  };
  g.clearTimeout = function(id){ if (one.delete(id)) { g.__nimbusPendingTimers--; g.__nimbusHandleReleased?.(); } return ct(id); };
  if (typeof si === "function") {
    g.setInterval = function(fn, ms, ...a){ const id = si(fn, ms, ...a); iv.add(id); g.__nimbusPendingTimers++; return id; };
    g.clearInterval = function(id){ if (iv.delete(id)) { g.__nimbusPendingTimers--; g.__nimbusHandleReleased?.(); } return ci(id); };
  }
  // process.exit: the program's pending timers and intervals never fire again.
  g.__nimbusStopProgramTimers = function(){
    for (const id of one) ct(id);
    one.clear();
    if (typeof ci === "function") for (const id of iv) ci(id);
    iv.clear();
    g.__nimbusPendingTimers = 0;
  };
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
// What the next launch of this entry must stage, kept apart because they are
// staged differently: files read synchronously and not answered (data), and
// modules the program tried to execute that the map lacked (graph roots).
function __nimbusDataReadMisses() {
  return [...(globalThis.__nimbusVfsResidencyMisses || [])];
}
function __nimbusExecutedModuleMisses() {
  return [...(globalThis.__nimbusModuleMisses || [])];
}
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
/** Where inlined wasm images are staged, one kernel-owned file per content key. */
const INLINE_WASM_DIR = '/var/lib/nimbus/inline-wasm';
/**
 * A base64 string literal whose first bytes are wasm's `\0asm` magic
 * (`AGFzbQ`), long enough to be a module. Quotes bound the match, so the scan
 * reads what wasm IS and matches no call shape.
 */
const INLINE_WASM_LITERAL_RE = /["'`](AGFzbQ[A-Za-z0-9+/]{58,}={0,2})["'`]/g;
/**
 * A numeric array literal that starts with wasm's magic and version,
 * `[0,97,115,109,1,0,0,0,…]`: how xxhash-wasm (Astro's content hashing) and
 * other small modules inline their image, as `new Uint8Array([…])`.
 */
const INLINE_WASM_ARRAY_RE = /\[\s*0\s*,\s*97\s*,\s*115\s*,\s*109\s*,\s*1\s*,\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*\d{1,3}\s*)+\]/g;
/** Wasm magic (`\0asm`) and version 1. */
function isWasmImage(bytes) {
    return bytes.length >= 8 && bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d
        && bytes[4] === 1 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0;
}
/**
 * Every wasm image a closure's JavaScript inlines, as a base64 string or as a
 * numeric array literal, deduplicated by content. Vite 8 compiles
 * es-module-lexer's parser from base64 at module top level
 * (`WebAssembly.compile(C())`), and xxhash-wasm instantiates a
 * `new Uint8Array([0,97,115,109,…])`; from a facet cell that is request
 * time, where the runtime refuses to compile from bytes, so the image has to
 * ride in the module map and be answered by content (the node-shims seam's
 * by-digest registry).
 */
export function findInlineWasmImages(bundle) {
    const found = new Map();
    const keep = (bytes) => {
        // A staged image is compiled with the map when the launch loads, so one
        // this runtime cannot compile fails the whole launch, where the program
        // meets it only if it compiles it: wasm-feature-detect inlines a module
        // per proposal it probes and catches each CompileError.
        if (!isWasmImage(bytes) || !WebAssembly.validate(bytes))
            return;
        const digest = wasmImageDigest(bytes);
        if (!found.has(digest))
            found.set(digest, bytes);
    };
    for (const [path, cell] of Object.entries(bundle)) {
        if (typeof cell !== 'string')
            continue;
        if (!(path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')))
            continue;
        if (cell.includes('AGFzbQ')) {
            for (const match of cell.matchAll(INLINE_WASM_LITERAL_RE)) {
                try {
                    keep(Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0)));
                }
                catch {
                    // Not base64 after all: not an image.
                }
            }
        }
        if (/97\s*,\s*115\s*,\s*109/.test(cell)) {
            for (const match of cell.matchAll(INLINE_WASM_ARRAY_RE)) {
                const values = match[0].slice(1, -1).split(',').map(Number);
                if (values.every((v) => Number.isInteger(v) && v >= 0 && v <= 255))
                    keep(Uint8Array.from(values));
            }
        }
    }
    return [...found.values()];
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
 * The runtime-code interpreter, its primordials and its host module, in every
 * launch's map: the primordials load at the launch's start, the other two
 * only when the program first produces code no launch staged
 * (core/_shared/commonjs-cell.ts, RUNTIME CODE).
 */
function interpreterModules(sources) {
    return {
        [RUNTIME_INTERPRETER_PRIMORDIALS_MODULE]: sources.interpreterPrimordials,
        [RUNTIME_INTERPRETER_MODULE]: sources.interpreter,
        [RUNTIME_INTERPRETER_OPS_MODULE]: sources.interpreterOps,
    };
}
/**
 * The entry code as a module of the map, named for the script it came from so
 * its stack frames carry that path; `-e` code is `[eval]`. The runtime may
 * have lowered it from ESM (runtime-registry.ts), and its scope is read off
 * the code itself (declaresWrapperBinding). `esModule` (RuntimeRunOpts) is
 * how the runner evaluates it: an ES entry's require is its static imports,
 * and what escapes it is explained as Node's loader explains it.
 */
function entryModule(userCode, filename, esModule) {
    const code = rewriteProvidedCommonJsModules(userCode);
    const name = commonJsEntryModuleName(filename || '[eval]');
    const path = 'filename || "/home/user/script.js"';
    return {
        name,
        text: wrapCommonJsCell(code, declaresWrapperBinding(code) ? 'block' : 'function').text,
        evaluate: `__nimbusEvaluateEntry(__nimbusEntryWrapper(${JSON.stringify(name)}, ${path}), mod, ${path}, dirname || "/home/user", ${esModule === true})`,
    };
}
/**
 * Generate one-shot runtime code with a plain fetch handler. `filename`
 * names the entry's module, and so its stack frames.
 */
export async function generateEntrypointCode(userCode, vfsState, usesSqlite, sources, wasmImports = [], filename, esModule) {
    const entry = entryModule(userCode, filename, esModule);
    const bundleSource = await facetVfsBundleSourceFor(vfsState);
    return {
        code: `
${bundleSource.imports}
${REAL_NODE_IMPORTS}
${COMMONJS_CELL_IMPORTS}
${usesSqlite ? SQLITE_FACET_IMPORT : ''}
${stagedBindingsFacetImport(vfsState.stagedBindings)}
${facetWasmImportsSource(wasmImports)}
const __NimbusHostResponse = globalThis.Response;
// The SUPERVISOR binding's filesystem calls answer a refusal as a value
// (core vfs-supervisor.ts answeringSupervisor).
${SUPERVISOR_ANSWERING_SRC}
// A synchronous read of stdin that has to wait stops the run, which is run
// again once the input is there (runtime/stop-replay.ts).
${STOP_REPLAY_SOURCE}

// The process's code: a module per cell, compiled when first required.
const __NIMBUS_CODE_CELLS = ${bundleSource.codeCells};
const __NIMBUS_RUNTIME_CODE = ${bundleSource.runtimeCode};
${COMMONJS_CELL_RUNTIME_SOURCE}

// The module bundle, at module level (startup time); the code cells the store
// adopts are getters over the map's own text.
const __MODULE_VFS_BUNDLE = __nimbusWithCodeCells(${bundleSource.expression});

class __ProcessExit extends Error {
  constructor(code) { super("process.exit(" + code + ")"); this.code = code; }
}

export default {
  async fetch(request, workerEnv, workerCtx) {
    const args = await request.json();
    const { argv, env, cwd: _cwd, filename, dirname, stdin, captureOutput, cred, diag: __diag, vfsCursor, dataPlan } = args;
    const __nimbusProcessId = Number(args.pid || 1);
    // A pipe or redirect streams through this input channel (exec's
    // _pumpStdinPipe); node-shims' process.stdin and fd 0 read it.
    const __nimbusLiveInputPid = Number(args.stdinPid || 0);
    // The channel has ended, and what it holds is taken whole before the
    // entry runs: a run after a stop that waited for the end of stdin.
    const __nimbusStdinWhole = args.stdinWhole === true;
    // A run after a stop is handed back the stdin the run before it took, and
    // takes all of that before it starts, whatever its size.
    const __nimbusStdinAtLeast = Number(args.stdinAtLeast || 0);
    // This run's stop, and what it replays of the run that stopped before it.
    // ctx.abort ends the isolate's JavaScript where it stands, so the program
    // never sees the stop; the session believes a stop only with this run's
    // nonce, which only this module holds.
    // ctx.abort is taken now, before the program runs, and handed a string.
    const __ctxAbort = workerCtx && typeof workerCtx.abort === "function" ? workerCtx.abort : null;
    const __apply = Reflect.apply;
    __nimbusStopReplay.begin({
      replay: args.replay || null,
      abort: __ctxAbort ? (reason) => __apply(__ctxAbort, workerCtx, [reason]) : null,
      captured: !!captureOutput || !workerEnv?.SUPERVISOR,
      // Read at a stop, after the run has printed (declared below).
      capturedText: () => ({ stdout, stderr }),
      nonce: args.stopNonce,
      // Its network goes through the session, which records what it reads.
      outbound: args.outbound === true,
      // The session holds what it answers past the read the run before
      // stopped at until the replay gets there.
      boundary: () => { const b = __supervisor && __supervisor.replayBoundary; return typeof b === "function" ? Reflect.apply(b, __supervisor, []) : undefined; },
    });
    // A \`< file\` redirect: fd 0 is this file (node-shims' stdin helpers).
    const __nimbusStdinFile = args.stdinFile && typeof args.stdinFile.path === "string" ? args.stdinFile : null;
    // Per invocation, not per module: this body is cached on
    // hash(code + bundle + manifest) and reused by any session whose snapshot
    // hashes the same, and epochs are per supervisor incarnation.
    const __MODULE_VFS_CURSOR = vfsCursor || null;
${VFS_CURSOR_SEED_SOURCE}
    // A user-invoked program has no wall-clock lifetime: the drain runs the
    // entrypoint's event loop until Node would exit, and only a kill (Ctrl-C)
    // ends it early.
    const __entryBudgetMs = Infinity;
    let __drainPasses = 0;
    // Every call that changes something outside the process is counted: a
    // run that made one cannot stop to be run again.
    const __supervisor = workerEnv?.SUPERVISOR
      ? __nimbusStopReplay.ledger(globalThis.__nimbusAnsweringSupervisor(workerEnv.SUPERVISOR)) : null;
    // Its network goes through its workspace's egress: node:tls refuses a TLS socket by name.
    globalThis.__nimbusEgress = workerEnv?.NIMBUS_EGRESS === true;
    // The same store, namespace and data plan a resident boots on, backed by
    // this run's heap (runOnce hosts no SQLite; vfs/facet-resident-store.ts).
    // Declared inside the request, beside the shims, so a loader that reuses
    // this isolate for another run starts it from an empty store.
${sources.residentStore}
    __residentBindInMemory(${ONE_SHOT_STORE_MEMORY_BYTES});
    __residentSetStorage(undefined, __supervisor);
    __nsSetCred(cred);
    __residentSetPlan(dataPlan);
    __residentSetPushRoots([_cwd || "/home/user", "/tmp"]);
    // The module bundle stays at module scope: a reused isolate adopts it
    // again on its next run, and its text cells are shared, not copied.
    const __residentBooted = await __residentBoot(() => __MODULE_VFS_BUNDLE, __MODULE_VFS_CURSOR, __supervisor, ${bundleSource.storageBytes});
    if (__residentBooted.cursor) {
      globalThis.__nimbusVfsCursor = { epoch: __residentBooted.cursor.epoch, rev: __residentBooted.cursor.rev };
    }
    // No user code runs before the namespace answers: it is the view every
    // synchronous stat, exists and readdir reads (CUTOVER #13).
    const __namespaceFailure = await __residentRequireNamespace(__supervisor, __residentBooted.failure);
    if (__namespaceFailure) {
      return __NimbusHostResponse.json({ exitCode: 1, stdout: "", stderr: __namespaceFailure + "\\n", residencyMisses: [] });
    }
    const __vfsBundle = __nimbusResidentBundle;
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
    // The relay carries bytes (see "Process output is bytes" in the shims).
    // Each chunk goes with its offset in what this run printed and the run's
    // number: what a replay prints again of the stopped run's output is
    // checked and dropped here, and a chunk the session has not acknowledged
    // when the run stops rides the stop (runtime/stop-replay.ts).
    const __queueRpcWrite = (method, bytes) => {
      const __chunk = __nimbusStopReplay.write(method, bytes);
      if (__chunk === null) return;
      __rpcWriteCount++;
      const __task = __rpcWriteChain
        .then(() => __supervisor[method](__chunk.b, __chunk.at, __chunk.run))
        .then(() => __nimbusStopReplay.acked(__chunk))
        .catch((e) => __onRpcDrop(__chunk.b.byteLength, e));
      __rpcWriteChain = __task.then(() => {}, () => {});
      __pendingIO.push(__task);
    };
    let cwd = _cwd || "/home/user";
    let stdout = "", stderr = "";
    let exitCode = 0;
    const __nimbusDeferProcessExitReport = true;
${sources.ledger}
    const __vfsDirs = {};

${ENTRYPOINT_TIMER_TRACKER}
${sources.shims}

${ENTRYPOINT_EVENT_LOOP}
${RESIDENCY_MISS_REPORT}

    // Override console AND process.stdout/stderr for live SUPERVISOR streaming
    if (__supervisor && !captureOutput) {
      __consoleMod.log = (...a) => { if (__nimbusProgramStopped) return; const s = __utilMod.format(...a) + "\\n"; stdout += s; __queueRpcWrite("stdout", __nimbusOutEnc.encode(s)); };
      __consoleMod.error = (...a) => { if (__nimbusProgramStopped) return; const s = __utilMod.format(...a) + "\\n"; stderr += s; __queueRpcWrite("stderr", __nimbusOutEnc.encode(s)); };
      __consoleMod.warn = __consoleMod.error;
      __consoleMod.info = __consoleMod.log;
      __consoleMod.debug = __consoleMod.log;
      __processMod.stdout.write = (d, enc, cb) => { if (typeof enc === "function") cb = enc; if (__nimbusProgramStopped) return true; const b = __nimbusOutBytes(d, enc); stdout += __nimbusOutText("stdout", b); __queueRpcWrite("stdout", b); if (typeof cb === "function") queueMicrotask(cb); return true; };
      __processMod.stderr.write = (d, enc, cb) => { if (typeof enc === "function") cb = enc; if (__nimbusProgramStopped) return true; const b = __nimbusOutBytes(d, enc); stderr += __nimbusOutText("stderr", b); __queueRpcWrite("stderr", b); if (typeof cb === "function") queueMicrotask(cb); return true; };
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
    Object.defineProperty(mod, "__nimbusImportMeta", { value: __nimbusFileImportMeta(filename || "/home/user/script.js") });
    // G2 (runtime-pkg wave): see corresponding comment in NodeProcess.run.
    __require.main = mod;
    try {
      await __nimbusPrepareStdin();
      // From here on the program runs: a stop is possible while stdin can
      // still come short of a read.
      __nimbusStopReplay.arm(__nimbusStdinCanStop());
      // Compiled here, by the registry, the first time. A SyntaxError in the
      // entry has no location of its own; the wrapper leads its stack with
      // the file, as Node does.
      const __entryResult = ${entry.evaluate};
      const __drain = await __nimbusRunEntrypointToExit(__entryResult, __entryBudgetMs);
      __drainPasses = __drain.passes;
      if (__nimbusProcessExitCode !== null) exitCode = __nimbusProcessExitCode;

      // A program that ended on its own may still be reading stdin; one that
      // called process.exit() has ended whatever it holds, its stdin included,
      // as Node's does. Waiting for the pump there waited for a parent that
      // keeps the pipe open to close it, which it need never do.
      if (__nimbusLiveStdinPump && !__nimbusAttachedTty && __nimbusProcessExitCode === null) await __nimbusLiveStdinPump;
    } catch (e) {
      if (e instanceof __ProcessExit) { exitCode = e.code; }
      else {
        const trace = (e && e.stack) || (e && e.message) || String(e);
        stderr += trace + "\\n";
        exitCode = 1;
        if (__supervisor && !captureOutput) {
          try { const __traceBytes = __nimbusOutEnc.encode(trace + "\\n"); __pendingIO.push(__supervisor.stderr(__traceBytes).catch((e2) => __onRpcDrop(__traceBytes.byteLength, e2))); } catch {}
        }
      }
    }
    // A program that ended without process.exit still gets its 'exit' event.
    if (__nimbusProcessExitCode === null) {
      __nimbusEmitExit(exitCode);
      if (__nimbusProcessExitCode !== null) exitCode = __nimbusProcessExitCode;
      __nimbusProgramStopped = true;
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
      if (__supervisor && !captureOutput) __queueRpcWrite("stderr", __nimbusOutEnc.encode(__residencyReport));
    }
    // A run after a stop that ended before printing all the stopped run had
    // printed did not retrace it: what it printed past that is not the
    // program's output.
    const __replayShort = __nimbusStopReplay.finish();
    if (__replayShort) {
      stderr += __replayShort;
      exitCode = 1;
      if (__supervisor && !captureOutput) {
        const __shortBytes = __nimbusOutEnc.encode(__replayShort);
        __pendingIO.push(__supervisor.stderr(__shortBytes).catch((e) => __onRpcDrop(__shortBytes.byteLength, e)));
      }
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
            await __supervisor.stderr(__nimbusOutEnc.encode(trace + "\\n"));
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
      // Unconditional, unlike diag: the supervisor stages these paths into
      // the next bundle for the same entry, so withholding them behind a
      // debug flag would leave the miss to repeat forever.
      residencyMisses: __nimbusDataReadMisses(),
      moduleMisses: __nimbusExecutedModuleMisses(),
      // Code produced while it ran, for the next launch (commonjs-cell.ts).
      runtimeCode: __nimbusRuntimeCodeLedger(),
      ...(__diag ? { diag: {
        drainPasses: __drainPasses, rpcWrites: __rpcWriteCount, fsRpcReads: globalThis.__nimbusFsRpcReads || 0,
        namespaceRefusals: (globalThis.__nimbusVfsCoherence && globalThis.__nimbusVfsCoherence.namespaceRefusals) || 0,
      } } : {}),
    });
  }
};
`,
        modules: bundleSource.modules,
        codeModules: { ...bundleSource.codeModules, ...interpreterModules(sources), [entry.name]: entry.text },
    };
}
/**
 * Generate a long-running Node entrypoint.
 *
 * Same core shim/VFS machinery as foreground node execution, but the
 * compiled user entry is booted once and the exported entrypoint keeps
 * serving HTTP requests from the shimmed http.Server registry.
 */
/**
 * Hand a record's entries to a consumer one at a time, releasing each as it
 * goes, so the record stops being a second holder of the whole set.
 *
 * The image store takes its images as a sequence for exactly this: a launch's
 * module text is the largest thing the coordinator assembles, and holding it
 * in two places at once is what the 128 MiB isolate could not survive.
 */
function* drainSources(sources) {
    for (const name of Object.keys(sources)) {
        const source = sources[name];
        delete sources[name];
        yield [name, source];
    }
}
/**
 * The image-store name a resident launch's code pack is materialized under.
 * Not a module name — the pack's own index names its modules — so it can
 * never collide with one of the main module's.
 */
const CODE_PACK_IMAGE = 'code pack';
/** The module-map name a precompiled wasm image travels under. */
export function facetWasmModuleName(index) {
    return `__nimbus_wasm_${index}.wasm`;
}
/**
 * The wasm imports one launch stages: the images its options name, then
 * every image the closure walk recorded (FacetVfsState.wasmImages) that the
 * options did not already name by path. One member per path; the closure's
 * record supplies the digest an option without one lacks.
 */
export function facetWasmImports(named, closure) {
    const byPath = new Map();
    for (const image of named)
        byPath.set(image.vfsPath, image);
    for (const image of closure) {
        const seen = byPath.get(image.vfsPath);
        if (seen === undefined)
            byPath.set(image.vfsPath, image);
        else if (seen.digest === undefined)
            byPath.set(image.vfsPath, { ...seen, digest: image.digest });
    }
    return [...byPath.values()].map((image, index) => ({ ...image, moduleName: facetWasmModuleName(index) }));
}
/**
 * The static imports that compile a launch's wasm images at module eval and
 * park them by VFS path for the node-shims WebAssembly seam.
 */
function facetWasmImportsSource(wasmImports) {
    if (wasmImports.length === 0)
        return '';
    const lines = wasmImports.map((entry, index) => `import __nimbusWasm${index} from ${JSON.stringify(entry.moduleName)};`);
    const entries = wasmImports.map((entry, index) => `[${JSON.stringify(stripLeadingSlashes(entry.vfsPath))}, __nimbusWasm${index}]`);
    const byDigest = wasmImports
        .map((entry, index) => (entry.digest === undefined
        ? null
        : `[${JSON.stringify(entry.digest)}, __nimbusWasm${index}]`))
        .filter((line) => line !== null);
    return `${lines.join('\n')}\nglobalThis.__nimbusPrecompiledWasm = new Map([${entries.join(', ')}]);`
        + `\nglobalThis.__nimbusPrecompiledWasmByDigest = new Map([${byDigest.join(', ')}]);`;
}
export async function generateLongRunningNodeCode(userCode, vfsState, opts, usesSqlite, sources, pacer) {
    const entry = entryModule(userCode, opts.filename, opts.esModule);
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
    const bundleSource = await facetVfsBundleSourceFor(vfsState, pacer);
    return {
        code: `
${bundleSource.imports}
import { DurableObject } from "cloudflare:workers";
${REAL_NODE_IMPORTS}
${COMMONJS_CELL_IMPORTS}
${usesSqlite ? SQLITE_FACET_IMPORT : ''}
${stagedBindingsFacetImport(vfsState.stagedBindings)}
${facetWasmImportsSource(opts.wasmImports ?? [])}
const __NIMBUS_ARGS = ${safeArgs};
const __NimbusHostResponse = globalThis.Response;
// The SUPERVISOR binding's filesystem calls answer a refusal as a value
// (core vfs-supervisor.ts answeringSupervisor).
${SUPERVISOR_ANSWERING_SRC}
// A synchronous read of stdin that has to wait stops the run with the
// facet's ctx.abort (runtime/stop-replay.ts).
${STOP_REPLAY_SOURCE}

// The process's code: a module per cell, compiled when first required. The
// only other way a string becomes code in a Worker is \`new Function\` at
// module evaluation, which compiled the whole closure before the program ran.
const __NIMBUS_CODE_CELLS = ${bundleSource.codeCells};
const __NIMBUS_RUNTIME_CODE = ${bundleSource.runtimeCode};
${COMMONJS_CELL_RUNTIME_SOURCE}

// \`let\`, not \`const\`, so the parsed bundle can be dropped once the store has
// adopted it. Holding both is the double materialisation: the module map's text
// and this object are the same bytes twice. The code cells the store adopts
// are getters over the map's own module text.
let __MODULE_VFS_BUNDLE = __nimbusWithCodeCells(${bundleSource.expression});

${sources.residentStore}

class __ProcessExit extends Error {
  constructor(code) { super("process.exit(" + code + ")"); this.code = code; }
}

let __nimbusStarted = false;
let __nimbusStarting = null;
let __nimbusRuntime = null;
let __nimbusAttachedLifecycle = null;

// The platform's timer, captured at module evaluation, before the shims wrap
// setTimeout in the resumption barrier. The flush below yields turns for its
// own bookkeeping; that is not a resumption of the program, and through the
// wrapped timer it paid a hidden ACQUIRE per yield — the one an inbound
// request relied on without saying so, and a second one after the response
// on every request. The request's barrier is taken explicitly, in the shared
// dispatch (__nimbusServeHttp), exactly once.
const __nimbusPlatformSetTimeout = setTimeout;

// A failed report of generated code or misses costs the next launch what this
// one learned, and nothing else: the program's own writes and responses do not
// wait on it. The failure is told to the guest's stderr, where the next-launch
// guidance it would otherwise contradict is printed.
async function __nimbusReportLearningFailure(supervisor, error) {
  try {
    if (supervisor) await supervisor.stderr(new TextEncoder().encode("Nimbus: runtime code persistence failed: " + String(error?.message || error) + "\\n"));
  } catch {}
}

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
      const turn = Promise.withResolvers();
      __nimbusPlatformSetTimeout(turn.resolve, 0);
      await turn.promise;
      if (rt.pendingIO.length <= rt.settledIO) break;
      const slice = rt.pendingIO.slice(rt.settledIO);
      rt.settledIO = rt.pendingIO.length;
      await Promise.allSettled(slice);
    }
    if (rt.settledIO === rt.pendingIO.length) {
      rt.pendingIO.length = 0;
      rt.settledIO = 0;
    }
    // After the drain, so the program's writes are durable whatever happens
    // to the report; unacknowledged entries are sent again by the next flush.
    const [__learning] = await Promise.allSettled([__nimbusFlushRuntimeCode(rt.supervisor)]);
    if (__learning.status === "rejected") await __nimbusReportLearningFailure(rt.supervisor, __learning.reason);
    const __vfsFailure = __vfsOutcomes.find((outcome) => outcome.status === "rejected");
    if (__vfsFailure) throw __vfsFailure.reason;
  });
  rt.pendingDrainChain = __pendingDrain.catch(() => {});
  await __pendingDrain;
}

async function __nimbusEnsureStarted(workerEnv, workerCtx, __startArgs) {
  if (__nimbusStarted) return;
  if (__nimbusStarting) return __nimbusStarting;
  __nimbusStarting = (async () => {
    const args = __NIMBUS_ARGS;
    const { argv, env, cwd: _cwd, filename, dirname, stdin, captureOutput, attachedTty, cred } = args;
    const __nimbusProcessId = Number(__startArgs?.pid || env?.NIMBUS_CP_CHILD_PID || 1);
    // Every resident process has a live input channel on its pid.
    const __nimbusLiveInputPid = Number(__startArgs?.pid || env?.NIMBUS_CP_CHILD_PID || 0);
    // The channel has ended, and what it holds is taken whole before the
    // entry runs: a boot after a stop that waited for the end of stdin.
    const __nimbusStdinWhole = !!(__startArgs && __startArgs.stdinWhole);
    // Off the start payload, never out of the module text: this body is
    // content-addressed into the facet image store, and a revision that
    // advances on every spawn would give the same program a new image each
    // time. Same reason argv/env/pid want to move here.
    const __MODULE_VFS_CURSOR = (__startArgs && __startArgs.vfsCursor) || null;
${VFS_CURSOR_SEED_SOURCE}
    const __nimbusStdinAtLeast = Number((__startArgs && __startArgs.stdinAtLeast) || 0);
    const __ctxAbort = workerCtx && typeof workerCtx.abort === "function" ? workerCtx.abort : null;
    const __apply = Reflect.apply;
    __nimbusStopReplay.begin({
      replay: (__startArgs && __startArgs.replay) || null,
      abort: __ctxAbort ? (reason) => __apply(__ctxAbort, workerCtx, [reason]) : null,
      captured: !!captureOutput || !workerEnv?.SUPERVISOR,
      nonce: __startArgs && __startArgs.stopNonce,
      boundary: () => { const b = __supervisor && __supervisor.replayBoundary; return typeof b === "function" ? Reflect.apply(b, __supervisor, []) : undefined; },
    });
    const __supervisor = workerEnv?.SUPERVISOR
      ? __nimbusStopReplay.ledger(globalThis.__nimbusAnsweringSupervisor(workerEnv.SUPERVISOR)) : null;
    // Its network goes through its workspace's egress: node:tls refuses a TLS socket by name.
    globalThis.__nimbusEgress = workerEnv?.NIMBUS_EGRESS === true;
    __nimbusRuntimeCodeReporter = () => {
      const report = __nimbusFlushRuntimeCode(__supervisor).catch(async (error) => {
        await __nimbusReportLearningFailure(__supervisor, error);
        throw error;
      });
      // Code may be produced by a timer after boot has returned, not by an
      // HTTP request that will call our flush. Own this asynchronous write.
      workerCtx.waitUntil(report);
      return report;
    };
    // The resident set lives in this facet's own SQLite rather than its heap.
    // A synchronous read cannot block and no JS stack here can be suspended, so
    // the bytes have to sit somewhere a synchronous call can already reach;
    // \`ctx.storage.sql.exec\` returns a Cursor, not a Promise. See
    // vfs/facet-resident-store.ts.
    __residentBind(workerCtx);
    __residentSetStorage(__startArgs && __startArgs.storage, __supervisor);
    __nsSetCred(cred);
    __residentSetPlan(__startArgs && __startArgs.dataPlan);
    // The shared read profile's files this launch staged; each is struck off
    // when read, and what is left at exit is reported unread (read-profile.ts).
    globalThis.__nimbusProfileStaged = new Set((__startArgs && __startArgs.profileStaged) || []);
    __residentSetPushRoots([_cwd || "/home/user", "/tmp"]);
    // Bring the store to the authority's current state before the program's
    // first instruction. This is what makes a first synchronous read of an
    // untouched file succeed, and it is the ONLY blocking step: the waiting is
    // done once, here, so that no synchronous read after it ever has to wait.
    //
    // A cold store adopts this spawn's snapshot and fills the rest. A store
    // that outlived its process — a durable application's, relaunched or
    // re-driven — is cheap to bring current: rows the absolute listing proves
    // current are kept, and only what changed is fetched. It is SERVED only
    // once that listing has vouched for it: rows it cannot vouch for are a
    // previous process's, of unknown age, so the kept store is emptied and
    // this launch boots as a cold one does. See __residentBoot.
    //
    // The thunk hands the parsed bundle over and drops this scope's reference,
    // so a cold boot frees it the moment it is adopted rather than holding it
    // through the fill. A kept store that reconciles never takes it.
    const __residentBootStarted = Date.now();
    const __residentBooted = await __residentBoot(
      () => { const __bundle = __MODULE_VFS_BUNDLE; __MODULE_VFS_BUNDLE = null; return __bundle; },
      __MODULE_VFS_CURSOR,
      __supervisor,
      ${bundleSource.storageBytes},
    );
    if (__startArgs && __startArgs.diag && __supervisor) {
      // NIMBUS_DEBUG only: what this process holds, for per-process storage measurement.
      try {
        const __stats = __residentStats();
        await __supervisor.stderr(new TextEncoder().encode("[nimbus-debug] resident boot " + JSON.stringify({
          ms: Date.now() - __residentBootStarted, ...__stats, failure: __residentBooted.failure || null,
        }) + "\\n"));
      } catch {}
    }
    __MODULE_VFS_BUNDLE = null;
    // One cursor, not two. The seed above publishes the cursor this SPAWN
    // staged at, which is right for a cold store and stale for a kept one —
    // the cursor the boot returns describes what the rows actually are.
    if (__residentBooted.cursor) {
      globalThis.__nimbusVfsCursor = { epoch: __residentBooted.cursor.epoch, rev: __residentBooted.cursor.rev };
    }
    // No user code runs before the namespace answers: it is the view every
    // synchronous stat, exists and readdir reads (CUTOVER #13). A launch whose
    // namespace cannot be listed fails here, naming why.
    const __namespaceFailure = await __residentRequireNamespace(__supervisor, __residentBooted.failure);
    if (__namespaceFailure) throw new Error(__namespaceFailure);
    const __vfsBundle = __nimbusResidentBundle;
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
    // The relay carries bytes (see "Process output is bytes" in the shims),
    // each chunk placed in what this run printed (runtime/stop-replay.ts).
    const __queueRpcWrite = (method, bytes) => {
      const __chunk = __nimbusStopReplay.write(method, bytes);
      if (__chunk === null) return;
      __rpcWriteCount++;
      const __task = __rpcWriteChain
        .then(() => __supervisor[method](__chunk.b, __chunk.at, __chunk.run))
        .then(() => __nimbusStopReplay.acked(__chunk))
        .catch((e) => __onRpcDrop(__chunk.b.byteLength, e));
      __rpcWriteChain = __task.then(() => {}, () => {});
      __pendingIO.push(__task);
    };
    let cwd = _cwd || "/home/user";
    let stdout = "", stderr = "";
    let exitCode = 0;
    const __nimbusDeferProcessExitReport = true;
${sources.ledger}
    const __vfsDirs = {};

${ENTRYPOINT_TIMER_TRACKER}
${sources.shims}

${ENTRYPOINT_EVENT_LOOP}
${RESIDENCY_MISS_REPORT}

    if (__supervisor && !captureOutput) {
      __consoleMod.log = (...a) => { if (__nimbusProgramStopped) return; const s = __utilMod.format(...a) + "\\n"; stdout += s; __queueRpcWrite("stdout", __nimbusOutEnc.encode(s)); };
      __consoleMod.error = (...a) => { if (__nimbusProgramStopped) return; const s = __utilMod.format(...a) + "\\n"; stderr += s; __queueRpcWrite("stderr", __nimbusOutEnc.encode(s)); };
      __consoleMod.warn = __consoleMod.error;
      __consoleMod.info = __consoleMod.log;
      __consoleMod.debug = __consoleMod.log;
      __processMod.stdout.write = (d, enc, cb) => { if (typeof enc === "function") cb = enc; if (__nimbusProgramStopped) return true; const b = __nimbusOutBytes(d, enc); stdout += __nimbusOutText("stdout", b); __queueRpcWrite("stdout", b); if (typeof cb === "function") queueMicrotask(cb); return true; };
      __processMod.stderr.write = (d, enc, cb) => { if (typeof enc === "function") cb = enc; if (__nimbusProgramStopped) return true; const b = __nimbusOutBytes(d, enc); stderr += __nimbusOutText("stderr", b); __queueRpcWrite("stderr", b); if (typeof cb === "function") queueMicrotask(cb); return true; };
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
    Object.defineProperty(mod, "__nimbusImportMeta", { value: __nimbusFileImportMeta(filename || "/home/user/script.js") });
    __require.main = mod;
    let __attachedCompletion = null;
    let __attachedExplicitExit = false;
    // \`--watch\` and \`--inspect-brk\` hold a process that has no handle left
    // (it waits for a change, or for a debugger); nothing else does.
    const __nimbusHeldWithoutHandles = Array.isArray(argv)
      && argv.some((__arg) => __arg === "--watch" || __arg === "--inspect-brk");
    let __nimbusEndedAtBoot = false;
    // A resident whose launcher writes its stdin takes what has arrived
    // before the entry runs, and a boot after a stop takes all of it (it has
    // ended), for its synchronous reads of fd 0. Any other resident's stdin
    // is read only as the program reads it: an attached one's carries the
    // terminal's resizes and signals too.
    if (__startArgs && __startArgs.stdinWriter) await __nimbusPrepareStdin();
    // From here on the program runs. Its boot can stop while stdin can still
    // come short of a read, when its launcher writes that stdin
    // (FacetManager._residentLaunchBody); nothing else would ever end it.
    __nimbusStopReplay.arm(
      __nimbusStdinCanStop() && !!(__startArgs && __startArgs.stdinWriter),
      attachedTty ? "runs attached to a terminal, which Nimbus does not run again"
        : "is a server started from the terminal, whose stdin nothing writes",
    );
    try {
      // Compiled here, by the registry, the first time. A SyntaxError in the
      // entry has no location of its own; the wrapper leads its stack with
      // the file, as Node does.
      const __entryResult = ${entry.evaluate};
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
        // Finished during its boot (\`--help\`, a CLI run that also serves):
        // the boot answers with its exit, as an explicit exit's does.
        else if (!__nimbusHeldWithoutHandles) __nimbusEndedAtBoot = await __nimbusHoldsNoHandle();
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
          try { const __traceBytes = __nimbusOutEnc.encode(trace + "\\n"); __pendingIO.push(__supervisor.stderr(__traceBytes).catch((e2) => __onRpcDrop(__traceBytes.byteLength, e2))); } catch {}
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
        try { await __supervisor.stderr(__nimbusOutEnc.encode(__residencyReport)); } catch {}
      }
      await __supervisor.reportExit(code, reason || "", __nimbusDataReadMisses(), [...(globalThis.__nimbusProfileStaged || [])], __nimbusRuntimeCodeLedger(), __nimbusExecutedModuleMisses());
      __nimbusProcessExitReported = true;
    };
    const __nimbusReportLifecycleFailure = async (e) => {
      const trace = (e && e.stack) || (e && e.message) || String(e);
      stderr += trace + "\\n";
      if (__supervisor) {
        try { await __supervisor.stderr(__nimbusOutEnc.encode(trace + "\\n")); } catch {}
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
        } else if (__nimbusEndedAtBoot || __nimbusHeldWithoutHandles) {
          finalCode = __nimbusEndedAtBoot ? 0 : Number(await __nimbusProcessExitPromise);
        } else {
          // process.exit, or the natural end: no live handle left.
          finalCode = Number(await Promise.race([__nimbusProcessExitPromise, __nimbusNaturalExit().then(() => 0)]));
        }
        if (__nimbusProcessExitCode === null) {
          __nimbusEmitExit(finalCode);
          if (__nimbusProcessExitCode !== null) finalCode = __nimbusProcessExitCode;
          __nimbusProgramStopped = true;
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
      } else if (__nimbusEndedAtBoot || __nimbusProcessExitCode !== null) {
        // Ended during its boot: its exit is reported before the boot answers.
        await __residentExitLifecycle;
      }
    }

    if (__rpcDrops > 0 && __supervisor) {
      const tail = "[orphan output: " + __rpcDrops + " dropped RPC write(s), ~" +
        __rpcDropBytes + " bytes lost" +
        (__rpcLastError ? "; last error: " + __rpcLastError : "") + "]\\n";
      try { await __supervisor.stderr(__nimbusOutEnc.encode(tail)); } catch {}
    }
    if (exitCode !== 0) {
      await __nimbusReportFinalExit(exitCode, stderr || ("exit " + exitCode + "\\n"));
      throw new Error(stderr || ("long-running node startup exited " + exitCode));
    }
    __nimbusStarted = true;
  })();
  return __nimbusStarting;
}

async function __nimbusDispatchHttp(req, workerEnv, workerCtx) {
  await __nimbusEnsureStarted(workerEnv, workerCtx, __nimbusStartArgs);
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

let __nimbusStartArgs = null;

export class NimbusProcess extends DurableObject {
  async startProcess(startArgs) {
    // Held so an HTTP-first entry (a restart re-entered by a routed request)
    // starts from the same payload startProcess would have used.
    if (startArgs) __nimbusStartArgs = startArgs;
    await __nimbusEnsureStarted(this.env, this.ctx, __nimbusStartArgs);
    // A boot after a stop that finished before the read it stopped at did
    // not retrace the boot before it: it fails, loudly.
    const __replayShort = __nimbusStopReplay.booted();
    if (__replayShort) throw new Error(__replayShort);
    // Booted: what it does from now on is a running server's, and the
    // coordinator boots a resident again only while it is starting.
    __nimbusStopReplay.unreplayable("had already started, and Nimbus runs a resident again only while it boots");
    if (__nimbusAttachedLifecycle) await __nimbusAttachedLifecycle;
    // What this facet's database holds now, and the cap its store keeps
    // under, for the session's storage ledger (N18).
    let databaseSize;
    try { databaseSize = this.ctx.storage.sql.databaseSize; } catch {}
    let storageCap = null;
    try { storageCap = __residentStorageCap(); } catch {}
    return { ok: true, databaseSize, storageCap };
  }
  async fetch(req) { return __nimbusDispatchHttp(req, this.env, this.ctx); }
  async handleHttpRequest(req) { return __nimbusDispatchHttp(req, this.env, this.ctx); }
}
`,
        modules: bundleSource.modules,
        codeModules: { ...bundleSource.codeModules, ...interpreterModules(sources), [entry.name]: entry.text },
    };
}
/**
 * What the facet store charges itself to hold one cell (facet-resident-store's
 * __residentCellCost, which this must match): its bytes (a text cell's UTF-8
 * length) plus 1%, a row per chunk and head, and a page of slack.
 */
/** What a module map costs the facet's store that adopts it (N18). A denial is a head row only; a code-only file is none. */
function moduleMapStorageBytes(bundle, codeOnly) {
    let bytes = 0;
    for (const [path, cell] of Object.entries(bundle)) {
        if (codeOnly?.has(path))
            continue;
        bytes += typeof cell === 'string' || cell instanceof Uint8Array ? residentCellCost(cell) : 2 * LEDGER_ROW_BYTES;
    }
    return bytes;
}
function residentCellCost(cell) {
    const isText = typeof cell === 'string';
    const size = isText ? cell.length : cell.byteLength;
    const limit = isText ? Math.floor(RESIDENT_CHUNK_BYTES / 3) : RESIDENT_CHUNK_BYTES;
    const chunks = Math.max(1, Math.ceil(size / limit));
    const bytes = isText ? utf8Length(cell) : size;
    return Math.ceil(bytes * 1.01) + (chunks + 1) * LEDGER_ROW_BYTES + 4096;
}
/**
 * Drop the raw forms of everything that has been serialized, in place.
 *
 * `bundleSource` is a total encoding of `bundle`: no caller can distinguish
 * a state carrying both from one carrying only the serialized half, because
 * both facet generators read the serialized half and nothing else does.
 * Holding both doubles the cost of a cached entry for its whole lifetime, and
 * that lifetime spans execs.
 *
 * Applied by `_buildProcessBundle` to every state it builds, whether or not
 * the entry turns out small enough to retain: the launch being served reads
 * the serialized forms too. `_stageOpencodeFacet` builds its own uncached
 * state and genuinely re-reads the raw cells
 * (`assertStagedBundleFitsRpcPayload`); it does not go through here.
 */
export function releaseSerializedSources(vfsState) {
    if (!vfsState.bundleSource)
        return;
    vfsState.bundle = {};
    vfsState.emits = undefined;
    vfsState.lowered = undefined;
}
/**
 * Drop the serialized forms once a module map has been generated from them.
 *
 * The generated source is a total encoding of it: every byte of the bundle
 * expression is inside it. Holding them
 * afterwards keeps a second copy of the largest thing this DO builds alive for
 * as long as the facet runs — for pi, 22.7 MB across the ~20 s window in which
 * the isolate was being reset. For the one-shot path that window is the run;
 * for a resident launch — the path every attached-TTY npm bin takes, how a
 * real agentic CLI starts — it is the boot, and holding the copy across it
 * reset the session isolate with exceededMemory, which tears the terminal
 * WebSocket down with no exit frame: the dead screen reading "[process
 * terminal closed]".
 *
 * Only for a state the prefetch cache refused. A retained entry's serialized
 * forms ARE the entry, and a later launch is served from them. An emptied
 * state could still generate a map — one with no program in it — so this
 * marks the state instead of trusting callers to stop.
 */
export function releaseGeneratedSources(vfsState) {
    vfsState.bundleSource = undefined;
    vfsState.generatedSourcesReleased = true;
}
/**
 * The module-map source for a state, memoized form first.
 *
 * A released state has neither form left, and rebuilding from its emptied raw
 * cells would silently generate a module map with no modules in it — which
 * surfaces inside the facet as "Cannot find module" for the whole require
 * closure, a long way from the cause. Say so here instead.
 */
async function facetVfsBundleSourceFor(vfsState, pacer) {
    if (vfsState.generatedSourcesReleased) {
        throw new Error('Nimbus: this facet VFS state was released after its module map was generated; '
            + 'it cannot generate a second one');
    }
    return vfsState.bundleSource
        ?? await buildFacetVfsBundleSource(vfsState.bundle, vfsState.bundleSideModulesRequired, pacer, { emits: vfsState.emits, lowered: vfsState.lowered, codeOnly: vfsState.codeOnly });
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
async function _readBundleCell(vfs, path) {
    const bytes = await filesOf(vfs).readBytes(path);
    if (bytes === null)
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT', path });
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
/** A cell's raw bytes: UTF-8 for text, as the file is on disk. */
function _bundleCellRawBytes(cell) {
    if (cell instanceof Uint8Array)
        return cell.byteLength;
    return typeof cell === 'string' ? _encodedSourceBytes(cell) : 0;
}
function _bundleCellLength(cell) {
    return typeof cell === 'string' ? cell.length : cell.byteLength;
}
/**
 * Pre-read admission check for a bundle candidate: refuse BEFORE reading
 * when the file's on-disk size already exceeds the remaining bundle budget
 * or the caller's per-file ceiling. Without this every helper read a file
 * in full, then discarded it when the post-read `cellLen` check tripped —
 * on trees with several 5–10 MiB artifacts that read alone was the memory
 * pressure that reset the isolate.
 *
 * `perFileCeiling` is the pass's own cap (e.g. CWD_SNAPSHOT_MAX_FILE_BYTES,
 * BIN_PACKAGE_SPECULATIVE_MAX_FILE_BYTES); omit it for budget-only checks.
 */
async function _bundleAdmits(vfs, path, budgetState, perFileCeiling) {
    const stat = await filesOf(vfs).lstat(path).catch(() => null);
    if (stat === null)
        return false;
    const size = stat.size;
    if (perFileCeiling !== undefined && size > perFileCeiling)
        return false;
    return budgetState.totalBytes + size <= VFS_BUNDLE_MAX_BYTES;
}
/** What a bundle currently weighs, and so what one more pass over it costs. */
function _bundleWeight(bundle) {
    let weight = 0;
    for (const cell of Object.values(bundle))
        weight += _bundleCellLength(cell);
    return weight;
}
/**
 * Supervisor-heap cost of a FacetVfsState the prefetch LRU is holding on to.
 *
 * `releaseSerializedSources` normally leaves only the serialized source,
 * manifest and metadata behind. Every representation actually present is
 * counted anyway, so the bound stays correct if that release policy changes:
 * counting only the raw cells would under-report a both-forms entry by about
 * half, which is how a count-bounded LRU came to look affordable.
 */
function retainedVfsStateBytes(state) {
    let bytes = 0;
    for (const [path, cell] of Object.entries(state.bundle)) {
        bytes += path.length;
        if (typeof cell === 'string' || cell instanceof Uint8Array)
            bytes += _bundleCellLength(cell);
    }
    for (const [path, emit] of state.emits ?? [])
        bytes += path.length + emit.length;
    for (const path of state.lowered ?? [])
        bytes += path.length;
    for (const path of state.codeOnly ?? [])
        bytes += path.length;
    const source = state.bundleSource;
    if (source) {
        bytes += source.expression.length + source.imports.length + source.codeCells.length + source.runtimeCode.length;
        for (const moduleSource of Object.values(source.modules))
            bytes += moduleSource.length;
        for (const [name, text] of Object.entries(source.codeModules))
            bytes += name.length + text.length;
    }
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
function _jsonEncodedBytes(value) {
    if (value instanceof Uint8Array) {
        let bytes = 2; // the surrounding braces
        let indexDigits = 1;
        let nextIndexWidth = 10;
        for (let index = 0; index < value.byteLength; index++) {
            if (index === nextIndexWidth) {
                indexDigits++;
                nextIndexWidth *= 10;
            }
            if (index > 0)
                bytes += 1; // comma
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
        if (code === 0x22 || code === 0x5c) {
            bytes += 2;
            continue;
        } // " \
        if (code < 0x20) {
            // \b \t \n \f \r get a two-character escape; every other C0 gets \u00XX.
            bytes += (code === 8 || code === 9 || code === 10 || code === 12 || code === 13) ? 2 : 6;
            continue;
        }
        if (code < 0x80) {
            bytes += 1;
            continue;
        }
        if (code < 0x800) {
            bytes += 2;
            continue;
        }
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
            // A well-formed pair is one 4-byte code point; a lone surrogate is
            // escaped as \uXXXX (JSON.stringify is well-formed since ES2019).
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                i++;
            }
            else {
                bytes += 6;
            }
            continue;
        }
        if (code >= 0xdc00 && code <= 0xdfff) {
            bytes += 6;
            continue;
        }
        bytes += 3;
    }
    return bytes;
}
/** `{"bundle":` + `}`: the frame around the one member. */
const ENCODED_PAYLOAD_FRAME_BYTES = 11;
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
export function encodedBundleSize(bundle) {
    const cells = new Map();
    let cellSum = 0;
    const self = {
        add(path, cell) {
            if (cells.has(path))
                return;
            const bytes = _jsonEncodedBytes(path) + 1 + _jsonEncodedBytes(cell);
            cells.set(path, bytes);
            cellSum += bytes;
        },
        remove(path) {
            const bytes = cells.get(path);
            if (bytes === undefined)
                return;
            cells.delete(path);
            cellSum -= bytes;
        },
        get bytes() {
            const separators = Math.max(0, cells.size - 1);
            return ENCODED_PAYLOAD_FRAME_BYTES + 2 + cellSum + separators;
        },
    };
    for (const [path, cell] of Object.entries(bundle))
        self.add(path, cell);
    return self;
}
/**
 * Bounded `path (N bytes)` listing, largest first. A snapshot diagnostic has
 * to name the files it is talking about — the facet's own error for a missing
 * one is an unattributable "Cannot find module" — without printing a bundle
 * that can run to thousands of entries.
 */
function describeBundleCells(cells, limit = 8) {
    const shown = [...cells].sort((a, b) => b[1] - a[1]).slice(0, limit);
    const rest = cells.length - shown.length;
    return shown.map(([path, bytes]) => `${path} (${bytes} bytes)`).join(', ') + (rest > 0 ? `, +${rest} more` : '');
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
const FACET_VFS_MODULE_PREFIX = '__nimbus_vfs_bundle_';
const FACET_VFS_MODULE_SOURCE_MARGIN = 1024;
/**
 * UTF-8 byte length of a generated module source, counted rather than
 * materialized.
 *
 * `new TextEncoder().encode(source).length` answers the same question by
 * allocating a second full copy of the string and then reading one number off
 * it. For pi's inline bundle expression that is an 18.26 MB Uint8Array, live
 * on the session DO beside the 18.26 MB string it measures, whose only use is
 * its own `.length` — and the encode also flattens the string it is given,
 * so a rope the template builder had not yet paid for becomes flat too.
 *
 * Same discipline `_jsonEncodedBytes` already applies to the snapshot:
 * sizing something never allocates a copy of it. Exactly equivalent to the
 * encoder, including its replacement of an unpaired surrogate with U+FFFD.
 */
function _encodedSourceBytes(source) {
    let bytes = 0;
    for (let i = 0; i < source.length; i++) {
        const code = source.charCodeAt(i);
        if (code < 0x80) {
            bytes += 1;
            continue;
        }
        if (code < 0x800) {
            bytes += 2;
            continue;
        }
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = i + 1 < source.length ? source.charCodeAt(i + 1) : 0;
            // A well-formed pair is one 4-byte code point; a lone surrogate is
            // encoded as U+FFFD, which is three bytes — same as the default below.
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                i++;
                continue;
            }
        }
        bytes += 3;
    }
    return bytes;
}
function _facetBundleModuleSource(bundle) {
    return `export default ${_serializeBundleForFacet(bundle)};`;
}
/**
 * Byte cost of the serializer's fixed scaffolding: the IIFE and the three
 * empty literals it always emits, with and without the `export default …;`
 * a side module wraps it in. Measured off the serializer itself so the
 * counts and the thing they count cannot drift.
 */
const _FACET_INLINE_ENVELOPE_BYTES = _encodedSourceBytes(_serializeBundleForFacet({}));
const _FACET_MODULE_ENVELOPE_BYTES = _encodedSourceBytes(_facetBundleModuleSource({}));
/**
 * What one cell adds to a generated bundle source, counted rather than built.
 *
 * `_serializeBundleForFacet` sorts a cell into one of three literals — the
 * text map, the base64 map, or the denied-path array — and each is a plain
 * JSON encoding, so a cell's contribution is additive and knowable without
 * materializing anything. Base64 is pure ASCII of a length fixed by the
 * source byte count, so a binary cell can be sized without being encoded.
 *
 * Sizing a bundle used to mean serializing it: the caller built the whole
 * 22.9 MB source, read `.length` off it, and threw it away — three times per
 * pi launch, once whole and twice more per-cell inside the split loop.
 */
function _facetBundleCellBytes(path, cell) {
    if (typeof cell === 'string') {
        return _jsonEncodedBytes(path) + 1 + _jsonEncodedBytes(cell);
    }
    if (cell instanceof Uint8Array) {
        return _jsonEncodedBytes(path) + 1 + 4 * Math.ceil(cell.byteLength / 3) + 2;
    }
    // A denial cell rides in the path array, which carries no key.
    return _jsonEncodedBytes(path);
}
/** Encoded size of the inline bundle expression, without building it. */
function _inlineBundleSourceBytes(bundle) {
    let bytes = _FACET_INLINE_ENVELOPE_BYTES;
    const counts = { str: 0, bin: 0, denied: 0 };
    for (const [path, cell] of Object.entries(bundle)) {
        bytes += _facetBundleCellBytes(path, cell);
        if (typeof cell === 'string')
            counts.str++;
        else if (cell instanceof Uint8Array)
            counts.bin++;
        else
            counts.denied++;
    }
    // One separator between siblings in each of the three literals.
    for (const n of Object.values(counts))
        if (n > 1)
            bytes += n - 1;
    return bytes;
}
/**
 * Whether a bundle cell at `path` is one the process can require as code:
 * `.js`, `.mjs`, `.cjs`, and extensionless files — the shape of nearly every
 * npm `bin` script. A TypeScript source is code through its emit instead.
 */
function isCodeCellPath(path) {
    const ext = vfsPathExtension(path);
    return ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '';
}
/**
 * Serialize a VFS bundle for Worker Loader without dropping required files.
 *
 * Every code cell becomes its own `{ cjs }` module (commonjs-cell.ts), which
 * the guest's registry compiles the first time the program requires it. A
 * file that is its own module is carried once, as that module: the process's
 * store adopts the file by reading the module back, so the cell is never also
 * data — except where the read-back cannot name it (commonJsCellReadsBack).
 * A cell whose module is an emit (a transform changed it) is never read back,
 * since the emit is not the file: its file is data when it was staged to be
 * read, or is not carried at all (`codeOnly`).
 *
 * The data cells stay one bundle. Small bundles remain inline. Large bundles
 * are partitioned into side modules below the existing per-module encoded
 * ceiling and merged during module evaluation. A single oversized cell is
 * split into ordered fragments; the merge expression concatenates those
 * fragments back to the original string or Uint8Array.
 */
export async function buildFacetVfsBundleSource(bundle, forceSideModules = false, pacer, { consume = false, emits, lowered, codeOnly, runtimeCode, } = {}) {
    const storageBytes = moduleMapStorageBytes(bundle, codeOnly);
    const codeModules = {};
    const rows = [];
    for (const [key, text] of runtimeCode ?? [])
        codeModules[runtimeCodeModuleName(key)] = text;
    // `consume`: the caller releases the raw cells right after (a launch's
    // build), so each is taken as its module is written and the map is never
    // held twice. Otherwise the caller's bundle is left as it was.
    const data = consume ? bundle : {};
    for (const path of Object.keys(bundle)) {
        const cell = bundle[path];
        const emit = emits?.get(path);
        const code = emit ?? (typeof cell === 'string' && isCodeCellPath(path) ? cell : undefined);
        const adopt = code !== undefined && emit === undefined && commonJsCellReadsBack(path);
        if (code !== undefined) {
            const wrapped = wrapCommonJsCell(code, lowered?.has(path) ? 'block' : 'function');
            const name = commonJsCellModuleName(path);
            // TypeScript is lowered too, and keeps CommonJS's names (bundle-cell-transform.ts).
            const esModule = lowered?.has(path) === true && bundleTypescriptLoader(path) === null;
            codeModules[name] = wrapped.text;
            rows.push([path, name, wrapped.head, wrapped.tail, wrapped.hashbang ? 1 : 0, adopt ? 1 : 0, esModule ? 1 : 0]);
            if (pacer)
                await pacer.spend(code.length);
        }
        if (adopt || codeOnly?.has(path)) {
            if (consume)
                delete bundle[path];
        }
        else if (!consume) {
            data[path] = cell;
        }
    }
    return {
        ...await serializeFacetVfsData(data, forceSideModules, pacer, consume),
        codeModules,
        codeCells: JSON.stringify(rows),
        runtimeCode: JSON.stringify([...(runtimeCode?.keys() ?? [])]),
        storageBytes,
    };
}
async function serializeFacetVfsData(bundle, forceSideModules, pacer, consume) {
    // Consumed, side modules always: an inline expression is copied again into
    // the runner's own source.
    if (consume)
        forceSideModules = true;
    // Size the inline form before building it. A bundle that will be split has
    // no use for the whole-bundle expression, and building one to read its
    // length off cost a second full copy of the largest string this DO makes.
    if (!forceSideModules
        && _inlineBundleSourceBytes(bundle) <= BUNDLE_MAX_ENCODED_BYTES) {
        return { expression: _serializeBundleForFacet(bundle), imports: '', modules: {} };
    }
    if (Object.keys(bundle).length === 0) {
        return { expression: _serializeBundleForFacet(bundle), imports: '', modules: {} };
    }
    const maxModuleBytes = BUNDLE_MAX_ENCODED_BYTES - FACET_VFS_MODULE_SOURCE_MARGIN;
    function sourceBytes(path, cell) {
        return _FACET_MODULE_ENVELOPE_BYTES + _facetBundleCellBytes(path, cell);
    }
    function splitCell(path, cell) {
        if (sourceBytes(path, cell) <= maxModuleBytes)
            return [[path, cell]];
        if (typeof cell !== 'string' && !(cell instanceof Uint8Array)) {
            throw new Error(`Nimbus: VFS denial cell path exceeds facet module limit: ${path}`);
        }
        const pieces = [];
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
                }
                else {
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
    const modules = {};
    const imports = [];
    const aliases = [];
    let chunk = {};
    let chunkPaths = [];
    let estimatedBytes = 0;
    // A chunk becomes its side module the moment it is full, so the cells it
    // carries and their serialization are never both held for the whole map:
    // consumed, a cell leaves the bundle as its module is written.
    async function flushChunk() {
        // Pieces of a split cell fill chunks before the cell's path is complete,
        // so emptiness is the chunk's own, not its finished paths'.
        if (estimatedBytes === 0)
            return;
        const index = aliases.length;
        const moduleName = `${FACET_VFS_MODULE_PREFIX}${index}.js`;
        const alias = `__nimbusVfsBundle${index}`;
        const source = _facetBundleModuleSource(chunk);
        if (_encodedSourceBytes(source) > BUNDLE_MAX_ENCODED_BYTES) {
            throw new Error(`Nimbus: generated VFS side module exceeds encoded limit: ${moduleName}`);
        }
        modules[moduleName] = source;
        imports.push(`import ${alias} from "${moduleName}";`);
        aliases.push(alias);
        if (consume)
            for (const path of chunkPaths)
                delete bundle[path];
        chunk = {};
        chunkPaths = [];
        estimatedBytes = 0;
        // Each side module is an independent serialization of its own cells, so
        // the turn may end between any two of them.
        if (pacer)
            await pacer.spend(source.length);
    }
    for (const path of Object.keys(bundle)) {
        const cell = bundle[path];
        for (const [piecePath, pieceCell] of splitCell(path, cell)) {
            const pieceBytes = sourceBytes(piecePath, pieceCell);
            if (piecePath in chunk
                || (estimatedBytes > 0 && estimatedBytes + pieceBytes > maxModuleBytes)) {
                await flushChunk();
            }
            chunk[piecePath] = pieceCell;
            estimatedBytes += pieceBytes;
        }
        chunkPaths.push(path);
    }
    await flushChunk();
    const expression = `(function(__parts){const __out={};for(const __part of __parts){` +
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
export function assertStagedBundleFitsRpcPayload(serialized, bundle) {
    const bytes = _encodedSourceBytes(serialized);
    if (bytes <= MAX_RPC_SAFE_PAYLOAD_BYTES)
        return;
    const cells = Object.entries(bundle)
        .map(([path, cell]) => [
        path,
        typeof cell === 'string' || cell instanceof Uint8Array ? _bundleCellLength(cell) : 0,
    ]);
    throw new Error(`Nimbus: staged facet VFS snapshot serializes to ${bytes} bytes, over the `
        + `${MAX_RPC_SAFE_PAYLOAD_BYTES}-byte RPC payload ceiling. Largest members: `
        + `${describeBundleCells(cells)}`);
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
export async function greedyAddMainEntries(vfs, cwd, bundle, budgetState, requiredPaths = new Set(), options = {}) {
    let added = 0;
    const groups = [];
    const bound = Math.min(options.maxBundleBytes ?? VFS_BUNDLE_MAX_BYTES, VFS_BUNDLE_MAX_BYTES);
    const independent = new Set(Object.keys(bundle));
    let rawBytes = 0;
    for (const cell of Object.values(bundle))
        rawBytes += _bundleCellRawBytes(cell);
    if (rawBytes >= bound)
        return { added, groups };
    const cwdStripped = cwd.replace(/^\/+/, '');
    const nmDir = cwdStripped + '/node_modules';
    if (!((await filesOf(vfs).exists(nmDir)) && (await filesOf(vfs).isDirectory(nmDir))))
        return { added, groups };
    const exts = ['', '.js', '.cjs', '.mjs', '/index.js', '/index.cjs'];
    // What the admitted groups defer with `import()`; a group does not walk them.
    const deferred = [];
    async function addOne(path) {
        const stripped = path.replace(/^\/+/, '');
        if ((isBundleModuleCandidate(stripped) || stripped.endsWith('.cjs')) && !isNativeBinPath(stripped)) {
            if (independent.has(stripped))
                return false;
            if (bundle[stripped] === undefined && !(await _bundleAdmits(vfs, stripped, budgetState, BIN_PACKAGE_SPECULATIVE_MAX_FILE_BYTES)))
                return false;
            const closure = await prefetchForRequire(requireFsOverBridge(vfs), '', stripped.slice(0, stripped.lastIndexOf('/')), '/' + stripped, bound, options.pacer?.spend.bind(options.pacer), {
                purpose: 'dependency-closure', held: bundle,
                maxAdditionalBytes: Math.max(0, bound - rawBytes),
                maxAdditionalFiles: Math.max(0, VFS_BUNDLE_MAX_FILES - budgetState.fileCount),
            });
            if ('kind' in closure || closure.bundle[stripped] === undefined)
                return false;
            for (const deferral of closure.deferred ?? [])
                if (deferral.alternatives === 1)
                    deferred.push(deferral);
            for (const [member, cell] of Object.entries(closure.bundle)) {
                if (bundle[member] !== undefined)
                    continue;
                bundle[member] = cell;
                rawBytes += _bundleCellRawBytes(cell);
                budgetState.totalBytes += _bundleCellLength(cell);
                budgetState.fileCount++;
                added++;
            }
            groups.push({ root: stripped, members: new Set(Object.keys(closure.bundle)) });
            return true;
        }
        if (stripped in bundle)
            return false;
        if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES)
            return false;
        if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES)
            return false;
        try {
            if (!(await filesOf(vfs).exists(stripped)) || (await filesOf(vfs).isDirectory(stripped)))
                return false;
            // This is a guess at what a program might require, and the same
            // per-file ceiling the entry-package walk applies bounds it: a
            // multi-MiB main entry is an alternative bundle (typescript's 8.69 MiB
            // `lib/typescript.js` beside the `lib/tsc.js` that actually runs), and
            // one guess must not spend a third of the budget — and a third of the
            // supervisor's headroom — on every invocation that never reads it.
            // Literal dependencies use the closure's byte allowance, not this
            // speculative-root per-file ceiling.
            if (!(await _bundleAdmits(vfs, stripped, budgetState, BIN_PACKAGE_SPECULATIVE_MAX_FILE_BYTES)))
                return false;
            // A guess must not be a native binary. Nothing in a Workers isolate can
            // load a `.node` addon or a `.exe` — the ABI policy classifies them
            // native-unsupported and the installer says so at install time — so
            // admitting one spends the budget on bytes no code path can reach.
            // Measured: freeing 1.3 MiB of rollup let `@napi-rs/lzma-linux-x64-gnu`'s
            // 1,445,448-byte `.node` in, which the size guard had been evicting.
            // Only the guess is filtered; a path the closure requires is untouched.
            if (isNativeBinPath(stripped))
                return false;
            // hardening-r5: preserve binary content as Uint8Array.
            const stat = await filesOf(vfs).stat(stripped);
            if (stat === null || rawBytes + stat.size > bound)
                return false;
            const content = (await _readBundleCell(vfs, stripped));
            const cellLen = _bundleCellLength(content);
            const raw = _bundleCellRawBytes(content);
            if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES || rawBytes + raw > bound)
                return false;
            bundle[stripped] = content;
            rawBytes += raw;
            budgetState.totalBytes += cellLen;
            budgetState.fileCount++;
            added++;
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Whether guessing at `pkgDir`'s main entry is still a guess.
     *
     * It is, for a package nothing required: that is what this pass exists for,
     * and a dynamic `require(variable)` leaves no edge to follow. It is NOT for
     * a package the closure reached only through a subpath export — there the
     * program has told us exactly which corner of the package it uses, and the
     * main entry is a different graph that no require reaches. Adding it anyway
     * is how `rollup/parseAst` (7.9 KB of binding) dragged in rollup's whole
     * bundler: `dist/shared/rollup.js` at 941 KB and, through the `module`
     * candidate, `dist/es/shared/node-entry.js` at 951 KB — measured together
     * as 46.5% of a real-vite snapshot, reached by no require in it.
     *
     * A package that loads its own main from a subpath at runtime does so
     * through a static edge, so it is in the closure and unaffected.
     */
    function mainIsSpeculative(pkgDir) {
        const prefix = pkgDir.replace(/^\/+/, '') + '/';
        let reached = false;
        for (const path of requiredPaths) {
            if (!path.startsWith(prefix))
                continue;
            // package.json alone is resolution metadata, not a use of the package.
            if (path === prefix + 'package.json')
                continue;
            reached = true;
            break;
        }
        return !reached;
    }
    async function addPkgEntry(pkgDir) {
        const manifest = (pkgDir + '/package.json').replace(/^\/+/, '');
        if (bundle[manifest] === undefined && !(await addOne(manifest)))
            return;
        // A package the closure reached keeps exactly what it reached; only an
        // unreached one gets the guess below.
        if (!mainIsSpeculative(pkgDir))
            return;
        // Malformed JSON, or a package whose entry fields the resolver cannot
        // read (`main: 7`, `exports: true`) drops that field and keeps the rest;
        // unparseable JSON is a package with no declared entry. Either way the
        // next package is unaffected.
        let pkg;
        try {
            const text = bundle[manifest];
            pkg = typeof text === 'string' ? parseResolvablePackageJson(text) : null;
        }
        catch {
            pkg = null;
        }
        // The root entry a bare require of this package resolves to, in the
        // order the runtime resolves it (require-resolver.ts resolvePkgSubpathEx):
        // exports under the CJS conditions, then the ESM ones, then legacy main,
        // then an index probe, each tried until one lands. A denied root
        // (`"." : null`) resolves to nothing and falls through the same way. A
        // hand-rolled walk of `exports["."]` read nothing from a root conditional
        // map (on-change@6: `{ types, default }`, no ".", no main) and guessed
        // `index.js`, which does not exist.
        const candidates = [];
        if (pkg) {
            let entry = resolvePackageEntry(pkg, '.', DEFAULT_CJS_CONDITIONS);
            if (entry === null && pkg.exports != null)
                entry = resolvePackageEntry(pkg, '.', DEFAULT_ESM_CONDITIONS);
            if (entry !== null)
                candidates.push(entry);
            if (pkg.main !== undefined)
                candidates.push(pkg.main);
        }
        candidates.push('index.js');
        for (const rel of candidates) {
            const norm = rel.replace(/^\.\//, '');
            const base = pkgDir + '/' + norm;
            let landed = false;
            const tries = /\.[a-z]+$/.test(norm) ? [base] : exts.map((e) => base + e);
            for (const candidate of tries) {
                if ((await filesOf(vfs).exists(candidate.replace(/^\/+/, ''))) &&
                    !(await filesOf(vfs).isDirectory(candidate.replace(/^\/+/, '')))) {
                    if ((await addOne(candidate))) {
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
                // The static walker cannot discover computed hash-chunk imports, so
                // the greedy oversample is the safety net for their reachability.
                const entryDir = base.replace(/\/[^/]+$/, '');
                {
                    const sibs = await (async () => vfs.readdir(entryDir))().catch(() => []);
                    for (const sib of sibs) {
                        if ((await launchEntryType(vfs, entryDir, sib)) !== 'file')
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
                        (await addOne(entryDir + '/' + sib.name));
                    }
                    // Walk one level into `shared/` — unconditionally, since the
                    // pattern is well-known across unbuild/rolldown/rollup chunked
                    // outputs. Bounded by addOne's budget checks; readdir of a
                    // typical shared/ dir returns 1-5 files.
                    const sharedDir = entryDir + '/shared';
                    const sharedStripped = sharedDir.replace(/^\/+/, '');
                    if (await (async () => filesOf(vfs).isDirectory(sharedStripped))().catch(() => false)) {
                        for (const sh of await (async () => vfs.readdir(sharedDir))().catch(() => [])) {
                            if ((await launchEntryType(vfs, sharedDir, sh)) !== 'file')
                                continue;
                            if (!/\.(cjs|mjs|js)$/.test(sh.name))
                                continue;
                            (await addOne(sharedDir + '/' + sh.name));
                        }
                    }
                }
                break;
            }
        }
    }
    for (const pkgDir of (await speculativePackageDirs(vfs, cwdStripped, bundle)))
        (await addPkgEntry(pkgDir));
    // Then the one `import()` a guessed module defers, when it defers only one
    // and it is a file of its own package, as a guess of its own with its static
    // closure; what that defers joins the queue. That is how a package proxies
    // or splits its own code, and it loads whenever the deferring code runs:
    // vinext imports @vitejs/plugin-rsc by a computed URL (a guess here, as a
    // project dependency); plugin-rsc imports vitefu, whose CommonJS entry loads
    // its ESM build with `import('./index.js')`. A module that defers several
    // chooses among them, and a deferral of another package is an optional
    // dependency (@vercel/og's `import("sharp")`, caught when absent, whose
    // 9.2 MB wasm image the launch would compile): a guess does not guess those.
    const followed = new Set();
    for (let i = 0; i < deferred.length; i++) {
        if (rawBytes >= bound || budgetState.fileCount >= VFS_BUNDLE_MAX_FILES)
            break;
        const target = await resolveDeferredImport(requireFsOverBridge(vfs), deferred[i], options.pacer?.spend.bind(options.pacer));
        // Its own package: where the deferral lands, not how it is spelled.
        const own = packageRootOf(deferred[i].fromDir.replace(/^\/+/, '') + '/_');
        if (target === null || own === null || packageRootOf(target) !== own || followed.has(target))
            continue;
        followed.add(target);
        await addOne(target);
    }
    return { added, groups };
}
/**
 * The packages a name resolved at runtime — a computed `require(name)`, or a
 * resolver call like exsolve's `resolveModulePath(name, { from: rootDir })` —
 * can plausibly reach: every package ONE `dependencies` hop from a package
 * the project itself declares or that owns a file in the static closure, plus
 * those roots themselves. Never devDependencies, never a second hop.
 *
 * Unbounded, the greedy oversample read every installed package's main:
 * for `node -e "import('got')"` in got's repo — a one-file static closure —
 * that was 1,526 files / 10.9 MB from 706 packages, which every later pass
 * re-scanned and esbuild-wasm transformed, and the exec path's 20 s bundle
 * deadline fired on a program that reads none of it. A bound that followed
 * dependency edges from the project's devDependencies reached all 772 of
 * them (measured), because a library repo's dev toolchain reaches the whole
 * tree. Computed requires almost always target a declared runtime
 * dependency of the package doing the requiring, so the bound is one hop
 * over `dependencies` only. Directories, sorted for a stable bundle.
 *
 * The project's own dependencies are hop ROOTS and not merely members,
 * because a bin runs inside the project and resolves from the project root,
 * where what it names is its host framework's runtime peer rather than
 * anything its own package declares. Measured on staging, `nuxt dev` on a
 * `nuxi init` project: npm points `node_modules/.bin/nuxt` at
 * `@nuxt/cli/bin/nuxi.mjs`, so `@nuxt/cli` owns the entry; `@nuxt/kit` is a
 * devDependency of `@nuxt/cli` and a dependency of `nuxt`, which the project
 * declares. Admitting `nuxt` without hopping from it left
 * `@nuxt/kit/package.json` unstaged, `readFileSync` raised EAGAIN inside
 * exsolve — which swallows every error — and the CLI reported
 * `Cannot resolve module "@nuxt/kit" (from: /home/user/nuxt-probe/mvp/)`.
 * One hop from each project dependency is what the project's own node_modules
 * was hoisted for; it is the same edge kind and the same single level the
 * owner hop already spends.
 */
export async function speculativePackageDirs(vfs, cwdStripped, bundle) {
    const runtimeDeps = async (pkgJsonPath) => {
        try {
            const meta = JSON.parse((await filesOf(vfs).readFileString(pkgJsonPath)));
            const names = new Set();
            for (const field of ['dependencies', 'optionalDependencies']) {
                const deps = meta?.[field];
                if (deps && typeof deps === 'object')
                    for (const name of Object.keys(deps))
                        names.add(name);
            }
            return [...names];
        }
        catch {
            return [];
        }
    };
    // The package that owns a bundle file: the last node_modules segment.
    const ownerOf = (path) => {
        const idx = path.lastIndexOf('/node_modules/');
        if (idx === -1)
            return null;
        const segs = path.slice(idx + '/node_modules/'.length).split('/');
        const name = segs[0]?.startsWith('@') ? segs.slice(0, 2).join('/') : segs[0];
        return name ? path.slice(0, idx + '/node_modules/'.length) + name : null;
    };
    // Resolve a bare name the way require does from `fromDir`: the nearest
    // node_modules up the tree that has it.
    const resolveDir = async (name, fromDir) => {
        let dir = fromDir;
        for (;;) {
            const candidate = dir + '/node_modules/' + name;
            if ((await filesOf(vfs).exists(candidate + '/package.json')))
                return candidate;
            const idx = dir.lastIndexOf('/');
            if (idx <= 0)
                return null;
            dir = dir.slice(0, idx);
        }
    };
    const reached = new Set();
    const hopped = new Set();
    // Returns what this hop landed on, so a root can be hopped from without
    // reading its manifest twice and without the caller tracking the edges.
    const hop = async (fromDir) => {
        if (hopped.has(fromDir))
            return [];
        hopped.add(fromDir);
        const landed = [];
        for (const name of (await runtimeDeps(fromDir + '/package.json'))) {
            const dir = (await resolveDir(name, fromDir));
            if (dir === null)
                continue;
            reached.add(dir);
            landed.push(dir);
        }
        return landed;
    };
    const projectDeps = (await hop(cwdStripped));
    const owners = new Set();
    for (const path of Object.keys(bundle)) {
        const owner = ownerOf(path);
        if (owner !== null)
            owners.add(owner);
    }
    for (const owner of owners) {
        reached.add(owner);
        (await hop(owner));
    }
    // The second kind of root: what the project declares. A bin resolving from
    // the project root reaches these packages' dependencies, and nothing else
    // in this function would — the project's dependency owns no staged file
    // when the bin that runs belongs to a sibling package.
    for (const dir of projectDeps)
        (await hop(dir));
    return [...reached].sort();
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
export async function addStaticReadFileAssets(vfs, cwd, bundle, budgetState) {
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
    async function addOneAsset(absPath) {
        const stripped = absPath.replace(/^\/+/, '');
        if (stripped in bundle)
            return false;
        if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES)
            return false;
        if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES)
            return false;
        try {
            if (!(await filesOf(vfs).exists(stripped)) || (await filesOf(vfs).isDirectory(stripped)))
                return false;
            if (!(await _bundleAdmits(vfs, stripped, budgetState)))
                return false;
            // hardening-r5: preserve binary content as Uint8Array.
            const content = (await _readBundleCell(vfs, stripped));
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
            (await addOneAsset(resolved));
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
 * (the namespace lists it). But the runtime
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
export async function addStaticReadFileDotfilesAndCompiled(vfs, cwd, bundle, budgetState) {
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
    async function addOneAsset(absPath) {
        const stripped = absPath.replace(/^\/+/, '');
        if (stripped in bundle)
            return false;
        if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES)
            return false;
        if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES)
            return false;
        try {
            if (!(await filesOf(vfs).exists(stripped)) || (await filesOf(vfs).isDirectory(stripped)))
                return false;
            if (!(await _bundleAdmits(vfs, stripped, budgetState)))
                return false;
            // hardening-r5: preserve binary content as Uint8Array.
            const content = (await _readBundleCell(vfs, stripped));
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
            (await addOneAsset(resolved));
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
export async function addBinTargetSiblings(vfs, scriptPath, bundle, budgetState, bundleProfile) {
    if (!scriptPath)
        return { added: 0, wasmPaths: [] };
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
        return { added: 0, wasmPaths: [] };
    const isScoped = segs[nmIdx + 1]?.startsWith('@');
    const pkgEnd = isScoped ? nmIdx + 3 : nmIdx + 2;
    if (pkgEnd > segs.length)
        return { added: 0, wasmPaths: [] };
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
    const candidates = [];
    // Every wasm image under the package, whatever its size: an image rides in
    // the module map by path and is compiled by the loader, so the bundle's
    // per-file cap does not apply to it (see FacetVfsState.wasmImages).
    const wasmPaths = [];
    const queue = [pkgRoot];
    while (queue.length > 0 && visited < MAX_PKG_FILES) {
        const dir = queue.shift();
        let entries;
        try {
            entries = (await vfs.readdir(dir));
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
            if ((await launchEntryType(vfs, dir, e)) === 'directory') {
                if (!shouldVisitBinPackageDirectory(pkgRoot, child, bundleProfile))
                    continue;
                queue.push(child);
                continue;
            }
            // File. Skip if already in bundle (the static walker beat us
            // to it) or outside this profile's package-data policy.
            if (!shouldIncludeBinPackageFile(pkgRoot, child, bundleProfile))
                continue;
            if (child.endsWith('.wasm'))
                wasmPaths.push(child);
            if (bundle[child] !== undefined)
                continue;
            const stat = await filesOf(vfs).lstat(child).catch(() => null);
            if (stat === null)
                continue;
            const size = stat.size;
            if (size > BIN_PACKAGE_SPECULATIVE_MAX_FILE_BYTES)
                continue;
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
        if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES)
            break;
        if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES)
            break;
        if (candidate.size > VFS_BUNDLE_MAX_BYTES - budgetState.totalBytes)
            continue;
        // hardening-r5: preserve binary content as Uint8Array.
        let content;
        try {
            content = (await _readBundleCell(vfs, candidate.path));
        }
        catch {
            continue;
        }
        const cellLen = _bundleCellLength(content);
        // A cell that does not fit must not abandon the walk: smallest-first
        // ordering means everything after it is smaller and may still fit.
        if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES)
            continue;
        bundle[candidate.path] = content;
        budgetState.totalBytes += cellLen;
        budgetState.fileCount++;
        added++;
    }
    return { added, wasmPaths };
}
/**
 * A string literal naming a `.wasm` file by a relative path: how a package
 * loads its image from beside its own module (`new URL('x.wasm',
 * import.meta.url)`, `path.join(__dirname, 'x.wasm')`).
 */
const RELATIVE_WASM_LITERAL_RE = /["'`]((?:\.{1,2}\/)*[\w@.-]+(?:\/[\w@.-]+)*\.wasm)["'`]/g;
/**
 * The wasm images a program's closure holds, by path and content digest.
 *
 * Three sources, one record: a `.wasm` cell the walk already staged (digested
 * from the cell, no second read); a `.wasm` file the bin-package pass saw but
 * did not stage because it is over the bundle's per-file cap — esbuild-wasm's
 * 11.9 MiB image is the motivating one; and a `.wasm` file a staged module
 * names by a relative literal, resolved against that module's directory —
 * the only way to find an image in a dependency the bin-package pass never
 * walks (lightningcss-wasm's 15.8 MiB `lightningcss_node.wasm`, which Vite 8
 * loads for CSS minification). A launch stages each as a module-map member
 * the loader compiles, registered under both keys, so the program's own
 * `new WebAssembly.Module(bytes)` is answered from the map whether it read
 * the bytes by path or carried them inline. A file that cannot be read is
 * left out; the seam's refusal names the module later.
 */
export async function collectClosureWasmImages(vfs, bundle, unstagedPaths) {
    const byPath = new Map();
    for (const [path, cell] of Object.entries(bundle)) {
        if (!path.endsWith('.wasm') || !(cell instanceof Uint8Array))
            continue;
        byPath.set(path, { vfsPath: '/' + stripLeadingSlashes(path), digest: wasmImageDigest(cell) });
    }
    const named = new Set(unstagedPaths);
    for (const [path, cell] of Object.entries(bundle)) {
        if (typeof cell !== 'string' || !cell.includes('.wasm'))
            continue;
        if (!(path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')))
            continue;
        // wasm-bindgen also uses a folded template/variable path. Reuse the
        // filesystem AST analysis rather than adding another string-pattern rule.
        for (const ref of findStaticFsReferences(cell, '/' + stripLeadingSlashes(path)).exact) {
            if (ref.path.endsWith('.wasm'))
                named.add(stripLeadingSlashes(ref.path));
        }
        const dir = stripLeadingSlashes(path).split('/').slice(0, -1);
        for (const match of cell.matchAll(RELATIVE_WASM_LITERAL_RE)) {
            const segments = [...dir];
            for (const segment of match[1].split('/')) {
                if (segment === '..')
                    segments.pop();
                else if (segment !== '.')
                    segments.push(segment);
            }
            named.add(segments.join('/'));
        }
    }
    for (const path of named) {
        if (byPath.has(path))
            continue;
        const digest = await streamedWasmImageDigest(vfs, path);
        if (digest === null)
            continue;
        byPath.set(path, { vfsPath: '/' + stripLeadingSlashes(path), digest });
    }
    return [...byPath.values()];
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
 *
 * `room` is what the snapshot bound leaves after what is already committed
 * (the static closure, and for learned entries this session's own misses), in
 * raw bytes: evidence fills that room and never pushes the snapshot past the
 * bound, so it can never be the reason a launch fails. `bytes` is what this
 * call staged, in the same unit.
 */
export async function addObservedReads(vfs, observed, bundle, requiredPaths, budgetState, room = Infinity, pacer) {
    if (!observed || observed.size === 0)
        return { added: 0, bytes: 0 };
    let bytes = 0;
    const candidates = [];
    for (const path of observed) {
        if (path === '')
            continue;
        // Already staged, but evictable: the evidence is what makes it required.
        if (bundle[path] !== undefined) {
            requiredPaths.add(path);
            continue;
        }
        const stat = await filesOf(vfs).lstat(path).catch(() => null);
        if (stat === null)
            continue;
        if (stat.type === 'directory')
            continue;
        candidates.push({ path, size: stat.size });
    }
    candidates.sort((a, b) => a.size - b.size);
    let added = 0;
    for (const candidate of candidates) {
        if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES)
            break;
        if (budgetState.totalBytes + candidate.size > VFS_BUNDLE_MAX_BYTES)
            continue;
        let content;
        try {
            content = (await _readBundleCell(vfs, candidate.path));
        }
        catch {
            continue;
        }
        const cellLen = _bundleCellLength(content);
        if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES)
            continue;
        const raw = _bundleCellRawBytes(content);
        if (bytes + raw > room)
            continue;
        bundle[candidate.path] = content;
        requiredPaths.add(candidate.path);
        bytes += raw;
        budgetState.totalBytes += cellLen;
        budgetState.fileCount++;
        added++;
    }
    // A module brings its static imports: learned one miss per launch, nuxt's
    // on-change alone would have cost a relaunch for each of its files.
    for (const path of observed) {
        if (!/\.[cm]?js$/.test(path) || bundle[path] === undefined)
            continue;
        const cell = bundle[path];
        const source = typeof cell === 'string' ? cell : new TextDecoder().decode(cell);
        const closure = await prefetchForRequire(requireFsOverBridge(vfs), source, '/' + path.slice(0, path.lastIndexOf('/')), '/' + path, undefined, pacer?.spend.bind(pacer));
        if ('kind' in closure)
            continue;
        for (const [dep, content] of Object.entries(closure.bundle)) {
            if (closure.speculative.has(dep))
                continue;
            if (bundle[dep] !== undefined) {
                requiredPaths.add(dep);
                continue;
            }
            const cellLen = _bundleCellLength(content);
            if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES)
                break;
            if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES)
                continue;
            const raw = _bundleCellRawBytes(content);
            if (bytes + raw > room)
                continue;
            bundle[dep] = content;
            requiredPaths.add(dep);
            bytes += raw;
            budgetState.totalBytes += cellLen;
            budgetState.fileCount++;
            added++;
        }
    }
    return { added, bytes };
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
 * Whether the facet's require path could ever load this cell AS A MODULE.
 *
 * Not a judgement about whether the file is useful — an evicted cell is a
 * real loss either way, since the synchronous read it exists for raises
 * EAGAIN. It is a judgement about what the loss can BREAK. A cell the loader
 * can resolve is one some other module may be importing, and losing it takes
 * every importer down with it; a cell it can never resolve is only ever read
 * as data, by whoever asked for that path specifically.
 *
 * Declaration files are the clean case, and the reason this is a suffix test
 * rather than a content one: `foo.d.ts` is consumed by a type checker and is
 * never the target of a `require`, so shedding one cannot orphan a module.
 * That does not contradict the list above keeping them admissible — a `.d.ts`
 * IS a legitimate runtime read for the one package that reads its own (tsc
 * and `lib.*.d.ts`). This decides only what goes FIRST once a bound has
 * already been breached and something has to.
 */
function _isLoadableModuleCell(path) {
    if (isTypescriptDeclarationFile(path))
        return false;
    const ext = vfsPathExtension(path);
    return ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.json'
        || ext === '.wasm' || ext === '' || bundleTypescriptLoader(path) !== null;
}
/**
 * Per-file ceiling for the speculative passes over installed packages: the
 * entry-package walk (`addBinTargetSiblings`) and the main-entry oversample
 * (`greedyAddMainEntries`).
 *
 * Everything the entry package needs in order to *run* arrives through the
 * require closure, which is uncapped and never evicted. These passes exist
 * only to catch what the static walker cannot see — data files, and modules
 * reached by a computed require — and those are small. Multi-MiB cells in a
 * package tree are overwhelmingly alternative bundles — typescript ships an
 * 8.69 MiB `lib/typescript.js` that `tsc` never reads — rather than data.
 *
 * So one speculative guess must not spend the budget every later invocation
 * then carries: the same reasoning as `CWD_SNAPSHOT_MAX_FILE_BYTES`, applied
 * to the package tree. A miss this causes is loud and self-repairing: the
 * facet reports the unstaged read and the next build stages it from the
 * residency ledger, which has no per-file rule.
 */
const BIN_PACKAGE_SPECULATIVE_MAX_FILE_BYTES = 4 * 1024 * 1024;
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
/** Directories the project snapshot never enters: dependencies, VCS, Nimbus's own state. */
const CWD_PROJECT_SKIP_DIRS = new Set(['node_modules', '.git', '.nimbus']);
/** The project tree a launch in `cwd` stages its working files from, as a key. */
function cwdProjectRoot(cwd) {
    return (cwd || '/home/user').replace(/^\/+/, '').replace(/\/+$/, '') || 'home/user';
}
/** Whether the file at `path` is in the project tree at `root`, as the snapshot walks it. */
function inCwdProject(root, path) {
    if (!path.startsWith(root + '/'))
        return false;
    return !path.slice(root.length + 1).split('/').slice(0, -1).some((name) => CWD_PROJECT_SKIP_DIRS.has(name));
}
async function addCwdProjectFiles(vfs, cwd, bundle, budgetState) {
    const root = cwdProjectRoot(cwd);
    const MAX_PROJECT_FILES = 512;
    let added = 0;
    let visited = 0;
    const queue = [root];
    while (queue.length > 0 && visited < MAX_PROJECT_FILES) {
        const dir = queue.shift();
        let entries;
        try {
            entries = (await vfs.readdir(dir));
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
            const isDirectory = (await launchEntryType(vfs, dir, e)) === 'directory';
            if (isDirectory && CWD_PROJECT_SKIP_DIRS.has(e.name))
                continue;
            const child = dir + '/' + e.name;
            if (isDirectory) {
                queue.push(child);
                continue;
            }
            if (bundle[child] !== undefined)
                continue;
            if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES)
                return { added };
            if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES)
                return { added };
            // Skip an oversized file before reading it: this walk guesses at what
            // the program might read, and one guess must not spend the budget (or
            // the supervisor's headroom) that every later invocation then carries.
            if (!(await _bundleAdmits(vfs, child, budgetState, CWD_SNAPSHOT_MAX_FILE_BYTES)))
                continue;
            let content;
            try {
                content = (await _readBundleCell(vfs, child));
            }
            catch {
                continue;
            }
            const cellLen = _bundleCellLength(content);
            if (cellLen > CWD_SNAPSHOT_MAX_FILE_BYTES)
                continue;
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
async function addEntryAbsPathReads(vfs, entryCode, bundle, budgetState) {
    let added = 0;
    // Capture absolute-path string literals. The path may not contain
    // the quote char; the surrounding regex strips line/block comments
    // first to avoid commented-out matches.
    // Path char set: alnum + dot + dash + slash + underscore. This
    // excludes spaces, glob chars, template syntax — all dynamic.
    const RX = /(['"`])(\/[A-Za-z0-9._\-\/]{1,510})\1/g;
    const REJECT_PREFIX = /^\/(proc|sys|dev|lib|lib64|boot|root)(\/|$)/;
    async function tryAdd(absPath) {
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
            if (!(await filesOf(vfs).exists(stripped)) || (await filesOf(vfs).isDirectory(stripped)))
                return;
            if (!(await _bundleAdmits(vfs, stripped, budgetState)))
                return;
            // hardening-r5: preserve binary content as Uint8Array.
            const content = (await _readBundleCell(vfs, stripped));
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
    async function scanOne(src) {
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
            (await tryAdd(literal));
        }
    }
    // Always scan entry code.
    (await scanOne(entryCode));
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
        (await scanOne(cell));
    }
    return { added };
}
/**
 * framework-fixes-F4 (2026-05-12): helper for the "esbuild unavailable
 * or fatally errored" paths. Walks the bundle for ESM-shaped files and
 * gives each a JS-valid diagnostic shim as its module (`placeEmit`), which
 * throws an informative Error at require-time.
 * Mirrors the per-file catch in transformEsmInBundle so the user gets the
 * same actionable error surface regardless of whether transform failed for
 * the whole batch or for one file.
 *
 * Does NOT touch non-ESM files, which run as the CommonJS they are.
 */
function _markBundleEsmAsFailed(bundle, placeEmit, packageTypeOf, reason) {
    for (const path of Object.keys(bundle)) {
        if (!isBundleModuleCandidate(path))
            continue;
        const src = bundle[path];
        if (typeof src !== 'string')
            continue;
        // A TypeScript source is never runnable as staged, so it always needs
        // the emit it cannot get; a JavaScript file only if it is ESM.
        if (bundleTypescriptLoader(path) !== null || looksLikeEsm(path, src, packageTypeOf(path)))
            placeEmit(path, esbuildDiagnosticShim(path, reason));
    }
}
/**
 * The package scope "type" of each JavaScript cell of `paths` it decides
 * the format of (a .js or extensionless file: module-format.ts), read
 * through the resolver's own lookup (require-resolution.ts
 * packageScopeType) once per directory, as a lookup by path.
 */
async function cellPackageTypes(vfs, paths) {
    const dirOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
    const byDir = new Map();
    for (const path of paths) {
        const ext = vfsPathExtension(path);
        if ((ext !== '.js' && ext !== '') || byDir.has(dirOf(path)))
            continue;
        byDir.set(dirOf(path), await packageScopeType(filesOf(vfs), dirOf(path)));
    }
    return (path) => byDir.get(dirOf(path)) ?? null;
}
/**
 * Transform every cell of the bundle that needs it (needsBundleCellTransform)
 * to CommonJS: transformBundleCells, over the bundle's cells, with the
 * launch's store and pacer. A module esbuild rejects becomes a diagnostic
 * shim that throws the reason when required (esbuildDiagnosticShim).
 *
 * Each result is the path's emit (`placeEmit`), to become its module cell,
 * and never the file: what a program reads is the file on disk, never the
 * launch's CommonJS rendering of it (tsc compiling its own project's
 * sources; a script patching an installed ES module and writing it back).
 *
 * Every cell lowered from ESM or compiled from TypeScript is added to
 * `lowered` (its module's block scope, commonjs-cell.ts THE WRAPPER).
 */
async function transformEsmInBundle(bundle, placeEmit, lowered, packageTypeOf, esbuild, pacer, store) {
    // Snapshot the cells first — transforms await; never iterate-and-mutate.
    const cells = [];
    for (const path of Object.keys(bundle)) {
        const source = bundle[path];
        const packageType = packageTypeOf(path);
        // hardening-r5: binary cells are not modules.
        if (typeof source === 'string' && needsBundleCellTransform(path, source, packageType))
            cells.push({ path, source, packageType });
    }
    return transformBundleCells(cells, { host: esbuild, store, pacer }, (path, result) => {
        placeEmit(path, result.code);
        if (result.lowered)
            lowered.add(path);
    });
}
/** A tool's config file: `<tool>.config.js|ts|mjs|cjs|mts|cts` (vite.config.ts, astro.config.mjs). */
const TOOL_CONFIG = /^(.+)\.config\.(?:c|m)?(?:j|t)s$/;
/**
 * The working dir's config files of the tool a launch runs. The tool
 * executes them (Vite bundles vite.config.ts and imports the result), so
 * what they import is code that nothing in the program's own graph names,
 * and a first run would miss it. They are optional roots: a command may
 * never read its config (`vite --version`), so a config graph past the
 * map's bound is cut, never a refusal. A config is the tool's when it is
 * named for the launched package or a package that one depends on (Astro
 * runs Vite, Vite runs PostCSS); a config of a tool the launch does not run
 * (eslint.config.js beside Vite) is not. What a config names by a string
 * (PostCSS's plugins) the tool loads by name: those join the walk's phase 2.
 */
export async function toolConfigRoots(vfs, cwd, scriptPath) {
    if (scriptPath === undefined)
        return [];
    // A bin is usually launched by its node_modules/.bin link.
    let script;
    try {
        script = await vfs.realpath(scriptPath);
    }
    catch {
        return [];
    }
    const root = packageRootOf(script.replace(/^\/+/, ''));
    if (root === null)
        return [];
    let manifest;
    try {
        manifest = JSON.parse(await filesOf(vfs).readFileString(root + '/package.json'));
    }
    catch {
        return [];
    }
    const tools = new Set(typeof manifest.name === 'string' ? [manifest.name] : []);
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        const named = manifest[field];
        if (named && typeof named === 'object')
            for (const name of Object.keys(named))
                tools.add(name);
    }
    let entries;
    try {
        entries = await vfs.readdir(cwd);
    }
    catch {
        return [];
    }
    const dir = cwd.replace(/^\/+/, '').replace(/\/+$/, '');
    return entries.flatMap((entry) => {
        const tool = entry.type === 'file' ? TOOL_CONFIG.exec(entry.name)?.[1] : undefined;
        return tool !== undefined && tools.has(tool) ? [{ path: (dir ? dir + '/' : '') + entry.name, config: true }] : [];
    });
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
export async function buildPrefetchBundle(vfs, options) {
    // This build accumulates raw VFS contents in the supervisor heap, and did it
    // with nothing watching: the estimator read 9.4 MiB while these bytes were
    // resetting the DO three times. Take the budget the enrichment passes are
    // allowed to spend, so a build queues behind other heavy work instead of
    // racing it, and attribute it so it lands under `prefetchBundleBytes` rather
    // than in the unattributed remainder.
    const lease = await acquireSupervisorAllocation(VFS_BUNDLE_MAX_BYTES);
    prefetchBundleStart(VFS_BUNDLE_MAX_BYTES);
    try {
        return await _buildPrefetchBundle(vfs, options);
    }
    finally {
        prefetchBundleEnd(VFS_BUNDLE_MAX_BYTES);
        lease.release();
    }
}
async function _buildPrefetchBundle(vfs, { scriptPath, cwd, entryCode, esbuild, bundleProfile = DEFAULT_FACET_BUNDLE_PROFILE, observedReads, pacer, maxBundleBytes = VFS_BUNDLE_MAX_BYTES, learnedFor, executedModules, transformStore, }) {
    // Read the cursor BEFORE the walk: a mutation that lands while the bundle
    // is being assembled must be reported as invalidated, not silently missed.
    const admitted = await vfs.acquire(null, 0);
    const cursor = { epoch: admitted.epoch, rev: admitted.rev };
    // Modules earlier runs executed belong to the complete required graph.
    // Adding them later as enrichment let final pruning remove one imported
    // sibling on every launch, so Nuxt/Vinext never reached a complete
    // executable map. A module that arrives with its text (Vite unlinks its
    // temporary config after loading it) is walked from that text. Files runs
    // only READ are observed reads below: data, never roots, whatever their
    // extension (Tailwind scans .js/.ts content files as text). The tool's
    // configs ride along, as optional roots (RequiredModuleRoot.config).
    const requiredRoots = [...await toolConfigRoots(vfs, cwd, scriptPath), ...executedModules ?? []];
    const prefetch = (await prefetchForRequire(requireFsOverBridge(vfs), entryCode || '', cwd, scriptPath, maxBundleBytes, pacer?.spend.bind(pacer), undefined, requiredRoots.length > 0 ? requiredRoots : undefined));
    if ('kind' in prefetch) {
        // A required closure larger than the bound can never launch as a
        // snapshot. Surface it as the process's own failure rather than a
        // build error: the caller maps it to exit 1 + stderr.
        throw new ClosureBoundExceededError(prefetch);
    }
    const bundle = { ...prefetch.bundle };
    const closurePaths = new Set(Object.keys(prefetch.bundle).filter((path) => !prefetch.speculative.has(path)));
    // Non-executable read evidence and other sessions' profiles may use only
    // the room the required executable graph leaves. Neither may displace it.
    const observedPaths = new Set();
    const learnedPaths = new Set();
    let room = maxBundleBytes;
    for (const path of closurePaths)
        room -= _bundleCellRawBytes(bundle[path]);
    let truncated = false;
    const budgetState = { totalBytes: 0, fileCount: 0 };
    // Each enrichment pass below re-scans the bundle accumulated so far, so a
    // pass costs about what the bundle currently weighs however little it adds
    // — which is why the cost reported here is the bundle's weight and not
    // `budgetState.totalBytes`, the enrichment's own running total. A pass that
    // admits nothing still reads everything. Reporting the weight is what makes
    // a large program's build cross turns — pi's passes each scan tens of MB —
    // while a small one never reaches a chunk bound and runs exactly as it
    // always did, with no suspension at all.
    const paceAfterPass = pacer
        ? () => pacer.spend(_bundleWeight(bundle))
        : () => Promise.resolve();
    // 1.5 Observed reads. Every pass below this line guesses what a program
    //     will read — from a call shape, a package layout, a string literal —
    //     and each of them is wrong for whatever it did not anticipate. These
    //     paths are not a guess: an earlier run of the same entry asked for
    //     them synchronously and the bundle did not have them. So they are
    //     admitted first, ahead of every guess, and they join the required set
    //     rather than the evictable one, because a file evicted here misses
    //     again on the next run and the loop never closes.
    // Other sessions' misses in the packages this closure can load
    // (read-profile.ts) are evidence of the same kind: a learned module joins
    // the module map with its imports, as this session's own misses do.
    const learned = learnedFor ? await learnedFor(Object.keys(bundle)).catch(() => []) : [];
    const own = await addObservedReads(vfs, observedReads ?? new Set(), bundle, observedPaths, budgetState, Math.max(0, room), pacer);
    room -= own.bytes;
    const learnedOnly = new Set(learned.filter((path) => !observedReads?.has(path) && !observedPaths.has(path)));
    await addObservedReads(vfs, learnedOnly, bundle, learnedPaths, budgetState, Math.max(0, room), pacer);
    for (const path of observedPaths)
        learnedPaths.delete(path);
    await paceAfterPass();
    // 2. Greedy oversample — every installed pkg's pkg.json + main.
    //    Catches dynamic-require / `bindings()` / plugin-loader cases the
    //    regex prefetch misses. Its budget is independent from the complete
    //    static require closure, which is correctness-critical.
    const independentBeforeGroups = new Set(Object.keys(bundle));
    const greedy = (await greedyAddMainEntries(vfs, cwd, bundle, budgetState, prefetch.entryPaths ?? closurePaths, { maxBundleBytes, pacer }));
    await paceAfterPass();
    // What the passes so far staged to run. Every pass below stages files to
    // be read, and so do the observed reads above.
    const stagedToRun = new Set(Object.keys(bundle));
    // 2.25 X.5-Z3: static-readFileSync asset prefetch. Scans every
    //      bundle .js/.mjs/.cjs source for the canonical jsdom shape:
    //
    //        fs.readFileSync(path.resolve(__dirname, "<rel>.css"), …)
    //
    //      and pulls the matched asset into the bundle. Without this,
    //      `default-stylesheet.css` (and similar runtime asset reads in
    //      tldts, parse5, lookup-table packages, mime-db, etc.) ENOENT
    //      at facet runtime even though the file is on VFS-disk + in
    const assetAdd = (await addStaticReadFileAssets(vfs, cwd, bundle, budgetState));
    void assetAdd;
    await paceAfterPass();
    // 2.27 X.5-U: dotfile + SWC-shape readFileSync sentinel prefetch.
    //      Sibling of `addStaticReadFileAssets` (X.5-Z3) — same call shape,
    //      different match space. Covers the SWC/TS-compiled
    //      `(0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, "<rel>"))`
    //      pattern AND filenames outside the Z3 ASSET_EXT whitelist
    //      (dotfiles, no-extension sentinels, "digest/hash/version/sha/md5"
    //      shapes). Motivating case: ts-jest's `.ts-jest-digest`. See
    const dotAdd = (await addStaticReadFileDotfilesAndCompiled(vfs, cwd, bundle, budgetState));
    void dotAdd;
    await paceAfterPass();
    // 2.30 G3 (runtime-pkg wave): bin-target sibling oversample. Pulls
    //      ALL files under the entry's package root (capped at 200) so
    //      bins like cowsay that readFileSync('cows/X.cow') at runtime
    //      find their data files. Existing greedy/asset/dotfile passes
    //      cover JS sources + a hardcoded ASSET_EXT list; this one
    //      catches custom extensions (.cow, .pem, .ttf, .wasm bundled
    //      as data, etc.) without needing a per-pkg whitelist.
    //      No-op when entry isn't inside node_modules.
    const binSiblingAdd = (await addBinTargetSiblings(vfs, scriptPath, bundle, budgetState, bundleProfile));
    await paceAfterPass();
    // 2.34 project-data snapshot: sync Node fs cannot await the
    // supervisor. Include a bounded snapshot of the current working tree
    // for common relative project-file reads while skipping dependency
    // and Nimbus cache directories. Async fs still uses live supervisor
    // reads and child-process staleness fallback.
    const cwdProjectAdd = (await addCwdProjectFiles(vfs, cwd, bundle, budgetState));
    void cwdProjectAdd;
    await paceAfterPass();
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
    const absScanAdd = (await addEntryAbsPathReads(vfs, entryCode || '', bundle, budgetState));
    void absScanAdd;
    await paceAfterPass();
    // 2.5 W3.5 Fix B: ESM→CJS transform pass. Walks `bundle`, sniffs each
    //     .js/.mjs for top-level import/export, runs esbuild's CJS transform
    //     on the matches, and keeps each result as the path's emit. Every cell
    //     reaches the guest as CommonJS (commonjs-cell.ts says why the registry
    //     cannot take the ES module itself).
    const emits = new Map();
    const lowered = new Set();
    // A file staged only to run carries its emit and not itself
    // (FacetVfsState.codeOnly): installed code is most of a map, and each ES
    // module carried twice would halve the closure the bound admits. One staged
    // to be read is carried as itself beside its emit: by a pass after the
    // module walk, because a run read it, or as a file of the working tree, the
    // project that tools read their sources and configs from (Vite bundling
    // vite.config.ts, tsc, a linter).
    const projectRoot = cwdProjectRoot(cwd);
    const codeOnly = new Set();
    const runOnly = (path) => stagedToRun.has(path) && !observedPaths.has(path) && !learnedPaths.has(path) && !inCwdProject(projectRoot, path);
    // A code-only file's cell is given its emit, the one string, the moment it
    // has one: the build never holds the file's bytes and its module both, and
    // what reads the cells for their code (bundleUsesNodeSqlite, the wasm and
    // binding scans) reads the module, which is all the map carries.
    const placeEmit = (path, code) => {
        emits.set(path, code);
        if (!runOnly(path))
            return;
        bundle[path] = code;
        codeOnly.add(path);
    };
    let transforms;
    const packageTypeOf = await cellPackageTypes(vfs, Object.keys(bundle).filter(isBundleModuleCandidate));
    if (esbuild) {
        // Transient failures propagate through the launch failure path before
        // serialization/cache/LOADER publication. Per-source verdicts still use
        // the lazy diagnostic cells installed by transformEsmInBundle.
        transforms = await transformEsmInBundle(bundle, placeEmit, lowered, packageTypeOf, esbuild, pacer, transformStore);
    }
    else {
        // No esbuild service was given: the ESM cells stage as diagnostics that
        // say so, rather than as source the registry rejects without a reason.
        _markBundleEsmAsFailed(bundle, placeEmit, packageTypeOf, 'no esbuild service was given to this launch');
    }
    // Each module's bundled records of the runtime's provided packages are
    // bound to them: the emit's, or the file's own when it is its module (a
    // TypeScript source never is). A file that changes has the result as its emit.
    for (const path of Object.keys(bundle)) {
        const cell = bundle[path];
        const code = emits.get(path) ?? (isBundleModuleCandidate(path) && bundleTypescriptLoader(path) === null ? cell : undefined);
        if (typeof code !== 'string')
            continue;
        await pacer?.spend(code.length);
        let bound;
        try {
            bound = rewriteProvidedCommonJsModules(code);
        }
        catch {
            // Unparseable: an emit stays as esbuild wrote it, and its require says
            // why; a file is not a module and has no records to bind (a LICENSE).
            continue;
        }
        if (bound !== code)
            placeEmit(path, bound);
    }
    await paceAfterPass();
    // 4. The snapshot's size guard, in the unit the session DO's memory was
    //    measured in and the require walk counts: raw bytes, a cell's UTF-8
    //    length (VFS_BUNDLE_MAX_BYTES, platform/limits.ts, unless the caller
    //    set its own). The per-module text limit is met by side modules and is
    //    not a reason to evict. Only
    //    OPTIONAL enrichment is evictable; the static require closure stays, and
    //    a closure past the bound by itself fails the launch by name.
    //
    //    Evicting an enrichment file is a real loss — the sync fs reads it
    //    exists for cannot fall back to the supervisor — so the paths that
    //    went are named rather than silently dropped.
    const size = encodedBundleSize(bundle);
    const rawBytes = new Map();
    let rawTotal = 0;
    for (const [path, cell] of Object.entries(bundle)) {
        const bytes = codeOnly.has(path) ? 0 : _bundleCellRawBytes(cell);
        rawBytes.set(path, bytes);
        rawTotal += bytes;
    }
    // A module's emit is part of what its path costs, beside its file when that is carried.
    for (const [path, emit] of emits) {
        const bytes = _encodedSourceBytes(emit);
        rawBytes.set(path, (rawBytes.get(path) ?? 0) + bytes);
        rawTotal += bytes;
    }
    if (rawTotal > maxBundleBytes) {
        // Only the walk's closure can fail a launch, and the path it names is the
        // one whose bytes (with its emit) crossed the bound, in walk order.
        let closureBytes = 0;
        let crossedAt = null;
        for (const path of closurePaths) {
            closureBytes += rawBytes.get(path) ?? 0;
            if (crossedAt === null && closureBytes > maxBundleBytes)
                crossedAt = path;
        }
        if (crossedAt !== null) {
            throw new ClosureBoundExceededError({
                kind: 'closure-exceeds-bound',
                entry: scriptPath ?? 'entry code',
                bytesSeen: closureBytes,
                bound: maxBundleBytes,
                lastPath: crossedAt,
            });
        }
        // An emit goes with its source: required when the source is.
        //
        // Order matters as much as the bound. Largest-first alone ranks a cell by
        // what it costs and never by what losing it costs: an admitted module and
        // the sibling it imports are both "optional", and shedding the sibling
        // leaves a module in the bundle that cannot load. On `astro dev` the
        // snapshot breached its bound by 591 files, and among the largest were
        // modules while 3,291 declaration files (never a require target) stayed.
        //
        // Unloadable cells first, then enrichment largest-first, then dynamic-import
        // subtrees last-discovered first, so a CLI's own `import()` deferral is shed last.
        const speculativeRank = new Map();
        for (const path of prefetch.speculative)
            speculativeRank.set(path, speculativeRank.size);
        const rankOf = (path) => speculativeRank.get(path) ?? -1;
        // Evidence goes after all enrichment: what others learned before this
        // session's own misses, each tier last-admitted first.
        const tierOf = (path) => closurePaths.has(path) ? 3 : observedPaths.has(path) ? 2 : learnedPaths.has(path) ? 1 : 0;
        const members = new Set();
        for (const group of greedy.groups)
            for (const path of group.members)
                members.add(path);
        const independent = new Set(Object.keys(bundle).filter(path => !members.has(path) || independentBeforeGroups.has(path)));
        const keptGroups = new Set(greedy.groups);
        const weight = (path) => rawBytes.get(path) ?? 0;
        const unitBytes = new Map();
        for (const group of greedy.groups) {
            let total = 0;
            for (const member of group.members)
                if (!independent.has(member))
                    total += weight(member);
            unitBytes.set(group.root, total);
            if (pacer)
                await pacer.spend(group.members.size * 256);
        }
        const lastAdmittedFirst = (tier) => [...tier].reverse().filter(path => independent.has(path));
        const enrichment = [...independent, ...greedy.groups.map(group => group.root)]
            .filter(path => tierOf(path) === 0)
            .sort((a, b) => {
            const loadable = (_isLoadableModuleCell(a) ? 1 : 0) - (_isLoadableModuleCell(b) ? 1 : 0);
            if (loadable !== 0)
                return loadable;
            const rankA = rankOf(a);
            const rankB = rankOf(b);
            if (rankA !== rankB)
                return rankA < 0 ? -1 : rankB < 0 ? 1 : rankB - rankA;
            return (unitBytes.get(b) ?? weight(b)) - (unitBytes.get(a) ?? weight(a));
        });
        const evictable = [...enrichment, ...lastAdmittedFirst(learnedPaths), ...lastAdmittedFirst(observedPaths)];
        async function retainedPaths() {
            const retained = new Set(independent);
            for (const group of keptGroups) {
                let work = 0;
                for (const path of group.members) {
                    retained.add(path);
                    work += path.length + 256;
                }
                if (pacer)
                    await pacer.spend(work);
            }
            return retained;
        }
        let retained = await retainedPaths();
        for (const path of evictable) {
            if (rawTotal <= maxBundleBytes)
                break;
            if (independent.delete(path)) {
                for (const group of keptGroups)
                    if (group.members.has(path))
                        keptGroups.delete(group);
            }
            else {
                for (const group of keptGroups)
                    if (group.root === path)
                        keptGroups.delete(group);
            }
            retained = await retainedPaths();
            rawTotal = 0;
            for (const path of retained)
                rawTotal += rawBytes.get(path) ?? 0;
        }
        const evicted = [];
        for (const k of Object.keys(bundle)) {
            if (retained.has(k))
                continue;
            evicted.push([k, rawBytes.get(k) ?? 0]);
            delete bundle[k];
            emits.delete(k);
            lowered.delete(k);
            codeOnly.delete(k);
            size.remove(k);
        }
        if (evicted.length > 0) {
            truncated = true;
            console.warn(`[facet-manager] prefetch snapshot exceeded ${maxBundleBytes} bytes; `
                + `evicted ${evicted.length} optional file(s). They still exist and `
                + `async reads still return them; synchronous reads raise EAGAIN: `
                + `${describeBundleCells(evicted)}`);
        }
    }
    const fileCount = Object.keys(bundle).length;
    const bundleSideModulesRequired = size.bytes > BUNDLE_MAX_ENCODED_BYTES;
    // Suppress lint: `greedy.added` is observed only via diagnostics.
    void greedy;
    const wasmImages = (await collectClosureWasmImages(vfs, bundle, binSiblingAdd.wasmPaths));
    return {
        bundle,
        ...(emits.size > 0 ? { emits } : {}),
        ...(lowered.size > 0 ? { lowered } : {}),
        ...(codeOnly.size > 0 ? { codeOnly } : {}),
        cursor,
        reachableCount: fileCount,
        truncated,
        ...(transforms ? { transforms } : {}),
        bundleSideModulesRequired,
        ...(wasmImages.length > 0 ? { wasmImages } : {}),
    };
}
/** The main module name a worker launch boots from unless told otherwise. */
export const DEFAULT_WORKER_MAIN_MODULE = 'worker.js';
const ROUTEABLE_PORT_ATTACH_TIMEOUT_MS = 1_000;
/** A port request may wait this long for a durable app's re-drive to boot. */
const DURABLE_ENSURE_BOOT_BUDGET_MS = 12_000;
/** The env var a launch reads its restart policy from — set by startProcess({ restart }) and `nimbus start --restart`. */
export const RESTART_POLICY_ENV = 'NIMBUS_RESTART';
/** Backoff per spent FencedWork attempt; a healthy boot resets that existing budget. */
const RESTART_BACKOFF_BASE_MS = 1_000;
function residentRestartPolicy(env) {
    return env?.[RESTART_POLICY_ENV] === 'on-failure' ? 'on-failure' : 'never';
}
/**
 * The durable owner a journal row serves: the row's stamped field for
 * reservation-claimed residents, falling back to the worker recipe's own
 * owner for rows written before the stamping rule landed.
 */
function residentOwner(record) {
    return record.owner ?? (record.recipe.kind === 'worker' ? record.recipe.owner : undefined);
}
/** 'running' is the measured common case: the platform's reset strikes
 *  seconds after a launch settles, while the resident runs. */
function residentLaunchDoing(record) {
    return record.phase === 'running' ? 'running' : 'starting';
}
export class FacetManager {
    ctx;
    env;
    processes;
    portRegistry;
    vfs = null;
    filesystem = null;
    hooks;
    /**
     * The resident-process scheduler (loaders/process-fabric.ts). Every
     * long-lived process — staged opencode, node servers, python/ruby socket
     * servers — is booted through it, and it is the only code that knows which
     * workerd process a facet landed in.
     */
    processFabric;
    /**
     * The same substrate the fabric runs residents on, held directly because a
     * one-shot has no lifecycle for the fabric to own — it is started, read and
     * gone inside one call.
     */
    processHost;
    network;
    /** NIMBUS_DEBUG=1: placement diagnostics into the process log store. */
    debugEnabled = false;
    processRpcResources = new Map();
    /**
     * The session's budget for stdin held while a run is stopped (stdin-read.ts,
     * _awaitStoppedInput), held here because the bytes are held in this
     * Durable Object, whichever process waits for them.
     */
    stdinReadAhead = new ReadAheadBudget(STDIN_SYNC_READ_BYTES + 1);
    /** Per one-shot that can stop at a read of stdin: its output across its runs (gateOutput). */
    outputGates = new Map();
    /** Per stdin channel of a process that can stop: what its current run took (stdinTakenBy). */
    stdinTaken = new Map();
    /** Per process that can stop: what each of its runs was answered (journalCall). */
    journals = new Map();
    /**
     * Connections a process that can stop opened through the session, by the
     * token its socket names (netTls, outboundCall): where to, and the upgrade
     * rendezvous between the guest asking and the outbound doing it.
     */
    netTargets = new Map();
    /** A live fetch the outbound is making for a journaled answer: its result, by ticket. */
    fetchTickets = new Map();
    /**
     * The content-addressed boot-image store (fabric's image-store.ts),
     * writing through this session's kernel-credentialed VFS and rooted off the
     * live process table.
     */
    imageStore = new ImageStore(() => this._imageBlobs(), (pid) => this.processes.get(pid)?.state === 'running');
    /**
     * The resident-launch journal (fabric's fenced-work.ts): the durable
     * record of every resident this session owes the user, and its recovery
     * after an instance reset. This manager supplies what a launch IS — the
     * recipe `_redrive` re-drives from — and how its loss is reported.
     */
    launchJournal;
    /**
     * The granting side of the launch budget (fabric's turn-budget.ts). The
     * session's alarm re-enters the object through `pumpResidentLaunches`;
     * journal recovery rides the first pump.
     */
    launchPump;
    launchTasks = new Set();
    launchesClosed = false;
    // attach-pid → serve-pid: the resident serve facet a bare-`opencode` dual
    // spawn created as an OS-child of the attach TUI. When the attach process
    // exits (reported / killed), its serve facet is torn down with it.
    _pairedServeFacet = new Map();
    // The bundle a resident pid booted from, so the misses it reports at exit
    // stage into the next launch of the same entry, as a one-shot's do.
    residentBundleKeys = new Map();
    /** Per resident pid: the shared read profile's entries its launch staged, settled at its exit. */
    residentProfileOffers = new Map();
    /**
     * The service the bundle's ESM→CJS pass transforms with. composeFacetManager
     * sets it: the host's own, or one whose transforms run in the session's
     * transform facet. Never one of this isolate: a transform engine's wasm
     * memory only grows.
     */
    esbuild = null;
    /**
     * Prefetch-bundle cache. buildPrefetchBundle does a full VFS reachable-set
     * walk + greedy oversample + esbuild ESM→CJS pass on EVERY foreground
     * exec — dominant wall-clock on large node_modules. This memoizes the
     * result (including the serialized facet bundle) keyed on
     * (bundleProfile, cwd, scriptPath, entryCode identity).
     *
     * Correctness watermark: the GLOBAL SqliteVFS revision. buildPrefetchBundle
     * reads from paths that can lie anywhere in the VFS (addEntryAbsPathReads
     * pulls absolute-path literals like /tmp/x),
     * so a cwd-scoped subtree revision cannot guarantee invalidation. The
     * global revision bumps on ANY write, so the cache invalidates on every
     * mutation that could change any file the bundle reads — provably
     * conservative. Bounded to a small LRU; the working set per session is a
     * handful of bins (tsc/vite/eslint) plus repeated `node -e` shapes.
     */
    prefetchBundleCache = new Map();
    static PREFETCH_CACHE_MAX = 16;
    /** Live sum of the entries' `bytes`, mirrored to the diag gauge on change. */
    prefetchCacheBytes = 0;
    /**
     * What each command's runs learned for its next launch: the modules they
     * tried to execute and the files they read that the launch lacked, and the
     * runtime code they produced (launch-learning-store.ts). Kept in the
     * session's storage: the session is evicted whenever it sits idle between
     * two commands, and a profile that died with it made the next run miss the
     * same file again (Vite's node_modules/ms/index.js on every launch).
     */
    learning;
    /**
     * Misses shared across sessions per installed package (read-profile.ts),
     * kept in the npm tarball cache bucket (NPM_TARBALL_CACHE) beside the
     * tarballs. Unbound, a miss is learned for this session only
     * (learning).
     */
    readProfile = null;
    /** Read-profile changes dropped after losing every write race. */
    readProfileConflicts = 0;
    /** Per module path: its static references at a revision (see _closureStaticRefs). */
    staticRefsMemo = new Map();
    /** Modules whose references are remembered: a few programs' closures. */
    static STATIC_REFS_MEMO_MAX = 16_384;
    /**
     * What the prefetch cache holds right now, for /api/_diag/memory: each
     * entry's key, the revision it was built at, and its retained bytes, next
     * to the filesystem's live revision and the residency profiles. A launch
     * that rebuilds where a hit was expected is explained by exactly these:
     * the revision moved, the key changed, or a miss profile dropped the entry.
     */
    prefetchCacheDiag() {
        return {
            revision: this.vfs ? this.vfs.revision() : null,
            entries: [...this.prefetchBundleCache].map(([key, entry]) => ({
                key, revision: entry.revision, bytes: entry.bytes,
            })),
            launchProfiles: this.learning.cached(),
        };
    }
    /** In-flight request-driven durable-app ensures, single-flight per port. */
    ensureInflight = new Map();
    /** Per-pid chain of journal-row amendments; see `_amendRow`. */
    rowAmendments = new Map();
    /**
     * pid → the derived owner it duplicates: the second live instance of an
     * identity. Not journalled (nothing re-drives it), so this is the only
     * record of why `expose(pid)` refuses it.
     */
    ephemeralPids = new Map();
    residentClaims = new Map();
    // NOTE: the opencode artifact sources (entry bundle, chunk pack, TUI worker
    // sources, wasm sidecars) are never materialized on the spawn path — this
    // manager only builds the small OpencodeStageSpec (argv/env/VFS snapshot).
    // facets/opencode-staging.ts assembles the module map inside the
    // Worker-Loader cache-miss callback, so the sources exist only while a facet
    // is actually loading.
    constructor(ctx, env, processes, portRegistry, host, hooks = {}) {
        this.ctx = ctx;
        this.learning = new LaunchLearningStore(ctx.storage);
        this.env = parseFacetManagerEnv(env);
        this.processes = processes;
        this.portRegistry = portRegistry;
        this.hooks = hooks;
        // The workspace's network (FacetManagerHooks.network); a manager no workspace composed uses the isolate's.
        this.network = hooks.network ?? (() => ISOLATE_NETWORK);
        this.processHost = host(ctx, env, () => this._residentDisk(), this.network);
        this.processFabric = new ProcessFabric(this.processHost);
        const debugVar = ((typeof env === 'object' || typeof env === 'function') && env !== null)
            ? Reflect.get(env, 'NIMBUS_DEBUG')
            : undefined;
        this.debugEnabled = debugVar === '1' || debugVar === 'true';
        const profiles = ((typeof env === 'object' || typeof env === 'function') && env !== null)
            ? Reflect.get(env, 'NPM_TARBALL_CACHE')
            : undefined;
        this.readProfile = profiles && typeof profiles === 'object'
            ? new ReadProfile(profiles, Date.now, () => { this.readProfileConflicts++; })
            : null;
        this.launchJournal = new FencedWork(ctx.storage, {
            generationBase: () => this.processes.pidBase,
            waitUntil: (promise) => this.ctx.waitUntil(promise),
            redrive: (record, attempt) => this._redrive(record, attempt),
            onRedrive: (record) => this.hooks.notify?.('\x1b[2m[nimbus: the session restarted while '
                + `"${record.command}" was ${residentLaunchDoing(record)} — restarting it]\x1b[0m\r\n`),
            onAbandoned: (record) => this.hooks.notify?.('\x1b[2m[nimbus: the session restarted again while '
                + `"${record.command}" was ${residentLaunchDoing(record)} — leaving it stopped]\x1b[0m\r\n`),
            onRedriveFailed: (record, e) => {
                console.warn(`[facet-manager] resident pid ${record.pid} ("${record.command}") not re-driven: ${errorMessage(e)}`);
                this.hooks.notify?.(`\x1b[2m[nimbus: "${record.command}" could not be restarted: `
                    + `${errorMessage(e)}]\x1b[0m\r\n`);
            },
        });
        this.launchPump = new PacedWork(ctx, {
            requestTurn: hooks.requestLaunchTurn?.bind(hooks),
        });
        // A reset that killed a resident launch left journal rows behind; the
        // first pump after the reset drains this reconciliation before any
        // waiter resumes, OFF the constructor's init gate.
        onColdStart(ctx, () => this.launchJournal.recoverInterrupted());
        // The journal row of a resident lives for the PROCESS's lifetime, so its
        // release belongs on the one seam every end-of-life passes through —
        // exit, kill, self-reported exit and timeout abort all mark the table.
        // Rooted on waitUntil: the hook fires synchronously inside whatever turn
        // ended the process, and the delete must not be a floating promise there.
        this.processes.setOnTerminal((pid) => {
            this.residentBundleKeys.delete(pid);
            this.residentProfileOffers.delete(pid);
            this.ctx.waitUntil(this.trackLaunchTask(this._onResidentTerminal(pid)));
        });
        this.processes.setDefaultSignalAction((pid, code, signal) => this._endBySignal(pid, code, signal));
    }
    /**
     * A signal's default action: the process ends with 128+signo whether its
     * facet is still being built (the launch stops at its next ownership gate)
     * or already booted (its resources are released like a kill).
     */
    _endBySignal(pid, code, signal) {
        if (this.processes.get(pid)?.state !== 'running')
            return;
        this.portRegistry.unregisterByPid(pid);
        this.releaseProcessRpcResources(pid);
        this.revokeProcessVfsWriters(pid);
        this.processes.exit(pid, code);
        this.processes.markExit(pid, code, signal);
        this.processes.closeInput(pid);
        try {
            this.hooks.onExternalExit?.(pid, code, signal);
        }
        catch { }
        this._teardownPairedServeFacet(pid);
    }
    /**
     * The process is over. Every end-of-life passes through here: a clean
     * exit, a kill, a timeout, a crash. Only one of them owes anything more
     * than the journal row's release — a crash under 'on-failure' is re-driven
     * from the row, after a backoff, while the row is still in storage so a
     * reset inside the backoff window recovers it like any other resident.
     */
    async _onResidentTerminal(pid) {
        await this.rowAmendments.get(pid);
        this.ephemeralPids.delete(pid);
        await this._releaseResidentClaim(pid);
        if (!this.launchJournal.has(pid))
            return;
        const entry = this.processes.get(pid);
        const key = `${FENCED_WORK_KEY_PREFIX}${pid}`;
        const row = (await this.launchJournal.rows()).get(key);
        const crashed = entry?.state === 'exited' && (entry.exitCode ?? 0) !== 0;
        if (this.launchesClosed || row === undefined || row.restart !== 'on-failure' || !crashed) {
            await this.launchJournal.release(pid);
            return;
        }
        const delayMs = RESTART_BACKOFF_BASE_MS * 2 ** row.attempt;
        this.hooks.notify?.(`\x1b[2m[nimbus: "${row.command}" exited with code ${entry.exitCode} — `
            + `restarting in ${delayMs / 1000}s (FencedWork attempt ${row.attempt + 1})]\x1b[0m\r\n`);
        await this.launchPump.nextTurn(Promise.resolve(), Date.now() + delayMs);
        // The process may have been removed or the session destroyed during the
        // backoff; a row that is gone is owed nothing.
        if (!(await this.launchJournal.rows()).has(key))
            return;
        await this.launchJournal.drive(key, row);
    }
    /** Claim identity AND write its recovery row in one serializable storage transaction. */
    async _claimResident(record) {
        const owner = residentOwner(record);
        if (owner === undefined)
            throw new Error('resident launch has no owner');
        const duplicate = await this.ctx.storage.transaction(async (txn) => {
            const key = `${RESIDENT_OWNER_KEY_PREFIX}${owner}`;
            const held = await txn.get(key);
            if (held !== undefined && held !== record.pid && held > this.processes.pidBase
                && this.processes.get(held)?.state === 'running')
                return held;
            await txn.put(key, record.pid);
            await txn.put(`${FENCED_WORK_KEY_PREFIX}${record.pid}`, record);
            return null;
        });
        if (duplicate === null) {
            this.residentClaims.set(record.pid, owner);
            // Adopt into FencedWork's per-instance lifetime bookkeeping and cross
            // its sync barrier before booting. The winning row already exists.
            await this.launchJournal.journal(record);
        }
        return duplicate;
    }
    async _releaseResidentClaim(pid) {
        const owner = this.residentClaims.get(pid);
        if (owner === undefined)
            return;
        this.residentClaims.delete(pid);
        await this.ctx.storage.transaction(async (txn) => {
            const key = `${RESIDENT_OWNER_KEY_PREFIX}${owner}`;
            if (await txn.get(key) === pid)
                await txn.delete(key);
        });
        await this.ctx.storage.sync();
    }
    /**
     * Amend one journal row in place — port stamp, owner adoption, settle —
     * serialized per pid so two amendments in flight on the same row cannot
     * interleave their read and write and lose one another's fields.
     */
    _amendRow(pid, amend) {
        const key = `${FENCED_WORK_KEY_PREFIX}${pid}`;
        const previous = this.rowAmendments.get(pid) ?? Promise.resolve(undefined);
        const next = previous.then(async () => {
            const row = (await this.launchJournal.rows()).get(key);
            if (row === undefined)
                return undefined;
            const amended = amend(row);
            if (amended !== row)
                await this.launchJournal.journal(amended);
            return amended;
        });
        const settled = next.then(() => undefined, () => undefined);
        this.rowAmendments.set(pid, settled);
        void settled.then(() => {
            if (this.rowAmendments.get(pid) === settled)
                this.rowAmendments.delete(pid);
        });
        return next;
    }
    /** The authority is the caller's: a session composes exactly one, and the
     *  manager credentials its processes through that one rather than a second
     *  authority over the same disk. */
    setVfs(vfs, filesystem) { this.vfs = vfs; this.filesystem = filesystem; }
    /**
     * What every loader-backed runtime builds its facet pools from: the env and
     * ctx a pool is constructed over, and the workspace's network its facets go
     * out through. One narrow accessor rather than every runtime reaching into
     * the manager's private fields.
     */
    loaderHost() {
        return { env: this.env, ctx: this.ctx, network: this.network() };
    }
    /**
     * The image store's disk: this session's VFS, as the kernel — the store is
     * written by the kernel and read by processes through supervisor bindings
     * that enforce their own credential. Mode 0644 at creation, as POSIX has
     * it, is what makes the read succeed for any process by construction; the
     * store itself decides nothing about modes.
     */
    _imageBlobs() {
        const vfs = this.vfs;
        if (!vfs) {
            throw new Error('Nimbus: a resident process needs a session filesystem to materialize its boot image');
        }
        const fs = vfs.as(CRED_KERNEL);
        return {
            mkdirp: (dir) => fs.mkdir(dir, { recursive: true, mode: 0o755 }),
            sizeOf: (path) => (fs.exists(path) ? fs.lstat(path).size : null),
            writeFile: (path, bytes) => fs.writeFile(path, bytes, { mode: 0o644 }),
            writeRange: (path, offset, bytes) => fs.writeRange(path, offset, bytes),
            list: (dir) => fs.readdir(dir).map((entry) => entry.name),
            unlink: (path) => fs.unlink(path),
        };
    }
    /**
     * The kernel-scoped VFS the durable image store reads and writes through —
     * `.nimbus/images/<sha256>` is session kernel data, not user content.
     */
    _imageVfs() {
        const vfs = this.vfs;
        if (!vfs) {
            throw new Error('Nimbus: a durable spawn needs a session filesystem to persist its launch image');
        }
        return vfs;
    }
    /** Give the bundle's ESM→CJS pass the host's esbuild, as composeFacetManager does. */
    setEsbuildService(esbuild) { this.esbuild = esbuild; }
    /**
     * The entry script as the facet compiles it: each dynamic `import()` routed
     * to the process's ESM loader, with the entry's own URL as the parent (Node
     * names `-e` code `<cwd>/[eval]` and stdin `<cwd>/[stdin]`). The parse runs
     * in the transform facet like every cell's, and its result is kept by content
     * in the session's transform store. The module-map walk reads the script as
     * written, before this.
     */
    async _entryDynamicImports(code, filename, cwd, pacer) {
        if (!mayHaveDynamicImport(code))
            return code;
        if (this.esbuild === null)
            throw new Error('entry dynamic import requires the transform service');
        const base = cwd.replace(/\/+$/, '') || '/';
        const path = filename === undefined || filename === '<eval>'
            ? `${base}/[eval]`
            : filename === '[stdin]' ? `${base}/[stdin]` : filename;
        const parentUrl = 'file:///' + path.replace(/^\/+/, '');
        return transformEntryScript(code, parentUrl, { host: this.esbuild, store: this._transformStore(), pacer });
    }
    /**
     * The store this session's launches keep their transform results in: the
     * session's database, admitted through its storage ledger, bound to the
     * esbuild service's transform host. None when the host has no identity (a
     * result could not be told apart from another host's) or there is no
     * filesystem to admit against.
     */
    _transformStore() {
        const hostId = this.esbuild?.transformHostId;
        const sql = this.ctx.storage.sql;
        if (!hostId || !sql || !this.vfs)
            return undefined;
        return new TransformStore(sql, this.ctx.storage, this.vfs.ledger, hostId);
    }
    /**
     * The pacer every launch is built under: the session's alarm-driven turn
     * pump, the deployment's chunk bound, and the one check a suspended launch
     * makes when it resumes — that the process it is building for still exists.
     */
    _launchPacer(pid) {
        return new TurnBudget(this.launchPump, turnChunkMaxBytes(this.env), () => this._assertLaunchStillOwned(pid));
    }
    /**
     * Assemble the filesystem bundle a process boots on, across as many
     * Durable Object turns as it takes.
     *
     * The one builder for every Node process this manager starts. A one-shot
     * exec and a resident launch used to own two copies of this: exec's was
     * memoized behind the prefetch cache and raced a wall-clock deadline in a
     * single turn; the resident's was paged with a TurnBudget and never cached.
     * Two paths, one job — and a tree large enough to page on one path hit the
     * deadline on the other, failing every `node -e` in it with "assembling the
     * filesystem bundle … exceeded". What the two callers genuinely differ in is
     * the entry, the working directory and the process they build for; that is
     * all they supply. Everything else — the revision-keyed cache and its stale
     * eviction, the residency profile a previous miss learned, the reachable-set
     * walk and its enrichment passes, the ESM→CJS transform, the manifest and
     * metadata, the module-map serialization with its side-module split, the
     * `node:sqlite` answer, and the release of the raw cells once they are
     * serialized — happens here, once, and yields the turn whenever a chunk's
     * worth of it has been done.
     *
     * There is no deadline. A launch that spans turns costs turns, not a held
     * thread, so a large tree is not a defect to be reported at N seconds; the
     * pacer's `stillWanted` check is what ends a build nothing will use — a
     * process killed while its build was suspended throws from the next resume,
     * and the caller reports that as it reports any other launch failure.
     *
     * The returned state carries its serialized forms (`bundleSource`,
     * `serializedManifest`, `serializedMetadata`) and has already released the
     * raw ones: `generateEntrypointCode` and `generateLongRunningNodeCode` read
     * the serialized forms and nothing else. A state the cache retained belongs
     * to the cache — a caller must not release its serialized forms either
     * (`cacheRetained` says which); one the cache refused belongs to the caller
     * alone, and `releaseGeneratedSources` drops it once a map is generated.
     *
     * A session without a filesystem gets an empty state: there is nothing to
     * stage and nothing to yield for.
     */
    /**
     * The closure's wasm images as module-map members for a one-shot facet,
     * read by path under the process's own credential. An image that cannot
     * be read is left out; the program's compile then meets the seam's own
     * refusal, which names the module.
     */
    async _wasmModulesByValue(entry, wasmImports) {
        const modules = {};
        if (!this.vfs || wasmImports.length === 0)
            return modules;
        if (!this.filesystem)
            throw new Error('Process filesystem authority is not initialized');
        const vfs = this.filesystem.bind({ pid: entry.pid, cred: entry.cred });
        for (const image of wasmImports) {
            const bytes = await filesOf(vfs).readBytes(stripLeadingSlashes(image.vfsPath)).catch(() => null);
            if (bytes === null)
                continue;
            modules[image.moduleName] = {
                wasm: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            };
        }
        return modules;
    }
    /**
     * The module-map members of the staged napi bindings `names`, by value, for
     * a one-shot facet (it has no disk reader at load): the shared loader and
     * trampoline, and each binding. Fetched from the worker's own assets —
     * L2-cached, digest-verified — inside the scope that holds the map, and
     * dropped with it.
     */
    async _stagedBindingModulesByValue(names) {
        if (names.length === 0)
            return {};
        const [loader, trampoline, ...bindings] = await Promise.all([
            fetchStagedBindingAsset(this.env, NAPI_WASM_LOADER),
            fetchStagedBindingAsset(this.env, NAPI_WASM_TRAMPOLINE),
            ...names.map((name) => fetchStagedBindingAsset(this.env, stagedBinding(name).wasm)),
        ]);
        const modules = {
            [STAGED_BINDING_LOADER_MODULE]: new TextDecoder().decode(loader),
            [STAGED_BINDING_TRAMPOLINE_MODULE]: { wasm: trampoline },
        };
        names.forEach((name, i) => { modules[stagedBinding(name).moduleName] = { wasm: bindings[i] }; });
        return modules;
    }
    /**
     * Stage every wasm image the closure inlines as base64 (findInlineWasmImages)
     * as a kernel-owned file named by its content key, and return the records
     * the launch registers it under: by that path, which both launch forms read
     * it from, and by digest, which is how the program's own compile of the
     * decoded bytes is recognised. Small (es-module-lexer's parser is 11.8 KB)
     * and written once per session per image.
     */
    _stageInlineWasmImages(bundle) {
        const images = findInlineWasmImages(bundle);
        if (images.length === 0 || !this.vfs)
            return [];
        const fs = this.vfs.as(CRED_KERNEL);
        fs.mkdir(INLINE_WASM_DIR, { recursive: true, mode: 0o755 });
        return images.map((bytes) => {
            const digest = wasmImageDigest(bytes);
            const vfsPath = `${INLINE_WASM_DIR}/${digest.replace(':', '-')}.wasm`;
            if (!(fs.exists(vfsPath) && fs.lstat(vfsPath).size === bytes.byteLength))
                fs.writeFile(vfsPath, bytes, { mode: 0o644 });
            return { vfsPath, digest };
        });
    }
    /** In-flight writes of the session's copies of staged bindings, by name; one writer each. */
    stagedBindingWrites = new Map();
    /**
     * The staged napi bindings `names` for a resident facet: the shared
     * loader's text (the caller stores it through the image store with the rest
     * of the map), the trampoline by value, and each binding by PATH. A
     * multi-megabyte member inline in the boot spec would sit in this isolate's
     * heap for the process's life; named by path it is read only while the
     * facet loads, like a runtime's interpreter image.
     *
     * Each path is a kernel-owned copy in the session's VFS, written once per
     * session and version. Completeness is its size — the write only ever grows
     * the file from offset zero — and it goes down in the image store's slice
     * size with a turn between slices, for the same reason boot images do: the
     * platform resets an object over what one turn has outstanding.
     */
    async _residentStagedBindingMembers(names, pacer) {
        if (names.length === 0)
            return null;
        const vfs = this.vfs;
        if (!vfs)
            throw new Error('Nimbus: a resident process needs a session filesystem to boot');
        const fs = vfs.as(CRED_KERNEL);
        const bindingPaths = {};
        for (const name of names) {
            const binding = stagedBinding(name);
            const path = binding.vfsPath;
            const complete = () => fs.exists(path) && fs.lstat(path).size === binding.wasm.bytes;
            if (!complete()) {
                let write = this.stagedBindingWrites.get(name);
                if (!write) {
                    write = (async () => {
                        try {
                            const bytes = new Uint8Array(await fetchStagedBindingAsset(this.env, binding.wasm));
                            fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
                            let offset = 0;
                            do {
                                const slice = bytes.subarray(offset, offset + FACET_IMAGE_WRITE_SLICE_BYTES);
                                // The first slice replaces the file, truncating an interrupted
                                // write's remains to a known length.
                                if (offset === 0)
                                    fs.writeFile(path, slice, { mode: 0o644 });
                                else
                                    fs.writeRange(path, offset, slice);
                                offset += slice.byteLength;
                                await pacer.spend(slice.byteLength);
                            } while (offset < bytes.byteLength);
                        }
                        finally {
                            this.stagedBindingWrites.delete(name);
                        }
                    })();
                    this.stagedBindingWrites.set(name, write);
                }
                await write;
                if (!complete())
                    throw new Error(`Nimbus: writing the staged ${name} binding to ${path} did not complete`);
            }
            bindingPaths[binding.moduleName] = path;
        }
        const [trampoline, loader] = await Promise.all([
            fetchStagedBindingAsset(this.env, NAPI_WASM_TRAMPOLINE),
            fetchStagedBindingAsset(this.env, NAPI_WASM_LOADER),
        ]);
        return { loader: new TextDecoder().decode(loader), trampoline, bindingPaths };
    }
    /**
     * Which contents a resident process holds from its first instruction,
     * beyond its module map: data-plan.ts over this process's view of the
     * namespace, mounts included where its launch names them. A path the plan
     * leaves out is still named and stat-able; a synchronous read of it is the
     * one honest miss.
     */
    async _planResidentData(entry, vfsState, cwd, home, pacer, 
    /** The program's path, which its listing walks mounts for (nameLaunch). */
    program) {
        if (!this.vfs || !this.filesystem)
            return { paths: [], storageBytes: 0 };
        const vfs = this.filesystem.bind({ pid: entry.pid, cred: entry.cred });
        const started = Date.now();
        const trace = (what) => {
            if (!this.debugEnabled)
                return;
            this.processes.appendOutput(entry.pid, 'stderr', `[nimbus-debug] data plan: ${what} at ${Date.now() - started} ms\n`);
        };
        trace('static references');
        const refs = await this._closureStaticRefs(vfs, vfsState.bundlePaths ?? [], pacer);
        trace(`${refs.length} modules name paths; learned reads`);
        // Where this process's listing walks mounts, the plan's below and its own
        // at boot: what its launch names.
        this.filesystem.nameLaunch?.(entry, () => launchNames(cwd, program, entry.argv, vfsState.bundlePaths ?? [], refs));
        const learned = await this._learnedReads(vfsState, entry.cred);
        trace(`${learned.length} learned; listing`);
        let pages = 0;
        let names = 0;
        const plan = await planFacetData({
            list: async (after) => {
                const page = await vfs.list(after, FS_LIST_PAGE_LIMIT);
                names += page.entries.length;
                trace(`page ${++pages}: ${page.entries.length} entries`);
                return { entries: page.entries, next: page.next };
            },
            readText: async (path) => {
                try {
                    return await filesOf(vfs).readFileString(path);
                }
                catch {
                    return null;
                }
            },
            linkTarget: (path) => linkTargetOf(vfs, path),
            stat: async (path) => {
                const st = await filesOf(vfs).stat(path).catch(() => null);
                return st && { kind: st.type, size: st.size };
            },
        }, {
            cwd,
            home: home || '/home/user',
            closure: vfsState.bundlePaths ?? [],
            codeOnly: vfsState.codeOnly,
            refs,
            learned,
            spend: (units) => pacer.spend(units),
        });
        trace(`planned ${plan.paths.length}`);
        // What the facet's store will hold (N18), in the cost its store charges
        // itself (facet-resident-store's __residentCellCost): the planned bytes on
        // overflow pages (1% over), a head and chunk rows per file, a namespace
        // row per name, and slack for the last write's page.
        const rows = plan.paths.length * 2 + Math.ceil(plan.bytes / RESIDENT_CHUNK_BYTES) + names;
        // And the module map, which the store adopts at boot: the process's code,
        // costed when the map was built (its cells are released once serialized).
        const moduleBytes = vfsState.moduleStorageBytes ?? moduleMapStorageBytes(vfsState.bundle, vfsState.codeOnly);
        const storageBytes = Math.ceil(plan.bytes * 1.01) + rows * LEDGER_ROW_BYTES + moduleBytes + 65_536;
        return { paths: plan.paths, storageBytes };
    }
    /**
     * A one-shot's data plan: what its closure reads synchronously by a path its
     * code spells out (static-fs-refs.ts; readFileSync, or a read-only openSync),
     * any size, through any links on it, that the module map does not hold. It
     * is data-plan.ts's `static` rule for synchronous reads, which needs the
     * closure and a stat per path but no listing. The store fetches it at boot,
     * so it is held beside the module map rather than carried in it: `vite
     * build` reads lightningcss's 15.8 MB image with readFileSync(new
     * URL('lightningcss_node.wasm', import.meta.url)), which as a map cell
     * left the closure no room under the map's bound.
     */
    async _staticReadPlan(entry, vfsState, cwd, pacer) {
        if (!this.filesystem)
            return [];
        const vfs = this.filesystem.bind({ pid: entry.pid, cred: entry.cred });
        const held = new Set(vfsState.bundlePaths ?? []);
        for (const path of vfsState.codeOnly ?? [])
            held.delete(path);
        const dir = stripLeadingSlashes(cwd).replace(/\/+$/, '');
        const reads = new Set();
        for (const refs of await this._closureStaticRefs(vfs, vfsState.bundlePaths ?? [], pacer)) {
            for (const ref of refs.exact)
                if (ref.sync)
                    reads.add(stripLeadingSlashes(ref.path));
            for (const ref of refs.cwdRelative)
                if (ref.sync)
                    reads.add(normalizeVfsPath((dir ? dir + '/' : '') + ref.path));
        }
        const plan = new Set();
        for (const path of reads) {
            let target;
            try {
                target = stripLeadingSlashes(await vfs.realpath('/' + path));
            }
            catch {
                continue;
            }
            if (held.has(target))
                continue;
            const stat = await filesOf(vfs).stat(target).catch(() => null);
            if (stat?.type === 'file')
                plan.add(target);
        }
        return [...plan];
    }
    /**
     * Paths earlier launches of the same build missed in this session. Other
     * sessions' misses (the shared read profile) join the module map instead,
     * in _buildProcessBundle, where a learned module brings its imports.
     */
    async _learnedReads(vfsState, _cred) {
        if (!vfsState.bundleKey)
            return [];
        const learned = await this.learning.forLaunch(vfsState.bundleKey);
        return [...learned.dataReads, ...learned.executedModules];
    }
    /**
     * The installed packages a closure can load: every package the lockfiles
     * pin whose node_modules directory is on the resolution path of the cwd or
     * of a closure file. A first miss is, by definition, in a package the
     * closure did not already load, so its package's root is found this way.
     */
    _profileRoots(closure, cwd) {
        const sql = this.ctx.storage.sql;
        if (!sql)
            return [];
        const integrities = new NpmCache(sql).installedIntegrities();
        if (integrities.size === 0)
            return [];
        const dirs = new Set();
        const ancestors = (dir) => {
            for (let d = dir;;) {
                const nm = d === '' ? 'node_modules' : `${d}/node_modules`;
                if (dirs.has(nm))
                    return;
                dirs.add(nm);
                if (d === '')
                    return;
                d = d.slice(0, Math.max(0, d.lastIndexOf('/')));
            }
        };
        ancestors(cwd.replace(/^\/+|\/+$/g, ''));
        for (const path of closure) {
            const k = path.replace(/^\/+/, '');
            ancestors(k.slice(0, Math.max(0, k.lastIndexOf('/'))));
        }
        return [...integrities.keys()].filter((root) => {
            const i = root.lastIndexOf('/node_modules/');
            const parent = i === -1 ? (root.startsWith('node_modules/') ? 'node_modules' : null) : root.slice(0, i + '/node_modules'.length);
            return parent !== null && dirs.has(parent);
        });
    }
    /**
     * A package directory's identity for the shared read profile: the tarball
     * integrity the session's lockfiles pin, or, for a package no lockfile
     * pins (a link, a git or file dependency), the content key of its
     * package.json as this credential reads it.
     */
    _packageIdentity(cred) {
        const sql = this.ctx.storage.sql;
        const integrities = sql ? new NpmCache(sql).installedIntegrities() : new Map();
        const view = this.vfs?.as(cred) ?? null;
        return (root) => {
            const integrity = integrities.get(root);
            if (integrity !== undefined)
                return integrity;
            if (view === null)
                return null;
            try {
                return `pkgjson:${view.contentKey(root + '/package.json')}`;
            }
            catch {
                return null;
            }
        };
    }
    /**
     * What the closure's JavaScript names by a foldable path (static-fs-refs.ts),
     * read from the VFS as written rather than from the module map, whose ESM
     * cells were rewritten and lost their import.meta. Each module is parsed once
     * per revision of it, in this session.
     */
    async _closureStaticRefs(vfs, paths, pacer) {
        const out = [];
        for (const path of paths) {
            if (!/\.(?:c|m)?js$/.test(path))
                continue;
            let rev;
            try {
                rev = await vfs.revision(path);
            }
            catch {
                continue;
            }
            const memo = this.staticRefsMemo.get(path);
            let refs;
            if (memo && memo.rev === rev) {
                refs = memo.refs;
            }
            else {
                let source;
                try {
                    source = await filesOf(vfs).readFileString(path);
                }
                catch {
                    continue;
                }
                await pacer.spend(source.length);
                refs = findStaticFsReferences(source, '/' + path);
                this.staticRefsMemo.delete(path);
                this.staticRefsMemo.set(path, { rev, refs });
                for (const oldest of this.staticRefsMemo.keys()) {
                    if (this.staticRefsMemo.size <= FacetManager.STATIC_REFS_MEMO_MAX)
                        break;
                    this.staticRefsMemo.delete(oldest);
                }
            }
            if (refs.exact.length + refs.listed.length + refs.patterns.length + refs.cwdRelative.length + refs.resolves.length > 0) {
                out.push(refs);
            }
        }
        return out;
    }
    async _buildProcessBundle(entry, spec, pacer) {
        if (!this.vfs) {
            return { bundle: {}, reachableCount: 0, truncated: false };
        }
        this.imageStore.ensureDir();
        if (!this.filesystem)
            throw new Error('Process filesystem authority is not initialized');
        const vfs = this.filesystem.bind({ pid: entry.pid, cred: entry.cred });
        const { cred } = entry;
        const profile = spec.bundleProfile ?? DEFAULT_FACET_BUNDLE_PROFILE;
        const credKey = `${cred.uid}:${cred.gid}:${cred.groups.join(',')}`;
        const key = `${profile}\x00${credKey}\x00${spec.cwd}\x00${spec.scriptPath ?? ''}\x00${_fnv1a(spec.entryCode)}`;
        const revision = (await vfs.revision());
        // An entry built at an older revision can never be SERVED again — the
        // lookup below requires an exact match — so from the first write after it
        // was admitted it is retained garbage, held in the isolate that is
        // measurably memory-constrained. Dropped here, before the build that
        // replaces it allocates, so the stale filesystem graph and the new one
        // never co-reside.
        let evictedStale = false;
        for (const [staleKey, stale] of this.prefetchBundleCache) {
            if (stale.revision === revision)
                continue;
            this.prefetchBundleCache.delete(staleKey);
            this.prefetchCacheBytes -= stale.bytes;
            evictedStale = true;
        }
        if (evictedStale)
            setPrefetchCacheBytes(this.prefetchCacheBytes);
        // A report still being recorded may drop this entry: let it land first.
        await this.learning.settled();
        const cached = this.prefetchBundleCache.get(key);
        if (cached && cached.revision === revision) {
            // Refresh LRU recency.
            this.prefetchBundleCache.delete(key);
            this.prefetchBundleCache.set(key, cached);
            return { ...cached.vfsState, cacheHit: true, cacheRetained: true };
        }
        const readProfile = this.readProfile;
        const offered = [];
        const learnedFor = readProfile === null ? undefined : async (closure) => {
            const roots = this._profileRoots(closure, spec.cwd);
            if (roots.length === 0)
                return [];
            offered.push(...await readProfile.lookup(roots, this._packageIdentity(cred), READ_PROFILE_LAUNCH_BYTES));
            return offered.map((entry) => entry.path);
        };
        const learning = await this.learning.forLaunch(key);
        // What earlier runs executed roots the required graph; what they read
        // stays data. A module whose file is readable but was not in the map
        // arrives as runtime code with its text; its imports are roots too, so a
        // launch does not discover one static dependency per run (Nuxt/Vinext).
        const executed = learning.executedModules.map((path) => ({ path }));
        for (const code of learning.code.values()) {
            if (code.kind === 'module' && !code.path.startsWith('data:')) {
                executed.push({ path: code.path.replace(/^\/+/, ''), text: code.text });
            }
        }
        const vfsState = await buildPrefetchBundle(vfs, {
            scriptPath: spec.scriptPath,
            cwd: spec.cwd,
            entryCode: spec.entryCode,
            esbuild: this.esbuild ?? undefined,
            bundleProfile: profile,
            observedReads: new Set(learning.dataReads),
            pacer,
            learnedFor,
            executedModules: executed,
            transformStore: this._transformStore(),
        });
        if (offered.length > 0) {
            const staged = [];
            const unresolved = [];
            for (const entry of offered) {
                if (vfsState.bundle[entry.path] !== undefined) {
                    staged.push(entry);
                    continue;
                }
                // Not staged: over the budget, or nothing a regular file answers (then it is pruned).
                const stat = await Promise.resolve(vfs.stat('/' + entry.path, { followSymlinks: false })).catch(() => null);
                if (stat === null || stat.type !== 'file')
                    unresolved.push(entry.path);
            }
            vfsState.profileOffer = { staged, unresolved };
        }
        vfsState.bundleKey = key;
        vfsState.bundlePaths = Object.keys(vfsState.bundle);
        // The only consumers of the raw cells past serialization are these two
        // answers, so they come first; the serialization then consumes the cells.
        vfsState.usesNodeSqlite = bundleUsesNodeSqlite(spec.entryCode, vfsState.bundle);
        vfsState.stagedBindings = stagedBindingsRequiredBy(Object.entries(vfsState.bundle));
        // Wasm a package inlines as base64 in its own source (Vite's copy of
        // es-module-lexer) never passes through the filesystem, so the closure
        // walk's by-path records cannot name it; it is staged here instead.
        const inlineWasm = this._stageInlineWasmImages(vfsState.bundle);
        if (inlineWasm.length > 0)
            vfsState.wasmImages = [...(vfsState.wasmImages ?? []), ...inlineWasm];
        // And what the module map costs the facet's store, which adopts it at boot
        // (N18): taken now, while the cells exist, for every launch this state
        // serves (a cache hit included).
        vfsState.moduleStorageBytes = moduleMapStorageBytes(vfsState.bundle, vfsState.codeOnly);
        vfsState.bundleSource = await buildFacetVfsBundleSource(vfsState.bundle, vfsState.bundleSideModulesRequired, pacer, {
            consume: true,
            emits: vfsState.emits,
            lowered: vfsState.lowered,
            codeOnly: vfsState.codeOnly,
            runtimeCode: await this._stagedRuntimeCode(learning, vfs, pacer),
        });
        vfsState.cacheHit = false;
        // Serialization is total: bundleSource/serializedManifest/serializedMetadata
        // carry every byte the raw cells and objects do, and both generators read
        // only the serialized forms. Retaining both doubled what an entry costs
        // for its whole lifetime — measured for pi at 502af77, per entry: raw
        // 17,253,610 + source 18,262,324 + manifest 600,060 + metadata 3,841,244
        // = 39,957,238 B, of which the raw halves are 21,694,914 B held to answer
        // `usesNodeSqlite`. Dropping them is a pure release: nothing downstream of
        // this method reads them, and a cache MISS rebuilds from the VFS rather
        // than from anything discarded here.
        //
        // Released BEFORE admission so the byte bound prices what the entry costs
        // from here on, not the peak it passed through on the way in.
        releaseSerializedSources(vfsState);
        vfsState.cacheRetained = this._admitPrefetchCacheEntry(key, revision, vfsState);
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
     * File what a run learned against the bundle it ran: code it produced,
     * modules it tried to execute and files it read that the launch lacked.
     *
     * A miss the supervisor never hears about is a miss the next run repeats,
     * so this is the whole of the repair: record it (in the session's storage,
     * so the next run learns it however long the user waits), and when that
     * taught the profile anything, drop the cached bundle for the key so the
     * next build is a real one and stages it. A report of nothing new keeps
     * the cache: a miss that cannot be staged would otherwise force a rebuild
     * on every launch. The record is queued ahead of any later read of the
     * profile, so a relaunch that follows at once builds from it. A failed
     * record rejects: its caller says so where the user reads it.
     */
    async _recordLaunchLearning(key, report) {
        if (!key)
            return;
        const empty = (list) => !Array.isArray(list) || list.length === 0;
        if (empty(report.code) && empty(report.executedModules) && empty(report.dataReads))
            return;
        if (await this.learning.record(key, report))
            this._dropPrefetchCacheEntry(key);
    }
    /** Tell a process's log that what its run learned was not kept. */
    _learningLost(pid, error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[facet-manager] launch learning for pid ${pid} not recorded:`, error);
        try {
            this.processes.appendOutput(pid, 'stderr', `Nimbus: what this run needed was not recorded for its next launch: ${message}\n`);
        }
        catch { /* the pid is gone; the platform log above has it */ }
    }
    _dropPrefetchCacheEntry(key) {
        const cached = this.prefetchBundleCache.get(key);
        if (!cached)
            return;
        this.prefetchBundleCache.delete(key);
        this.prefetchCacheBytes -= cached.bytes;
        setPrefetchCacheBytes(this.prefetchCacheBytes);
    }
    /**
     * The runtime code recorded for an entry, as `{ cjs }` module text by key:
     * a constructor call as the function module (or the SyntaxError the
     * constructor would throw), a file lowered and wrapped as a module cell is.
     * A file is staged by its content key even when the launch also carries its
     * path as a cell: the guest looks a path up first and the key only for a
     * path the map lacks — the same text written under a fresh name.
     */
    async _stagedRuntimeCode(learning, vfs, pacer) {
        const modules = new Map();
        for (const [codeKey, entry] of learning.code) {
            if (entry.kind === 'expression') {
                modules.set(codeKey, runtimeExpressionModule(entry.code));
                continue;
            }
            if (entry.kind !== 'module') {
                modules.set(codeKey, runtimeFunctionModule(entry.kind, entry.params, entry.body));
                continue;
            }
            if (entry.path.startsWith('data:')) {
                if (!this.esbuild)
                    throw new Error('No transformer for a staged data URL module');
                // A data: URL is always an ES module to Node.
                const result = await this.esbuild.transform(entry.text, {
                    loader: 'js', format: 'cjs', target: 'esnext',
                    moduleMetadata: true, dynamicImportParent: 'data:text/javascript,', esModuleScope: true,
                });
                modules.set(codeKey, wrapCommonJsCell(result.code, 'block').text);
                continue;
            }
            const path = entry.path.replace(/^\/+/, '');
            const file = { [path]: entry.text };
            const emits = new Map();
            const placeEmit = (at, code) => { emits.set(at, code); };
            const lowered = new Set();
            const packageTypeOf = await cellPackageTypes(vfs, [path]);
            if (this.esbuild)
                await transformEsmInBundle(file, placeEmit, lowered, packageTypeOf, this.esbuild, pacer, this._transformStore());
            else
                _markBundleEsmAsFailed(file, placeEmit, packageTypeOf, 'no esbuild service was given to this launch');
            let code = emits.get(path) ?? file[path];
            try {
                code = rewriteProvidedCommonJsModules(code);
            }
            catch {
                // Unparseable: it stays as written, and requiring it says why.
            }
            const scope = lowered.has(path) || declaresWrapperBinding(code) ? 'block' : 'function';
            modules.set(codeKey, wrapCommonJsCell(code, scope).text);
        }
        return modules.size > 0 ? modules : undefined;
    }
    /** True when the cache is holding this state — see FacetVfsState.cacheRetained. */
    _admitPrefetchCacheEntry(key, revision, vfsState) {
        const previous = this.prefetchBundleCache.get(key);
        if (previous)
            this.prefetchCacheBytes -= previous.bytes;
        const bytes = retainedVfsStateBytes(vfsState);
        this.prefetchBundleCache.delete(key);
        // A bundle larger than the WHOLE bound is not retained. It used to be
        // admitted anyway, on the reasoning that refusing it means never caching
        // the program the session is running — but admission then evicted every
        // other entry to make room for something that still did not fit, leaving
        // the cache over its own bound with nothing else in it. Measured: a
        // 21.50 MiB entry left a 16 MiB cache holding 21.50 MiB with four prior
        // entries gone. The caller still uses this build for the invocation it was
        // made for; it simply does not become permanent supervisor pressure after
        // that. With it refused, the loop below can no longer be asked to evict
        // the entry it just admitted.
        if (bytes > PREFETCH_CACHE_MAX_BYTES) {
            setPrefetchCacheBytes(this.prefetchCacheBytes);
            return false;
        }
        this.prefetchBundleCache.set(key, { revision, vfsState, bytes });
        this.prefetchCacheBytes += bytes;
        for (const [oldest, entry] of this.prefetchBundleCache) {
            if (this.prefetchBundleCache.size <= FacetManager.PREFETCH_CACHE_MAX
                && this.prefetchCacheBytes <= PREFETCH_CACHE_MAX_BYTES)
                break;
            this.prefetchBundleCache.delete(oldest);
            this.prefetchCacheBytes -= entry.bytes;
        }
        setPrefetchCacheBytes(this.prefetchCacheBytes);
        return this.prefetchBundleCache.has(key);
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
    revokeProcessVfsWriters(pid, writerId) {
        openSupervisorDeliveries(this.ctx).endReadRun(pid, writerId);
        if (writerId === undefined)
            this.vfs?.revokeAppendWriters(pid);
        else
            this.vfs?.revokeAppendWriter(pid, writerId);
    }
    /**
     * True while a resident facet holds this pid — it was adopted through the
     * bin-spawn contract and now owns the process lifecycle, reporting its own
     * exit. A caller that launched the command must not record an exit for it.
     */
    hasResidentProcess(pid) {
        return this.processRpcResources.has(pid);
    }
    /** Acknowledge generated code only after storage has accepted it. The
     * launch key comes from the process table, never from guest arguments. */
    async noteProcessRuntimeCode(pid, entries, executedModules = [], dataReads = []) {
        const key = this.residentBundleKeys.get(pid);
        if (!key || this.processes.get(pid)?.state !== 'running')
            throw new Error('Runtime code report has no live launch');
        await this._recordLaunchLearning(key, { code: entries, executedModules, dataReads });
    }
    noteProcessReportedExit(pid, exitCode, dataReads, evidence, runtimeCode, executedModules) {
        // Filed before the exit marks the table: the terminal hook forgets the key.
        this.ctx.waitUntil(this._recordLaunchLearning(this.residentBundleKeys.get(pid), { code: runtimeCode, executedModules, dataReads })
            .catch((error) => this._learningLost(pid, error)));
        const residencyMisses = [...(dataReads ?? []), ...(executedModules ?? [])];
        const exiting = this.processes.get(pid);
        const offer = this.residentProfileOffers.get(pid);
        this.residentProfileOffers.delete(pid);
        if (this.readProfile && exiting) {
            // The shared profile learns only what this supervisor served the process
            // after a miss, as the process's own credential sees it (read-profile.ts).
            const profile = this.readProfile;
            const identity = this._packageIdentity(exiting.cred);
            const view = this.vfs?.as(exiting.cred) ?? null;
            const served = evidence?.served ?? new Set();
            // Observers and vouchers are principals the router verified, read off
            // this session's Durable Object name; an anonymous session only reads.
            const principal = profilePrincipal(sessionIdentity({ ctx: this.ctx })?.tenantSegment);
            this.ctx.waitUntil((async () => {
                const tag = principal === null ? null : await principalTag(principal);
                if (tag !== null && view !== null && residencyMisses && residencyMisses.length > 0) {
                    const found = await verifiedEvidence(residencyMisses, served, async (path) => {
                        try {
                            const st = view.lstat(path.replace(/^\/+/, ''));
                            return { type: st.type, size: st.size };
                        }
                        catch {
                            return null;
                        }
                    });
                    if (found.length > 0)
                        await profile.observe(found, tag, identity);
                }
                if (tag !== null && offer !== undefined) {
                    const unread = evidence?.profileUnread ? new Set(evidence.profileUnread) : null;
                    await profile.settle(offer.staged, unread, served, new Set(offer.unresolved), tag);
                }
            })().catch(() => undefined));
        }
        this.portRegistry.unregisterByPid(pid);
        this.processes.exit(pid, exitCode);
        const tracked = this.processRpcResources.get(pid);
        if (tracked?.releaseOnReportExit) {
            this.releaseProcessRpcResources(pid);
            this.revokeProcessVfsWriters(pid);
        }
        else if (!tracked) {
            this.revokeProcessVfsWriters(pid);
        }
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
            // from the table — the exec path needs the canonical
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
            await this.processes.reap();
            // A child of the command that ran it, so under its credential: the
            // program's syscalls answer under the credential the table holds for
            // its pid. At the top of the table it ran as the session user whoever
            // started it.
            entry = this.processes.spawn(command, opts.argv || [], opts.cwd || '/home/user', { parentPid: opts.invokerPid });
            // The command that ran it awaits it as that command's work (a shell
            // line's `node x`), until it ends: the session tells a shell doing
            // nothing but await its programs by it (SessionProcessSupervisor).
            if (opts.invokerPid !== undefined)
                this.processes.beginAwait(opts.invokerPid, entry.pid);
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
        // Started with the launch, so a writer that has finished (echo, head) has
        // delivered all of it, and its end, by the time the program starts: the
        // guest takes what is queued then, for its synchronous reads of fd 0
        // (node-shims.ts, __nimbusPrepareStdin).
        const stdinPump = opts.stdinPipe ? this._pumpStdinPipe(entry.pid, opts.stdinPipe) : null;
        const diagOn = isExecDiagEnabled();
        const __bundleStart = diagOn ? Date.now() : 0;
        // Paced like a resident launch: a tree too large for one turn costs
        // turns, and the pacer's stillWanted check ends a build whose process was
        // killed while it was suspended. The invocation that granted the last
        // chunk awaits `chunkEnded` (PacedWork.pump), so it owns the launch until
        // the pacer settles: once the program is loaded and about to be entered
        // (_execViaLoader's onLoaded), as a resident launch settles once its
        // process has booted, and in the finally below for a launch that ends
        // sooner. Not at the end of the build, which would release that turn
        // with the module map still to assemble and load on it; and not at the
        // end of the run, which held the session's launch alarm for as long as
        // the program ran, so a child it launched and waited on, needing a turn
        // of its own, never got one.
        const pacer = this._launchPacer(entry.pid);
        let vfsState;
        try {
            vfsState = await this._buildProcessBundle(entry, { scriptPath: opts.filename, cwd: opts.cwd || '/home/user', entryCode: code, bundleProfile: opts.bundleProfile }, pacer);
        }
        catch (err) {
            // The require closure that cannot fit the snapshot bound is the
            // process's own answer, not a build failure: exit 1 with a stderr
            // that names the entry, the staged bytes at the stop, the bound,
            // and the remedy — the same shape the got/next guards print.
            pacer.settle();
            stdinPump?.stop();
            if (err instanceof ClosureBoundExceededError) {
                const o = err.outcome;
                const mib = (n) => `${(n / 1048576).toFixed(1)} MiB`;
                const stderr = `require closure for ${o.entry} exceeds the snapshot bound: ` +
                    `${mib(o.bytesSeen)} staged when ${o.lastPath} crossed the ` +
                    `${mib(o.bound)} bound; the process was not started.\n` +
                    `Run it as a server or split the entry; there is no flag to bypass.`;
                if (this.processes.get(entry.pid)?.state === 'running') {
                    this._failLaunch(entry.pid, stderr);
                }
                return { exitCode: 1, stdout: '', stderr };
            }
            // A failed build is thrown to the caller exactly as before. What must
            // not be left behind is the process entry: it was spawned above and
            // would otherwise sit 'running' forever for a process that never
            // started. A build ended by a kill finds its entry already exited and
            // reports nothing twice.
            if (this.processes.get(entry.pid)?.state === 'running') {
                this._failLaunch(entry.pid, `assembling the filesystem bundle for \`${command}\` failed: ${errorMessage(err)}`);
            }
            throw err;
        }
        // Where the one-shot's listing of its namespace walks mounts: what its
        // launch names, the literal paths of its own code included.
        const cwd = opts.cwd || '/home/user';
        this.filesystem?.nameLaunch?.(entry, () => launchNames(cwd, opts.filename, opts.argv ?? [], vfsState.bundlePaths ?? [], [findStaticFsReferences(code, opts.filename?.startsWith('/') ? opts.filename : `${cwd}/[eval]`)]));
        const bundleMs = diagOn ? Date.now() - __bundleStart : 0;
        const diagSink = diagOn
            ? { loadMs: 0, runMs: 0, moduleMapBytes: 0, bundleBytes: 0 }
            : undefined;
        const abortController = new AbortController();
        // Ctrl-C / kill on a user program has to end the in-flight run, not just
        // mark the table row: the runOnce request carries this signal.
        this.processes.setTerminator(entry.pid, () => abortController.abort());
        // A shell Ctrl+C arrives as an abort on the command's signal — it is the
        // same kill, forwarded onto the controller the runOnce request carries.
        const onShellAbort = () => abortController.abort();
        opts.signal?.addEventListener('abort', onShellAbort, { once: true });
        // A process whose stdin a read could find short can stop at that read and
        // run again (runtime/stop-replay.ts): its input channel, if it has one,
        // and the gate that delivers its output once across its runs.
        const inputChannel = opts.stdinPipe ? entry.pid : Number(opts.env?.NIMBUS_CP_CHILD_PID || 0);
        const stoppable = inputChannel > 0 || opts.stdinFile !== undefined;
        const held = this.stdinReadAhead.open();
        // A run after a stop that strays is ended here, as a kill ends one, but
        // it is not a kill: the process fails, naming how it strayed.
        const divergence = new AbortController();
        if (stoppable) {
            this.outputGates.set(entry.pid, new ReplayOutputGate());
            this.journals.set(entry.pid, new ReplayJournal(() => {
                this.outputGates.get(entry.pid)?.close();
                divergence.abort();
            }));
            if (opts.stdinFile)
                this.journals.get(entry.pid).bindStdinFile({ path: opts.stdinFile.path, offset: opts.stdinFile.offset, limit: STDIN_SYNC_READ_BYTES });
        }
        if (inputChannel > 0)
            this.stdinTaken.set(inputChannel, new StdinTaken(held, STDIN_SYNC_READ_BYTES));
        // Each run starts from the umask the process started with: a umask the
        // program set is its run's own.
        const startUmask = entry.cred.umask;
        const runSignal = AbortSignal.any([abortController.signal, divergence.signal]);
        try {
            // A one-shot holds its module map and what it was seen to read (both in
            // the bundle), and plans no listing of the namespace (§2.8: the
            // principal's image is where that comes from). What its closure reads
            // synchronously by a path its code spells out needs no listing, and is
            // its data plan.
            let dataPlan = await this._staticReadPlan(entry, vfsState, cwd, pacer);
            // A stoppable run's network goes through the session (SupervisorRPC's
            // fetch and connect), which records what it answers; its code is
            // digested, so a run after a stop that would load other code does not.
            let launch = {
                ...opts,
                stopNonce: crypto.randomUUID(),
                ...(stoppable ? { outbound: true, codeDigest: { value: undefined } } : {}),
            };
            let result;
            // What the session has of a captured run's output: the last stopped
            // run's, until a run after it gets past the read it stopped at (N8).
            let acceptedCapture = { stdout: '', stderr: '' };
            const journal = this.journals.get(entry.pid);
            for (let stops = 0;; stops++) {
                let outcome;
                try {
                    outcome = await this._execViaLoader(code, launch, entry, vfsState, dataPlan, runSignal, pacer, diagSink);
                }
                catch (error) {
                    const changed = error instanceof ReplayCodeChanged;
                    if (!changed && (!divergence.signal.aborted || abortController.signal.aborted))
                        throw error;
                    outcome = { stop: { v: 3, kind: 'diverged', run: launch.replay?.run ?? 1, out: [], why: changed ? error.message : journal?.diverged ?? errorMessage(error) } };
                }
                if (!('stop' in outcome) && journal?.diverged) {
                    outcome = { stop: { v: 3, kind: 'diverged', run: launch.replay?.run ?? 1, out: [], why: journal.diverged } };
                }
                if (!('stop' in outcome)) {
                    result = outcome;
                    break;
                }
                // The session decides whether the run may go again: what it did
                // outside itself is counted here, whatever the guest counted.
                const refused = outcome.stop.kind === 'stdin' && journal ? journal.unreplayable : null;
                if (outcome.stop.kind === 'stdin' && outcome.stop.captured)
                    acceptedCapture = outcome.stop.captured;
                journal?.stopped();
                // runOneShot released the stopped Worker's nested hold. The child's
                // outer launch admission must go too: only the session waits on its
                // stdin now, and keeping that slot could prevent the parent starting
                // the child whose exit tells it to close this stdin.
                const resumeAdmission = suspendLaunchAdmission(this.ctx);
                // The stopped run's descriptors go with it: the next run opens its
                // own, numbered as the stopped run's were.
                await this.hooks.rewindProcessFiles?.(entry.pid);
                const resumed = await this._resumeStoppedRun(entry, outcome.stop, stops, inputChannel, launch, abortController.signal, held, { accepted: acceptedCapture, refused });
                if ('exit' in resumed) {
                    result = resumed.exit;
                    break;
                }
                // The replay is a new Worker in flight. Rejoin the admission queue
                // before rebuilding its module map or asking a preparation helper.
                try {
                    await resumeAdmission?.(abortController.signal);
                }
                catch (error) {
                    if (abortController.signal.aborted || !isDynamicWorkerDeadlock(error))
                        throw error;
                    // This program already ran and printed before its read. A refusal
                    // to run it AGAIN ends that existing process, never its spawn.
                    const message = `node: could not resume after waiting for stdin (${error.code}): ${error.message}\n`;
                    if (!launch.captureOutput)
                        await this._deliverOutput(entry.pid, 'stderr', new TextEncoder().encode(message));
                    result = { exitCode: 1, stdout: acceptedCapture.stdout, stderr: launch.captureOutput ? acceptedCapture.stderr + message : '' };
                    break;
                }
                this.processes.setUmask(entry.pid, startUmask);
                launch = { ...launch, ...resumed.next, stopNonce: crypto.randomUUID() };
                // The stopped run's module map was released once it loaded, unless
                // the prefetch cache keeps it: the next run builds it again, a hit
                // when nothing it holds has changed since.
                if (vfsState.generatedSourcesReleased) {
                    vfsState = await this._buildProcessBundle(entry, { scriptPath: opts.filename, cwd, entryCode: code, bundleProfile: opts.bundleProfile }, pacer);
                    dataPlan = await this._staticReadPlan(entry, vfsState, cwd, pacer);
                }
            }
            await this._recordLaunchLearning(vfsState.bundleKey, {
                code: result.runtimeCode, executedModules: result.moduleMisses, dataReads: result.residencyMisses,
            }).catch((error) => this._learningLost(entry.pid, error));
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
                    bundleBytes: diagSink.bundleBytes,
                    namespaceRefusals: result.diag?.namespaceRefusals ?? 0,
                    rpcWrites: result.diag?.rpcWrites ?? 0,
                    fsRpcReads: result.diag?.fsRpcReads ?? 0,
                    cacheHit: vfsState.cacheHit ?? false,
                    turns: pacer.chunks,
                    exitCode: result.exitCode,
                    at: Date.now(),
                });
            }
            return result;
        }
        catch (err) {
            // The abort controller firing means this run ended BY a kill — the
            // shell's Ctrl+C or `kill <pid>`. The process was not a crash and the
            // abort text is not its stderr: mark it killed and hand back 130 (the
            // shell's signalled status) with nothing for the terminal to print.
            if (abortController.signal.aborted) {
                this.processes.kill(entry.pid);
                return { exitCode: 130, stdout: '', stderr: '' };
            }
            // The ledger refused to start it (EAGAIN): it never ran. That is its
            // spawn failing, for whoever spawned it to report: a child_process
            // parent as an 'error' event. A pid the caller allocated is the
            // caller's to mark; one spawned here ends with status 1.
            if (isDynamicWorkerDeadlock(err)) {
                if (!opts.skipSpawn)
                    this.processes.exit(entry.pid, 1);
                throw err;
            }
            const exitCode = 1;
            const reason = `runtime worker error: ${errorMessage(err)}`;
            this.processes.exit(entry.pid, exitCode);
            this._w5RecordTermination(entry.pid, exitCode, 'runtime-worker', reason);
            try {
                this.hooks.onExternalExit?.(entry.pid, exitCode, reason);
            }
            catch { }
            return { exitCode, stdout: '', stderr: errorMessage(err) };
        }
        finally {
            opts.signal?.removeEventListener('abort', onShellAbort);
            pacer.settle();
            stdinPump?.stop();
            if (inputChannel > 0)
                this.stdinTaken.get(inputChannel)?.release();
            this.stdinTaken.delete(inputChannel);
            held.give();
            if (stoppable) {
                this.outputGates.delete(entry.pid);
                this.journals.get(entry.pid)?.close();
                this.journals.delete(entry.pid);
                this._dropNetTargets(entry.pid);
            }
        }
    }
    /**
     * A process stopped at a synchronous read of stdin that needs input not
     * there yet (runtime/stop-replay.ts): deliver what its record carries of
     * its output, wait for the input the read needs (the end of stdin, or any of
     * it), hand the channel back what the run took and the input after it, and
     * say how to run it again; or how the process ends instead. What the run
     * took and what was shown are the session's own account (StdinTaken,
     * ReplayOutputGate), not the record's.
     */
    async _resumeStoppedRun(entry, stop, stops, inputChannel, launch, signal, held, 
    // The captured output the session holds (the last stopped run's), and why
    // the session refuses to run it again, when it does.
    session = { accepted: { stdout: '', stderr: '' }, refused: null }) {
        const pid = entry.pid;
        const taken = this.stdinTaken.get(inputChannel);
        taken?.retire();
        const gate = this.outputGates.get(pid);
        const stopped = gate?.stopped(stop) ?? { fresh: [], prefix: null };
        for (const { stream, bytes } of stopped.fresh)
            await this._deliverOutput(pid, stream, bytes);
        // Output a captured run printed before it stopped: the result of an exit
        // that does not run it again. A run that does run again prints it again.
        // A run that strayed before the read is not its own: what the session
        // holds is the run's before it (N8).
        const captured = !launch.captureOutput ? { stdout: '', stderr: '' }
            : stop.kind === 'stdin' && stop.captured ? stop.captured : session.accepted;
        const ends = (exitCode) => ({ exit: { exitCode, stdout: captured.stdout, stderr: captured.stderr } });
        const fail = async (message) => {
            const text = message.endsWith('\n') ? message : `${message}\n`;
            if (!launch.captureOutput)
                await this._deliverOutput(pid, 'stderr', new TextEncoder().encode(text));
            return { exit: { exitCode: 1, stdout: captured.stdout, stderr: launch.captureOutput ? captured.stderr + text : '' } };
        };
        if (stop.kind === 'diverged') {
            return fail(`node: this program did not retrace its run before when Nimbus ran it again to wait for stdin (${stop.why}), `
                + 'so it was ended; what it printed before its read of stdin had already been shown. A program whose path to such '
                + 'a read depends on more than its input, its clock, its random numbers and the files and responses it reads cannot '
                + 'be run again: read process.stdin instead.');
        }
        if (session.refused !== null) {
            return fail(`ERR_NIMBUS_SYNC_STDIN: fs.readFileSync(0) has to wait for stdin, which is still open. Nimbus waits by running `
                + `the program again from its start once the input is there, but this program ${session.refused}. Read process.stdin `
                + 'instead: it takes the input as it arrives.');
        }
        if (stops + 1 >= STOP_LIMIT) {
            return fail(`node: this program waited for stdin ${STOP_LIMIT} times through synchronous reads, each by running `
                + 'it again from its start; Nimbus runs a program at most that many times. Read process.stdin instead.');
        }
        if (!launch.captureOutput && stopped.prefix === null) {
            return fail(`node: this program printed more than ${REPLAY_PREFIX_MAX_BYTES / 1048576} MiB before a synchronous read of stdin `
                + 'that has to wait, more than a second run is checked against. Read process.stdin instead.');
        }
        const replay = {
            run: stop.run + 1,
            tape: stop.tape,
            stopAt: stop.stopAt,
            prefix: stopped.prefix ? { stdout: encodeBase64(stopped.prefix.stdout), stderr: encodeBase64(stopped.prefix.stderr) } : null,
            observations: this.journals.get(pid)?.observations,
        };
        // A \`< file\` the stopped run read synchronously but the launch had not
        // staged: the next run reads it ahead. Nothing is waited for.
        if (launch.stdinFile)
            return { next: { stdinFile: { ...launch.stdinFile, syncRead: true }, replay } };
        const channel = inputChannel > 0 ? this._stdinChannel(inputChannel) : null;
        if (channel === null)
            return fail('node: a synchronous read of stdin stopped a process that has no input channel');
        const before = taken ? taken.take() : { chunks: [], bytes: 0 };
        const full = `node: fs.readFileSync(0) waits for the end of stdin, and stdin passed ${Math.round(STDIN_SYNC_READ_BYTES / 1048576)} MiB `
            + '(the most a synchronous read holds, one budget across the session) without ending. Read process.stdin, '
            + 'which takes it as it arrives, or redirect a file (< file), which a synchronous read takes whole.';
        if (before === null)
            return fail(full);
        const input = await this._awaitStoppedInput(channel, stop.until === 'data' ? 'data' : 'end', signal, held, before.bytes);
        if ('aborted' in input) {
            this.processes.kill(pid);
            return ends(130);
        }
        if ('signal' in input)
            return ends(input.signal === 'SIGINT' ? 130 : input.signal === 'SIGKILL' ? 137 : 143);
        if ('full' in input)
            return fail(full);
        // Back in front of the channel, in order: what the run took, then what
        // came after. The channel holds them now, not this account.
        const back = before.chunks.map((data) => ({ data, ended: false }));
        channel.unread(back.concat(input.packets));
        held.give(before.bytes + input.bytes);
        return { next: { replay, stdinWhole: input.ended, stdinAtLeast: before.bytes + input.bytes } };
    }
    /**
     * The input a stopped run's read waits for, taken off its channel: until
     * the channel ends (\`end\`), or until it holds any (\`data\`). Held against
     * the session's budget, at most STDIN_SYNC_READ_BYTES with what the run had
     * already taken, as owned pieces however small the writes were; of the
     * channel's control packets only the last resize is kept, and a terminating
     * signal, the shell's abort or a kill ends the wait.
     */
    async _awaitStoppedInput(channel, until, signal, held, already) {
        const pieces = new OwnedPieces();
        let resize;
        let ended = false;
        const aborted = new Promise((resolve) => {
            if (signal.aborted)
                resolve('aborted');
            else
                signal.addEventListener('abort', () => resolve('aborted'), { once: true });
        });
        const encoder = new TextEncoder();
        for (;;) {
            const packet = await Promise.race([channel.read(1000), aborted]);
            if (packet === 'aborted') {
                held.give(pieces.bytes);
                return { aborted: true };
            }
            if (packet.signal === 'SIGINT' || packet.signal === 'SIGTERM' || packet.signal === 'SIGKILL') {
                held.give(pieces.bytes);
                return { signal: packet.signal };
            }
            if (packet.resize)
                resize = packet.resize;
            const data = typeof packet.data === 'string' ? encoder.encode(packet.data) : packet.data;
            if (data.byteLength > 0) {
                const granted = already + pieces.bytes + data.byteLength > STDIN_SYNC_READ_BYTES ? 0 : held.take(data.byteLength);
                if (granted < data.byteLength) {
                    held.give(granted + pieces.bytes);
                    return { full: true };
                }
                pieces.add(data);
            }
            if (packet.ended) {
                ended = true;
                break;
            }
            if (until === 'data' && pieces.bytes > 0)
                break;
        }
        const packets = pieces.finish().map((data) => ({ data, ended: false }));
        if (resize)
            packets.push({ data: new Uint8Array(0), ended: false, resize });
        return { packets, bytes: pieces.bytes, ended };
    }
    /** `pid`'s stdin channel: the host's, else the session's input store when the pid has one. */
    _stdinChannel(pid) {
        if (this.hooks.stdinChannel)
            return this.hooks.stdinChannel(pid);
        if (!this.processes.hasInput(pid))
            return null;
        return {
            read: (waitMs) => this.processes.readInput(pid, waitMs),
            unread: (packets) => this.processes.unreadInput(pid, packets),
        };
    }
    /** A process's output, delivered as its own supervisor RPC delivers it. */
    async _deliverOutput(pid, stream, bytes) {
        if (this.hooks.deliverOutput)
            await this.hooks.deliverOutput(pid, stream, bytes);
        else
            this.processes.appendOutputBytes(pid, stream, bytes);
    }
    /**
     * A chunk a process printed, tagged with its run and its offset in what the
     * run printed: the part to deliver (runtime/stop-replay.ts). A process with
     * no gate cannot stop, and every chunk is delivered as it is.
     */
    gateOutput(pid, stream, data, at, run) {
        return this.outputGates.get(pid)?.take(stream, data, at, run) ?? data;
    }
    /**
     * The account of what the current run of a process that can stop takes
     * from stdin channel \`pid\` (cpReadStdin notes each packet it hands over,
     * and a read by a stopped run takes nothing); undefined for any other channel.
     */
    stdinTakenBy(pid) {
        return this.stdinTaken.get(pid);
    }
    /**
     * A supervisor call from a process, answered through \`dispatch\`: for one
     * that can stop, through its journal (runtime/stop-replay.ts ReplayJournal),
     * which counts what it does outside itself and checks what a run after a
     * stop is answered against the run before it.
     */
    journalCall(op, args, pid, run, dispatch) {
        const journal = pid === undefined ? undefined : this.journals.get(pid);
        // A call that names no run is the session's own on the process's behalf
        // (the stat a `< file` relaunch makes), not something a run was told.
        if (!journal || run === undefined || op === 'replayBoundary' || op === 'netTls' || op === 'outbound')
            return dispatch();
        if (op === 'getCachedTarball' || op === 'getPackument')
            return journal.externalRead(op, args, run);
        return journal.handle(op, args, run, dispatch);
    }
    /** Whether this bound run is still recording: cache reads must not fill shared stores. */
    journalRecording(pid, run) {
        const journal = pid === undefined ? undefined : this.journals.get(pid);
        return !!journal && journal.admits(run) && journal.recording;
    }
    stdinPrepared(pid, run) { this.journals.get(pid)?.prepared(run); }
    async cacheResult(pid, run, ticket, result) {
        const journal = this.journals.get(pid);
        if (!journal)
            throw new Error('no such cache observation');
        await journal.externalResult(ticket, result, run);
    }
    /** The run after a stop reached the read the run before it stopped at. */
    async replayBoundary(pid, run) {
        await this.journals.get(pid)?.boundary(run);
    }
    /**
     * A process that can stop opening a TLS connection through the session
     * (\`open\`: where to; the outbound proxies it), and asking for its upgrade
     * (\`upgrade\`: answered once the outbound has made the TLS session with the
     * server). Opening one is something a second run would do again.
     */
    async netTls(pid, run, action, token, payload) {
        const journal = this.journals.get(pid);
        if (!journal || !journal.admits(run) || !/^[0-9a-f]{32}$/.test(token))
            throw new Error('netTls: no such process or connection');
        if (action === 'open') {
            const host = String(payload?.host ?? ''), port = Number(payload?.port);
            if (host.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65535)
                throw new Error('netTls: bad target');
            const refused = await journal.beforeEffect(`tls.connect ${host}:${port}`);
            if (refused)
                throw refused;
            this._netTarget(token, pid).host = host;
            this._netTarget(token, pid).port = port;
            this._netTarget(token, pid).register();
            return true;
        }
        if (action === 'upgrade') {
            const target = this._netTarget(token, pid);
            const servername = typeof payload?.servername === 'string' ? payload.servername : undefined;
            target.ask(servername === undefined ? {} : { servername });
            return await target.answered;
        }
        throw new Error(`netTls: unknown action ${action}`);
    }
    /**
     * The outbound side of a process's network (SupervisorRPC.fetch/connect,
     * the globalOutbound of a run that can stop):
     *   effect(what)            a request that is not a read, a plain connection
     *   fetch(key, what)        a read: { replay: response } or { live: ticket }
     *   fetched(ticket, result) what the live read got; answered when the
     *                           program may have it
     *   connect(token)          where a TLS connection goes
     *   awaitUpgrade(token)     resolves when the guest asks for the TLS session
     *   upgraded(token, result) whether the outbound made it
     */
    async outboundCall(pid, run, action, payload) {
        const journal = this.journals.get(pid);
        if (!journal || !journal.admits(run))
            throw new Error('outbound: this run of the process has stopped');
        switch (action) {
            case 'effect': {
                const refused = await journal.beforeEffect(String(payload?.what ?? 'a request'));
                if (refused)
                    throw refused;
                // The run cannot be replayed now: the outbound need not ask again.
                return { unrecorded: true };
            }
            case 'fetch': {
                // Nothing is recorded for a run that cannot be replayed (D1).
                if (!journal.recording)
                    return { unrecorded: true };
                const key = String(payload?.key ?? '');
                const what = String(payload?.what ?? 'a request');
                let plan;
                const planned = new Promise((resolve) => { plan = resolve; });
                const ticket = crypto.randomUUID();
                let deliver;
                const fetched = new Promise((resolve) => { deliver = resolve; });
                let replayed = false;
                let response;
                const done = journal.answer('fetchHeader ' + key, what + ' headers', async (expected) => {
                    if (expected?.response) {
                        replayed = true;
                        response = expected.response;
                        const { status, statusText, headers, hasBody } = response;
                        return { status, statusText, headers, hasBody };
                    }
                    plan({ live: ticket });
                    const result = await fetched;
                    if ('error' in result) {
                        // A pre-headers platform rejection has not crossed as a
                        // Response. Keep the live error, but never replay an incomplete
                        // failure shape (the body-error protocol below records one).
                        journal.disqualify(`${what} failed before its headers (${result.error})`);
                        throw new Error(result.error);
                    }
                    response = { ...result, body: new Uint8Array(0) };
                    return result;
                }, () => response);
                const live = { pid, run, key, what, deliver, done, response: undefined };
                this.fetchTickets.set(ticket, live);
                done.then(() => {
                    live.response = response;
                    if (replayed) {
                        if (response?.hasBody)
                            this._startFetchBody(ticket, live, journal);
                        else
                            this.fetchTickets.delete(ticket);
                        plan({ replay: response, ticket });
                    }
                }, (error) => { this.fetchTickets.delete(ticket); plan({ error: errorMessage(error) }); });
                return await planned;
            }
            case 'fetched': {
                const ticket = String(payload?.ticket ?? '');
                const live = this.fetchTickets.get(ticket);
                if (!live || live.pid !== pid || live.run !== run)
                    throw new Error('outbound: no such request');
                const result = payload?.result;
                live.deliver(result);
                try {
                    await live.done;
                }
                catch (error) {
                    this.fetchTickets.delete(ticket);
                    throw error;
                }
                if (!('error' in result) && result.hasBody)
                    this._startFetchBody(ticket, live, journal);
                else
                    this.fetchTickets.delete(ticket);
                return true;
            }
            case 'fetchBody': {
                const ticket = String(payload?.ticket ?? '');
                const live = this.fetchTickets.get(ticket);
                if (!live || live.pid !== pid || live.run !== run || !live.body)
                    throw new Error('outbound: no such response body');
                this.fetchTickets.delete(ticket);
                live.body.deliver(payload?.result);
                await live.body.done;
                journal.bodyFinished(ticket);
                return true;
            }
            case 'connect': {
                const token = String(payload?.token ?? '');
                if (!/^[0-9a-f]{32}$/.test(token)) {
                    // A plain connection (not one the TLS shim opened): proxied, and
                    // something a second run would do again.
                    const refused = await journal.beforeEffect(`connect ${token}`);
                    if (refused)
                        throw refused;
                    return { plain: true, unrecorded: true };
                }
                const target = this._netTarget(token, pid);
                const registered = await Promise.race([target.registered.then(() => true), new Promise((r) => setTimeout(() => r(false), 10_000))]);
                if (!registered)
                    throw new Error('outbound: no connection was opened under this name');
                return { host: target.host, port: target.port };
            }
            case 'awaitUpgrade': {
                const target = this._netTarget(String(payload?.token ?? ''), pid);
                return await target.asked;
            }
            case 'upgraded': {
                const target = this._netTarget(String(payload?.token ?? ''), pid);
                const result = payload?.result;
                target.answer(result && result.ok ? { ok: true } : { ok: false, error: String(result?.error ?? 'the TLS session could not be made') });
                return true;
            }
            default:
                throw new Error(`outbound: unknown action ${action}`);
        }
    }
    _startFetchBody(ticket, live, journal) {
        if (live.body)
            return;
        journal.bodyStarted(ticket, live.what);
        let deliver;
        const pending = new Promise((resolve) => { deliver = resolve; });
        const done = journal.answer('fetchBody ' + live.key, live.what + ' body', async () => {
            const result = await pending;
            if ('tooLarge' in result)
                journal.disqualify(`received a response larger than ${REPLAY_FETCH_MAX_BYTES / 1048576} MiB (${live.what})`);
            else if (live.response) {
                if ('error' in result) {
                    live.response.bodyError = result.error;
                    live.response.bodyFailure = result.failure;
                }
                if ('body' in result) {
                    live.response.body = result.body;
                    live.response.chunks = result.chunks;
                    journal.bodyBytes(result.body.byteLength);
                }
            }
            return result;
        });
        // The ticket owns the pending answer even if its client is aborted.
        done.catch(() => { });
        live.body = { deliver, done };
    }
    _netTarget(token, pid) {
        let target = this.netTargets.get(token);
        if (target === undefined) {
            let register, ask, answer;
            const registered = new Promise((resolve) => { register = resolve; });
            const asked = new Promise((resolve) => { ask = resolve; });
            const answered = new Promise((resolve) => { answer = resolve; });
            target = { pid, host: '', port: 0, registered, register, asked, ask, answered, answer };
            this.netTargets.set(token, target);
        }
        if (target.pid !== pid)
            throw new Error('no such connection');
        return target;
    }
    /** A process ended: its connections' names are forgotten and their waits answered. */
    _dropNetTargets(pid) {
        for (const [token, target] of this.netTargets) {
            if (target.pid !== pid)
                continue;
            target.ask(null);
            target.answer({ ok: false, error: 'the process ended' });
            this.netTargets.delete(token);
        }
        for (const [ticket, live] of this.fetchTickets) {
            if (live.pid !== pid)
                continue;
            live.deliver({ error: 'the process ended' });
            live.body?.deliver({ error: 'the process ended' });
            this.fetchTickets.delete(ticket);
        }
    }
    /**
     * Feed a pipe to `pid`'s input channel as it arrives, a chunk at a time:
     * a full queue waits for the program to read, and the pipe's end ends the
     * channel. stop() leaves the rest of the pipe unread, so a program that
     * finished without reading all of it (`tail -f log | node -e ...`)
     * releases the pipe and its writer ends, as a closed reader ends it in a
     * shell.
     */
    _pumpStdinPipe(pid, pipe) {
        const opened = !this.processes.hasInput(pid);
        if (opened)
            this.processes.openInput(pid);
        let stopped = false;
        void (async () => {
            for (;;) {
                // A piece at a time: the queue is bounded, and one larger than its
                // room would never fit.
                const piece = await pipe.readBytes(STDIN_PIPE_PIECE_BYTES);
                if (stopped)
                    return;
                if (piece === null) {
                    this.processes.endInput(pid);
                    return;
                }
                while (!this.processes.writeInputBytes(pid, piece).ok) {
                    if (stopped || !(await this.processes.whenInputWritable(pid)) || stopped)
                        return;
                }
            }
        })().catch(() => { if (!stopped)
            this.processes.endInput(pid); });
        return {
            stop: () => {
                stopped = true;
                if (opened)
                    this.processes.closeInput(pid);
            },
        };
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
    async _execViaLoader(code, opts, entry, vfsState, dataPlan, signal, pacer, diagSink) {
        // Answered by _buildProcessBundle while the raw cells were still in
        // hand; re-deriving it here is what forced them to be retained.
        const usesSqlite = vfsState.usesNodeSqlite ?? bundleUsesNodeSqlite(code, vfsState.bundle);
        const [sqliteModules, sources] = await Promise.all([
            this.sqliteModuleEntry(usesSqlite),
            fetchNodeFacetSources(this.env),
        ]);
        const writerId = crypto.randomUUID();
        let writerActivated = false;
        let __loadStart = 0;
        let __runStart = 0;
        const body = JSON.stringify({
            pid: entry.pid,
            argv: opts.argv || [],
            env: opts.env || {},
            cwd: opts.cwd || '/home/user',
            filename: opts.filename || '<eval>',
            dirname: opts.dirname || '/home/user',
            stdin: opts.stdin || '',
            // A pipe: the input channel it streams through (_pumpStdinPipe), whole
            // or not. A `< file`: the file fd 0 is.
            stdinPid: opts.stdinPipe ? entry.pid : 0,
            ...(opts.stdinWhole ? { stdinWhole: true } : {}),
            ...(opts.stdinFile ? { stdinFile: opts.stdinFile } : {}),
            // A run after a stop: what the stopped run drew, and what it printed,
            // and the stdin it is handed back.
            ...(opts.replay ? { replay: opts.replay } : {}),
            ...(opts.stdinAtLeast ? { stdinAtLeast: opts.stdinAtLeast } : {}),
            // Only this run's stop counts (stop-replay.ts stopRecordOf).
            ...(opts.stopNonce ? { stopNonce: opts.stopNonce } : {}),
            // Its network goes through the session (runOnce's outbound below).
            ...(opts.outbound ? { outbound: true } : {}),
            captureOutput: !!opts.captureOutput,
            cred: { ...entry.cred, groups: [...entry.cred.groups] },
            vfsCursor: vfsState.cursor,
            dataPlan,
            ...(diagSink ? { diag: true } : {}),
        });
        try {
            return await this.processHost.runOnce({
                pid: entry.pid,
                writerId,
                ...(opts.outbound ? { outbound: true } : {}),
                // The module map is the largest thing this DO builds — pi's is ~23 MB
                // — and it is dead the moment the loader has taken it. Everything
                // that holds it is therefore scoped to the load: it is assembled in
                // here rather than named by the enclosing frame, and the serialized
                // forms it was built from are released unless the prefetch cache is
                // keeping them. Otherwise the coordinator carries a second full copy
                // of the program for the whole run the facet then performs,
                // which is the window the isolate was being reset in.
                code: async () => {
                    // A one-shot has no disk reader at load, so the closure's wasm
                    // images ride by value: read here, inside the scope that holds
                    // the map, and compiled by the loader like the sqlite sidecar.
                    const wasmImports = facetWasmImports([], vfsState.wasmImages ?? []);
                    const wasmModules = (await this._wasmModulesByValue(entry, wasmImports));
                    // The staged napi bindings ride by value too, from the worker's
                    // own assets, for the same reason.
                    const stagedModules = await this._stagedBindingModulesByValue(vfsState.stagedBindings ?? []);
                    const entryCode = await this._entryDynamicImports(code, opts.filename, opts.cwd || '/home/user', pacer);
                    const generatedWorker = await generateEntrypointCode(entryCode, vfsState, usesSqlite, sources, wasmImports, opts.filename, opts.esModule);
                    const codeModules = {};
                    for (const [name, text] of Object.entries(generatedWorker.codeModules))
                        codeModules[name] = { cjs: text };
                    if (diagSink) {
                        diagSink.moduleMapBytes = _encodedSourceBytes(generatedWorker.code);
                        for (const source of Object.values(generatedWorker.modules)) {
                            diagSink.moduleMapBytes += _encodedSourceBytes(source);
                        }
                        for (const text of Object.values(generatedWorker.codeModules)) {
                            diagSink.moduleMapBytes += _encodedSourceBytes(text);
                        }
                        for (const m of [...Object.values(sqliteModules), ...Object.values(wasmModules)]) {
                            diagSink.moduleMapBytes += m.wasm.byteLength;
                        }
                        // Read before the release below, which is the last moment the
                        // three parts of that total are separable.
                        diagSink.bundleBytes = _encodedSourceBytes(vfsState.bundleSource?.expression ?? '');
                        for (const source of Object.values(vfsState.bundleSource?.modules ?? {})) {
                            diagSink.bundleBytes += _encodedSourceBytes(source);
                        }
                        for (const text of Object.values(vfsState.bundleSource?.codeModules ?? {})) {
                            diagSink.bundleBytes += _encodedSourceBytes(text);
                        }
                    }
                    // A run after a stop loads what the first run loaded, or nothing:
                    // a module map rebuilt from files that changed while it waited
                    // would answer it differently with nothing to show for it.
                    if (opts.codeDigest) {
                        const digest = answerDigest([generatedWorker.code, generatedWorker.modules, generatedWorker.codeModules]);
                        if (opts.codeDigest.value === undefined)
                            opts.codeDigest.value = digest;
                        else if (opts.codeDigest.value !== digest)
                            throw new ReplayCodeChanged();
                    }
                    if (!vfsState.cacheRetained)
                        releaseGeneratedSources(vfsState);
                    if (diagSink)
                        __loadStart = Date.now();
                    return {
                        compatibilityDate: CF_COMPAT_DATE,
                        compatibilityFlags: [...GUEST_COMPAT_FLAGS],
                        mainModule: 'runner.js',
                        modules: { 'runner.js': generatedWorker.code, ...generatedWorker.modules, ...codeModules, ...sqliteModules, ...wasmModules, ...stagedModules },
                    };
                },
                request: new Request('http://nimbus-runtime.local/run', {
                    method: 'POST',
                    body,
                    signal,
                }),
                onWriterActivated: (id) => {
                    this._activateProcessVfsWriter(entry.pid, id);
                    writerActivated = true;
                },
                onLoaded: () => {
                    pacer.settle();
                    if (!diagSink)
                        return;
                    diagSink.loadMs = Date.now() - __loadStart;
                    __runStart = Date.now();
                },
            }, async (response) => {
                const result = await response.json();
                if (diagSink)
                    diagSink.runMs = Date.now() - __runStart;
                return result;
            });
        }
        catch (error) {
            // The run stopped itself with ctx.abort, at a synchronous read of stdin
            // that has to wait (runtime/stop-replay.ts): its reason is the record.
            const stop = opts.stopNonce ? stopRecordOf(error, opts.stopNonce, opts.replay?.run ?? 1) : null;
            if (stop) {
                // Nothing the stopped run asks for afterwards is its to take.
                this.stdinTaken.get(entry.pid)?.retire();
                return { stop };
            }
            throw error;
        }
        finally {
            // A one-shot worker is unkeyed and cannot be re-resolved into a later
            // request's context, so it can never be a routeable target (server
            // scripts are promoted to the keyed long-running facet instead). But its
            // http shim still calls SUPERVISOR.registerPort on listen(); drop any
            // such reservation here so a dead facet leaves no stale null-stub port.
            this.portRegistry.unregisterByPid(entry.pid);
            if (writerActivated)
                this.revokeProcessVfsWriters(entry.pid, writerId);
        }
    }
    /**
     * Run a staged-artifact bundle (currently opencode) as an ESM mainModule.
     *
     * The bundle is ESM-only and imports node:sqlite, so it cannot use the
     * CommonJS module-cell path. It rides into the Worker Loader module map
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
        const writerId = crypto.randomUUID();
        const supervisor = supervisorBindingProps(this.ctx, staged.pid, { writerId, network: this.network() });
        const ctxExports = getNimbusCtxExports();
        let entrypoint;
        let writerActivated = false;
        try {
            this._activateProcessVfsWriter(staged.pid, writerId);
            writerActivated = true;
            entrypoint = await createLoadedWorkerEntrypoint(ctxExports, supervisor, staged.stageSpec);
            if (typeof entrypoint.fetch !== 'function') {
                throw new Error('Nimbus: opencode runner entrypoint has no fetch method');
            }
            const response = await entrypoint.fetch(new Request('http://nimbus-runtime.local/run', { method: 'POST' }));
            try {
                const result = await response.json();
                this.processes.exit(staged.pid, result.exitCode);
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
            if (writerActivated)
                this.revokeProcessVfsWriters(staged.pid, writerId);
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
        const entry = this.processes.spawn(command, ['opencode', ...opts.argv], opts.cwd, { parentPid: opts.invokerPid });
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
        if (this.vfs)
            this.imageStore.ensureDir();
        const processVfs = this.filesystem ? this.filesystem.bind({ pid: entry.pid, cred: entry.cred }) : null;
        const vfsState = processVfs
            ? await buildPrefetchBundle(processVfs, { cwd: opts.cwd, entryCode: '', esbuild: this.esbuild || undefined })
            : { bundle: {}, reachableCount: 0, truncated: false };
        const vfsBundle = _serializeBundleForFacet(vfsState.bundle);
        assertStagedBundleFitsRpcPayload(vfsBundle, vfsState.bundle);
        const stageSpec = {
            mode,
            argv: opts.argv,
            env: runnerEnv,
            cred: { ...entry.cred, groups: [...entry.cred.groups] },
            cwd: opts.cwd,
            stdin: opts.stdin ?? '',
            vfsBundle,
            vfsCursor: serializeFacetVfsCursor(vfsState.cursor),
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
        let handle;
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
                    this.revokeProcessVfsWriters(pid, writerId);
                },
            });
            this._noteProcessPlacement(pid, handle);
            this.trackProcessRpcResources(pid, [handle], { releaseOnReportExit: false });
            this.ctx.waitUntil(handle.done
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
            return { pid, exitCode: 0, stdout: '', stderr: '' };
        }
        catch (e) {
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
            invokerPid: opts.invokerPid,
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
                // The pair's exec id, from the serve: the command that ran `opencode`
                // may have ended while the serve booted, and been reaped since.
                invokerPid: servePid,
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
        let handle;
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
                    this.revokeProcessVfsWriters(pid, writerId);
                },
            });
            this._noteProcessPlacement(pid, handle);
            // The handle's route target resolves the RUNNING facet wherever it is
            // hosted; binding it for the pid before the port is announced is what
            // lets the shim's listen()→SUPERVISOR.registerPort back-fill.
            // The opencode runner dispatches through node-shims' __nimbusServeHttp, which strips the ACQUIRE.
            this.portRegistry.bindFacetStub(pid, handle.routeTarget, { deliversAcquire: true });
            this.trackProcessRpcResources(pid, [handle], { releaseOnReportExit: false });
            resourcesTracked = true;
            this.ctx.waitUntil(handle.done
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
            await clearPortCapability({ ctx: this.ctx, portRegistry: this.portRegistry }, port);
            this.portRegistry.register(port, pid);
            return { pid, exitCode: 0, stdout: '', stderr: '' };
        }
        catch (e) {
            this.portRegistry.unregisterByPid(pid);
            if (resourcesTracked)
                this.releaseProcessRpcResources(pid);
            else
                handle?.kill();
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
    /**
     * NIMBUS_DEBUG live evidence (log-tail channel) of where a resident process
     * was scheduled. The manager logs an opaque description; only the fabric
     * knows what a placement is.
     */
    _noteProcessPlacement(pid, handle) {
        if (!this.debugEnabled)
            return;
        try {
            this.processes.appendOutput(pid, 'stderr', `[nimbus-debug] process hosted on ${handle.describePlacement()}\n`);
        }
        catch { /* best-effort */ }
    }
    /**
     * The reader the fabric completes a boot spec's by-path members with.
     *
     * Reads as CRED_KERNEL because that is who WROTE them: the generated images
     * are kernel-owned (`_imageBlobs`) and the runtime wasm images
     * are installed by the kernel. Uncached because these are the session's
     * largest files — a ruby interpreter image is 34.3 MiB — and pinning one in
     * the VFS content LRU for the life of the session is what once crashed the
     * supervisor.
     */
    _residentDisk() {
        const vfs = this.vfs;
        if (!vfs) {
            throw new Error('Nimbus: a resident process needs a session filesystem to boot');
        }
        const fs = vfs.as(CRED_KERNEL);
        return { readFile: (path) => fs.readFileUncached(path) };
    }
    /**
     * Fail a paced launch whose process went away while it was suspended.
     *
     * Between turns anything may happen to the process — a kill, a reap, an
     * image sweep that has already unrooted its images. Continuing would
     * spend further turns building a facet for a pid nothing will ever attach
     * to, and would write image files the next sweep immediately collects.
     */
    _assertLaunchStillOwned(pid) {
        if (this.processes.get(pid)?.state === 'running')
            return;
        throw new Error(`Nimbus: the launch for pid ${pid} was cancelled while it was suspended`);
    }
    /**
     * The one way this manager boots a resident process. Every resident process
     * is a facet of this session; there is nothing to place and nothing here
     * decides anything about where a program runs.
     */
    async _startResidentProcess(pid, spec) {
        const { run, ...process } = spec;
        const handle = await this.processFabric.startResidentProcess({
            pid,
            workerKey: `nimbus-process:${this.ctx.id.toString()}:${pid}${run !== undefined && run > 1 ? `:run${run}` : ''}`,
            onWriterActivated: (writerId) => {
                this._activateProcessVfsWriter(pid, writerId);
            },
            onWriterRetired: (writerId) => {
                this.revokeProcessVfsWriters(pid, writerId);
            },
            ...process,
        });
        this._noteProcessPlacement(pid, handle);
        return handle;
    }
    _activateProcessVfsWriter(pid, writerId) {
        // The run this writer is reads the process's stdin, and no run before it,
        // and is the one its supervisor calls are answered for.
        this.stdinTaken.get(pid)?.start(writerId);
        this.journals.get(pid)?.start(writerId);
        const entry = this.processes.get(pid);
        if (!entry || entry.state !== 'running') {
            throw new Error(`Nimbus: cannot activate append writer for non-running process ${pid}`);
        }
        const journal = this.journals.get(pid);
        if (journal)
            openSupervisorDeliveries(this.ctx).startReadRun(pid, writerId, {
                maxEntries: REPLAY_JOURNAL_MAX_ENTRIES,
                maxBytes: REPLAY_READ_RECEIPT_MAX_BYTES,
                recording: () => journal.recording,
                disqualify: (why) => journal.disqualify(why + ` (REPLAY_JOURNAL_MAX_ENTRIES=${REPLAY_JOURNAL_MAX_ENTRIES}; REPLAY_READ_RECEIPT_MAX_BYTES=${REPLAY_READ_RECEIPT_MAX_BYTES})`),
            });
        // ProcessTable PIDs are monotonic within a generation and generation-strided
        // across resets, so this live entry is the sole positive authority root.
        this.vfs?.activateAppendWriter(pid, writerId);
    }
    /**
     * Grant every suspended launch a chunk of this turn — the session's alarm
     * calls this, and journal recovery rides the first pump. See fabric's
     * `PacedWork.pump` for the ownership argument.
     */
    pumpResidentLaunches() {
        return this.launchPump.pump();
    }
    trackLaunchTask(task) {
        this.launchTasks.add(task);
        void task.then(() => this.launchTasks.delete(task), () => this.launchTasks.delete(task));
        return task;
    }
    async closeLaunches() {
        this.launchesClosed = true;
        this.launchPump.close();
        while (this.launchTasks.size > 0)
            await Promise.allSettled([...this.launchTasks]);
        await Promise.all(this.rowAmendments.values());
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
    /**
     * A launch that fails before its process is running reports the same way
     * regardless of which phase failed: the pid is exited, the terminal event
     * recorded, and the session notified. Callers do their phase-specific
     * cleanup (ports, tracked RPC resources) first and pass a reason that names
     * the phase.
     */
    _failLaunch(pid, reason) {
        this.processes.exit(pid, 1);
        this._w5RecordTermination(pid, 1, 'facet', reason);
        try {
            this.hooks.onExternalExit?.(pid, 1, reason);
        }
        catch { }
    }
    /**
     * Re-drive a journalled launch after an instance reset. What the journal
     * row carries is the recipe, and who the launch ran as (its credential and
     * exec id); env and secrets are never written to storage, so a worker
     * launch's are re-resolved by the embedder through
     * `hooks.resolveWorkerLaunch`.
     */
    async _redrive(record, attempt) {
        const { recipe } = record;
        if (record.cred === undefined) {
            // Reported through onRedriveFailed, and the row is superseded.
            throw new Error('its journal entry predates the credential a re-drive runs under, so it is not started as anyone else');
        }
        const identity = { cred: record.cred, ...(record.execId === undefined ? {} : { execId: record.execId }) };
        switch (recipe.kind) {
            case 'node': return this._spawnResident(recipe.code, recipe.opts, attempt, identity);
            case 'worker': {
                // Which resolver a worker recipe re-drives through is decided by
                // `recipe.resident`, and it is not a flag: it is the interpreter
                // image (`{ runtime, argv }`) of a python/ruby socket server the
                // SESSION launched for itself. Only those recipes take the
                // image-store fallback, because the session persisted that image and
                // no embedder was ever asked about the launch. Every other worker
                // recipe — an embedder's `spawnWorker`, durable or not — re-drives
                // through the embedder's `resolveWorkerLaunch`, and falls back to the
                // image store only when no embedder hook is composed at all.
                const resolve = recipe.resident
                    ? this.hooks.resolveWorkerLaunchFallback
                    : this.hooks.resolveWorkerLaunch ?? this.hooks.resolveWorkerLaunchFallback;
                if (!resolve)
                    throw new Error('resident launch journal holds a worker launch but no resolveWorkerLaunch hook is composed');
                const resolved = await resolve(recipe);
                if (resolved === null)
                    return undefined;
                const mainModule = resolved.mainModule ?? recipe.mainModule ?? DEFAULT_WORKER_MAIN_MODULE;
                const { [mainModule]: workerCode, ...modules } = resolved.modules;
                if (workerCode === undefined)
                    throw new Error(`resolved worker launch carries no ${mainModule} main module`);
                return this._spawnWorker(workerCode, record.command, recipe.cwd, {
                    port: recipe.resident ? record.port : recipe.port > 0 ? recipe.port : undefined, modules, compatibilityDate: recipe.compatibilityDate,
                    compatibilityFlags: recipe.compatibilityFlags, startArgs: resolved.startArgs ?? recipe.startArgs,
                    resident: recipe.resident, restart: record.restart,
                    env: resolved.env ?? undefined, globalOutbound: resolved.globalOutbound,
                    vfsWasmModules: resolved.vfsWasmModules,
                    vfsTextModules: resolved.vfsTextModules,
                    mainModule,
                    durable: { owner: residentOwner(record) ?? recipe.owner, image: recipe.image },
                }, attempt, identity);
            }
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
    spawnNode(code, opts = {}) {
        return this._spawnResident(code, opts, 0);
    }
    /**
     * `attempt` distinguishes the launch the user asked for from the one re-drive
     * an instance reset earns it, and is carried in the journal rather than in
     * the caller's options because no caller has an opinion about it. So is a
     * re-drive's credential and exec id, from the row: the process that invoked
     * the launch went with the instance.
     */
    async _spawnResident(code, opts, attempt, redriven) {
        await this.processes.reap();
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
            // A child of its invoker, under its credential, as exec's. A re-drive has
            // no invoker (the journal never holds one): it runs as the row says.
            entry = this.processes.spawn(command, opts.argv || [], cwd, { parentPid: opts.invokerPid, ...redriven });
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
        const launch = this._runResidentLaunch(entry, code, command, opts, attempt);
        if (!opts.attachedTty) {
            // A server's caller is told a port is bound, so it has to wait for the
            // boot that binds it. The wait costs this turn nothing: every chunk of
            // the launch runs on a turn of its own.
            await launch;
            return { pid: entry.pid };
        }
        // An attached TUI has no such handshake — its terminal is already open on
        // this pid and the first thing it will show is the program's own output.
        // Returning now is what lets the shell's response complete while the
        // launch is still being built, which is the whole point: the turn that
        // asked for the process must not be the turn that builds it.
        // Rooted so the launch is not an abandoned promise between turns. A
        // failure has already exited the process and notified the session on its
        // way out, so there is nothing left here to report and nothing to gain
        // from also failing the invocation that started it.
        this.ctx.waitUntil(launch.catch(() => { }));
        return { pid: entry.pid };
    }
    /**
     * Build and boot a resident process across as many turns as it takes.
     *
     * Every phase below is paced: the walk, the ESM transform, the module-map
     * serialization and the image-store write each report the work they do, and
     * the pacer ends the turn whenever a chunk's worth has accumulated. What the
     * session gets back between those chunks is its thread — which is what the
     * terminal WebSocket needs to survive a launch, and what no amount of making
     * the launch faster would have given it.
     */
    _runResidentLaunch(entry, code, command, opts, attempt) {
        if (this.launchesClosed)
            return Promise.reject(new Error('Launch scheduler is closed'));
        return this.trackLaunchTask(this._runResidentLaunchBody(entry, code, command, opts, attempt));
    }
    async _runResidentLaunchBody(entry, code, command, opts, attempt) {
        const cwd = opts.cwd || '/home/user';
        const pacer = this._launchPacer(entry.pid);
        // Journalled before the first byte of work. A launch that FAILS deletes
        // its row on the way out — its process has already been exited and the
        // user notified, so there is nothing left to owe. A launch that SETTLES
        // rewrites the row as a running resident instead: measured live, the
        // resets this journal exists for strike seconds AFTER the launch settles,
        // and a row deleted at settle was exactly why recovery sat inert while
        // sessions kept dying. The row is finally released by the supervisor's
        // terminal hook when the process ends. A re-drive owns its own process,
        // so the caller's pid goes with the instance that had it.
        //
        // Every resident has an identity from the moment it is spawned: derived
        // from the working directory and argv (never the env), so the same
        // `node server.js` from the same directory is the same application
        // across restarts and resets. A resident that declares a port at spawn
        // which an EXPLICIT reservation holds (an embedder's ensureDurableApp)
        // adopts that reservation's owner instead — the landed contract: the
        // embedder declared the port, so whatever binds it is the application.
        //
        // A second live instance of the same derived identity is ephemeral: it
        // runs, but it is not the durable one — it takes no slot (the slot is
        // the identity's, and a live facet already holds it), claims no
        // reservation, and is not journalled, so nothing re-drives it and a
        // port it binds retires the previous occupant's capability like any
        // unrelated process would.
        const derivedOwner = await deriveResidentOwner(cwd, opts.argv ?? []);
        let owner = derivedOwner;
        if (opts.port !== undefined && opts.port > 0 && opts.port < 65536) {
            const declared = await readPortReservation(this.ctx, opts.port);
            if (declared !== null && declared.owner !== null && declared.kind === 'explicit') {
                owner = declared.owner;
            }
        }
        // The recipe is the launch's inputs; the invoker is a pid of this
        // instance, which a re-drive outlives, so the row carries who it ran as.
        const { invokerPid: _invokerPid, ...inputs } = opts;
        const recipe = { kind: 'node', code, opts: { ...inputs, skipSpawn: undefined, callerPid: undefined } };
        const ranAs = { cred: entry.cred, ...(entry.execId === undefined ? {} : { execId: entry.execId }) };
        const initial = {
            pid: entry.pid, command, attempt, phase: 'starting', owner,
            recipe,
            restart: residentRestartPolicy(opts.env),
            ...ranAs,
        };
        let duplicateOf;
        try {
            duplicateOf = await this._claimResident(initial);
            this._assertLaunchStillOwned(entry.pid);
        }
        catch (e) {
            pacer.settle();
            await this._releaseResidentClaim(entry.pid);
            await this.launchJournal.release(entry.pid);
            this._failLaunch(entry.pid, 'long-running node launch failed: ' + errorMessage(e));
            throw e;
        }
        const ephemeral = duplicateOf !== null;
        // The reservation the identity holds, if any: its port is what `$PORT`
        // is set to and what the facet's durable slot is bound for, so the
        // resident's `ctx.storage` persists across resets the way a durable
        // worker's does.
        const held = ephemeral ? null : await readPortReservationByOwner(this.ctx, owner);
        let durableFacetName;
        let launchEnv;
        if (held !== null) {
            durableFacetName = await acquireDurableFacetSlot(this.ctx, owner);
            launchEnv = {
                PORT: String(held.port),
                NIMBUS_APP: held.reservation.name ?? owner,
            };
        }
        if (ephemeral) {
            this.ephemeralPids.set(entry.pid, owner);
            this.hooks.notify?.(`\x1b[2m[nimbus: second instance of "${(opts.argv ?? []).join(' ') || command}" `
                + `is not the durable one — pid ${duplicateOf} keeps the identity]\x1b[0m\r\n`);
        }
        const record = {
            pid: entry.pid,
            command,
            attempt,
            phase: 'starting',
            recipe,
            owner,
            ...(held !== null ? { port: held.port, injectedPort: held.port } : {}),
            restart: residentRestartPolicy(opts.env),
            ...ranAs,
        };
        try {
            if (!ephemeral)
                await this.launchJournal.journal(record);
        }
        catch (e) {
            // A resident that cannot be journalled does not start; the failure is
            // reported the way a boot failure is.
            pacer.settle();
            this._failLaunch(entry.pid, 'long-running node launch failed: ' + errorMessage(e));
            throw e;
        }
        try {
            await this._residentLaunchBody(entry, code, command, cwd, opts, pacer, durableFacetName, launchEnv);
        }
        catch (e) {
            // Bundle construction and source staging precede the launch body's
            // resource-cleanup try/catch. An attached caller already has its pid;
            // rejecting our background task alone leaves that pid running forever.
            pacer.settle();
            if (entry.exitCode === null) {
                this._failLaunch(entry.pid, "long-running node launch failed: " + errorMessage(e));
            }
            await this.launchJournal.release(entry.pid);
            throw e;
        }
        finally {
            pacer.settle();
        }
        // Booted and running: the launch proved itself, so the resident starts
        // its running life with a fresh re-drive budget. If the process already
        // ended inside the launch body's own settlement, the terminal hook has
        // released the row — do not write it back. Amended, not rewritten from
        // `record`: a port the program bound during its boot has already been
        // stamped onto the row, and the settle must not lose it.
        if (this.launchJournal.has(entry.pid)) {
            await this._amendRow(entry.pid, (row) => ({ ...row, attempt: 0, phase: 'running' }));
        }
    }
    async _residentLaunchBody(entry, code, command, cwd, opts, pacer, durableFacetName, launchEnv) {
        const diagOn = isExecDiagEnabled();
        const __bundleStart = diagOn ? Date.now() : 0;
        if (this.debugEnabled)
            this.processes.appendOutput(entry.pid, 'stderr', '[nimbus-debug] launch: building the module map\n');
        const vfsState = await this._buildProcessBundle(entry, { scriptPath: opts.filename, cwd, entryCode: code, bundleProfile: opts.bundleProfile }, pacer);
        if (this.debugEnabled) {
            this.processes.appendOutput(entry.pid, 'stderr', `[nimbus-debug] module map: ${vfsState.reachableCount} files${vfsState.cacheHit ? ' (prefetch cache)' : ''}, `
                + `transforms ${JSON.stringify(vfsState.transforms ?? null)} (${pacer.chunks} turns so far)\n`);
        }
        const planStart = Date.now();
        const { paths: dataPlan, storageBytes } = await this._planResidentData(entry, vfsState, cwd, opts.env?.HOME, pacer, opts.filename);
        if (this.debugEnabled) {
            this.processes.appendOutput(entry.pid, 'stderr', `[nimbus-debug] data plan: ${dataPlan.length} paths in ${Date.now() - planStart} ms (${pacer.chunks} turns so far)\n`);
        }
        const bundleMs = diagOn ? Date.now() - __bundleStart : 0;
        // The launch-time overlay (`$PORT`, `$NIMBUS_APP` under a reservation)
        // rides on top of the recipe's env and is never journalled: it is
        // re-derived from the reservation on every launch, so a port the
        // application was given follows the reservation, not the recipe.
        const spawnEnv = launchEnv === undefined ? opts.env : { ...(opts.env || {}), ...launchEnv };
        // Every long-running process has an input channel on its pid, and its
        // stdin reads that channel once the program consumes stdin. A
        // backgrounded server started from the terminal sees its stdin stay open,
        // as a job's terminal stdin does, instead of an immediate EOF; only an
        // attached one is a TTY. The pid travels in the start payload (startArgs),
        // not the env: the env is part of the generated worker, which is
        // content-addressed into the image store, so a pid there gave every
        // restart of the same server a new image.
        const processEnv = opts.attachedTty
            ? {
                ...(spawnEnv || {}),
                NIMBUS_ATTACHED_TTY: '1',
                NIMBUS_CP_CHILD_PID: String(entry.pid),
                TERM: opts.env?.TERM || 'xterm-256color',
                COLORTERM: opts.env?.COLORTERM || 'truecolor',
                COLUMNS: opts.env?.COLUMNS || '80',
                LINES: opts.env?.LINES || '24',
                FORCE_COLOR: opts.env?.FORCE_COLOR || '1',
            }
            : spawnEnv;
        // Answered by _buildProcessBundle while the raw cells were still in hand.
        const usesSqlite = vfsState.usesNodeSqlite ?? bundleUsesNodeSqlite(code, vfsState.bundle);
        const [sqliteModules, sources] = await Promise.all([
            this.sqliteModuleEntry(usesSqlite),
            fetchNodeFacetSources(this.env),
        ]);
        // Each image is read by path when the facet loads, never by value here.
        const wasmImports = facetWasmImports([], vfsState.wasmImages ?? []);
        let generatedWorker = await generateLongRunningNodeCode(await this._entryDynamicImports(code, opts.filename, cwd, pacer), vfsState, { ...opts, env: processEnv, cred: entry.cred, wasmImports }, usesSqlite, sources, pacer);
        // Sized here, while the map is still in hand. Reading these after the load
        // would itself be what keeps the map alive, and the whole point of the
        // scoping below is that nothing does.
        let moduleMapBytes = 0;
        let bundleBytes = 0;
        if (diagOn) {
            for (const source of [...Object.values(generatedWorker.modules), ...Object.values(generatedWorker.codeModules)]) {
                bundleBytes += _encodedSourceBytes(source);
            }
            moduleMapBytes = _encodedSourceBytes(generatedWorker.code) + bundleBytes;
        }
        const cacheHit = vfsState.cacheHit ?? false;
        const vfsCursor = vfsState.cursor;
        if (vfsState.bundleKey)
            this.residentBundleKeys.set(entry.pid, vfsState.bundleKey);
        const profileOffer = vfsState.profileOffer;
        if (profileOffer !== undefined)
            this.residentProfileOffers.set(entry.pid, profileOffer);
        // The map is generated; the state's only remaining job is its cursor.
        // Released here, before the boot — releasing afterwards keeps the copy
        // alive for exactly the window that was resetting the isolate. A state
        // the cache retained is the cache's to keep, and is served to the next
        // launch of the same entry.
        if (!vfsState.cacheRetained)
            releaseGeneratedSources(vfsState);
        let handle;
        let resourcesTracked = false;
        try {
            // Assembled as one record of the SAME string objects the generator
            // produced — no copy — and then handed over: this frame drops its own
            // reference before materialize runs, and the sequence below drops each
            // source as the store takes it, so one image's text is resident rather
            // than every image's twice over.
            const sources = {
                'worker.js': generatedWorker.code,
                ...generatedWorker.modules,
            };
            // The code cells travel as ONE image of many modules: the boot spec
            // names a path, not thousands, and the loader slices them out at load.
            const codePack = encodeCommonJsPack(generatedWorker.codeModules);
            generatedWorker = undefined;
            // The staged napi bindings: the shared loader is module text like the
            // rest of the map, the trampoline a 2 KB asset, each binding a path.
            const staged = await this._residentStagedBindingMembers(vfsState.stagedBindings ?? [], pacer);
            if (staged)
                sources[STAGED_BINDING_LOADER_MODULE] = staged.loader;
            const { [CODE_PACK_IMAGE]: codePackPath, ...vfsTextModules } = await this.imageStore.materialize(entry.pid, (function* () { yield* drainSources(sources); yield [CODE_PACK_IMAGE, codePack.splice(0)]; })(), pacer);
            if (this.debugEnabled)
                this.processes.appendOutput(entry.pid, 'stderr', '[nimbus-debug] launch: images stored, starting the facet\n');
            // A resident whose launcher writes its stdin can stop at a synchronous
            // read of it while it boots, and boot again once the input is there
            // (runtime/stop-replay.ts). One started from the terminal is awaited by
            // the shell, which nothing could write past; an attached one's stdin is
            // the terminal.
            const stdinWriter = opts.stdinWriter === true && !opts.attachedTty;
            const heldStdin = this.stdinReadAhead.open();
            // A boot after a stop that strays is ended (its facet killed) and the
            // process fails, naming how.
            let strayed = null;
            if (stdinWriter) {
                this.outputGates.set(entry.pid, new ReplayOutputGate());
                this.stdinTaken.set(entry.pid, new StdinTaken(heldStdin, STDIN_SYNC_READ_BYTES));
                this.journals.set(entry.pid, new ReplayJournal(() => {
                    this.outputGates.get(entry.pid)?.close();
                    strayed?.();
                }));
            }
            // Each boot starts from the umask the process started with.
            const startUmask = entry.cred.umask;
            let rerun = null;
            let stopNonce = crypto.randomUUID();
            try {
                for (let stops = 0;; stops++) {
                    // Last gate before the facet exists. A launch now spans many turns, so
                    // a kill can land anywhere inside it; booting a process the table has
                    // already exited would leave a facet nothing owns, running against a
                    // pid the session has finished reporting on.
                    this._assertLaunchStillOwned(entry.pid);
                    try {
                        handle = await this._startResidentProcess(entry.pid, {
                            // The attached-TTY runner holds startProcess open for the process's
                            // life; the server/watch runner returns once it is up.
                            startContract: opts.attachedTty ? 'lifetime' : 'boot',
                            startArgs: {
                                pid: entry.pid, vfsCursor, dataPlan,
                                ...(profileOffer !== undefined && profileOffer.staged.length > 0 ? { profileStaged: profileOffer.staged.map((e) => e.path) } : {}),
                                ...(this.debugEnabled ? { diag: true } : {}),
                                ...(stdinWriter ? { stdinWriter: true, stopNonce } : {}),
                                // A boot after a stop: what the stopped boot drew and printed, and
                                // the stdin it is handed back.
                                ...(rerun !== null ? { replay: rerun.replay, stdinAtLeast: rerun.stdinAtLeast ?? 0, ...(rerun.stdinWhole ? { stdinWhole: true } : {}) } : {}),
                            },
                            // Each boot after a stop is a fresh isolate: a keyed loader keeps the
                            // stopped one's module state.
                            ...(rerun !== null ? { run: rerun.replay.run } : {}),
                            storageBytes,
                            // A resident whose declared port is reserved binds the owner's
                            // durable slot — the same store a durable worker spawn takes — so the
                            // reservation's durability reaches this process's storage too.
                            ...(durableFacetName !== undefined
                                ? { facet: { name: durableFacetName, durable: true } }
                                : {}),
                            boot: {
                                kind: 'code',
                                code: {
                                    compatibilityDate: CF_COMPAT_DATE,
                                    compatibilityFlags: [...GUEST_COMPAT_FLAGS],
                                    mainModule: 'worker.js',
                                    // Only fixed-size assets of the worker's own ride by value: the
                                    // sqlite sidecar and the staged bindings' trampoline.
                                    modules: staged ? { ...sqliteModules, [STAGED_BINDING_TRAMPOLINE_MODULE]: { wasm: staged.trampoline } } : sqliteModules,
                                    vfsTextModules,
                                    // Wasm images are read by path when the facet loads: the closure's
                                    // own, and the staged bindings' kernel-owned copies.
                                    vfsWasmModules: {
                                        ...Object.fromEntries(wasmImports.map((image) => [image.moduleName, image.vfsPath])),
                                        ...staged?.bindingPaths,
                                    },
                                    vfsCommonJsPacks: [codePackPath],
                                },
                            },
                        });
                        // A boot after a stop that strays is killed where it stands.
                        const booting = handle;
                        strayed = () => booting.kill();
                        // Ended while its facet was being created (a signal's default action).
                        if (this.processes.get(entry.pid)?.state !== 'running') {
                            handle.kill();
                            return;
                        }
                        if (diagOn) {
                            recordExecTelemetry({
                                command,
                                bundleMs,
                                // Both spans are pure computation plus SQLite, and workerd's clock
                                // only moves on I/O, so timing them here reads 0 however many
                                // seconds they burn. The tail's per-turn cpuTime is the authority on
                                // what a launch costs; what this record adds is what it is made OF.
                                loadMs: 0,
                                runMs: 0,
                                drainPasses: 0,
                                moduleMapBytes,
                                // The side modules ARE the VFS bundle whenever the map was split;
                                // when it stayed inline it rides inside worker.js and shows up only
                                // in the total.
                                bundleBytes,
                                namespaceRefusals: 0,
                                rpcWrites: 0,
                                fsRpcReads: 0,
                                cacheHit,
                                turns: pacer.chunks,
                                exitCode: 0,
                                at: Date.now(),
                            });
                        }
                        this.trackProcessRpcResources(entry.pid, [handle], { releaseOnReportExit: !opts.attachedTty });
                        resourcesTracked = true;
                        // A node-shims resident: its __nimbusServeHttp takes the delivered ACQUIRE off each request.
                        this.portRegistry.bindFacetStub(entry.pid, handle.routeTarget, { deliversAcquire: true });
                        if (opts.attachedTty) {
                            this.ctx.waitUntil(handle.done
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
                            await handle.booted();
                        }
                        break;
                    }
                    catch (e) {
                        // The boot stopped itself at a synchronous read of stdin that has to
                        // wait: wait for the input, then boot it again.
                        const journal = this.journals.get(entry.pid);
                        let stop = stdinWriter ? stopRecordOf(e, stopNonce, rerun?.replay.run ?? 1) : null;
                        if (stop === null && journal?.diverged)
                            stop = { v: 3, kind: 'diverged', run: rerun?.replay.run ?? 1, out: [], why: journal.diverged };
                        if (stop === null)
                            throw e;
                        this.stdinTaken.get(entry.pid)?.retire();
                        const refused = stop.kind === 'stdin' && journal ? journal.unreplayable : null;
                        journal?.stopped();
                        await this.hooks.rewindProcessFiles?.(entry.pid);
                        // The stopped facet is released whole (its slot, its name, its
                        // storage) before the next boot takes a slot of its own.
                        handle?.kill();
                        await handle?.done.catch(() => { });
                        handle = undefined;
                        this.portRegistry.unregisterByPid(entry.pid);
                        const waiting = new AbortController();
                        this.processes.setTerminator(entry.pid, () => waiting.abort());
                        const resumed = await this._resumeStoppedRun(entry, stop, stops, entry.pid, {}, waiting.signal, heldStdin, { accepted: { stdout: '', stderr: '' }, refused });
                        if ('exit' in resumed) {
                            if (this.processes.get(entry.pid)?.state === 'running') {
                                this.processes.exit(entry.pid, resumed.exit.exitCode);
                                try {
                                    this.hooks.onExternalExit?.(entry.pid, resumed.exit.exitCode, 'stopped at a synchronous read of stdin');
                                }
                                catch { }
                            }
                            return;
                        }
                        this.processes.setUmask(entry.pid, startUmask);
                        rerun = resumed.next;
                        stopNonce = crypto.randomUUID();
                    }
                }
            }
            finally {
                this.stdinTaken.get(entry.pid)?.release();
                this.stdinTaken.delete(entry.pid);
                heldStdin.give();
                if (stdinWriter) {
                    this.outputGates.delete(entry.pid);
                    // Booted: from here it is a running server, never run again.
                    this.journals.get(entry.pid)?.close();
                    this.journals.delete(entry.pid);
                    this._dropNetTargets(entry.pid);
                }
            }
            if (opts.port && opts.port > 0 && opts.port < 65536) {
                await this._registerResidentPort(entry.pid, opts.port);
            }
        }
        catch (e) {
            // A program classified as long-running that ended on its own during
            // its boot — `json-server --version` prints and exits 0 — reported its
            // exit through the supervisor, which released the facet and rejected
            // the boot handshake with 'resident process released'. That is a
            // completed run, not a failed launch: the process table already holds
            // its real exit code, and the caller reports that code.
            this.portRegistry.unregisterByPid(entry.pid);
            if (resourcesTracked)
                this.releaseProcessRpcResources(entry.pid);
            if (this.processExitCode(entry.pid) !== null)
                return;
            handle?.kill();
            this._failLaunch(entry.pid, 'long-running node boot failed: ' + errorMessage(e));
            throw e;
        }
    }
    /**
     * The exit code of a launched process that has already ended, or null
     * while it runs. What a caller that started a resident reads to tell a
     * server that is up from a program that finished during its boot.
     */
    processExitCode(pid) {
        const entry = this.processes.get(pid);
        if (entry === undefined || entry.state === 'running')
            return null;
        return entry.exitCode ?? 0;
    }
    /**
     * Spawn a long-running dynamic Worker, boot it, and return its boot payload
     * beside the pid and the process's own inbound facet.
     *
     * The shared primitive for any runtime that serves over
     * handleHttpRequest(Request) — the python and ruby socket servers today —
     * and for an embedder's own Worker-class program: `workerCode` boots as
     * `opts.mainModule` (default `worker.js`), `opts.modules` ride inline,
     * `opts.vfsTextModules` and `opts.vfsWasmModules` are read by path when the
     * facet loads.
     *
     * The interpreter image it carries is the memory that should not sit in the
     * session's own isolate — ruby's interpreter+stdlib alone is 34.3 MiB — and
     * a facet's envelope is independent of the session's, so it does not. It has
     * no readiness coupling back into the session: the runner answers
     * startProcess with its boot payload and the caller waits on that one
     * promise, so nothing polls the port to decide the process is up.
     *
     * The returned `facet` is bound to the resident handle's route target — the
     * same target a registered port routes to — so a port-less process can be
     * invoked directly. It has no release: `kill(pid)` is the one lifecycle
     * owner, and the facet is dead once the pid is.
     */
    async spawnWorker(workerCode, command, cwd, opts = {}) {
        return this._spawnWorker(workerCode, command, cwd, opts, 0);
    }
    /** `attempt` is the journal's re-drive budget, and `redriven` who a re-drive runs as, as `_spawnResident` carries them. */
    async _spawnWorker(workerCode, command, cwd, opts, attempt, redriven) {
        if (opts.resident && !opts.durable) {
            opts = { ...opts, durable: { owner: await deriveResidentOwner(cwd, opts.resident.argv) } };
        }
        await this.processes.reap();
        // The table entry carries the same argv the identity is derived from, so
        // a runtime resident reads the same way through either path.
        const entry = this.processes.spawn(command, opts.resident?.argv ?? [], cwd, { parentPid: opts.invokerPid, ...redriven });
        // Stamp the process-table entry so /api/processes exposes this as a
        // long-running process.
        this.processes.setLongRunning(entry.pid);
        // Resident facets always get a spawn notification — they're visible and
        // users want the PID for later `logs`/`kill`.
        try {
            this.hooks.onSpawn?.(entry.pid, command, true);
        }
        catch { }
        const compatibilityDate = opts.compatibilityDate ?? CF_COMPAT_DATE;
        const compatibilityFlags = opts.compatibilityFlags ?? [];
        const mainModule = opts.mainModule ?? DEFAULT_WORKER_MAIN_MODULE;
        if (opts.modules && Object.hasOwn(opts.modules, mainModule)) {
            throw new Error(`Nimbus: spawnWorker main module '${mainModule}' is also an inline module; workerCode is the main module`);
        }
        let handle;
        let resourcesTracked = false;
        let record;
        let durableFacetName;
        let launchEnv;
        const foreground = opts.foreground ? this._holdForeground(entry.pid, opts.foreground) : null;
        try {
            if (opts.durable) {
                // A durable spawn on a declared port starts only when a reservation the
                // owner already holds is persisted. Validated before the journal row is
                // written and before the process boots, so a foreign or absent
                // reservation refuses the launch rather than stealing the exposure.
                if (!opts.resident && opts.port && opts.port > 0 && opts.port < 65536) {
                    const preFlight = await readPortReservation(this.ctx, opts.port);
                    if (preFlight === null || preFlight.owner !== opts.durable.owner) {
                        throw new Error('port reservation conflict: durable worker does not own port ' + opts.port);
                    }
                }
                // A live outbound binding cannot be journalled — a reset would re-drive
                // the recipe with nothing to stand in for it. Only the EMBEDDER's
                // resolveWorkerLaunch can re-mint one: the session's fallback reads
                // the image store, which never carries a binding, so a durable spawn
                // carrying globalOutbound is refused where no embedder hook exists.
                if (opts.globalOutbound !== undefined && opts.globalOutbound !== null
                    && this.hooks.resolveWorkerLaunch === undefined) {
                    throw new Error('Nimbus: a durable spawn carrying a live globalOutbound binding '
                        + 'cannot be journalled without an embedder resolveWorkerLaunch hook');
                }
                // Self-owned applications persist their launch inputs as image blobs —
                // a runner blob for worker.js, an application blob for modules + env —
                // under .nimbus/images/<sha256>, and the journal row names the digests
                // of what was written, never placeholder strings. An embedder-owned
                // spawn is given digests by its own bookkeeping instead.
                const image = opts.durable.image
                    ?? await persistDurableWorkerImage(this._imageVfs(), workerCode, {
                        modules: opts.modules ?? {},
                        ...(opts.env !== undefined ? { env: opts.env } : {}),
                        vfsWasmModules: opts.vfsWasmModules,
                        vfsTextModules: opts.vfsTextModules,
                        ...(opts.mainModule !== undefined ? { mainModule: opts.mainModule } : {}),
                        startArgs: opts.startArgs,
                    });
                await this.ctx.storage.transaction(async (txn) => {
                    const key = `${DURABLE_IMAGES_KEY_PREFIX}${opts.durable.owner}`;
                    const images = await txn.get(key) ?? [];
                    if (!images.some((held) => held.runner === image.runner && held.application === image.application)) {
                        await txn.put(key, [...images, image]);
                    }
                });
                // Journalled before the launch's first byte of work, so a row a
                // later instance reads proves this process never ended.
                record = {
                    pid: entry.pid,
                    command,
                    attempt,
                    phase: 'starting',
                    recipe: {
                        kind: 'worker',
                        owner: opts.durable.owner,
                        image,
                        port: opts.port ?? 0,
                        cwd,
                        compatibilityDate,
                        compatibilityFlags,
                        ...(opts.durable.image && !opts.resident ? { startArgs: opts.startArgs } : {}),
                        ...(opts.resident ? { resident: opts.resident } : {}),
                        ...(opts.mainModule !== undefined ? { mainModule: opts.mainModule } : {}),
                    },
                    // The row-level fields `ensureDurableAppOnPort` reads — same values
                    // the recipe carries, stamped so port/owner lookup never depends on
                    // the recipe's kind.
                    owner: opts.durable.owner,
                    restart: opts.restart ?? 'never',
                    ...(opts.port !== undefined && opts.port > 0 ? { port: opts.port } : {}),
                    cred: entry.cred,
                    ...(entry.execId !== undefined ? { execId: entry.execId } : {}),
                };
                // The durable facet name is claimed once, ever, from DO storage — a
                // re-drive after a reset, an eviction's re-attach and a relaunch all
                // land on the same `app-slot-<n>`, which is the only thing that keeps
                // the retained SQLite bound to this application.
                const duplicate = await this._claimResident(record);
                if (duplicate !== null) {
                    this.ephemeralPids.set(entry.pid, opts.durable.owner);
                    this.hooks.notify?.(`\x1b[2m[nimbus: second instance of "${command}" is not the durable one — pid ${duplicate} keeps the identity]\x1b[0m\r\n`);
                }
                else if (!opts.resident || await readPortReservationByOwner(this.ctx, opts.durable.owner)) {
                    durableFacetName = await acquireDurableFacetSlot(this.ctx, opts.durable.owner);
                }
                if (duplicate === null) {
                    const held = await readPortReservationByOwner(this.ctx, opts.durable.owner);
                    if (held) {
                        launchEnv = { PORT: String(held.port), NIMBUS_APP: held.reservation.name ?? opts.durable.owner };
                        await this._amendRow(entry.pid, (row) => ({ ...row, port: held.port, injectedPort: held.port }));
                    }
                }
            }
            handle = await this._startResidentProcess(entry.pid, {
                // These runners answer startProcess with a boot payload (listening
                // port, or a completed non-server run) and stay resident after it.
                startContract: 'boot',
                startArgs: opts.resident && opts.startArgs && typeof opts.startArgs === 'object'
                    ? { ...opts.startArgs, supervisorPid: entry.pid,
                        ...(launchEnv ? { userEnv: { ...z.record(z.string(), z.unknown()).parse(Reflect.get(opts.startArgs, 'userEnv') ?? {}), ...launchEnv } } : {}) }
                    : opts.startArgs,
                ...(durableFacetName !== undefined
                    ? { facet: { name: durableFacetName, durable: true } }
                    : {}),
                boot: {
                    kind: 'code',
                    code: {
                        compatibilityDate,
                        compatibilityFlags,
                        mainModule,
                        modules: { ...(opts.modules || {}), [mainModule]: workerCode },
                        vfsWasmModules: opts.vfsWasmModules,
                        ...(opts.vfsTextModules !== undefined ? { vfsTextModules: opts.vfsTextModules } : {}),
                        ...(opts.env !== undefined || launchEnv !== undefined ? { env: { ...opts.env, ...launchEnv } } : {}),
                        ...(opts.globalOutbound !== undefined ? { globalOutbound: opts.globalOutbound } : {}),
                    },
                },
            });
            this.trackProcessRpcResources(entry.pid, [handle]);
            resourcesTracked = true;
            this.portRegistry.bindFacetStub(entry.pid, handle.routeTarget);
            const boot = foreground ? await Promise.race([handle.booted(), foreground.interrupted]) : await handle.booted();
            if (record && this.launchJournal.has(entry.pid)) {
                // Booted and running: the launch proved itself, so the resident
                // starts its running life with a fresh re-drive budget.
                await this._amendRow(entry.pid, (row) => ({ ...row, attempt: 0, phase: 'running' }));
            }
            if (opts.port && opts.port > 0 && opts.port < 65536) {
                if (opts.durable && !opts.resident) {
                    // Re-read after the boot: a release or reassignment during it wins.
                    // The durable launch registers only under a reservation it still
                    // owns; it never clears or takes a foreign exposure.
                    const reservation = await readPortReservation(this.ctx, opts.port);
                    if (reservation === null || reservation.owner !== opts.durable.owner) {
                        throw new Error('port reservation conflict: durable worker does not own port ' + opts.port);
                    }
                    // The owner's hold on the port survives the instance reset that
                    // re-drove this launch, and preview URLs minted against it stay
                    // valid: the durable capability is re-adopted through the
                    // reservation's own path, gated on the stored owner.
                }
                await this._registerResidentPort(entry.pid, opts.port);
            }
            const target = handle.routeTarget;
            return {
                pid: entry.pid,
                boot,
                facet: {
                    fetch: (request) => target.handleHttpRequest(request),
                    connect: async (request) => {
                        if (typeof target.handleWebSocketRequest !== 'function') {
                            throw new Error(`Nimbus: worker pid ${entry.pid} accepts no WebSocket upgrades`);
                        }
                        return target.handleWebSocketRequest(request);
                    },
                },
            };
        }
        catch (e) {
            this.portRegistry.unregisterByPid(entry.pid);
            if (resourcesTracked)
                this.releaseProcessRpcResources(entry.pid);
            else
                handle?.kill();
            // An interrupt already killed the process; it did not fail.
            if (!opts.foreground?.signal.aborted)
                this._failLaunch(entry.pid, 'long-running worker boot failed: ' + errorMessage(e));
            throw e;
        }
        finally {
            foreground?.release();
        }
    }
    _holdForeground(pid, launch) {
        this.processes.setForeground(pid, true);
        const unsubscribe = this.processes.subscribeLogs(pid, (chunk) => launch.write(chunk.stream, chunk.data));
        let onAbort = () => { };
        const interrupted = new Promise((_, reject) => {
            onAbort = () => {
                this.kill(pid);
                reject(new DOMException('the launching command was interrupted', 'AbortError'));
            };
        });
        interrupted.catch(() => { });
        if (launch.signal.aborted)
            onAbort();
        else
            launch.signal.addEventListener('abort', onAbort, { once: true });
        return {
            interrupted,
            release: () => {
                launch.signal.removeEventListener('abort', onAbort);
                unsubscribe();
                this.processes.setForeground(pid, false);
            },
        };
    }
    /**
     * A resident process announcing it bound `port`.
     *
     * The stamp is unconditional: the pid's journal row gets `{ port }`
     * whether or not anything reserved it, which is what lets
     * `ensureDurableAppOnPort` re-drive ANY resident a reset killed — the
     * scoped URLs need no capability, so this alone makes every server's
     * preview survive a reset on demand.
     *
     * The capability is bound to identity, not to the port. The stored
     * capability is re-adopted only when the row's owner IS the reservation's
     * owner; any other occupant — an unrelated server, a pid outside the
     * resident lifecycle, the ephemeral second instance of an identity —
     * retires it and mints fresh, so a shared link 404s rather than reaching
     * a program it was never handed out for. An EXPLICIT reservation (an
     * embedder's `ensureDurableApp`) is the one exception, and it is the
     * landed contract: the embedder declared the port, so the row adopts the
     * reservation's owner and the capability with it.
     *
     * Under an injected `$PORT`, a resident that binds a different port is
     * registered anyway — the server must not break — but the row records
     * the mismatch, so `apps.list` reports it as failed and the user is told.
     */
    async _registerResidentPort(pid, port) {
        const reservation = await readPortReservation(this.ctx, port);
        let claimedBy;
        if (reservation?.owner && reservation.kind === 'explicit' && !this.ephemeralPids.has(pid)) {
            const owner = reservation.owner;
            const anotherLive = [...(await this.launchJournal.rows()).values()].some((row) => row.pid !== pid && residentOwner(row) === owner
                && row.pid > this.processes.pidBase && this.processes.get(row.pid)?.state === 'running');
            if (!anotherLive)
                claimedBy = owner;
        }
        let newlyMismatched = false;
        const row = await this._amendRow(pid, (current) => {
            const owner = claimedBy ?? residentOwner(current);
            const injected = current.injectedPort;
            // Under an injected $PORT, the reserved port is the row's port for as
            // long as this pid holds it; a second, different binding is recorded
            // as the mismatch rather than displacing it.
            const holdsInjected = injected !== undefined && injected !== port
                && this.portRegistry.get(injected)?.pid === pid;
            const stampedPort = holdsInjected ? injected : port;
            const portMismatch = injected !== undefined && injected !== port && !holdsInjected
                ? { listened: port, reserved: injected }
                : undefined;
            const same = current.port === stampedPort && residentOwner(current) === owner
                && (current.portMismatch?.listened === portMismatch?.listened)
                && (current.portMismatch?.reserved === portMismatch?.reserved);
            if (same)
                return current;
            newlyMismatched = portMismatch !== undefined && current.portMismatch === undefined;
            const { portMismatch: _dropped, ...rest } = current;
            return {
                ...rest,
                port: stampedPort,
                ...(owner !== undefined ? { owner } : {}),
                ...(portMismatch !== undefined ? { portMismatch } : {}),
            };
        });
        if (newlyMismatched && row?.portMismatch !== undefined) {
            this.hooks.notify?.(`\x1b[2m[nimbus: "${row.command}" listened on ${port} but its reservation owns `
                + `${row.portMismatch.reserved} ($PORT) — the app's URL will not reach it]\x1b[0m\r\n`);
        }
        // A pid nothing journalled — the in-process dev servers, a builtin's
        // adopted wrapper pid — still has an identity: the process table's. It
        // re-adopts a reservation it owns exactly as a resident does; the one
        // thing it cannot do is adopt an EXPLICIT owner, because there is no row
        // to stamp the adoption on, so it registers ephemeral on that port.
        const owner = row === undefined
            ? (await this.residentIdentity(pid))?.owner
            : residentOwner(row);
        if (claimedBy !== undefined && row !== undefined && this.residentClaims.get(pid) !== claimedBy) {
            const previousOwner = this.residentClaims.get(pid);
            await this._releaseResidentClaim(pid);
            const duplicate = await this._claimResident(row);
            if (duplicate !== null) {
                this.ephemeralPids.set(pid, claimedBy);
                await this.launchJournal.release(pid);
            }
            else if (previousOwner && row.recipe.kind === 'worker') {
                // Adoption moves retained images with the identity, including the
                // index that survives a clean exit after the journal row is released.
                await this.ctx.storage.transaction(async (txn) => {
                    const previousKey = `${DURABLE_IMAGES_KEY_PREFIX}${previousOwner}`;
                    const nextKey = `${DURABLE_IMAGES_KEY_PREFIX}${claimedBy}`;
                    const previous = await txn.get(previousKey) ?? [];
                    const next = await txn.get(nextKey) ?? [];
                    const combined = [...next];
                    for (const image of previous) {
                        if (!combined.some((held) => held.runner === image.runner && held.application === image.application))
                            combined.push(image);
                    }
                    await txn.put(nextKey, combined);
                    await txn.delete(previousKey);
                });
            }
        }
        if (reservation !== null && reservation.owner !== null && owner === reservation.owner && !this.ephemeralPids.has(pid)) {
            this.portRegistry.register(port, pid);
            await restoreReservedPortCapability({ ctx: this.ctx, portRegistry: this.portRegistry }, port, reservation.owner);
            return;
        }
        // Any other occupant retires the previous one's capability — and its
        // directory row, so a public link goes dead rather than dangling — and
        // registers with a fresh one. The owner's reservation survives it.
        if (reservation?.owner) {
            this.hooks.notify?.(`\x1b[2m[nimbus: port ${port} belongs to ${reservation.owner}; pid ${pid} registers ephemeral (owner ${owner ?? 'none'})]\x1b[0m\r\n`);
        }
        if (reservation?.visibility === 'public' && reservation.capability !== null) {
            await unbindPublicPortCapability(this._publicDirectoryHost(), reservation.capability);
        }
        await clearPortCapability({ ctx: this.ctx, portRegistry: this.portRegistry }, port);
        this.portRegistry.register(port, pid);
    }
    /**
     * Who a pid is. One resolver, in precedence order: the ephemeral-duplicate
     * mark, the journal row (the owner a launch this manager made was stamped
     * with — derived from the launch's own cwd+argv, or adopted from an
     * explicit reservation), and finally the process table. The table knows
     * cwd and argv for every pid, so a serving process nothing journalled — the
     * in-process Vite dev server, real-vite, a staged artifact, any wrapper pid
     * a builtin adopted — has the same derived identity shape as a resident
     * and answers to the same app verbs. It just cannot be re-driven after a
     * reset: only a journal row carries a recipe. Null only for a pid that is
     * neither journalled nor running.
     */
    async residentIdentity(pid) {
        const duplicated = this.ephemeralPids.get(pid);
        if (duplicated !== undefined)
            return { owner: duplicated, ephemeral: true, port: undefined };
        const row = (await this.launchJournal.rows()).get(`${FENCED_WORK_KEY_PREFIX}${pid}`);
        if (row !== undefined)
            return { owner: residentOwner(row), ephemeral: false, port: row.port };
        const entry = this.processes.get(pid);
        if (entry === undefined || entry.state !== 'running')
            return null;
        return {
            owner: await deriveResidentOwner(entry.cwd, entry.argv),
            ephemeral: false,
            port: this.portRegistry.getAll().find((live) => live.pid === pid)?.port,
        };
    }
    /**
     * Every stamped identity — the reservations, and the journal rows that
     * carry an owner — folded one row per owner. A live pid in THIS instance
     * makes it running (or starting, until its launch settles and its port
     * is registered); a mismatch diagnostic makes it failed; everything else
     * is stopped, which for a row a reset left behind means re-drivable on
     * request.
     */
    async listResidentApps() {
        const apps = new Map();
        for (const [port, reservation] of await listPortReservations(this.ctx)) {
            if (reservation.owner === null)
                continue;
            apps.set(reservation.owner, {
                owner: reservation.owner,
                name: reservation.name ?? null,
                port,
                pid: null,
                status: 'stopped',
                visibility: reservation.visibility,
                capability: reservation.capability,
                restart: 'never',
                diagnostic: null,
            });
        }
        for (const [, row] of await this.launchJournal.rows()) {
            const owner = residentOwner(row);
            if (owner === undefined)
                continue;
            const app = apps.get(owner) ?? {
                owner, name: null, port: null, pid: null, status: 'stopped',
                visibility: 'scoped', capability: null, restart: 'never', diagnostic: null,
            };
            if (app.port === null && row.port !== undefined && row.port > 0)
                app.port = row.port;
            if (row.restart !== undefined)
                app.restart = row.restart;
            const entry = this.processes.get(row.pid);
            const live = row.pid > this.processes.pidBase && entry?.state === 'running';
            if (live) {
                app.pid = row.pid;
                const bound = app.port !== null && this.portRegistry.get(app.port)?.pid === row.pid;
                app.status = row.phase === 'running' && bound ? 'running' : 'starting';
            }
            if (row.portMismatch !== undefined) {
                app.status = 'failed';
                app.diagnostic = `listened on ${row.portMismatch.listened}, owns ${row.portMismatch.reserved}`;
            }
            apps.set(owner, app);
        }
        // Every process serving a port is an application whether or not a
        // journal row backs it — the identity comes from the same resolver the
        // verbs use, so what `list` shows is what `expose` will bind. A row-backed
        // app already carries its pid from above; this only adds the servers
        // nothing journalled (the dev servers, adopted wrapper pids).
        for (const live of this.portRegistry.getAll()) {
            const identity = await this.residentIdentity(live.pid);
            if (identity === null || identity.ephemeral || identity.owner === undefined)
                continue;
            const app = apps.get(identity.owner) ?? {
                owner: identity.owner, name: null, port: null, pid: null, status: 'stopped',
                visibility: 'scoped', capability: null, restart: 'never', diagnostic: null,
            };
            if (app.pid !== null)
                continue;
            app.pid = live.pid;
            if (app.port === null)
                app.port = live.port;
            if (app.status === 'stopped')
                app.status = 'running';
            apps.set(identity.owner, app);
        }
        // The live pid's exec id, read from its process: the one place it lives.
        return [...apps.values()].map((app) => (app.pid === null ? app : { ...app, ...execIdField(this.processes.get(app.pid)) }));
    }
    async registerPort(pid, port) {
        if (port > 0 && port < 65536) {
            await this._registerResidentPort(pid, port);
        }
    }
    waitForRouteablePorts(pid, timeoutMs = ROUTEABLE_PORT_ATTACH_TIMEOUT_MS) {
        return this.portRegistry.waitForRouteablePortsByPid(pid, timeoutMs);
    }
    finishProcess(pid, exitCode, reason = 'exited') {
        this.portRegistry.unregisterByPid(pid);
        this.processes.exit(pid, exitCode);
        this.releaseProcessRpcResources(pid);
        this.revokeProcessVfsWriters(pid);
        this._teardownPairedServeFacet(pid);
        if (exitCode !== 0) {
            this._w5RecordTermination(pid, exitCode, 'facet', reason);
            try {
                this.hooks.onExternalExit?.(pid, exitCode, reason);
            }
            catch { }
        }
    }
    /**
     * Kill a running process by PID. Given the signal that ends it (a name
     * without `SIG`), it exits with that signal's status, 128+signo, and its
     * exit names `SIG<name>`; without one it is SIGKILL's 137, `killed`.
     */
    kill(pid, signal) {
        const entry = this.processes.get(pid);
        if (!entry || entry.state !== 'running')
            return false;
        const code = signal === undefined ? 137 : exitCodeForSignal(signal);
        this.portRegistry.unregisterByPid(pid);
        this.releaseProcessRpcResources(pid);
        this.revokeProcessVfsWriters(pid);
        const result = this.processes.kill(pid, code);
        if (result) {
            try {
                this.hooks.onExternalExit?.(pid, code, signal === undefined ? 'killed' : `SIG${signal}`);
            }
            catch { }
        }
        this._teardownPairedServeFacet(pid);
        return result;
    }
    /**
     * Remove a durable application: the ONLY path that deletes durable facet
     * storage. Owner-checked by construction — `freeDurableFacetSlot` answers
     * only a slot the owner actually holds, and the reservation release refuses
     * a foreign owner's record — so another owner's name cannot be reached.
     *
     * One ordered teardown: the live process is killed first (a released
     * durable facet only aborts, so nothing else ends it), the port reservation
     * is released, the journal rows for the owner are purged (nothing is owed a
     * removed application), the facet's SQLite is deleted, and the slot row is
     * freed last — so a crash mid-removal leaves a name still claimed rather
     * than a store nobody can re-drive.
     */
    async removeDurableApp(owner) {
        // Kill any live process this owner still has — a durable release aborts
        // without deleting, so the store outlives the process unless removal
        // ends it here.
        const journalRows = await this.ctx.storage.list({ prefix: 'resident-launch:' });
        const ownedPids = [];
        const ownedPorts = new Set();
        for (const [, record] of journalRows) {
            // Owner-stamped rows cover every kind the reservation claims — a node
            // resident that bound the port is as much the application as a durable
            // worker spawn is.
            if (residentOwner(record) !== owner)
                continue;
            ownedPids.push(record.pid);
        }
        for (const pid of ownedPids)
            this.kill(pid);
        // The reservation may outlive every journal row (spawn never finished
        // writing one), so scan the port records for the owner too.
        const portRows = await this.ctx.storage.list({ prefix: PORT_CAPABILITY_KEY_PREFIX });
        for (const [key, record] of portRows) {
            if (record?.owner === owner)
                ownedPorts.add(Number(key.slice(PORT_CAPABILITY_KEY_PREFIX.length)));
            // A public capability leaves the routing directory with the row —
            // before the reservation is released so a mid-removal crash leaves a
            // dead URL rather than a dangling route to this session.
            if (record?.owner === owner && record.visibility === 'public' && typeof record.capability === 'string') {
                await unbindPublicPortCapability(this._publicDirectoryHost(), record.capability);
            }
        }
        for (const port of ownedPorts) {
            // A port stamp is not ownership. Release only a reservation that still
            // belongs to this owner, and never unregister somebody else's listener.
            if ((await readPortReservation(this.ctx, port))?.owner !== owner)
                continue;
            await releasePortReservation(this.ctx, { owner, port });
            const live = this.portRegistry.get(port);
            if (live && ownedPids.includes(live.pid))
                this.portRegistry.unregister(port);
        }
        const imageRows = await this.ctx.storage.list({ prefix: DURABLE_IMAGES_KEY_PREFIX });
        const ownedImages = [...(imageRows.get(`${DURABLE_IMAGES_KEY_PREFIX}${owner}`) ?? [])];
        const retainedImages = [...imageRows].filter(([key]) => key !== `${DURABLE_IMAGES_KEY_PREFIX}${owner}`).flatMap(([, images]) => images);
        for (const row of journalRows.values()) {
            if (row.recipe.kind !== 'worker')
                continue;
            (residentOwner(row) === owner ? ownedImages : retainedImages).push(row.recipe.image);
        }
        const imagesPurged = this.vfs ? purgeDurableWorkerImages(this.vfs, ownedImages, retainedImages) : 0;
        await this.ctx.storage.delete(`${DURABLE_IMAGES_KEY_PREFIX}${owner}`);
        await this.ctx.storage.delete(`${RESIDENT_OWNER_KEY_PREFIX}${owner}`);
        const purged = await this.launchJournal.purgeWhere((record) => residentOwner(record) === owner);
        const name = await freeDurableFacetSlot(this.ctx, owner, (slot) => deleteFacetStorage(this.ctx, slot));
        return name !== null || purged > 0 || ownedPorts.size > 0 || imagesPurged > 0;
    }
    /** The session-shaped view the public-directory helpers read env from. */
    _publicDirectoryHost() {
        return { env: this.env.rawEnv, ctx: this.ctx };
    }
    /**
     * Whether a request addressed to `port` can reach a durable application —
     * and, when the application is journaled but dead, drive its re-drive and
     * wait for the boot, bounded.
     *
     * The port request is the one surface a reset leaves dark: the alarm pump
     * re-drives journaled launches eventually, but a URL a user is holding
     * cannot wait for an alarm that may never fire. 'started' means a live
     * process owns the port now; 'absent' means nothing durable claims it
     * (the caller answers 502 as it always has); 'failed' means a re-drive
     * ran and lost, or outlived its bound — the caller answers 503 and lets
     * the page re-ask.
     *
     * Single-flight per port: parallel requests on a woken page share one
     * ensure, which shares the journal's per-row drive with recovery — a
     * request that lands mid-recovery waits on that boot, it never boots a
     * second process.
     */
    ensureDurableAppOnPort(port) {
        let inflight = this.ensureInflight.get(port);
        if (inflight === undefined) {
            inflight = this._ensureDurableAppOnPort(port);
            this.ensureInflight.set(port, inflight);
            inflight.finally(() => {
                if (this.ensureInflight.get(port) === inflight)
                    this.ensureInflight.delete(port);
            });
        }
        return inflight;
    }
    async _ensureDurableAppOnPort(port) {
        if (this.portRegistry.has(port))
            return 'started';
        // The journal row is what makes a port a launch this instance owes —
        // reservation or not: every resident's row is stamped with the port it
        // bound, so any of them re-drives on request. A port with no stamped
        // row (nothing ever bound it, or the app was removed and its rows
        // purged) answers absent — nothing here can bring back an application
        // with no recipe. When more than one row names the port, the
        // reservation's owner wins; otherwise the newest launch does.
        const reservation = await readPortReservation(this.ctx, port);
        const rows = await this.launchJournal.rows();
        const candidates = [...rows].filter(([, record]) => record.port === port);
        const ownerRow = reservation !== null && reservation.owner !== null
            ? candidates.find(([, record]) => residentOwner(record) === reservation.owner)
            : undefined;
        const entry = ownerRow ?? candidates.sort(([, a], [, b]) => b.pid - a.pid)[0];
        if (entry === undefined)
            return 'absent';
        const [rowKey, record] = entry;
        if (record.pid > this.processes.pidBase) {
            // This instance's own row: the launch is already building — waiting
            // for its port registration is the entire ask, and driving the row
            // again would boot a second copy.
            return (await this._waitForPort(port, DURABLE_ENSURE_BOOT_BUDGET_MS))
                ? 'started' : 'failed';
        }
        const { promise: boundHit, resolve: markBound } = withResolvers();
        setTimeout(() => markBound(true), DURABLE_ENSURE_BOOT_BUDGET_MS);
        const failed = await Promise.race([
            this.launchJournal.drive(rowKey, record),
            boundHit,
        ]);
        if (failed)
            return 'failed';
        // A settled drive either owns the port or deliberately answered 'gone':
        // a resolver's null superseded the row, which is absent, not failed.
        return this.portRegistry.has(port) ? 'started' : 'absent';
    }
    /** Poll for a port registration the in-flight launch has not made yet. */
    async _waitForPort(port, budgetMs) {
        const deadline = Date.now() + budgetMs;
        while (Date.now() < deadline) {
            if (this.portRegistry.has(port))
                return true;
            const { promise: tick, resolve: tickDone } = withResolvers();
            setTimeout(tickDone, 50);
            await tick;
        }
        return this.portRegistry.has(port);
    }
    get stats() { return { ...this.processes.stats, readProfileConflicts: this.readProfileConflicts }; }
}
