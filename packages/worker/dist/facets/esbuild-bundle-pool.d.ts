/**
 * EsbuildBundlePool — the session's single esbuild facet pool.
 *
 * Install-time pre-bundling and on-demand /@modules/ bundling dispatch the
 * same worker (the pre-bundle preamble + esbuild.wasm, one slot). When each
 * pipeline built its own IsolatePool the supervisor retained two copies of
 * the ~12 MiB wasm bytes and warmed two loader slots per session, and the
 * two pools never queued behind each other. One pool, owned by the session,
 * holds one wasm copy — leased once from the shared supervisor allocation
 * budget, the way the pre-bundler already accounted for its own — for as
 * long as the installer and dev server live, and is disposed with them.
 *
 * Construction is lazy and everything heavy is imported on first use so
 * the fabric/preamble/wasm subgraph stays out of the cold script-eval
 * graph of sessions that never bundle.
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
    /** Releases the wasm bytes' supervisor credit; held until dispose(). */
    private releaseWasmCredit;
    /** Bumped by dispose() so a construction it interrupted tears itself down. */
    private generation;
    constructor(env: unknown, ctx: DurableObjectState);
    /**
     * Callers MUST acquire the pool before taking any slice lease: the
     * first construction reserves the full supervisor budget while the wasm
     * bytes are fetched, so a caller already holding slice credit would
     * wait on itself.
     */
    acquire(): Promise<IsolatePool>;
    private construct;
    /**
     * Tear the pool down with its host. A later acquire() constructs a fresh
     * pool, so a session that installs again after a teardown still bundles.
     */
    dispose(): void;
}
//# sourceMappingURL=esbuild-bundle-pool.d.ts.map