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
import type { ProcessEntry } from '@nimbus-sh/core/runtime/process-table.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { CredentialedVfs, SqliteVFS, VfsStat } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { type PortVisibility } from '../session/port-capability.js';
import { TurnBudget } from '@nimbus-sh/fabric/turn-budget.js';
import { EsbuildService, type TransformResult } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { type ProcessHostFactory, type ResidentCodeSpec } from '@nimbus-sh/fabric/process-fabric.js';
import { type OpencodeRunnerOptions } from '../runtime/opencode-facet-runner.js';
import { type FacetBundleProfile } from '@nimbus-sh/core/runtime/bundle-profile.js';
import { type WasmImageRecord } from './wasm-image-digest.js';
type EsbuildTransformOptions = NonNullable<Parameters<EsbuildService['transform']>[1]>;
type LargeEsmTransform = (code: string, options: EsbuildTransformOptions) => Promise<TransformResult>;
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
    diag?: {
        drainPasses: number;
        rpcWrites: number;
        fsRpcReads: number;
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
 * The loop subscribes to the exit promise ONCE — a per-pass
 * `exitPromise.then()` allocates a promise every iteration — and yields
 * through the raw setTimeout so its own ticks don't inflate the timer count
 * it watches.
 */
export declare const ENTRYPOINT_EVENT_LOOP = "\nfunction __nimbusHandleCount(__name) {\n  const __value = globalThis[__name];\n  return typeof __value === \"number\" ? __value : 0;\n}\n\n// Work an entrypoint's STARTUP has to settle before it can be called booted.\nfunction __nimbusPendingStartupWork() {\n  return __nimbusHandleCount(\"__nimbusPendingTimers\") + __nimbusHandleCount(\"__nimbusPendingOps\");\n}\n\n// The above, plus the handles a program holds open on purpose. A bound port\n// keeps a Node process alive, and it keeps a one-shot facet alive too.\nfunction __nimbusLiveHandles() {\n  const __servers = globalThis.__portRegistry;\n  const __bound = __servers && typeof __servers.size === \"number\" ? __servers.size : 0;\n  return __nimbusPendingStartupWork() + __bound;\n}\n\nasync function __nimbusRunEventLoop(__countHandles, __exitPromise, __deadlineMs, __minPasses) {\n  let __exited = false;\n  if (__exitPromise && typeof __exitPromise.then === \"function\") {\n    __exitPromise.then(() => { __exited = true; }, () => { __exited = true; });\n  }\n  const __rawSetTimeout = (typeof globalThis.__nimbusRawSetTimeout === \"function\")\n    ? globalThis.__nimbusRawSetTimeout\n    : globalThis.setTimeout;\n  const __rawClearTimeout = (typeof globalThis.__nimbusRawClearTimeout === \"function\")\n    ? globalThis.__nimbusRawClearTimeout\n    : globalThis.clearTimeout;\n  let __expired = false;\n  let __pass = 0;\n  // A user-invoked program runs until it exits or is killed \u2014 there is no\n  // wall-clock deadline, so no expiry timer is armed at all. (Callers that\n  // still pass a finite deadline get the timer for compatibility.)\n  const __deadline = Number.isFinite(__deadlineMs)\n    ? __rawSetTimeout(() => { __expired = true; }, __deadlineMs)\n    : null;\n  while (!__exited && !__expired && (__pass < __minPasses || __countHandles() > 0)) {\n    // The warm-up passes give a settling microtask chain its turns and cost\n    // ~5\u00B5s each; past them the loop is waiting on wall-clock work, where\n    // spinning at 0ms would burn the isolate's CPU indefinitely.\n    await new Promise((resolve) => __rawSetTimeout(resolve, __pass < __minPasses ? 0 : 1));\n    __pass++;\n  }\n  if (__deadline !== null) { try { __rawClearTimeout(__deadline); } catch {} }\n  // `pending` is what the caller reports when it gives up: a one-shot program\n  // still holding a handle did NOT finish, and exiting 0 would claim it did.\n  return { passes: __pass, pending: __exited ? 0 : __countHandles() };\n}\n\n// An ESM entry's own evaluation promise (top-level await) is the one promise\n// that IS a handle \u2014 the module has not finished loading until it settles.\n// Answers true when process.exit won the race instead.\nasync function __nimbusAwaitEntryEvaluation(__entryResult) {\n  if (!__entryResult || typeof __entryResult.then !== \"function\") return false;\n  const __exit = {};\n  const __raced = await Promise.race([\n    __entryResult.then(() => null),\n    __nimbusProcessExitPromise.then(() => __exit, () => __exit),\n  ]);\n  return __raced === __exit;\n}\n\n// A one-shot facet's lifetime IS the loop: it runs the program until Node\n// would exit, or until the lifetime budget runs out.\nasync function __nimbusRunEntrypointToExit(__entryResult, __deadlineMs) {\n  if (await __nimbusAwaitEntryEvaluation(__entryResult)) return { passes: 0, pending: 0 };\n  return await __nimbusRunEventLoop(__nimbusLiveHandles, __nimbusProcessExitPromise, __deadlineMs, 4);\n}\n\n// A resident facet keeps running after the call that boots it returns, so it\n// settles startup and nothing more. The handles it holds open deliberately \u2014\n// its listening port \u2014 are the point of it, not a reason to make the shell's\n// prompt wait.\nasync function __nimbusSettleEntrypointStartup(__entryResult, __deadlineMs) {\n  if (await __nimbusAwaitEntryEvaluation(__entryResult)) return { passes: 0, pending: 0 };\n  return await __nimbusRunEventLoop(\n    __nimbusPendingStartupWork, __nimbusProcessExitPromise, __deadlineMs, 4,\n  );\n}\n";
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
export declare function generateEntrypointCode(userCode: string, vfsState: FacetVfsState, usesSqlite: boolean, shims: string, wasmImports?: readonly FacetWasmImport[]): Promise<GeneratedNodeFacetCode>;
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
}, usesSqlite: boolean, shims: string, pacer?: TurnBudget): Promise<GeneratedNodeFacetCode>;
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
type FacetVfsDenial = {
    error: 'EACCES';
};
type FacetVfsBundle = Record<string, string | Uint8Array | FacetVfsDenial>;
type FacetVfsMetadata = Pick<VfsStat, 'type' | 'size' | 'mode' | 'uid' | 'gid'>;
interface FacetVfsState {
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
    cursor?: {
        epoch: string;
        rev: number;
    };
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
}
/**
 * Drop the raw forms of everything that has been serialized, in place.
 *
 * `bundleSource`, `serializedManifest` and `serializedMetadata` are total
 * encodings of `bundle`, `manifest` and `metadata` — no caller can distinguish
 * a state carrying both from one carrying only the serialized halves, because
 * both facet generators read the serialized halves and nothing else does.
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
 * The generated source is a total encoding of all three: every byte of the
 * bundle expression, the manifest and the metadata is inside it. Holding them
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
    expression: string;
    imports: string;
    modules: Record<string, string>;
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
export declare function encodedBundleSize(bundle: FacetVfsBundle, manifest: Record<string, string[]>): {
    add(path: string, cell: FacetVfsBundle[string]): void;
    remove(path: string): void;
    readonly bytes: number;
};
/**
 * Serialize a VFS bundle for Worker Loader without dropping required files.
 *
 * Small bundles remain inline. Large bundles are partitioned into side
 * modules below the existing per-module encoded ceiling and merged during
 * module evaluation. A single oversized cell is split into ordered fragments;
 * the merge expression concatenates those fragments back to the original
 * string or Uint8Array before module precompilation begins.
 */
export declare function buildFacetVfsBundleSource(bundle: FacetVfsBundle, forceSideModules?: boolean, pacer?: TurnBudget): Promise<FacetVfsBundleSource>;
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
 * computed-path requires). Bounded to package.json + 1 main-entry file
 * per package — sub-agent §Q3 quantified the worst-case cumulative
 * budget impact (~322 KiB for fastify, ~1.7 MiB for ts-jest).
 *
 * `requiredPaths` is the static require closure. A package the closure
 * already reached — but reached only through a SUBPATH — has its main entry
 * skipped; see `mainIsSpeculative`.
 */
export declare function greedyAddMainEntries(vfs: CredentialedVfs, cwd: string, bundle: Record<string, string | Uint8Array>, budgetState: {
    totalBytes: number;
    fileCount: number;
}, requiredPaths?: ReadonlySet<string>): {
    added: number;
};
/**
 * The packages a computed `require(name)` inside the program can plausibly
 * name: the project root's own runtime `dependencies`, plus every package
 * ONE `dependencies` hop from a package that already owns a file in the
 * static closure. Never devDependencies, never a second hop.
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
 */
export declare function speculativePackageDirs(vfs: CredentialedVfs, cwdStripped: string, bundle: Record<string, string | Uint8Array>): string[];
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
export declare function addStaticReadFileAssets(vfs: CredentialedVfs, cwd: string, bundle: Record<string, string | Uint8Array>, budgetState: {
    totalBytes: number;
    fileCount: number;
}): {
    added: number;
};
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
export declare function addStaticReadFileDotfilesAndCompiled(vfs: CredentialedVfs, cwd: string, bundle: Record<string, string | Uint8Array>, budgetState: {
    totalBytes: number;
    fileCount: number;
}): {
    added: number;
};
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
export declare function addBinTargetSiblings(vfs: CredentialedVfs, scriptPath: string | undefined, bundle: Record<string, string | Uint8Array>, budgetState: {
    totalBytes: number;
    fileCount: number;
}, bundleProfile: FacetBundleProfile): {
    added: number;
    wasmPaths: string[];
};
/**
 * The wasm images a program's closure holds, by path and content digest.
 *
 * Two sources, one record: a `.wasm` cell the walk already staged (digested
 * from the cell, no second read), and a `.wasm` file the bin-package pass
 * saw but did not stage because it is over the bundle's per-file cap —
 * esbuild-wasm's 11.9 MiB image is the motivating one. A launch stages each
 * as a module-map member the loader compiles, registered under both keys,
 * so the program's own `new WebAssembly.Module(bytes)` is answered from the
 * map whether it read the bytes by path or carried them inline. A file that
 * cannot be read is left out; the seam's refusal names the module later.
 */
export declare function collectClosureWasmImages(vfs: Pick<CredentialedVfs, 'readFile'>, bundle: Record<string, string | Uint8Array | FacetVfsDenial>, unstagedPaths: readonly string[]): WasmImageRecord[];
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
export declare function addObservedReads(vfs: CredentialedVfs, observed: ReadonlySet<string> | undefined, bundle: Record<string, string | Uint8Array>, requiredPaths: Set<string>, budgetState: {
    totalBytes: number;
    fileCount: number;
}): {
    added: number;
};
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
export declare function isBundleModuleCandidate(path: string): boolean;
/**
 * The esbuild loader for a TypeScript source in the bundle, or null when the
 * path does not name one.
 *
 * A resolved `.ts` file reaches the facet as TypeScript, and TypeScript is not
 * JavaScript: `new Function` on a type annotation is a SyntaxError whether or
 * not the file has a single import in it. So these transform on their
 * EXTENSION, where `.js` files transform on their content — `looksLikeEsm` is
 * the right question for a file that is already valid JS either way, and the
 * wrong one for a file that is never valid JS.
 *
 * A declaration file (`.d.ts`, `.d.mts`, `.d.cts`) is not a source: it has
 * no runtime form, nothing `require()`s one, and esbuild's output for it is
 * empty by definition. It is DATA — read by the program that ships it, which
 * is exactly typescript: `tsc` reads its own `lib/lib.*.d.ts` with
 * `readFileSync`, and every declaration it type-checks against comes from
 * those bytes. Transforming them handed the compiler an 811-byte license
 * comment where `lib.es5.d.ts` (217 KB) had been, and every global type was
 * gone. So a declaration file is left exactly as it was staged.
 */
export declare function bundleTypescriptLoader(path: string): 'ts' | 'tsx' | null;
/** `name.d.ts` / `name.d.mts` / `name.d.cts`, by TypeScript's own rule. */
export declare function isTypescriptDeclarationFile(path: string): boolean;
export declare function compiledCellKey(path: string): string;
/** The source path a compiled-cell key stands for, or null for a plain path. */
export declare function compiledCellPath(key: string): string | null;
/**
 * The pre-compile loop both generated facets run at module evaluation, the
 * only moment workerd lets a string become code. One definition so the two
 * facets cannot drift on what they compile: every JavaScript-shaped cell
 * (`.js`, `.mjs`, `.cjs` and the extensionless bin scripts) from its own
 * bytes, and every TypeScript source from its compiled cell — which is
 * removed from the bundle here, so a `readFileSync` of the source path
 * returns the source and a directory listing never shows the key.
 */
export declare const BUNDLE_PRECOMPILE_LOOP: string;
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
export declare function buildPrefetchBundle(vfs: CredentialedVfs, scriptPath: string | undefined, cwd: string, entryCode: string, esbuild?: EsbuildService, bundleProfile?: FacetBundleProfile, observedReads?: ReadonlySet<string>, pacer?: TurnBudget, isolatedTransform?: LargeEsmTransform, maxBundleBytes?: number): Promise<FacetVfsState>;
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
    requestLaunchTurn?: (notBefore?: number) => void;
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
    transformLargeEsm?: LargeEsmTransform;
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
export interface LongRunningWorkerSpawnOptions {
    /** Interpreter residents share Node's atomic derived-owner claim. */
    resident?: {
        runtime: 'ruby' | 'python';
        argv: string[];
    };
    restart?: ResidentRestartPolicy;
    port?: number;
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
    private _pairedServeFacet;
    /**
     * W3.5 Fix B: lazily-created EsbuildService for the ESM→CJS pre-pass
     * over the prefetch bundle. Created on first exec where vfs is set;
     * shared across subsequent execs (warm wasm).  Optional setter
     * `setEsbuildService` lets NimbusSession share its existing instance
     * to avoid double-init.
     */
    private esbuild;
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
    private prefetchBundleCache;
    private static readonly PREFETCH_CACHE_MAX;
    /** Live sum of the entries' `bytes`, mirrored to the diag gauge on change. */
    private prefetchCacheBytes;
    /**
     * What each entry was observed to read and not have, keyed exactly like the
     * prefetch cache above so a profile can only ever seed the bundle it was
     * measured against.
     *
     * costs one more loud failure and then relearns. Persisting it would be a
     * schema and a migration bought with nothing the in-memory form does not
     * already deliver for the case that matters: running the command again.
     */
    private residencyProfiles;
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
    private static readonly RESIDENCY_PROFILE_MAX_ENTRIES;
    /**
     * A program that reads a directory of data files misses once per file, so
     * the cap has to clear a real working set. Past it the profile stops
     * growing and the surplus stays loud — a bounded map that admits the first
     * N is honest; an unbounded one in a Durable Object is a leak.
     */
    private static readonly RESIDENCY_PROFILE_MAX_PATHS;
    constructor(ctx: DurableObjectState, env: unknown, processes: SessionProcessSupervisor, portRegistry: PortRegistry, host: ProcessHostFactory, hooks?: FacetManagerHooks);
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
    setVfs(vfs: SqliteVFS): void;
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
    /**
     * W3.5 Fix B: hand the FacetManager a pre-warmed EsbuildService for
     * the ESM→CJS bundle pre-pass. NimbusSession already lazy-creates one
     * for the user-shell `node` runtime; sharing avoids paying init twice.
     */
    setEsbuildService(esbuild: EsbuildService): void;
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
     * File what a process could not read against the bundle that failed it.
     *
     * A miss the supervisor never hears about is a miss the next run repeats,
     * so this is the whole of the repair: record the path, then drop the cached
     * bundle for that key so the next build is a real one and stages it. The
     * program that hit the miss is already gone — nothing here rescues it, and
     * nothing here needs to, because the facet failed loudly on the way out.
     */
    private _recordResidencyMisses;
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
    noteProcessReportedExit(pid: number, exitCode: number): void;
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
        bundleProfile?: FacetBundleProfile;
        /** Return stdout/stderr in the result while keeping supervisor RPC
         *  available for VFS and child_process operations. */
        captureOutput?: boolean;
        /** Shell abort (Ctrl+C): aborting this aborts the in-flight run. */
        signal?: AbortSignal;
    }): Promise<FacetExecResult>;
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
     * `new Function` CJS facet path. It rides into the Worker Loader module map
     * as a real ESM module; the generated runner (mainModule) installs the
     * Bun-global polyfill, seeds process state, imports the bundle, and returns
     * buffered stdout/stderr/exit. node:sqlite is supplied as an override map
     * module so the static import links.
     */
    execStagedArtifact(artifact: string, opts: Omit<OpencodeRunnerOptions, 'cred' | 'vfsBundle' | 'vfsManifest' | 'vfsMetadata' | 'vfsCursor' | 'shimsCode' | 'mode'> & {
        command?: string;
        attachedTty?: boolean;
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
    /** Whether any launch is suspended waiting for a turn. */
    get hasPendingLaunchTurns(): boolean;
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
    /** Flush files written by the script back to the supervisor's VFS. */
    private _flushVfsWrites;
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
     * the caller's options because no caller has an opinion about it.
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
    /** `attempt` is the journal's re-drive budget, as `_spawnResident` carries it. */
    private _spawnWorker;
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
    /** Kill a running process by PID. */
    kill(pid: number): boolean;
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
        total: number;
        running: number;
        exited: number;
        killed: number;
        nextPid: number;
    };
}
export {};
//# sourceMappingURL=manager.d.ts.map