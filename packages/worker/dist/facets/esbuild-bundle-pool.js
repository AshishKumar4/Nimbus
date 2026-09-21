import { acquireResidentSupervisorAllocation } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import { PRE_BUNDLE_CONCURRENCY, PRE_BUNDLE_SLICE_CAP_BYTES, SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES, } from '@nimbus-sh/platform/limits.js';
function hasAssetsFetcher(env) {
    if (typeof env !== 'object' || env === null)
        return false;
    const assets = Reflect.get(env, 'ASSETS');
    return typeof assets === 'object' && assets !== null && typeof Reflect.get(assets, 'fetch') === 'function';
}
export class EsbuildBundlePool {
    env;
    ctx;
    pool = null;
    pending = null;
    /** Releases the wasm bytes' supervisor credit; held until dispose(). */
    releaseWasmCredit = null;
    /** Bumped by dispose() so a construction it interrupted tears itself down. */
    generation = 0;
    constructor(env, ctx) {
        this.env = env;
        this.ctx = ctx;
    }
    /**
     * Callers MUST acquire the pool before taking any slice lease: the
     * first construction reserves the full supervisor budget while the wasm
     * bytes are fetched, so a caller already holding slice credit would
     * wait on itself.
     */
    acquire() {
        if (this.pool)
            return Promise.resolve(this.pool);
        if (this.pending)
            return this.pending;
        const generation = this.generation;
        const pending = this.construct().then(({ pool, releaseWasmCredit }) => {
            if (this.generation !== generation) {
                // dispose() ran while the wasm bytes were in flight.
                try {
                    pool.dispose();
                }
                catch { /* best-effort */ }
                releaseWasmCredit();
                throw new Error('EsbuildBundlePool: disposed during construction');
            }
            this.pool = pool;
            this.releaseWasmCredit = releaseWasmCredit;
            return pool;
        }).finally(() => {
            if (this.pending === pending)
                this.pending = null;
        });
        this.pending = pending;
        return pending;
    }
    async construct() {
        if (!hasAssetsFetcher(this.env)) {
            throw new Error('EsbuildBundlePool: env.ASSETS binding missing — the esbuild wasm asset cannot be fetched');
        }
        const env = this.env;
        const [{ IsolatePool }, { preBundlePreamble }, { fetchEsbuildJsFnBody, fetchEsbuildWasmBytes }] = await Promise.all([
            import('@nimbus-sh/fabric/isolate-pool.js'),
            import('../loaders/pre-bundle-preamble.js'),
            import('../runtime/esbuild-wasm-bytes.js'),
        ]);
        // Resident, and sized to what the pool will KEEP — not the whole budget.
        //
        // The full-budget claim this used to make is grantable exactly once: the
        // lease it shrinks to becomes a permanent floor, so a second pool
        // construction asked for 40 MiB against 28.1 MiB that could ever be free
        // and parked in the FIFO with no error and no CPU. Measured on a
        // deployed worker: capacity 41,943,040, resident 11,907,565, queued 1 for
        // 222 s with the isolate healthy the whole time — and because the queue
        // refuses everyone behind a waiter, the whole session stopped making
        // progress. The bound below is the same one the payload is checked
        // against, so the slice cap stays free for the work the pool exists for.
        const maxRetainedWasmBytes = SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES - PRE_BUNDLE_SLICE_CAP_BYTES;
        const setupAllocation = await acquireResidentSupervisorAllocation(maxRetainedWasmBytes);
        let retained = false;
        try {
            const [wasmBytes, jsFnBody] = await Promise.all([fetchEsbuildWasmBytes(env), fetchEsbuildJsFnBody(env)]);
            if (wasmBytes.byteLength > maxRetainedWasmBytes) {
                throw new RangeError(`esbuild wasm payload ${wasmBytes.byteLength} exceeds the ${maxRetainedWasmBytes}-byte retained budget`);
            }
            // IsolatePool keeps the constructor-time module bytes until dispose(),
            // so retain their exact credit rather than treating construction as a
            // handoff that immediately frees the ArrayBuffer.
            setupAllocation.shrinkTo(wasmBytes.byteLength);
            const pool = new IsolatePool(env, this.ctx, {
                concurrency: PRE_BUNDLE_CONCURRENCY,
                timeoutMs: 60_000,
                retries: 0,
                tag: 'esbuild-bundle',
                preamble: preBundlePreamble(jsFnBody),
                wasmModules: { 'esbuild.wasm': wasmBytes },
            });
            retained = true;
            return { pool, releaseWasmCredit: setupAllocation.release };
        }
        finally {
            if (!retained)
                setupAllocation.release();
        }
    }
    /**
     * Tear the pool down with its host. A later acquire() constructs a fresh
     * pool, so a session that installs again after a teardown still bundles.
     */
    dispose() {
        this.generation++;
        const pool = this.pool;
        this.pool = null;
        this.pending = null;
        if (pool) {
            try {
                pool.dispose();
            }
            catch { /* best-effort */ }
        }
        const release = this.releaseWasmCredit;
        this.releaseWasmCredit = null;
        release?.();
    }
}
