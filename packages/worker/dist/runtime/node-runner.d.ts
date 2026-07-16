/**
 * node-runner.ts — Always-fresh-isolate dispatch for `node` and `bun`.
 *
 * Architectural promise (post fresh-isolate-bun-behavioral wave)
 * ─────────────────────────────────────────────────────────────
 * Every external runtime invocation is dispatched into a Worker Loader
 * isolate. Explicit long-running flags and source that binds a server use
 * a keyed facet so later requests can resolve its route stub.
 *
 * Two execution modes
 * ───────────────────
 *   short — `facetMgr.exec(code, opts)`. Per-call LOADER.get(codeId)
 *           creates a fresh isolate keyed on hash(code+bundle+manifest).
 *           Output is streamed back via per-pid child DO Facet's
 *           supervisor RPC (`_rpcStdout` / `_rpcStderr`); supervisor
 *           awaits and returns the consolidated {exitCode, stdout,
 *           stderr}. The facet is deleted at completion.
 *
 *   long  — `facetMgr.spawnNode(code, opts)`. Fire-and-
 *           forget LOADER.load(). Returns {pid, facetStub} immediately;
 *           the shell prints a `[started (long-running): pid=N
 *           cmd=...]` notice and returns. The facet outlives the
 *           supervisor RPC until killed or evicted.
 *
 * Routing
 * ───────
 *   long-running argv flag or server bind in source  → long
 *   default                                          → short
 *
 * Anti-requirements observed
 * ──────────────────────────
 *   - NO setTimeout / sleep on hot paths.
 *   - NO fallback to in-supervisor execution. facetMgr.exec /
 *     facetMgr.spawnNode throw if env.LOADER is missing.
 *
 * Cold-start (measured against prod 9d30dc95):
 *   first-run `node -e`     : 152–608 ms (warm-isolate cold case)
 *   warm `node -e` (median) : 102 ms
 *   warm `node script.js`   : ~50–100 ms
 * All under the 250ms warm-pool gate; no warm-pool needed.
 */
import type { FacetManager } from '../facets/manager.js';
import type { FacetBundleProfile } from './bundle-profile.js';
/**
 * Argv long-running detection. Signals we honour:
 *   --watch       (node --watch / bun --watch)
 *   --inspect     (node --inspect)
 *   --inspect-brk (node --inspect-brk)
 */
export declare function isLongRunningInvocation(args: string[]): boolean;
export declare function looksLikeServer(code: string): boolean;
/** Result of a `runFresh` call. */
export interface RunFreshResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    spawnedPid?: number;
    longRunning: boolean;
}
export interface RunFreshOpts {
    argv?: string[];
    env?: Record<string, string>;
    cwd?: string;
    filename?: string;
    dirname?: string;
    stdin?: string;
    captureOutput?: boolean;
    /** Display label for the long-running spawn. Defaults to the
     *  command + filename. Surfaced in the [started (long-running)]
     *  notice + /api/processes listing. */
    command?: string;
    /**
     * G4 (runtime-pkg wave): caller has already allocated a
     * process supervisor PID for this invocation; runFresh / facetMgr.exec
     * should reuse it instead of spawning a duplicate. Used by the
     * .bin handler in src/session/init.ts to keep `ps` showing ONE
     * row per bin invocation instead of two (the wrapper + the inner
     * node script).
     */
    skipSpawn?: boolean;
    callerPid?: number;
    forceLongRunning?: boolean;
    attachedTty?: boolean;
    bundleProfile?: FacetBundleProfile;
}
/** Dispatch a Node-compatible invocation into a fresh or keyed facet. */
export declare function runFresh(facetMgr: FacetManager, code: string, opts: RunFreshOpts): Promise<RunFreshResult>;
//# sourceMappingURL=node-runner.d.ts.map