/**
 * Per-spawn task body for Worker Loader isolates.
 *
 * The isolate delegates command execution back to the supervisor through a
 * narrow RPC and returns copied string output. The parent pool owns streaming
 * and process bookkeeping.
 */
export interface SpawnInIsolateSpec {
    /** The original cp.spawn payload from node-shims.ts. */
    req: {
        command: string;
        args: string[];
        env: Record<string, string>;
        cwd: string;
        stdio?: any;
        detached?: boolean;
        shell?: boolean | string;
        stdin?: string;
    };
    /** Pre-resolved kind from FacetProcessManager._dispatch. */
    kind: 'pure-builtin' | 'facet-direct' | 'unknown';
    /** Stable id the parent captured for the spawn (for hooks-routing). */
    parentChildId: number | string;
}
export interface SpawnInIsolateResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
/**
 * Signature must remain `(spec, env)` because Worker Loader dispatch calls
 * the task as `fn(item, env)`.
 */
export declare const runSpawnInIsolate: (spec: SpawnInIsolateSpec, env: {
    SUPERVISOR: {
        cpDispatchInline(req: any, kind: string): Promise<{
            exitCode: number;
            stdout: string;
            stderr: string;
        }>;
    };
}) => Promise<SpawnInIsolateResult>;
//# sourceMappingURL=spawn-facet.d.ts.map