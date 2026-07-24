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
import type { CredentialedVfs, SqliteVFS } from '../vfs/sqlite-vfs.js';
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
     * Exec telemetry, populated only when NIMBUS_DIAG_EXEC=1. drainPasses and
     * rpcWrites originate inside the facet (see exec-telemetry.ts); the
     * supervisor folds them with its own phase timings before recording.
     */
    diag?: {
        drainPasses: number;
        rpcWrites: number;
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
export declare const ENTRYPOINT_PROMISE_TRACKER = "\nfunction __makeEntrypointPromiseTracker() {\n  const __tracked = new Set();\n  const __origThen = Promise.prototype.then;\n  const __origCatch = Promise.prototype.catch;\n  const __origFinally = Promise.prototype.finally;\n  let __active = false;\n  const __track = (p) => {\n    if (!p || typeof p.then !== \"function\") return p;\n    __tracked.add(p);\n    try {\n      __origThen.call(p, () => { __tracked.delete(p); }, () => { __tracked.delete(p); });\n    } catch {\n      __tracked.delete(p);\n    }\n    return p;\n  };\n  return {\n    start() {\n      __active = true;\n      try {\n        Promise.prototype.then = function(...args) {\n          const __next = __origThen.apply(this, args);\n          if (__active) __track(__next);\n          return __next;\n        };\n        Promise.prototype.catch = function(...args) {\n          const __next = __origCatch.apply(this, args);\n          if (__active) __track(__next);\n          return __next;\n        };\n        Promise.prototype.finally = function(...args) {\n          const __next = __origFinally.apply(this, args);\n          if (__active) __track(__next);\n          return __next;\n        };\n      } catch {\n        __active = false;\n      }\n    },\n    stop() {\n      __active = false;\n      try {\n        Promise.prototype.then = __origThen;\n        Promise.prototype.catch = __origCatch;\n        Promise.prototype.finally = __origFinally;\n      } catch {}\n    },\n    track: __track,\n    // Drain floating entry work until it settles, the process exits, or a\n    // bound is hit. Two distinct kinds of pending work need different\n    // treatment to match Node's event-loop semantics:\n    //\n    //   - Unsettled tracked PROMISES are microtask chains. Per Node a pending\n    //     promise does NOT keep the process alive \u2014 only handles/timers do.\n    //     A settling chain (create-vite's clack scaffold, c3 / create-astro\n    //     streaming their project to the live VFS) must be allowed to finish,\n    //     but a NEVER-settling chain\n    //     (`Promise.resolve().then(() => new Promise(() => {}))`) must not\n    //     pin the facet. So tracked promises are drained only up to a finite\n    //     `maxPromisePasses` budget \u2014 generous enough for the multi-tick\n    //     scaffolders, finite enough that a stuck chain still exits.\n    //\n    //   - Pending macrotask TIMERS/intervals (`__timersPending`) DO keep the\n    //     loop alive (nuxi settles through setTimeout-driven steps).\n    //\n    // BOTH branches are bounded by the wall-clock deadline AND the pass\n    // budget, because each bound covers the other's blind spot: workerd does\n    // not advance `Date.now()` while an isolate spins without I/O (measured\n    // `elapsed=0` across the whole drain), so a no-I/O drain loops forever\n    // against a deadline that never trips \u2014 the pass budget is the frozen-\n    // clock backstop. Under a live clock (host tests, drains interleaved with\n    // real I/O) a setTimeout(0) pass costs ~1ms of clamped timer, so the 50k\n    // budget alone would spin for tens of seconds \u2014 the deadline is the\n    // live-clock bound, tripping long before the budget. Scaffolders settle\n    // their multi-tick chains well inside both bounds, so a stuck chain, an\n    // idle long-running server's keep-alive, a TTL timeout, or a `--watch`\n    // poller ends the drain promptly instead of pinning the facet and the\n    // shell prompt.\n    async drain(exitPromise, deadlineMs = 5000, minPasses = 0) {\n      const __start = Date.now();\n      const __maxPromisePasses = 50000;\n      const __timersPending = () => (typeof globalThis.__nimbusPendingTimers === \"number\" ? globalThis.__nimbusPendingTimers : 0);\n      let __exited = false;\n      if (exitPromise && typeof exitPromise.then === \"function\") {\n        exitPromise.then(() => { __exited = true; }, () => { __exited = true; });\n      }\n      const __rawSetTimeout = (typeof globalThis.__nimbusRawSetTimeout === \"function\")\n        ? globalThis.__nimbusRawSetTimeout\n        : globalThis.setTimeout;\n      let __pass = 0;\n      for (\n        ;\n        !__exited\n          && (__pass < minPasses\n            || (__timersPending() > 0 && Date.now() - __start < deadlineMs && __pass < __maxPromisePasses)\n            || (__tracked.size > 0 && Date.now() - __start < deadlineMs && __pass < __maxPromisePasses));\n        __pass++\n      ) {\n        await new Promise((resolve) => __rawSetTimeout(resolve, 0));\n      }\n      return __pass;\n    },\n  };\n}\n";
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
     * Read one of a process's files with its own credential. The fabric uses it
     * to resolve a boot spec's wasm sidecars wherever the facet is hosted — a
     * peer pulls the same bytes back over the coordinator's fs RPC.
     */
    private _readProcessFile;
    /**
     * W3.5 Fix B: hand the FacetManager a pre-warmed EsbuildService for
     * the ESM→CJS bundle pre-pass. NimbusSession already lazy-creates one
     * for the user-shell `node` runtime; sharing avoids paying init twice.
     */
    setEsbuildService(esbuild: EsbuildService): void;
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
     * The one way this manager boots a resident process. Both spawn primitives
     * declare `heavy` — they exist precisely to run something that stays
     * resident, binds ports and grows memory — and everything after this call
     * treats the returned handle identically regardless of where it landed.
     */
    private _startResidentProcess;
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
     * accumulates memory for as long as it runs — so it declares `heavy` and the
     * fabric gives it its own workerd process. Where it lands is the fabric's
     * business; nothing below this line knows or asks.
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
     * Like every resident primitive it declares `heavy`: the runtime image it
     * carries is exactly the memory that should not sit in the coordinator's
     * workerd process.
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
//# sourceMappingURL=manager.d.ts.map