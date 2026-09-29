import { PRE_BUNDLE_CONCURRENCY } from '@nimbus-sh/platform/limits.js';
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
    /** Bumped by dispose() so a construction it interrupted tears itself down. */
    generation = 0;
    constructor(env, ctx) {
        this.env = env;
        this.ctx = ctx;
    }
    acquire() {
        if (this.pool)
            return Promise.resolve(this.pool);
        if (this.pending)
            return this.pending;
        const generation = this.generation;
        const pending = this.construct().then((pool) => {
            if (this.generation !== generation) {
                // dispose() ran while the adapter was in flight.
                try {
                    pool.dispose();
                }
                catch { /* best-effort */ }
                throw new Error('EsbuildBundlePool: disposed during construction');
            }
            this.pool = pool;
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
            throw new Error('EsbuildBundlePool: env.ASSETS binding missing — the esbuild JS adapter cannot be fetched');
        }
        const env = this.env;
        const [{ IsolatePool }, { preBundlePreamble }, { fetchEsbuildJsFnBody }, { esbuildWasmModule }] = await Promise.all([
            import('@nimbus-sh/fabric/isolate-pool.js'),
            import('../loaders/pre-bundle-preamble.js'),
            import('../runtime/esbuild-wasm-bytes.js'),
            import('../runtime/host-wasm.js'),
        ]);
        const [wasmModule, jsFnBody] = await Promise.all([esbuildWasmModule(), fetchEsbuildJsFnBody(env)]);
        return new IsolatePool(env, this.ctx, {
            concurrency: PRE_BUNDLE_CONCURRENCY,
            timeoutMs: 60_000,
            retries: 0,
            tag: 'esbuild-bundle',
            preamble: preBundlePreamble(jsFnBody),
            wasmModules: { 'esbuild.wasm': wasmModule },
        });
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
    }
}
