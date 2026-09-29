/**
 * EsbuildBundlePool — the session's single esbuild facet pool.
 *
 * Install-time pre-bundling and on-demand /@modules/ bundling dispatch the
 * same worker (the pre-bundle preamble + esbuild.wasm, one slot). One pool,
 * owned by the session, warms one loader slot for as long as the installer
 * and dev server live, and is disposed with them.
 *
 * The wasm is the host Worker's own compiled esbuild module
 * (runtime/host-wasm.ts), shared with the facet. The pool keeps no copy of
 * the bytes, so it holds no supervisor allocation credit: it used to fetch
 * and retain the ~12 MiB wasm for its whole life, leased from the shared
 * supervisor budget as a resident owner.
 *
 * Construction is lazy and everything heavy is imported on first use so
 * the fabric/preamble subgraph stays out of the cold script-eval graph of
 * sessions that never bundle.
 */
import type { IsolatePool } from '@nimbus-sh/fabric/isolate-pool.js';
/** The pool surface both bundling pipelines dispatch through. */
export type BundlePool = Pick<IsolatePool, 'submit'>;
/** What a bundling pipeline receives from its host. */
export interface BundlePoolProvider {
    /** The session's pool, constructed on first call. */
    acquire(): Promise<BundlePool>;
}
export declare class EsbuildBundlePool implements BundlePoolProvider {
    private readonly env;
    private readonly ctx;
    private pool;
    private pending;
    /** Bumped by dispose() so a construction it interrupted tears itself down. */
    private generation;
    constructor(env: unknown, ctx: DurableObjectState);
    acquire(): Promise<IsolatePool>;
    private construct;
    /**
     * Tear the pool down with its host. A later acquire() constructs a fresh
     * pool, so a session that installs again after a teardown still bundles.
     */
    dispose(): void;
}
//# sourceMappingURL=esbuild-bundle-pool.d.ts.map