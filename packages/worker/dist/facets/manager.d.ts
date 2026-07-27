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
import { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import type { CredentialedVfs, SqliteVFS, VfsStat } from '../vfs/sqlite-vfs.js';
import type { PortRegistry } from '../runtime/port-registry.js';
import { EsbuildService } from '../runtime/esbuild-service.js';
import { type OpencodeRunnerOptions } from '../runtime/opencode-facet-runner.js';
import { type FacetBundleProfile } from '../runtime/bundle-profile.js';
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
export declare const ONE_SHOT_EXIT_RESERVE_MS = 3000;
/**
 * Budget used when the supervisor did not stamp an absolute deadline on the
 * payload. The deadline is the real bound — see `entryDeadlineAt` — because
 * it is measured from the supervisor's own timer rather than restarted when
 * the drain begins, so a slow module init cannot push the drain past the kill
 * and lose the honest message.
 */
export declare const ONE_SHOT_ENTRY_DEADLINE_MS: number;
/**
 * How long a RESIDENT facet settles its startup before answering its boot
 * call. It keeps running afterwards, so this is not a lifetime decision: the
 * budget only has to cover the entrypoint's own startup chain (binding a
 * port, first render). `spawnNode` awaits the boot, so a server's idle
 * keep-alive timer must not be allowed to hold the shell's prompt.
 */
export declare const RESIDENT_BOOT_SETTLE_MS = 1000;
export declare const ENTRYPOINT_PROMISE_TRACKER = "\nfunction __makeEntrypointPromiseTracker() {\n  const __tracked = new Set();\n  const __origThen = Promise.prototype.then;\n  const __origCatch = Promise.prototype.catch;\n  const __origFinally = Promise.prototype.finally;\n  let __active = false;\n  const __track = (p) => {\n    if (!p || typeof p.then !== \"function\") return p;\n    __tracked.add(p);\n    try {\n      __origThen.call(p, () => { __tracked.delete(p); }, () => { __tracked.delete(p); });\n    } catch {\n      __tracked.delete(p);\n    }\n    return p;\n  };\n  return {\n    start() {\n      __active = true;\n      try {\n        Promise.prototype.then = function(...args) {\n          const __next = __origThen.apply(this, args);\n          if (__active) __track(__next);\n          return __next;\n        };\n        Promise.prototype.catch = function(...args) {\n          const __next = __origCatch.apply(this, args);\n          if (__active) __track(__next);\n          return __next;\n        };\n        Promise.prototype.finally = function(...args) {\n          const __next = __origFinally.apply(this, args);\n          if (__active) __track(__next);\n          return __next;\n        };\n      } catch {\n        __active = false;\n      }\n    },\n    stop() {\n      __active = false;\n      try {\n        Promise.prototype.then = __origThen;\n        Promise.prototype.catch = __origCatch;\n        Promise.prototype.finally = __origFinally;\n      } catch {}\n    },\n    track: __track,\n    // Drain floating entry work until it settles, the process exits, or the\n    // deadline passes. Three kinds of pending work, mirroring Node's loop:\n    //\n    //   - Unsettled tracked PROMISES are microtask chains (create-vite's\n    //     clack scaffold, c3 / create-astro streaming a project to the live\n    //     VFS). Per Node a pending promise does not by itself keep a process\n    //     alive, but a floating `.then` chain is the only handle we have on\n    //     an entrypoint that has not returned its work, so it counts.\n    //   - Pending macrotask TIMERS/intervals (`__nimbusPendingTimers`).\n    //   - In-flight ASYNC OPERATIONS (`__nimbusPendingOps`): a fetch, a\n    //     response body read, an fs/child_process RPC. `await` never calls\n    //     the patched Promise.prototype.then, so a floating async entrypoint\n    //     is invisible to promise tracking \u2014 this counter is how awaited work\n    //     is seen at all. See the shim's __nimbusTrackOp.\n    //\n    // The bound is a REAL wall-clock deadline, armed as a timer rather than\n    // compared against `Date.now()`: a `setTimeout(0)` turn in workerd costs\n    // ~5\u00B5s, so the pass budget this loop used to carry (50k) expired after\n    // ~150ms and silently overrode every longer deadline the callers declared\n    // \u2014 anything slower than that, including an ordinary network fetch, was\n    // abandoned mid-flight and reported as a clean exit.\n    //\n    // The yield gap follows what is being waited on: a settling promise chain\n    // advances once per event-loop turn, so it is yielded at 0ms; a timer or\n    // an in-flight I/O op is wall-clock bound, so spinning at 0ms would just\n    // burn the isolate's CPU for the whole deadline.\n    async drain(exitPromise, deadlineMs = 5000, minPasses = 0) {\n      const __count = (name) => (typeof globalThis[name] === \"number\" ? globalThis[name] : 0);\n      const __pending = () => __tracked.size + __count(\"__nimbusPendingTimers\") + __count(\"__nimbusPendingOps\");\n      let __exited = false;\n      if (exitPromise && typeof exitPromise.then === \"function\") {\n        exitPromise.then(() => { __exited = true; }, () => { __exited = true; });\n      }\n      const __rawSetTimeout = (typeof globalThis.__nimbusRawSetTimeout === \"function\")\n        ? globalThis.__nimbusRawSetTimeout\n        : globalThis.setTimeout;\n      const __rawClearTimeout = (typeof globalThis.__nimbusRawClearTimeout === \"function\")\n        ? globalThis.__nimbusRawClearTimeout\n        : globalThis.clearTimeout;\n      let __expired = false;\n      const __deadline = __rawSetTimeout(() => { __expired = true; }, deadlineMs);\n      let __pass = 0;\n      while (!__exited && !__expired && (__pass < minPasses || __pending() > 0)) {\n        await new Promise((resolve) => __rawSetTimeout(resolve, __tracked.size > 0 ? 0 : 1));\n        __pass++;\n      }\n      try { __rawClearTimeout(__deadline); } catch {}\n      // `pending` is what the caller reports when it gives up: a one-shot\n      // program that still has work in flight did NOT finish, and exiting 0\n      // would claim it did.\n      return { passes: __pass, pending: __exited ? 0 : __pending() };\n    },\n  };\n}\n";
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
    /** Diagnostics: how many files survived the cap (post-greedy-oversample). */
    reachableCount: number;
    /** Diagnostics: was the bundle truncated by the encoded-size cap? */
    truncated: boolean;
    /** Telemetry: served from the prefetch-bundle cache (no VFS walk). */
    cacheHit?: boolean;
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
}
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
export declare function buildFacetVfsBundleSource(bundle: FacetVfsBundle, forceSideModules?: boolean): FacetVfsBundleSource;
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
 */
export declare function greedyAddMainEntries(vfs: CredentialedVfs, cwd: string, bundle: Record<string, string | Uint8Array>, budgetState: {
    totalBytes: number;
    fileCount: number;
}): {
    added: number;
};
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
export declare function buildPrefetchBundle(vfs: CredentialedVfs, scriptPath: string | undefined, cwd: string, entryCode: string, esbuild?: EsbuildService, bundleProfile?: FacetBundleProfile): Promise<FacetVfsState>;
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
    modules?: Record<string, string | {
        wasm: ArrayBuffer;
    }>;
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
    /** NIMBUS_DEBUG=1: placement diagnostics into the process log store. */
    private debugEnabled;
    private processRpcResources;
    private timedOutProcessIds;
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
    constructor(ctx: DurableObjectState, env: unknown, processes: SessionProcessSupervisor, portRegistry: PortRegistry, hooks?: FacetManagerHooks);
    setVfs(vfs: SqliteVFS): void;
    /**
     * W3.5 Fix B: hand the FacetManager a pre-warmed EsbuildService for
     * the ESM→CJS bundle pre-pass. NimbusSession already lazy-creates one
     * for the user-shell `node` runtime; sharing avoids paying init twice.
     */
    setEsbuildService(esbuild: EsbuildService): void;
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
    private _buildPrefetchBundleCached;
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
    execStagedArtifact(artifact: string, opts: Omit<OpencodeRunnerOptions, 'cred' | 'vfsBundle' | 'vfsManifest' | 'vfsMetadata' | 'shimsCode' | 'mode'> & {
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
     * The one way this manager boots a resident process. The caller's primitive
     * declares its own `processClass`; this method carries it to the fabric's
     * single policy point and adds nothing of its own. Everything after this
     * call treats the returned handle identically regardless of where it landed.
     */
    private _startResidentProcess;
    private _activateProcessVfsWriter;
    /**
     * A host death that the fabric recovered from is never silent: it lands in
     * the process log the user reads with `logs <pid>`.
     */
    private _noteHostRespawn;
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
    /** Flush files written by the script back to the supervisor's VFS. */
    private _flushVfsWrites;
    /** Execution timeout. */
    private _execWithTimeout;
    /**
     * Spawn a long-running Node process with the same shimmed require/fs/http
     * environment used by foreground `node <script>` execution.
     *
     * A resident primitive: the process outlives the call, may bind a port, and
     * accumulates memory for as long as it runs.
     *
     * Declares `light`, and the reason is ordering, not placement. A node
     * request handler routinely writes a file and returns a response that
     * asserts the write is already visible; `resident-node-request-vfs-durability`
     * pins that. Locally the write and the response settle against one VFS in
     * one workerd process. On a peer the write travels back over SUPERVISOR
     * while the response travels forward over the route target — two independent
     * paths — and nothing today orders them. Until that ordering is re-proven
     * across the extra hop rather than assumed, node stays in the coordinator's
     * process. Its image is also the cheapest of the resident runtimes, so it
     * has the least to gain from a peer.
     */
    spawnNode(code: string, opts?: {
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
    }): Promise<{
        pid: number;
    }>;
    /**
     * Spawn a long-running dynamic Worker, boot it, and return its boot payload.
     *
     * The shared primitive for any runtime that serves over
     * handleHttpRequest(Request) — the python and ruby socket servers today.
     *
     * Declares `heavy`. The interpreter image it carries is exactly the memory
     * that should not sit in the coordinator's workerd process — ruby's
     * interpreter+stdlib alone is 34.3 MiB, and it already travels to the host
     * BY VFS PATH, so peer placement costs the coordinator nothing it was not
     * already paying. It has no readiness coupling back into the session: the
     * runner answers startProcess with its boot payload and the caller waits on
     * that one promise, so nothing polls the port to decide the process is up.
     */
    spawnWorker(workerCode: string, command: string, cwd: string, opts?: LongRunningWorkerSpawnOptions): Promise<{
        pid: number;
        boot: unknown;
    }>;
    registerPort(pid: number, port: number): void;
    waitForRouteablePorts(pid: number, timeoutMs?: number): Promise<number[]>;
    finishProcess(pid: number, exitCode: number, reason?: string): void;
    /** Kill a running process by PID. */
    kill(pid: number): boolean;
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