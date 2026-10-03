import type { PrebundleResult, PrebundleSpec } from '../npm/pre-bundle-facet.js';
/** What both pre-bundling pipelines call. */
export interface BundlePool {
    prebundle(spec: PrebundleSpec): Promise<PrebundleResult>;
}
/** What a pre-bundling pipeline receives from its host. */
export interface BundlePoolProvider {
    /** The session's pool, its facet loaded. */
    acquire(): Promise<BundlePool>;
}
export declare class PrebundlePool implements BundlePoolProvider {
    private readonly env;
    private readonly ctx;
    private readonly pool;
    /** Pre-bundles waiting for a slot, oldest first; a finishing one hands its slot to the next. */
    private readonly waiting;
    private running;
    constructor(env: unknown, ctx: DurableObjectState);
    acquire(): Promise<BundlePool>;
    /** The build facet is the Durable Object's, not the pool's: nothing to release. */
    dispose(): void;
}
//# sourceMappingURL=prebundle-pool.d.ts.map