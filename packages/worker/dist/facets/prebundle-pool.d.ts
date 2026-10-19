import { type SupervisorAllocationOwner } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import type { PrebundleResult, PrebundleSpec } from '../npm/pre-bundle-facet.js';
/** A worker takes a prepared slice only at dispatch, never while its slot is queued. */
export interface PrebundleTask {
    readonly specifier: string;
    readonly signal?: AbortSignal;
    readonly bytes: number;
    readonly owner?: SupervisorAllocationOwner;
    readonly running?: boolean;
    prepare(): PrebundleSpec;
}
export interface PrebundleDispatch {
    readonly specifier: string;
    readonly signal?: AbortSignal;
    take(): PrebundleSpec;
    transferred(): void;
}
/** What both pre-bundling pipelines call. */
export interface BundlePool {
    prebundle(task: PrebundleTask): Promise<PrebundleResult>;
}
/** What a pre-bundling pipeline receives from its host. */
export interface BundlePoolProvider {
    readonly session?: string;
    /** The session's pool, its facet loaded. */
    acquire(signal?: AbortSignal): Promise<BundlePool>;
}
export declare class PrebundlePool implements BundlePoolProvider {
    private readonly env;
    private readonly ctx;
    /** Pre-bundles waiting for a slot, oldest first; a finishing one hands its slot to the next. */
    private readonly waiting;
    private running;
    constructor(env: unknown, ctx: DurableObjectState);
    get session(): string;
    acquire(signal?: AbortSignal): Promise<BundlePool>;
    private dispatch;
    private waitForSlot;
    /** The build facet is the Durable Object's, not the pool's: nothing to release. */
    dispose(): void;
}
//# sourceMappingURL=prebundle-pool.d.ts.map