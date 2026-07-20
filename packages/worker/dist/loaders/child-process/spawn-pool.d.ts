/**
 * Supervisor-side child-process dispatch pool.
 *
 * Child-process calls from Node facets are executed through Worker Loader
 * isolates instead of allocation-heavy dispatch in the supervisor isolate.
 * Each spawn receives its own lifecycle envelope while command semantics
 * continue to flow through the existing supervisor RPC.
 */
export interface SpawnPoolHooks {
    onStdout(data: string): void;
    onStderr(data: string): void;
}
export interface SpawnPoolReq {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    stdio?: any;
    detached?: boolean;
    shell?: boolean | string;
    stdin?: string;
    processPid: number;
}
export declare class ChildProcessSpawnPool {
    /**
     * Shared single-slot pool. Serial dispatch keeps one dynamic-worker
     * allocation in flight while moving child execution out of the
     * supervisor isolate.
     */
    private readonly pool;
    /**
     * Promise chain for serializing submits. Each new submit awaits
     * the previous one's completion BEFORE invoking pool.submit.
     * This gives us strict 1-in-flight-at-a-time on slot 0; 4-cap
     * never trips even with 8 concurrent cp.spawn invocations.
     */
    private chain;
    constructor(env: any, ctx: DurableObjectState);
    /**
     * Dispatch a single cp.spawn request through a fresh Worker Loader
     * isolate. Streams stdout/stderr to the parent via `hooks` once the
     * task completes (we don't have incremental streaming yet — the
     * supervisor-side cpDispatchInline returns final strings; future
     * improvement: pull-RPC streaming from the loader isolate).
     *
     * Returns the exit code.
     */
    runOne(req: SpawnPoolReq, kind: 'pure-builtin' | 'facet-direct' | 'shell-direct', hooks: SpawnPoolHooks): Promise<number>;
}
//# sourceMappingURL=spawn-pool.d.ts.map