/**
 * Supervisor-side child-process dispatch pool.
 *
 * Child-process calls from Node facets are executed through Worker Loader
 * isolates instead of allocation-heavy dispatch in the supervisor isolate.
 * Each spawn receives its own lifecycle envelope while command semantics
 * continue to flow through the existing supervisor RPC.
 */
import { LoaderPool } from '@nimbus-sh/fabric/loader-pool.js';
import { runSpawnInIsolate } from './spawn-facet.js';
export class ChildProcessSpawnPool {
    /**
     * Shared single-slot pool. Serial dispatch keeps one dynamic-worker
     * allocation in flight while moving child execution out of the
     * supervisor isolate.
     */
    pool;
    /**
     * Promise chain for serializing submits. Each new submit awaits
     * the previous one's completion BEFORE invoking pool.submit.
     * This gives us strict 1-in-flight-at-a-time on slot 0; 4-cap
     * never trips even with 8 concurrent cp.spawn invocations.
     */
    chain = Promise.resolve();
    constructor(env, ctx) {
        this.pool = new LoaderPool(env, ctx, {
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
        // Serialize through slot 0 of the shared pool so workerd's per-
        // method-context dynamic-worker cap (4) is never tripped. The
        // chain promise links each spawn to wait for the previous one to
        // settle BEFORE issuing pool.submit. Slot 0 has at most one
        // in-flight LOADER.get ref at any moment.
        let result;
        const myTurn = this.chain.then(async () => {
            try {
                return await this.pool.submit(runSpawnInIsolate, spec);
            }
            catch (e) {
                const msg = (e && e.message) ? String(e.message) : String(e);
                return { exitCode: 1, stdout: '', stderr: 'spawn-pool: ' + msg + '\n' };
            }
        });
        // Update the chain BEFORE awaiting so the next caller serializes
        // behind us. .catch consumed so a runOne failure doesn't break
        // the chain for subsequent calls.
        this.chain = myTurn.catch(() => undefined);
        result = await myTurn;
        if (result.stdout)
            hooks.onStdout(result.stdout);
        if (result.stderr)
            hooks.onStderr(result.stderr);
        return typeof result.exitCode === 'number' ? result.exitCode : 1;
    }
}
