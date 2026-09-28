/**
 * Supervisor-side child-process dispatch pool.
 *
 * Child-process calls from Node facets are executed through Worker Loader
 * isolates instead of allocation-heavy dispatch in the supervisor isolate.
 * Each spawn receives its own lifecycle envelope while command semantics
 * continue to flow through the existing supervisor RPC.
 */
import { IsolatePool } from '@nimbus-sh/fabric/isolate-pool.js';
import { runSpawnInIsolate } from './spawn-facet.js';
const RESULT_ENCODER = new TextEncoder();
export class ChildProcessSpawnPool {
    /**
     * Shared single-slot pool: one Dynamic Worker, whose slot queue runs
     * spawns one at a time, moving child execution out of the supervisor
     * isolate.
     */
    pool;
    constructor(env, ctx) {
        this.pool = new IsolatePool(env, ctx, {
            tag: 'cp-spawn',
            concurrency: 1,
            timeoutMs: 2 * 60_000,
            retries: 0,
        });
    }
    /**
     * Dispatch a single cp.spawn request through a fresh Worker Loader
     * isolate. Streams stdout/stderr to the parent via `hooks` once the
     * task completes (we don't have incremental streaming yet — the
     * supervisor-side cpDispatchInline returns final strings; future
     * improvement: pull-RPC streaming from the loader isolate).
     *
     * Returns the exit code.
     */
    async runOne(req, kind, hooks) {
        const spec = {
            req: {
                // Single-ownership: defensive copy of the request fields that
                // cross the RPC boundary. Strings are copied by structured-clone;
                // we explicitly copy `args` and `env` arrays/objects so a
                // post-call mutation in the caller doesn't affect the task body.
                command: String(req.command || ''),
                args: Array.isArray(req.args) ? req.args.map(String) : [],
                env: { ...(req.env || {}) },
                cwd: String(req.cwd || '/home/user'),
                stdio: req.stdio,
                detached: !!req.detached,
                shell: req.shell ?? false,
                stdin: typeof req.stdin === 'string' ? req.stdin : '',
                processPid: req.processPid,
            },
            kind,
        };
        let result;
        try {
            result = await this.pool.submit(runSpawnInIsolate, spec);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            result = { exitCode: 1, stdout: '', stderr: 'spawn-pool: ' + msg + '\n' };
        }
        if (result.stdout)
            hooks.onStdout(RESULT_ENCODER.encode(result.stdout));
        if (result.stderr)
            hooks.onStderr(RESULT_ENCODER.encode(result.stderr));
        return typeof result.exitCode === 'number' ? result.exitCode : 1;
    }
}
