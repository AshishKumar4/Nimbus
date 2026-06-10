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
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { PortRegistry } from '../runtime/port-registry.js';
import { EsbuildService } from '../runtime/esbuild-service.js';
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
}
export declare const ENTRYPOINT_PROMISE_TRACKER = "\nfunction __makeEntrypointPromiseTracker() {\n  const __tracked = new Set();\n  const __origThen = Promise.prototype.then;\n  const __origCatch = Promise.prototype.catch;\n  const __origFinally = Promise.prototype.finally;\n  let __active = false;\n  const __track = (p) => {\n    if (!p || typeof p.then !== \"function\") return p;\n    __tracked.add(p);\n    try {\n      __origThen.call(p, () => { __tracked.delete(p); }, () => { __tracked.delete(p); });\n    } catch {\n      __tracked.delete(p);\n    }\n    return p;\n  };\n  return {\n    start() {\n      __active = true;\n      try {\n        Promise.prototype.then = function(...args) {\n          const __next = __origThen.apply(this, args);\n          if (__active) __track(__next);\n          return __next;\n        };\n        Promise.prototype.catch = function(...args) {\n          const __next = __origCatch.apply(this, args);\n          if (__active) __track(__next);\n          return __next;\n        };\n        Promise.prototype.finally = function(...args) {\n          const __next = __origFinally.apply(this, args);\n          if (__active) __track(__next);\n          return __next;\n        };\n      } catch {\n        __active = false;\n      }\n    },\n    stop() {\n      __active = false;\n      try {\n        Promise.prototype.then = __origThen;\n        Promise.prototype.catch = __origCatch;\n        Promise.prototype.finally = __origFinally;\n      } catch {}\n    },\n    track: __track,\n    // Drain floating entry promises until they settle, the process exits,\n    // or a wall-clock deadline is hit. `minPasses` guarantees a minimum\n    // number of ticks so freshly-scheduled work (microtasks that haven't\n    // registered yet) gets a chance to surface. The deadline \u2014 not a fixed\n    // tick count \u2014 bounds genuinely-pending promises (servers, intervals);\n    // a fixed tiny pass cap previously abandoned legitimate multi-tick\n    // async entrypoints (e.g. create-vite's clack-driven scaffold) before\n    // their synchronous file writes ran.\n    async drain(exitPromise, deadlineMs = 5000, minPasses = 0) {\n      const __exit = {};\n      const __start = Date.now();\n      for (let __pass = 0; (__tracked.size > 0 || __pass < minPasses) && Date.now() - __start < deadlineMs; __pass++) {\n        if (exitPromise && typeof exitPromise.then === \"function\") {\n          const __result = await Promise.race([\n            new Promise((resolve) => setTimeout(() => resolve(null), 0)),\n            exitPromise.then(() => __exit, () => __exit),\n          ]);\n          if (__result === __exit) return;\n        } else {\n          await new Promise((resolve) => setTimeout(resolve, 0));\n        }\n      }\n    },\n  };\n}\n";
/**
 * Greedy-oversample every installed package's main entry. The static
 * prefetch via require-resolver covers the require() chain literally
 * present in source; greedy oversampling adds a safety net for dynamic
 * patterns the regex misses (jest/`bindings`/`import-local` style
 * computed-path requires). Bounded to package.json + 1 main-entry file
 * per package — sub-agent §Q3 quantified the worst-case cumulative
 * budget impact (~322 KiB for fastify, ~1.7 MiB for ts-jest).
 */
export declare function greedyAddMainEntries(vfs: SqliteVFS, cwd: string, bundle: Record<string, string | Uint8Array>, budgetState: {
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
export declare function addStaticReadFileAssets(vfs: SqliteVFS, cwd: string, bundle: Record<string, string | Uint8Array>, budgetState: {
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
export declare function addStaticReadFileDotfilesAndCompiled(vfs: SqliteVFS, cwd: string, bundle: Record<string, string | Uint8Array>, budgetState: {
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
    modules?: Record<string, any>;
    compatibilityFlags?: string[];
}
export declare class FacetManager {
    private ctx;
    private env;
    private processes;
    private portRegistry;
    private vfs;
    private hooks;
    private processRpcResources;
    private timedOutProcessIds;
    /**
     * W3.5 Fix B: lazily-created EsbuildService for the ESM→CJS pre-pass
     * over the prefetch bundle. Created on first exec where vfs is set;
     * shared across subsequent execs (warm wasm).  Optional setter
     * `setEsbuildService` lets NimbusSession share its existing instance
     * to avoid double-init.
     */
    private esbuild;
    /**
     * Memoized sql.js wasm bytes for the node:sqlite facet path. Fetched
     * once from env.ASSETS (sqlite-wasm-bytes.ts) on the first facet that
     * imports node:sqlite, then reused for every subsequent sqlite facet in
     * this isolate. Held as an ArrayBuffer because the Worker Loader module
     * map needs a fresh `{ wasm }` entry per facet config.
     */
    private sqliteWasmBytes;
    private sqliteWasmBytesPromise;
    constructor(ctx: DurableObjectState, env: unknown, processes: SessionProcessSupervisor, portRegistry: PortRegistry, hooks?: FacetManagerHooks);
    setVfs(vfs: SqliteVFS): void;
    /**
     * W3.5 Fix B: hand the FacetManager a pre-warmed EsbuildService for
     * the ESM→CJS bundle pre-pass. NimbusSession already lazy-creates one
     * for the user-shell `node` runtime; sharing avoids paying init twice.
     */
    setEsbuildService(esbuild: EsbuildService): void;
    /**
     * Build the Worker Loader module-map fragment that carries the sql.js
     * WebAssembly.Module into a facet, when that facet imports node:sqlite.
     * Returns `{}` for the common case (no sqlite) so the spread is free.
     *
     * The bytes are fetched once per isolate and reused (a fresh ArrayBuffer
     * view per facet config). workerd compiles the `wasm` module ahead of
     * dispatch, so the facet's static `import "sqlite.wasm"` resolves to a
     * ready WebAssembly.Module — no request-time compile(bytes).
     *
     * Throws if env.ASSETS is unavailable: the facet code already imports
     * `sqlite.wasm` (usesSqlite is true), so a missing module entry would
     * fail facet load with an opaque resolver error; surfacing the cause
     * here is clearer.
     */
    private sqliteModuleEntry;
    private trackProcessRpcResources;
    private releaseProcessRpcResources;
    noteProcessReportedExit(pid: number, exitCode: number): void;
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
    /** Flush files written by the script back to the supervisor's VFS. */
    private _flushVfsWrites;
    /** Execution timeout. */
    private _execWithTimeout;
    /**
     * Run npm install in a dedicated facet.
     * All writes go through SUPERVISOR.writeFile (live VFS),
     * progress streams via SUPERVISOR.stdout.
     */
    /**
     * Spawn a vite dev server facet.
     * Returns immediately with the facet stub for HTTP routing.
     */
    spawnVite(root: string, basePath?: string): Promise<{
        pid: number;
        facetStub: any;
    }>;
    /**
     * Spawn a long-running Node process with the same shimmed require/fs/http
     * environment used by foreground `node <script>` execution.
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
        facetStub: any;
    }>;
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
    spawn(workerCode: string, command: string, cwd: string, opts?: {
        port?: number;
    }): Promise<{
        pid: number;
        facetStub: any;
    }>;
    /**
     * Spawn a long-running dynamic Worker and register its routeable port.
     *
     * This is the shared primitive for any runtime that exposes
     * handleHttpRequest(Request): Node facets, Vite adapters, Python virtual
     * sockets, and future WASI socket servers should use
     * this path instead of each owning process-table and PortRegistry plumbing.
     */
    spawnWorker(workerCode: string, command: string, cwd: string, opts?: LongRunningWorkerSpawnOptions): Promise<{
        pid: number;
        facetStub: any;
    }>;
    registerPort(pid: number, port: number, facetStub: any): void;
    attachReservedPorts(pid: number, facetStub: any): number[];
    waitForRouteablePorts(pid: number, facetStub: any, timeoutMs?: number): Promise<number[]>;
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