/**
 * node-runner.ts — Always-fresh-isolate dispatch for `node` and `bun`.
 *
 * Architectural promise (post fresh-isolate-bun-behavioral wave)
 * ─────────────────────────────────────────────────────────────
 * Every external runtime invocation (`node script`, `node -e`,
 * `node --version`, `bun X`, `npx X`) is dispatched into a FRESH
 * Worker Loader isolate. There is NO content-sniffing heuristic; the
 * only routing signal is argv flags that explicitly mean "this is
 * supposed to be long-lived" (`--watch`, `--inspect`, `--inspect-brk`).
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
 *   long  — `facetMgr.spawn(workerCode, command, cwd)`. Fire-and-
 *           forget LOADER.load(). Returns {pid, facetStub} immediately;
 *           the shell prints a `[started (long-running): pid=N
 *           cmd=...]` notice and returns. The facet outlives the
 *           supervisor RPC until killed or evicted.
 *
 * Routing
 * ───────
 *   args.includes('--watch' | '--inspect' | '--inspect-brk')  → long
 *   default                                                    → short
 *
 * The previous `detectLongRunning(code, args)` content-regex sniff
 * (deprecated) is removed. False-positives (a script that *imports*
 * http but exits quickly) used to fork unnecessarily; with
 * argv-only routing, the user gets the inline behaviour they expect
 * unless they explicitly opted into long-running with a flag.
 *
 * For scripts that don't terminate but also don't carry one of the
 * argv flags (e.g. an http.listen with no --watch), `facetMgr.exec`'s
 * 5-minute timeout caps the worst case. The supervisor returns the
 * timeout exit code; the facet is torn down. Documented trade-off.
 *
 * Anti-requirements observed
 * ──────────────────────────
 *   - NO setTimeout / sleep on hot paths.
 *   - NO fallback to in-supervisor execution. facetMgr.exec /
 *     facetMgr.spawn throw if env.LOADER is missing.
 *   - NO content-sniffing heuristic. argv-only routing.
 *
 * Cold-start (measured against prod 9d30dc95):
 *   first-run `node -e`     : 152–608 ms (warm-isolate cold case)
 *   warm `node -e` (median) : 102 ms
 *   warm `node script.js`   : ~50–100 ms
 * All under the 250ms warm-pool gate; no warm-pool needed.
 */
import type { FacetManager } from '../facets/manager.js';
/**
 * Argv-only long-running detection. The ONLY signals we honour:
 *   --watch       (node --watch / bun --watch)
 *   --inspect     (node --inspect)
 *   --inspect-brk (node --inspect-brk)
 *
 * No content sniff; no heuristic over the script source. False-positive
 * class is gone. False-negative class is "user runs a server without
 * --watch and the supervisor RPC blocks for 5 min" — accepted; users
 * are guided in docs to add `--watch` for keep-alive servers OR rely
 * on the 5-min timeout to recover.
 */
export declare function isLongRunningInvocation(args: string[]): boolean;
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
    /** Display label for the long-running spawn. Defaults to the
     *  command + filename. Surfaced in the [started (long-running)]
     *  notice + /api/processes listing. */
    command?: string;
    /**
     * G4 (runtime-pkg wave): caller has already allocated a
     * processTable PID for this invocation; runFresh / facetMgr.exec
     * should reuse it instead of spawning a duplicate. Used by the
     * .bin handler in src/session/init.ts to keep `ps` showing ONE
     * row per bin invocation instead of two (the wrapper + the inner
     * node script).
     */
    skipSpawn?: boolean;
    callerPid?: number;
}
/**
 * Always-fresh-isolate dispatcher. Replaces the previous
 * `runNodeScript` content-sniff variant. Used by both `node` and
 * `bun` shell handlers.
 */
export declare function runFresh(facetMgr: FacetManager, code: string, opts: RunFreshOpts): Promise<RunFreshResult>;
/**
 * BACKWARD-COMPAT shim. The child-process isolation design's `runNodeScript` is now an
 * alias for `runFresh` so the call sites in src/session/init.ts don't
 * need to change in this commit.
 */
export declare const runNodeScript: typeof runFresh;
//# sourceMappingURL=node-runner.d.ts.map