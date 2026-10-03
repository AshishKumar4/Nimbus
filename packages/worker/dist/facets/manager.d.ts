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
import { ReadAheadBudget } from '@nimbus-sh/core/runtime/stdin-read.js';
import { type ProcessEntry } from '@nimbus-sh/core/runtime/process-table.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { type NodeFacetSources } from '../runtime/node-shims-artifact.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { NimbusFilesystemAuthority, RuntimeFsBridge } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { type PortVisibility } from '../session/port-capability.js';
import { type RequiredModuleRoot } from '@nimbus-sh/core/runtime/require-resolver.js';
import { type StagedProfileEntry } from './read-profile.js';
import { TurnBudget } from '@nimbus-sh/fabric/turn-budget.js';
import { type EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { type BundleCellResultStore, type BundleCellTransformStats } from '@nimbus-sh/core/runtime/bundle-cell-transform.js';
import { type ProcessHostFactory, type ResidentCodeSpec } from '@nimbus-sh/fabric/process-fabric.js';
import { type OpencodeRunnerOptions } from '../runtime/opencode-facet-runner.js';
import { type FacetBundleProfile } from '@nimbus-sh/core/runtime/bundle-profile.js';
import { type WasmImageRecord } from './wasm-image-digest.js';
/**
 * The filesystem a launch's module map is built from: the process's bound
 * supervisor bridge. Its probes and reads go through the resolver's one
 * adapter over it (requireFsOverBridge), made once per bridge.
 */
type LaunchFs = RuntimeFsBridge;
/** A pipe or redirect's bytes, exactly as written, until it ends (null). */
export interface StdinBytes {
    readBytes(maxLength: number): Promise<Uint8Array | null>;
}
/** Result returned from a facet execution */
export interface FacetExecResult {
    exitCode: number;
    stdout: string;
    stderr: string;
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
     * Files the run tried to execute that its module map lacked: the next
     * launch's module map is built with them as roots (launch-learning-store.ts).
     */
    moduleMisses?: string[];
    /**
     * Code the run produced and could not compile (a file written then
     * required, a Function-constructor call), as its ledger reported it:
     * staged for the next launch of the same entry (commonjs-cell.ts, RUNTIME
     * CODE). Validated where it is recorded.
     */
    runtimeCode?: unknown[];
    /**
     * Exec telemetry, populated only when NIMBUS_DIAG_EXEC=1. drainPasses,
     * rpcWrites and fsRpcReads originate inside the facet (see
     * exec-telemetry.ts); the supervisor folds them with its own phase timings
     * before recording.
     */
    diag?: {
        drainPasses: number;
        rpcWrites: number;
        fsRpcReads: number;
        namespaceRefusals?: number;
    };
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
 * How long a RESIDENT facet settles its startup before answering its boot
 * call. It keeps running afterwards, so this is not a lifetime decision: the
 * budget only has to cover the entrypoint's own startup chain (binding a
 * port, first render). `spawnNode` awaits the boot, so a server's idle
 * keep-alive timer must not be allowed to hold the shell's prompt.
 */
export declare const RESIDENT_BOOT_SETTLE_MS = 1000;
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
export declare const ENTRYPOINT_EVENT_LOOP = "\nfunction __nimbusHandleCount(__name) {\n  const __value = globalThis[__name];\n  return typeof __value === \"number\" ? __value : 0;\n}\n\n// Binding a native listen(0) first awaits session-wide allocation. Until it\n// binds, it is a referenced handle just like the eventual server; unref and\n// close still remove its contribution. It is also startup work to settle.\nfunction __nimbusPendingHttpListens() {\n  let count = 0;\n  const listeners = globalThis.__nimbusPendingHttpListeners;\n  if (listeners) for (const server of listeners) if (!server.__nimbusUnrefed) count++;\n  return count;\n}\n\nfunction __nimbusPendingStartupWork() {\n  return __nimbusHandleCount(\"__nimbusPendingTimers\") + __nimbusHandleCount(\"__nimbusPendingOps\") + __nimbusPendingHttpListens();\n}\n\n// The above, plus the handles a program holds open on purpose. A bound port\n// keeps a Node process alive, and it keeps a one-shot facet alive too.\nfunction __nimbusLiveHandles() {\n  const __servers = globalThis.__portRegistry;\n  let __bound = 0;\n  if (__servers && typeof __servers.values === \"function\") {\n    for (const __server of __servers.values()) if (!__server?.__nimbusUnrefed) __bound++;\n  }\n  return __nimbusPendingStartupWork() + __bound + __nimbusHandleCount(\"__nimbusInputHandles\")\n    + __nimbusHandleCount(\"__nimbusOpenSockets\");\n}\n\nasync function __nimbusRunEventLoop(__countHandles, __exitPromise, __deadlineMs, __minPasses) {\n  let __exited = false;\n  if (__exitPromise && typeof __exitPromise.then === \"function\") {\n    __exitPromise.then(() => { __exited = true; }, () => { __exited = true; });\n  }\n  const __rawSetTimeout = (typeof globalThis.__nimbusRawSetTimeout === \"function\")\n    ? globalThis.__nimbusRawSetTimeout\n    : globalThis.setTimeout;\n  const __rawClearTimeout = (typeof globalThis.__nimbusRawClearTimeout === \"function\")\n    ? globalThis.__nimbusRawClearTimeout\n    : globalThis.clearTimeout;\n  let __expired = false;\n  let __pass = 0;\n  // A user-invoked program runs until it exits or is killed \u2014 there is no\n  // wall-clock deadline, so no expiry timer is armed at all. (Callers that\n  // still pass a finite deadline get the timer for compatibility.)\n  const __deadline = Number.isFinite(__deadlineMs)\n    ? __rawSetTimeout(() => { __expired = true; }, __deadlineMs)\n    : null;\n  while (!__exited && !__expired && (__pass < __minPasses || __countHandles() > 0)) {\n    // The warm-up passes give a settling microtask chain its turns and cost\n    // ~5\u00B5s each; past them the loop is waiting on wall-clock work, where\n    // spinning at 0ms would burn the isolate's CPU indefinitely.\n    await new Promise((resolve) => __rawSetTimeout(resolve, __pass < __minPasses ? 0 : 1));\n    __pass++;\n  }\n  if (__deadline !== null) { try { __rawClearTimeout(__deadline); } catch {} }\n  // `pending` is what the caller reports when it gives up: a one-shot program\n  // still holding a handle did NOT finish, and exiting 0 would claim it did.\n  return { passes: __pass, pending: __exited ? 0 : __countHandles() };\n}\n\n// An ESM entry's own evaluation promise (top-level await) is the one promise\n// that IS a handle \u2014 the module has not finished loading until it settles.\n// Answers true when process.exit won the race instead.\nasync function __nimbusAwaitEntryEvaluation(__entryResult) {\n  if (!__entryResult || typeof __entryResult.then !== \"function\") return false;\n  const __exit = {};\n  const __raced = await Promise.race([\n    __entryResult.then(() => null),\n    __nimbusProcessExitPromise.then(() => __exit, () => __exit),\n  ]);\n  return __raced === __exit;\n}\n\n// A one-shot facet's lifetime IS the loop: it runs the program until Node\n// would exit, or until the lifetime budget runs out.\nasync function __nimbusRunEntrypointToExit(__entryResult, __deadlineMs) {\n  if (await __nimbusAwaitEntryEvaluation(__entryResult)) return { passes: 0, pending: 0 };\n  return await __nimbusRunEventLoop(__nimbusLiveHandles, __nimbusProcessExitPromise, __deadlineMs, 4);\n}\n\n// Whether the program holds no live handle once a settling chain has had the\n// same four turns the one-shot loop gives it.\nasync function __nimbusHoldsNoHandle() {\n  const __rawSetTimeout = (typeof globalThis.__nimbusRawSetTimeout === \"function\")\n    ? globalThis.__nimbusRawSetTimeout\n    : globalThis.setTimeout;\n  for (let __pass = 0; __pass < 4; __pass++) await new Promise((resolve) => __rawSetTimeout(resolve, 0));\n  return __nimbusLiveHandles() === 0;\n}\n\n// A resident process ends as Node's does: when it holds no live handle. It\n// may serve for hours, so this does not poll: every place a handle is released\n// (a timer firing or cleared, an operation settling, a server closed or\n// unref'd, stdin let go) calls __nimbusHandleReleased, and a release that\n// leaves none is the program's natural end.\nfunction __nimbusNaturalExit() {\n  return new Promise((resolve) => {\n    let __checking = false;\n    const __released = () => {\n      if (__checking) return;\n      __checking = true;\n      __nimbusHoldsNoHandle().then((__none) => {\n        __checking = false;\n        if (!__none) return;\n        if (globalThis.__nimbusHandleReleased === __released) globalThis.__nimbusHandleReleased = undefined;\n        resolve();\n      });\n    };\n    globalThis.__nimbusHandleReleased = __released;\n    __released();\n  });\n}\n\n// A resident facet keeps running after the call that boots it returns, so it\n// settles startup and nothing more. The handles it holds open deliberately \u2014\n// its listening port \u2014 are the point of it, not a reason to make the shell's\n// prompt wait. Its module's own evaluation is bounded by the same budget: a\n// server entry that ends in a top-level await which never settles\n// (`await new Promise(() => {})`, a dev server awaiting a listen that fails)\n// is a running program in Node, and waiting on it here left the boot call \u2014\n// and every request routed to the facet, which waits for boot \u2014 hung\n// forever. A rejection after the budget fails the process as Node's does.\nasync function __nimbusSettleEntrypointStartup(__entryResult, __deadlineMs) {\n  const __startedAt = Date.now();\n  if (__entryResult && typeof __entryResult.then === \"function\") {\n    const __rawSetTimeout = (typeof globalThis.__nimbusRawSetTimeout === \"function\")\n      ? globalThis.__nimbusRawSetTimeout\n      : globalThis.setTimeout;\n    const __rawClearTimeout = (typeof globalThis.__nimbusRawClearTimeout === \"function\")\n      ? globalThis.__nimbusRawClearTimeout\n      : globalThis.clearTimeout;\n    const __exit = {};\n    const __late = {};\n    let __timer = null;\n    const __raced = await Promise.race([\n      __entryResult.then(() => null),\n      __nimbusProcessExitPromise.then(() => __exit, () => __exit),\n      new Promise((resolve) => { __timer = __rawSetTimeout(() => resolve(__late), __deadlineMs); }),\n    ]).finally(() => { try { __rawClearTimeout(__timer); } catch {} });\n    if (__raced === __exit) return { passes: 0, pending: 0 };\n    if (__raced === __late) {\n      __entryResult.then(undefined, (__error) => { queueMicrotask(() => { throw __error; }); });\n      return { passes: 0, pending: __nimbusPendingStartupWork() };\n    }\n  }\n  return await __nimbusRunEventLoop(\n    __nimbusPendingStartupWork, __nimbusProcessExitPromise,\n    Math.max(0, __deadlineMs - (Date.now() - __startedAt)), 4,\n  );\n}\n";
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
export declare function findInlineWasmImages(bundle: FacetVfsBundle): Uint8Array[];
/**
 * A generated facet's module map: its main module, the side modules the VFS
 * bundle's data was partitioned across, and the `{ cjs }` modules of the
 * process's code — every cell of its closure and its entry
 * (core/_shared/commonjs-cell.ts).
 */
interface GeneratedNodeFacetCode {
    code: string;
    modules: Record<string, string>;
    codeModules: Record<string, string>;
}
/**
 * Generate one-shot runtime code with a plain fetch handler. `filename`
 * names the entry's module, and so its stack frames.
 */
export declare function generateEntrypointCode(userCode: string, vfsState: FacetVfsState, usesSqlite: boolean, sources: NodeFacetSources, wasmImports?: readonly FacetWasmImport[], filename?: string): Promise<GeneratedNodeFacetCode>;
/** One wasm image the generated main module imports from the module map. */
export interface FacetWasmImport {
    /** The module-map name the boot spec carries the image under. */
    moduleName: string;
    /** The absolute VFS path the program reads the same bytes from. */
    vfsPath: string;
    /**
     * A content key for the same bytes, for an image the program never reads
     * from the filesystem — one inlined in a package's own source as base64.
     * The seam recognises the bytes instead of the path.
     */
    digest?: string;
}
/** The module-map name a precompiled wasm image travels under. */
export declare function facetWasmModuleName(index: number): string;
/**
 * The wasm imports one launch stages: the images its options name, then
 * every image the closure walk recorded (FacetVfsState.wasmImages) that the
 * options did not already name by path. One member per path; the closure's
 * record supplies the digest an option without one lacks.
 */
export declare function facetWasmImports(named: readonly {
    vfsPath: string;
    digest: string | undefined;
}[], closure: readonly WasmImageRecord[]): FacetWasmImport[];
export declare function generateLongRunningNodeCode(userCode: string, vfsState: FacetVfsState, opts: {
    argv?: string[];
    env?: Record<string, string>;
    cwd?: string;
    filename?: string;
    dirname?: string;
    stdin?: string;
    attachedTty?: boolean;
    cred: ProcessEntry['cred'];
    /** Wasm images the generated main module imports and parks in the seam. */
    wasmImports?: readonly FacetWasmImport[];
}, usesSqlite: boolean, sources: NodeFacetSources, pacer?: TurnBudget): Promise<GeneratedNodeFacetCode>;
/**
 * Result of preparing facet VFS state.
 *   - bundle:   path → content for the complete static require closure
 *               plus bounded optional snapshot enrichment for dynamic
 *               requires and synchronous filesystem reads. Required files
 *               are never removed to satisfy an enrichment budget.
 *

 * The process's view of names and stats is the namespace its store boots on
 * (vfs/facet-resident-store.ts), never a spawn-time table.
 */
type FacetVfsDenial = {
    error: 'EACCES';
};
type FacetVfsBundle = Record<string, string | Uint8Array | FacetVfsDenial>;
interface FacetVfsState {
    /** The shared read profile's entries this launch was offered: staged ones, and those no regular file answered. */
    profileOffer?: {
        staged: StagedProfileEntry[];
        unresolved: string[];
    };
    bundle: FacetVfsBundle;
    /**
     * The executable form of each TypeScript source in `bundle`, by the
     * source's path: esbuild's emit, which becomes the path's module cell while
     * `bundle` keeps the source a program reads. A JavaScript cell needs none —
     * its transformed text replaces it in `bundle` and serves both.
     */
    emits?: Map<string, string>;
    /**
     * The JavaScript cells lowered from ESM (transformEsmInBundle), whose
     * module wraps them in the block scope (commonjs-cell.ts, THE WRAPPER).
     * Every other code cell is CommonJS as Node would run it.
     */
    lowered?: Set<string>;
    /** What the module map costs the facet's store, taken before its cells are released (N18). */
    moduleStorageBytes?: number;
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
    cursor?: {
        epoch: string;
        rev: number;
    };
    /** Diagnostics: how many files survived the cap (post-greedy-oversample). */
    reachableCount: number;
    /** Diagnostics: was the bundle truncated by the encoded-size cap? */
    truncated: boolean;
    /** Diagnostics: how the build's transforms were answered. */
    transforms?: BundleCellTransformStats;
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
    /** Move the bundle out of the main module when combined state exceeds its ceiling. */
    bundleSideModulesRequired?: boolean;
    /**
     * The wasm images the closure holds, by path and content digest — see
     * `collectClosureWasmImages`. A launch stages each as a wasm map entry.
     */
    wasmImages?: readonly WasmImageRecord[];
    /**
     * Memoized `bundleUsesNodeSqlite(entryCode, bundle)`. Answered while the raw
     * cells are still in hand so `releaseSerializedSources` can drop them — it is
     * the only thing anything downstream still wanted them for.
     */
    usesNodeSqlite?: boolean;
    /**
     * Names of the staged napi bindings the closure requires
     * (stagedBindingsRequiredBy), answered with `usesNodeSqlite`: the launch
     * carries each, and the main module registers them.
     */
    stagedBindings?: string[];
    /**
     * True once `releaseGeneratedSources` has dropped the serialized forms. The
     * state can still answer for its cursor, key and flags; it can no longer
     * generate a module map, and asking is an error rather than an empty map.
     */
    generatedSourcesReleased?: boolean;
    /**
     * Whether the prefetch cache is holding this state's serialized forms. A
     * refused entry belongs to the invocation that built it and nothing else,
     * which is what makes releasing it safe.
     */
    cacheRetained?: boolean;
    /** Every path the module map carries: the closure a resident launch plans its data from. */
    bundlePaths?: readonly string[];
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
export declare function releaseSerializedSources(vfsState: FacetVfsState): void;
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
export declare function releaseGeneratedSources(vfsState: FacetVfsState): void;
interface FacetVfsBundleSource {
    /** The data cells: an inline expression, or one joining the side modules. */
    expression: string;
    imports: string;
    modules: Record<string, string>;
    /** The code cells as `{ cjs }` module texts, by module name. */
    codeModules: Record<string, string>;
    /** The JSON of the launch's CommonJsCellRow table. */
    codeCells: string;
    /** The JSON list of runtime-code keys the map carries as `gen/<key>.js`. */
    runtimeCode: string;
    /**
     * What the process's store charges itself to adopt the data cells and the
     * code cells it reads back (facet-resident-store's __residentCellCost).
     */
    storageBytes: number;
}
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
export declare function encodedBundleSize(bundle: FacetVfsBundle): {
    add(path: string, cell: FacetVfsBundle[string]): void;
    remove(path: string): void;
    readonly bytes: number;
};
/**
 * Serialize a VFS bundle for Worker Loader without dropping required files.
 *
 * Every code cell becomes its own `{ cjs }` module (commonjs-cell.ts), which
 * the guest's registry compiles the first time the program requires it. Its
 * text is the one copy the map carries: the process's store adopts the file
 * by reading that module back, so a cell is never also data — except where
 * the read-back cannot name it (commonJsCellReadsBack) and for a TypeScript
 * source, whose file is the source and whose module is the emit.
 *
 * The data cells stay one bundle. Small bundles remain inline. Large bundles
 * are partitioned into side modules below the existing per-module encoded
 * ceiling and merged during module evaluation. A single oversized cell is
 * split into ordered fragments; the merge expression concatenates those
 * fragments back to the original string or Uint8Array.
 */
export declare function buildFacetVfsBundleSource(bundle: FacetVfsBundle, forceSideModules?: boolean, pacer?: TurnBudget, { consume, emits, lowered, runtimeCode, }?: {
    consume?: boolean;
    emits?: ReadonlyMap<string, string>;
    /** Cells lowered from ESM, wrapped in the block scope. */
    lowered?: ReadonlySet<string>;
    /** Runtime code staged for this launch: `{ cjs }` module text by key. */
    runtimeCode?: ReadonlyMap<string, string>;
}): Promise<FacetVfsBundleSource>;
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
export declare function assertStagedBundleFitsRpcPayload(serialized: string, bundle: FacetVfsBundle): void;
/**
 * Greedy-oversample every installed package's main entry. The static
 * prefetch via require-resolver covers the require() chain literally
 * present in source; greedy oversampling adds a safety net for dynamic
 * patterns the regex misses (jest/`bindings`/`import-local` style
 * computed-path requires). Each guessed root brings its readable literal
 * closure as one optional admission/eviction unit, within the existing caps.
 *
 * `requiredPaths` is the static require closure. A package the closure
 * already reached — but reached only through a SUBPATH — has its main entry
 * skipped; see `mainIsSpeculative`.
 */
interface OptionalModuleGroup {
    root: string;
    members: ReadonlySet<string>;
}
export declare function greedyAddMainEntries(vfs: LaunchFs, cwd: string, bundle: Record<string, string | Uint8Array>, budgetState: {
    totalBytes: number;
    fileCount: number;
}, requiredPaths?: ReadonlySet<string>, options?: {
    maxBundleBytes?: number;
    pacer?: TurnBudget;
}): Promise<{
    added: number;
    groups: OptionalModuleGroup[];
}>;
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
export declare function speculativePackageDirs(vfs: LaunchFs, cwdStripped: string, bundle: Record<string, string | Uint8Array>): Promise<string[]>;
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
export declare function addStaticReadFileAssets(vfs: LaunchFs, cwd: string, bundle: Record<string, string | Uint8Array>, budgetState: {
    totalBytes: number;
    fileCount: number;
}): Promise<{
    added: number;
}>;
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
export declare function addStaticReadFileDotfilesAndCompiled(vfs: LaunchFs, cwd: string, bundle: Record<string, string | Uint8Array>, budgetState: {
    totalBytes: number;
    fileCount: number;
}): Promise<{
    added: number;
}>;
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
export declare function addBinTargetSiblings(vfs: LaunchFs, scriptPath: string | undefined, bundle: Record<string, string | Uint8Array>, budgetState: {
    totalBytes: number;
    fileCount: number;
}, bundleProfile: FacetBundleProfile): Promise<{
    added: number;
    wasmPaths: string[];
}>;
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
export declare function collectClosureWasmImages(vfs: LaunchFs, bundle: Record<string, string | Uint8Array | FacetVfsDenial>, unstagedPaths: readonly string[]): Promise<WasmImageRecord[]>;
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
export declare function addObservedReads(vfs: LaunchFs, observed: ReadonlySet<string> | undefined, bundle: Record<string, string | Uint8Array>, requiredPaths: Set<string>, budgetState: {
    totalBytes: number;
    fileCount: number;
}, room?: number, pacer?: TurnBudget): Promise<{
    added: number;
    bytes: number;
}>;
/** What buildPrefetchBundle builds a module map for, and with what. */
export interface PrefetchBundleOptions {
    /** The program's path; absent for `-e` code and stdin. */
    scriptPath?: string;
    cwd: string;
    entryCode: string;
    /** The ESM→CJS pass's transform host; absent, ESM cells stage as diagnostics. */
    esbuild?: EsbuildService;
    bundleProfile?: FacetBundleProfile;
    /** Paths earlier runs of the same entry read synchronously and missed. */
    observedReads?: ReadonlySet<string>;
    /** The launch's pacer; a build without one runs in the caller's turn. */
    pacer?: TurnBudget;
    /** The closure's raw-byte bound (VFS_BUNDLE_MAX_BYTES). */
    maxBundleBytes?: number;
    /** Other sessions' misses in the packages the closure can load (read-profile.ts). */
    learnedFor?: (closure: readonly string[]) => Promise<readonly string[]>;
    /** Modules earlier runs executed, as roots of the required graph; one that arrives with its text is walked from it. */
    executedModules?: readonly RequiredModuleRoot[];
    /** Where the launch's transform results are kept by content. */
    transformStore?: BundleCellResultStore;
}
/**
 * The working dir's config files of the tool a launch runs. The tool
 * executes them (Vite bundles vite.config.ts and imports the result), so
 * what they import is required code that nothing in the program's own graph
 * names, and a first run would miss it. A config is the tool's when it is
 * named for the launched package or a package that one depends on (Astro
 * runs Vite, Vite runs PostCSS); a config of a tool the launch does not run
 * (eslint.config.js beside Vite) is not. What a config names by a string
 * (PostCSS's plugins) the tool loads by name: those join the walk's phase 2.
 */
export declare function toolConfigRoots(vfs: LaunchFs, cwd: string, scriptPath: string | undefined): Promise<RequiredModuleRoot[]>;
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
export declare function buildPrefetchBundle(vfs: LaunchFs, options: PrefetchBundleOptions): Promise<FacetVfsState>;
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
    /**
     * Arrange for `pumpResidentLaunches` to run on a fresh Durable Object turn.
     *
     * The session satisfies this with an alarm, which is the only primitive that
     * genuinely re-enters the object: a fresh turn is both a released thread and
     * a fresh CPU budget, and a launch needs each for a different reason.
     */
    requestLaunchTurn?: (notBefore?: number) => void | Promise<void>;
    /**
     * Put a line in front of the user, whether or not a terminal is attached.
     *
     * Distinct from writing to a process's output: what this reports happened to
     * the SESSION, and the socket that would have shown it is typically the one
     * the event destroyed. The session satisfies it with the live terminal when
     * there is one and the persisted scrollback when there is not, so the line
     * survives until someone reconnects to read it.
     */
    notify?: (line: string) => void;
    /**
     * Resolve the launch inputs a journalled worker launch needs re-driven with.
     * Keyed by `recipe.owner`: the embedder's own record of the durable
     * application decides — `null` means it is stopped or removed, so it is not
     * restarted.
     */
    resolveWorkerLaunch?: (recipe: WorkerRecipe) => Promise<ResolvedWorkerLaunch | null>;
    /**
     * The session's own default resolver, reading the durable image store a
     * self-owned spawn persisted under `.nimbus/images/`. Consulted ONLY when
     * `resolveWorkerLaunch` is absent — an embedder's hook still overrides
     * everything. Being the fallback is also what it is *not*: it can never
     * re-mint a live globalOutbound binding, so a durable spawn carrying one
     * is refused unless the embedder hook exists.
     */
    resolveWorkerLaunchFallback?: (recipe: WorkerRecipe) => Promise<ResolvedWorkerLaunch | null>;
}
export interface ForegroundLaunch {
    signal: AbortSignal;
    write(stream: 'stdout' | 'stderr', text: string): void;
}
export interface LongRunningWorkerSpawnOptions {
    /** Interpreter residents share Node's atomic derived-owner claim. */
    resident?: {
        runtime: 'ruby' | 'python';
        argv: string[];
    };
    /**
     * The command that launched the process, waiting on its boot: until the
     * boot settles the process's output goes there instead of the shell
     * mirror, and the command's interrupt kills the process.
     */
    foreground?: ForegroundLaunch;
    restart?: ResidentRestartPolicy;
    port?: number;
    /** The process whose command starts this one: its exec id is this one's. Never journalled. */
    invokerPid?: number;
    /** Inline modules: source text, or small wasm carried by value. */
    modules?: Record<string, string | {
        wasm: ArrayBuffer;
    }>;
    /**
     * Module name → VFS path of a wasm image the process's host materializes
     * for itself. Runtime images belong here, not in `modules`: ruby's is
     * 34.3 MiB, past what any single RPC value may carry.
     */
    vfsWasmModules?: Record<string, string>;
    /**
     * Module name → VFS path of a content-addressed module SOURCE, read as
     * UTF-8 when the facet loads — the same by-path posture as
     * `vfsWasmModules`, through the same kernel image reader, for module text
     * an embedder keeps in its own content store rather than carrying by value.
     * Each path must name its own digest (`…/<sha256>.js`, see fabric's
     * `facetImagePath`); the loader verifies it on read.
     */
    vfsTextModules?: Record<string, string>;
    /**
     * The module the isolate boots from; `workerCode` is placed under this name
     * in the module map. Default `'worker.js'`.
     */
    mainModule?: string;
    compatibilityFlags?: string[];
    compatibilityDate?: string;
    env?: ResidentCodeSpec['env'];
    globalOutbound?: ResidentCodeSpec['globalOutbound'];
    /** Forwarded verbatim to the runner's startProcess. */
    startArgs?: unknown;
    /**
     * Set for a worker a durable application owns: the launch is journalled and
     * re-driven after an instance reset through `hooks.resolveWorkerLaunch`.
     * A plain spawnWorker stays unjournaled.
     */
    durable?: {
        owner: string;
        image?: {
            runner: string;
            application: string;
        };
    };
}
/** The main module name a worker launch boots from unless told otherwise. */
export declare const DEFAULT_WORKER_MAIN_MODULE = "worker.js";
/**
 * The narrow handle `spawnWorker` returns beside the pid: the process's own
 * inbound surface, bound to the resident handle's route target, for an
 * embedder that invokes the worker directly rather than through a registered
 * port. It carries NO release — `kill(pid)` remains the one lifecycle owner,
 * and this handle is dead once that pid is; nothing here can end, restart or
 * detach the process.
 */
export interface WorkerFacet {
    /** Inbound HTTP, on the facet's `handleHttpRequest`. */
    fetch(request: Request): Promise<Response>;
    /** Inbound WebSocket upgrade, on the facet's `handleWebSocketRequest`. */
    connect(request: Request): Promise<Response>;
}
/** What `spawnWorker` answers with. */
export interface SpawnedWorker {
    pid: number;
    /** The runner's startProcess payload. */
    boot: unknown;
    facet: WorkerFacet;
}
/** What `spawnNode` needs to build and boot one resident Node process. */
export interface ResidentSpawnOptions {
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
    /** The process whose command starts this one: its exec id is this one's. Never journalled. */
    invokerPid?: number;
    bundleProfile?: FacetBundleProfile;
}
/** The launch inputs a re-drive rebuilds a worker from: content digests and
 *  transport, never env or credentials — the embedder resolves those. */
export interface WorkerRecipe {
    /**
     * Set only for an interpreter resident the SESSION launched itself — a
     * `python`/`ruby` socket server whose image is the runtime the session
     * installed. It is the runtime and argv of that interpreter, never a
     * boolean, and it is what routes the recipe's re-drive to the session's own
     * image-store fallback (`resolveWorkerLaunchFallback`) rather than the
     * embedder's `resolveWorkerLaunch`: the session owns that image and its
     * bookkeeping, and no embedder was asked about the launch. A worker recipe
     * WITHOUT it — every embedder-driven `spawnWorker` — re-drives through the
     * embedder's resolver, with the fallback consulted only when no embedder
     * hook is composed.
     */
    resident?: LongRunningWorkerSpawnOptions['resident'];
    kind: 'worker';
    /** The durable application this process belongs to, keyed by the embedder. */
    owner: string;
    /** Content digests of the two images the launch was built from. */
    image: {
        runner: string;
        application: string;
    };
    port: number;
    cwd: string;
    compatibilityDate: string;
    compatibilityFlags: string[];
    startArgs?: unknown;
    /**
     * The main module the launch booted from, when it was not the default —
     * so a re-drive whose resolver answers modules alone still boots the same
     * one. Rows written before the field existed booted `worker.js`.
     */
    mainModule?: string;
}
export type ResidentRestartPolicy = 'never' | 'on-failure';
/** The env var a launch reads its restart policy from — set by startProcess({ restart }) and `nimbus start --restart`. */
export declare const RESTART_POLICY_ENV = "NIMBUS_RESTART";
/** One application as `apps.list` reports it — every stamped identity, live or not. */
export interface ResidentAppSummary {
    owner: string;
    name: string | null;
    port: number | null;
    pid: number | null;
    status: 'running' | 'starting' | 'stopped' | 'failed';
    visibility: PortVisibility;
    capability: string | null;
    restart: ResidentRestartPolicy;
    /** Set with status 'failed': what went wrong, in the user's terms. */
    diagnostic: string | null;
    /** The exec id of `pid` (`ProcessEntry.execId`); absent when it has none. */
    execId?: string;
}
/** What a pid's journal row says about who it is. */
export interface ResidentIdentity {
    owner: string | undefined;
    ephemeral: boolean;
    port: number | undefined;
}
/** What the embedder supplies for a re-driven worker launch. */
export interface ResolvedWorkerLaunch {
    startArgs?: unknown;
    /** Null is the absent answer — the same JSON the image blob carries. */
    env: ResidentCodeSpec['env'] | null;
    globalOutbound: ResidentCodeSpec['globalOutbound'];
    /** Module name → source text, including the main module under its name. */
    modules: Record<string, string>;
    /** Module name → VFS path of a wasm image, restored with the launch. */
    vfsWasmModules?: Record<string, string>;
    /** Module name → VFS path of a content-addressed module source, restored with the launch. */
    vfsTextModules?: Record<string, string>;
    /**
     * The name in `modules` the launch boots from. Absent, the recipe's own
     * `mainModule` decides, then `'worker.js'`.
     */
    mainModule?: string;
}
export declare class FacetManager {
    private ctx;
    private env;
    private processes;
    private portRegistry;
    private vfs;
    private filesystem;
    private hooks;
    /**
     * The resident-process scheduler (loaders/process-fabric.ts). Every
     * long-lived process — staged opencode, node servers, python/ruby socket
     * servers — is booted through it, and it is the only code that knows which
     * workerd process a facet landed in.
     */
    private processFabric;
    /**
     * The same substrate the fabric runs residents on, held directly because a
     * one-shot has no lifecycle for the fabric to own — it is started, read and
     * gone inside one call.
     */
    private processHost;
    /** NIMBUS_DEBUG=1: placement diagnostics into the process log store. */
    private debugEnabled;
    private processRpcResources;
    /**
     * The session's pipe read-ahead budget (stdin-read.ts), held here because a
     * read ahead is held in this Durable Object, whichever launch holds it. One
     * byte over the bound shows whether a pipe ended exactly there.
     */
    readonly stdinReadAhead: ReadAheadBudget;
    /**
     * The content-addressed boot-image store (fabric's image-store.ts),
     * writing through this session's kernel-credentialed VFS and rooted off the
     * live process table.
     */
    private readonly imageStore;
    /**
     * The resident-launch journal (fabric's fenced-work.ts): the durable
     * record of every resident this session owes the user, and its recovery
     * after an instance reset. This manager supplies what a launch IS — the
     * recipe `_redrive` re-drives from — and how its loss is reported.
     */
    private readonly launchJournal;
    /**
     * The granting side of the launch budget (fabric's turn-budget.ts). The
     * session's alarm re-enters the object through `pumpResidentLaunches`;
     * journal recovery rides the first pump.
     */
    private readonly launchPump;
    private readonly launchTasks;
    private launchesClosed;
    private _pairedServeFacet;
    private readonly residentBundleKeys;
    /** Per resident pid: the shared read profile's entries its launch staged, settled at its exit. */
    private readonly residentProfileOffers;
    /**
     * The service the bundle's ESM→CJS pass transforms with. composeFacetManager
     * sets it: the host's own, or one whose transforms run in the session's
     * transform facet. Never one of this isolate: a transform engine's wasm
     * memory only grows.
     */
    private esbuild;
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
    private prefetchBundleCache;
    private static readonly PREFETCH_CACHE_MAX;
    /** Live sum of the entries' `bytes`, mirrored to the diag gauge on change. */
    private prefetchCacheBytes;
    /**
     * What each command's runs learned for its next launch: the modules they
     * tried to execute and the files they read that the launch lacked, and the
     * runtime code they produced (launch-learning-store.ts). Kept in the
     * session's storage: the session is evicted whenever it sits idle between
     * two commands, and a profile that died with it made the next run miss the
     * same file again (Vite's node_modules/ms/index.js on every launch).
     */
    private learning;
    /**
     * Misses shared across sessions per installed package (read-profile.ts),
     * kept in the npm tarball cache bucket (NPM_TARBALL_CACHE) beside the
     * tarballs. Unbound, a miss is learned for this session only
     * (learning).
     */
    private readProfile;
    /** Read-profile changes dropped after losing every write race. */
    private readProfileConflicts;
    /** Per module path: its static references at a revision (see _closureStaticRefs). */
    private staticRefsMemo;
    /** Modules whose references are remembered: a few programs' closures. */
    private static readonly STATIC_REFS_MEMO_MAX;
    /**
     * What the prefetch cache holds right now, for /api/_diag/memory: each
     * entry's key, the revision it was built at, and its retained bytes, next
     * to the filesystem's live revision and the residency profiles. A launch
     * that rebuilds where a hit was expected is explained by exactly these:
     * the revision moved, the key changed, or a miss profile dropped the entry.
     */
    prefetchCacheDiag(): {
        revision: number | null;
        entries: Array<{
            key: string;
            revision: number;
            bytes: number;
        }>;
        launchProfiles: Array<{
            key: string;
            executedModules: string[];
            dataReads: string[];
            codeKeys: string[];
        }>;
    };
    /** In-flight request-driven durable-app ensures, single-flight per port. */
    private ensureInflight;
    /** Per-pid chain of journal-row amendments; see `_amendRow`. */
    private rowAmendments;
    /**
     * pid → the derived owner it duplicates: the second live instance of an
     * identity. Not journalled (nothing re-drives it), so this is the only
     * record of why `expose(pid)` refuses it.
     */
    private ephemeralPids;
    private residentClaims;
    constructor(ctx: DurableObjectState, env: unknown, processes: SessionProcessSupervisor, portRegistry: PortRegistry, host: ProcessHostFactory, hooks?: FacetManagerHooks);
    /**
     * A signal's default action: the process ends with 128+signo whether its
     * facet is still being built (the launch stops at its next ownership gate)
     * or already booted (its resources are released like a kill).
     */
    private _endBySignal;
    /**
     * The process is over. Every end-of-life passes through here: a clean
     * exit, a kill, a timeout, a crash. Only one of them owes anything more
     * than the journal row's release — a crash under 'on-failure' is re-driven
     * from the row, after a backoff, while the row is still in storage so a
     * reset inside the backoff window recovers it like any other resident.
     */
    private _onResidentTerminal;
    /** Claim identity AND write its recovery row in one serializable storage transaction. */
    private _claimResident;
    private _releaseResidentClaim;
    /**
     * Amend one journal row in place — port stamp, owner adoption, settle —
     * serialized per pid so two amendments in flight on the same row cannot
     * interleave their read and write and lose one another's fields.
     */
    private _amendRow;
    /** The authority is the caller's: a session composes exactly one, and the
     *  manager credentials its processes through that one rather than a second
     *  authority over the same disk. */
    setVfs(vfs: SqliteVFS, filesystem: NimbusFilesystemAuthority): void;
    /**
     * The env/ctx pair every loader-backed runtime builds its facet pools
     * from. A pool is constructed from exactly these two, so the manager
     * exposes them as one narrow accessor rather than every runtime reaching
     * into its private fields.
     */
    loaderHost(): {
        env: unknown;
        ctx: DurableObjectState;
    };
    /**
     * The image store's disk: this session's VFS, as the kernel — the store is
     * written by the kernel and read by processes through supervisor bindings
     * that enforce their own credential. Mode 0644 at creation, as POSIX has
     * it, is what makes the read succeed for any process by construction; the
     * store itself decides nothing about modes.
     */
    private _imageBlobs;
    /**
     * The kernel-scoped VFS the durable image store reads and writes through —
     * `.nimbus/images/<sha256>` is session kernel data, not user content.
     */
    private _imageVfs;
    /** Give the bundle's ESM→CJS pass the host's esbuild, as composeFacetManager does. */
    setEsbuildService(esbuild: EsbuildService): void;
    /**
     * The entry script as the facet compiles it: each dynamic `import()` routed
     * to the process's ESM loader, with the entry's own URL as the parent (Node
     * names `-e` code `<cwd>/[eval]` and stdin `<cwd>/[stdin]`). The parse runs
     * in the transform facet like every cell's, and its result is kept by content
     * in the session's transform store. The module-map walk reads the script as
     * written, before this.
     */
    private _entryDynamicImports;
    /**
     * The store this session's launches keep their transform results in: the
     * session's database, admitted through its storage ledger, bound to the
     * esbuild service's transform host. None when the host has no identity (a
     * result could not be told apart from another host's) or there is no
     * filesystem to admit against.
     */
    private _transformStore;
    /**
     * The pacer every launch is built under: the session's alarm-driven turn
     * pump, the deployment's chunk bound, and the one check a suspended launch
     * makes when it resumes — that the process it is building for still exists.
     */
    private _launchPacer;
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
    private _wasmModulesByValue;
    /**
     * The module-map members of the staged napi bindings `names`, by value, for
     * a one-shot facet (it has no disk reader at load): the shared loader and
     * trampoline, and each binding. Fetched from the worker's own assets —
     * L2-cached, digest-verified — inside the scope that holds the map, and
     * dropped with it.
     */
    private _stagedBindingModulesByValue;
    /**
     * Stage every wasm image the closure inlines as base64 (findInlineWasmImages)
     * as a kernel-owned file named by its content key, and return the records
     * the launch registers it under: by that path, which both launch forms read
     * it from, and by digest, which is how the program's own compile of the
     * decoded bytes is recognised. Small (es-module-lexer's parser is 11.8 KB)
     * and written once per session per image.
     */
    private _stageInlineWasmImages;
    /** In-flight writes of the session's copies of staged bindings, by name; one writer each. */
    private stagedBindingWrites;
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
    private _residentStagedBindingMembers;
    /**
     * Which contents a resident process holds from its first instruction,
     * beyond its module map: data-plan.ts over this process's view of the
     * namespace, mounts included where its launch names them. A path the plan
     * leaves out is still named and stat-able; a synchronous read of it is the
     * one honest miss.
     */
    private _planResidentData;
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
    private _staticReadPlan;
    /**
     * Paths earlier launches of the same build missed in this session. Other
     * sessions' misses (the shared read profile) join the module map instead,
     * in _buildProcessBundle, where a learned module brings its imports.
     */
    private _learnedReads;
    /**
     * The installed packages a closure can load: every package the lockfiles
     * pin whose node_modules directory is on the resolution path of the cwd or
     * of a closure file. A first miss is, by definition, in a package the
     * closure did not already load, so its package's root is found this way.
     */
    private _profileRoots;
    /**
     * A package directory's identity for the shared read profile: the tarball
     * integrity the session's lockfiles pin, or, for a package no lockfile
     * pins (a link, a git or file dependency), the content key of its
     * package.json as this credential reads it.
     */
    private _packageIdentity;
    /**
     * What the closure's JavaScript names by a foldable path (static-fs-refs.ts),
     * read from the VFS as written rather than from the module map, whose ESM
     * cells were rewritten and lost their import.meta. Each module is parsed once
     * per revision of it, in this session.
     */
    private _closureStaticRefs;
    private _buildProcessBundle;
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
    private _recordLaunchLearning;
    /** Tell a process's log that what its run learned was not kept. */
    private _learningLost;
    private _dropPrefetchCacheEntry;
    /**
     * The runtime code recorded for an entry, as `{ cjs }` module text by key:
     * a constructor call as the function module (or the SyntaxError the
     * constructor would throw), a file lowered and wrapped as a module cell is.
     * A file is staged by its content key even when the launch also carries its
     * path as a cell: the guest looks a path up first and the key only for a
     * path the map lacks — the same text written under a fresh name.
     */
    private _stagedRuntimeCode;
    /** True when the cache is holding this state — see FacetVfsState.cacheRetained. */
    private _admitPrefetchCacheEntry;
    /**
     * Build the Worker Loader module-map fragment that carries the sql.js
     * WebAssembly.Module into a facet, when that facet imports node:sqlite.
     * Returns `{}` for the common case (no sqlite) so the spread is free.
     * Delegates to the shared per-isolate memoizer in opencode-staging.ts.
     */
    private sqliteModuleEntry;
    private trackProcessRpcResources;
    private releaseProcessRpcResources;
    private revokeProcessVfsWriters;
    /**
     * True while a resident facet holds this pid — it was adopted through the
     * bin-spawn contract and now owns the process lifecycle, reporting its own
     * exit. A caller that launched the command must not record an exit for it.
     */
    hasResidentProcess(pid: number): boolean;
    /** Acknowledge generated code only after storage has accepted it. The
     * launch key comes from the process table, never from guest arguments. */
    noteProcessRuntimeCode(pid: number, entries: unknown[], executedModules?: string[], dataReads?: string[]): Promise<void>;
    noteProcessReportedExit(pid: number, exitCode: number, dataReads?: string[], evidence?: {
        served: ReadonlySet<string>;
        profileUnread: readonly string[] | null;
    }, runtimeCode?: unknown[], executedModules?: string[]): void;
    /**
     * Tear down the serve facet a dual (`opencode`) spawn paired with this pid.
     * Called when the attach TUI exits (reported / killed) so the OS-child serve
     * facet never outlives its foreground process.
     */
    private _teardownPairedServeFacet;
    /** Execute one-shot JS code in an isolated dynamic Worker. */
    exec(code: string, opts: {
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
        /** The process whose command runs the program: its exec id is the program's. */
        invokerPid?: number;
        bundleProfile?: FacetBundleProfile;
        /** Return stdout/stderr in the result while keeping supervisor RPC
         *  available for VFS and child_process operations. */
        captureOutput?: boolean;
        /** Shell abort (Ctrl+C): aborting this aborts the in-flight run. */
        signal?: AbortSignal;
        /**
         * A pipe or redirect as the program's stdin. It streams through the
         * process's input channel as it arrives, from before the program
         * starts; the program is never held for the pipe to end.
         */
        stdinPipe?: StdinBytes;
        /**
         * The pipe ends within what was read ahead of it: the program takes all
         * of it before it starts, for its synchronous reads of stdin.
         */
        stdinWhole?: boolean;
        /**
         * A `< file` redirect: fd 0 is this file from `offset`. `syncRead`: the
         * program reads stdin synchronously, so it reads the file first.
         */
        stdinFile?: {
            path: string;
            offset: number;
            syncRead: boolean;
        };
    }): Promise<FacetExecResult>;
    /**
     * Feed a pipe to `pid`'s input channel as it arrives, a chunk at a time:
     * a full queue waits for the program to read, and the pipe's end ends the
     * channel. stop() leaves the rest of the pipe unread, so a program that
     * finished without reading all of it (`tail -f log | node -e ...`)
     * releases the pipe and its writer ends, as a closed reader ends it in a
     * shell.
     */
    private _pumpStdinPipe;
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
    private _w5RecordTermination;
    private _execViaLoader;
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
    execStagedArtifact(artifact: string, opts: Omit<OpencodeRunnerOptions, 'cred' | 'vfsBundle' | 'vfsCursor' | 'sources' | 'mode'> & {
        command?: string;
        attachedTty?: boolean;
        invokerPid?: number;
    }): Promise<StagedArtifactExecResult>;
    /**
     * Prepare a staged-opencode spawn: spawn the process-table entry, snapshot
     * the VFS, and build the small OpencodeStageSpec. The artifact sources
     * (entry bundle, chunk pack, wasm sidecars — ~23 MB of module map) are NOT
     * materialized here: NimbusLoadedEntrypoint assembles them from the spec in
     * a stateless worker isolate on the Worker-Loader cache-miss path, so the
     * supervisor DO never carries them (it OOM-reset at the 128 MiB isolate cap
     * when it did — live-diagnosed 2026-07-16).
     */
    private _stageOpencodeFacet;
    /**
     * Attached-TTY staged-artifact lifecycle (the interactive opencode TUI). Boots
     * the runner's startProcess() — which holds the facet open via ctx.waitUntil
     * while opencode's createCliRenderer loop streams ANSI frames to the terminal
     * RPC and the live stdin pump feeds keystrokes — and returns immediately with
     * the pid. The facet reports its own exit via SUPERVISOR.reportExit; resources
     * release on report-exit, the same contract the long-running node path uses.
     */
    private _execStagedArtifactAttached;
    /**
     * Run a headless `opencode serve` as a resident, routeable server facet. The
     * server binds a KNOWN loopback port (honouring an explicit --port/-p/env.PORT,
     * else an allocated free port injected into argv) so the in-session loopback
     * router and external `/port/<n>` both reach it. Returns immediately with the
     * pid once the facet is spawned + its route stub bound; readiness is gated by
     * the caller (dual path health-gates on `/doc`).
     */
    execStagedArtifactServer(artifact: string, opts: {
        argv: string[];
        env: Record<string, string>;
        cwd: string;
        command?: string;
        port?: number;
        invokerPid?: number;
    }): Promise<StagedArtifactExecResult>;
    /**
     * Bare `opencode` (the interactive TUI) as a MULTI-ISOLATE process pair: a
     * headless `opencode serve` facet + an `opencode attach <url>` attached-TTY
     * facet, each in its own 128 MiB isolate, joined by the session loopback port
     * registry. The serve facet is an OS-child of the attach facet: it is health-
     * gated before attach launches, and torn down when the attach TUI exits.
     * Returns the ATTACH pid — the user-facing foreground process.
     */
    execStagedArtifactDual(artifact: string, opts: {
        argv: string[];
        env: Record<string, string>;
        cwd: string;
        command?: string;
        invokerPid?: number;
    }): Promise<StagedArtifactExecResult>;
    private _runOpencodeServerFacet;
    /**
     * NIMBUS_DEBUG live evidence (log-tail channel) of where a resident process
     * was scheduled. The manager logs an opaque description; only the fabric
     * knows what a placement is.
     */
    private _noteProcessPlacement;
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
    private _residentDisk;
    /**
     * Fail a paced launch whose process went away while it was suspended.
     *
     * Between turns anything may happen to the process — a kill, a reap, an
     * image sweep that has already unrooted its images. Continuing would
     * spend further turns building a facet for a pid nothing will ever attach
     * to, and would write image files the next sweep immediately collects.
     */
    private _assertLaunchStillOwned;
    /**
     * The one way this manager boots a resident process. Every resident process
     * is a facet of this session; there is nothing to place and nothing here
     * decides anything about where a program runs.
     */
    private _startResidentProcess;
    private _activateProcessVfsWriter;
    /**
     * Grant every suspended launch a chunk of this turn — the session's alarm
     * calls this, and journal recovery rides the first pump. See fabric's
     * `PacedWork.pump` for the ownership argument.
     */
    pumpResidentLaunches(): Promise<void>;
    private trackLaunchTask;
    closeLaunches(): Promise<void>;
    /** Allocate a free loopback port for a resident server facet (from 4096 up). */
    private _allocateLoopbackPort;
    /**
     * Poll `http://127.0.0.1:<port>/doc` through the loopback port router until it
     * answers 200, bounded by `timeoutMs`. Fails loud (with the server's log tail
     * and the last poll outcome) if the serve facet exits early or never becomes
     * ready. Each poll is individually capped at `pollTimeoutMs` so a request
     * wedged in the booting facet cannot starve the loop; the 30s default budget
     * covers the live-measured ~14s cold boot-to-serving time with margin.
     */
    private _awaitOpencodeServerReady;
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
    private _warmOpencodeServer;
    /** Recent stderr/stdout tail for a pid, for fail-loud diagnostics. */
    private _processLogTail;
    /**
     * A launch that fails before its process is running reports the same way
     * regardless of which phase failed: the pid is exited, the terminal event
     * recorded, and the session notified. Callers do their phase-specific
     * cleanup (ports, tracked RPC resources) first and pass a reason that names
     * the phase.
     */
    private _failLaunch;
    /**
     * Re-drive a journalled launch after an instance reset. What the journal
     * row carries is the recipe and nothing else: env and credentials are never
     * written to storage, so a worker launch's are re-resolved by the embedder
     * through `hooks.resolveWorkerLaunch`.
     */
    private _redrive;
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
    spawnNode(code: string, opts?: ResidentSpawnOptions): Promise<{
        pid: number;
    }>;
    /**
     * `attempt` distinguishes the launch the user asked for from the one re-drive
     * an instance reset earns it, and is carried in the journal rather than in
     * the caller's options because no caller has an opinion about it. So is a
     * re-drive's `execId`, from the row: the process that invoked the launch
     * went with the instance.
     */
    private _spawnResident;
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
    private _runResidentLaunch;
    private _runResidentLaunchBody;
    private _residentLaunchBody;
    /**
     * The exit code of a launched process that has already ended, or null
     * while it runs. What a caller that started a resident reads to tell a
     * server that is up from a program that finished during its boot.
     */
    processExitCode(pid: number): number | null;
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
    spawnWorker(workerCode: string, command: string, cwd: string, opts?: LongRunningWorkerSpawnOptions): Promise<SpawnedWorker>;
    /** `attempt` is the journal's re-drive budget, and `execId` a re-drive's exec id, as `_spawnResident` carries them. */
    private _spawnWorker;
    private _holdForeground;
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
    private _registerResidentPort;
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
    residentIdentity(pid: number): Promise<ResidentIdentity | null>;
    /**
     * Every stamped identity — the reservations, and the journal rows that
     * carry an owner — folded one row per owner. A live pid in THIS instance
     * makes it running (or starting, until its launch settles and its port
     * is registered); a mismatch diagnostic makes it failed; everything else
     * is stopped, which for a row a reset left behind means re-drivable on
     * request.
     */
    listResidentApps(): Promise<ResidentAppSummary[]>;
    registerPort(pid: number, port: number): Promise<void>;
    waitForRouteablePorts(pid: number, timeoutMs?: number): Promise<number[]>;
    finishProcess(pid: number, exitCode: number, reason?: string): void;
    /**
     * Kill a running process by PID. Given the signal that ends it (a name
     * without `SIG`), it exits with that signal's status, 128+signo, and its
     * exit names `SIG<name>`; without one it is SIGKILL's 137, `killed`.
     */
    kill(pid: number, signal?: string): boolean;
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
    removeDurableApp(owner: string): Promise<boolean>;
    /** The session-shaped view the public-directory helpers read env from. */
    private _publicDirectoryHost;
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
    ensureDurableAppOnPort(port: number): Promise<'started' | 'absent' | 'failed'>;
    private _ensureDurableAppOnPort;
    /** Poll for a port registration the in-flight launch has not made yet. */
    private _waitForPort;
    get stats(): {
        readProfileConflicts: number;
        total: number;
        running: number;
        exited: number;
        killed: number;
        nextPid: number;
    };
}
export {};
//# sourceMappingURL=manager.d.ts.map