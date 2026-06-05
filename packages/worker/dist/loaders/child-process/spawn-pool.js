/**
 * Supervisor-side child-process dispatch pool.
 *
 * Child-process calls from Node facets are executed through Worker Loader
 * isolates instead of allocation-heavy dispatch in the supervisor isolate.
 * Each spawn receives its own lifecycle envelope while command semantics
 * continue to flow through the existing supervisor RPC.
 */
import { NimbusLoaderPool } from '../loader-pool.js';
import { runSpawnInIsolate } from './spawn-facet.js';
export class ChildProcessSpawnPool {
    env;
    ctx;
    /**
     * Shared NimbusLoaderPool with concurrency=4 (the workerd
     * dynamic-worker cap). `submit` lands on slot 0 — 8 concurrent
     * submits all share slot 0 sequentially via the slot's ownership
     * (one in-flight LOADER.get per slot). Re-using the same pool
     * across runOne calls avoids the 4-cap entirely: only ONE
     * LOADER.get ref is held at a time per slot, and there are at
     * most 4 slots = 4 concurrent LOADER.get refs from this pool.
     *
     * The map() variant distributes items across slots (concurrency=4
     * items at a time). For per-spawn isolation we use submit() so
     * each spawn runs serially through one slot; that gives the
     * architectural win (spawn dispatch runs in a Worker Loader
     * isolate, NOT in the supervisor's V8 context) without tripping
     * the workerd cap.
     *
     * Trade-off: 8 concurrent cp.spawn calls become serial through
     * slot 0. Wall-clock cost: ~50ms per spawn dispatch (warm-isolate
     * RPC round-trip). For typical interactive shell usage (1-3
     * spawns) this is invisible. Heavy parallel patterns (npm test
     * launching N jest workers) sequentialise — accepted trade-off
     * vs the prod-failure-mode of "Too many concurrent dynamic
     * workers." Future improvement: distribute via map() when batch
     * shape is known.
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
        this.env = env;
        this.ctx = ctx;
        this.pool = new NimbusLoaderPool(env, ctx, {
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
    async runOne(req, kind, hooks, childId) {
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
            },
            kind,
            parentChildId: childId,
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
        const results = [result];
        if (!results || results.length === 0) {
            hooks.onStderr('spawn-pool: no result returned\n');
            return 1;
        }
        const r = results[0];
        if (r.stdout)
            hooks.onStdout(r.stdout);
        if (r.stderr)
            hooks.onStderr(r.stderr);
        return typeof r.exitCode === 'number' ? r.exitCode : 1;
    }
}
