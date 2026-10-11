export declare const FACET_LIMITS: Readonly<{
    process: Readonly<{
        cpuMs: 300000;
        subRequests: 10000000;
    }>;
    build: Readonly<{
        cpuMs: 300000;
        subRequests: 100000;
    }>;
    esbuild: Readonly<{
        cpuMs: 300000;
        subRequests: 100000;
    }>;
    transform: Readonly<{
        cpuMs: 300000;
        subRequests: 100000;
    }>;
    git: Readonly<{
        cpuMs: 300000;
        subRequests: 1000000;
    }>;
    isolate: Readonly<{
        cpuMs: 300000;
        subRequests: 100000;
    }>;
    fanout: Readonly<{
        cpuMs: 300000;
        subRequests: 100000;
    }>;
    worker: Readonly<{
        cpuMs: 300000;
        subRequests: 100000;
    }>;
}>;
export type FacetKind = keyof typeof FACET_LIMITS;
export interface FacetResourceLimits {
    cpuMs: number;
    subRequests: number;
}
export interface FacetCodePolicy {
    kind: FacetKind;
    limits: FacetResourceLimits;
}
/** One call's wall deadline for `kind`, or undefined: the kind runs processes, which have none. */
export declare function facetCallDeadlineMs(kind: FacetKind): number | undefined;
/** What the hosting Worker must declare at least, since a facet's limits only lower its parent's. */
export declare const MAX_FACET_CPU_MS: number;
export declare const MAX_FACET_SUBREQUESTS: number;
export declare function facetLimits(kind: FacetKind): Readonly<FacetResourceLimits>;
/** A cached worker must not retain an earlier policy's limits or guest binding. */
export declare function facetPolicyKey(kind: FacetKind, limits?: Readonly<FacetResourceLimits>): string;
/**
 * The Loader id `key` is cached under with `kind`'s policy: the policy, then
 * the raw id's length, then the raw id. The policy key has no `/` and the
 * length fixes where the raw id ends, so no two (id, policy) pairs share an
 * encoding, whatever a raw id contains (a guest names its own ids through the
 * Loader shim). Applied once, at the boundary that creates the cached worker.
 */
export declare function facetLoaderKey(kind: FacetKind, key: string, limits?: Readonly<FacetResourceLimits>): string;
/** Callers can lower, never raise, a kind's native ceiling. */
export declare function effectiveFacetLimits(kind: FacetKind, requested?: Partial<FacetResourceLimits>): FacetResourceLimits;
/**
 * The policy of code a guest hands Nimbus's Worker Loader shim (a user's
 * Worker under `nimbus wrangler dev`): the worker kind, lowered by the limits
 * the code asks for. Nothing in the code can claim another kind; the guest
 * is not who decides its own ceiling.
 */
export declare function guestFacetPolicy(code: {
    limits?: Partial<FacetResourceLimits>;
}): FacetCodePolicy;
/** `code` with `kind`'s native limits, lowered by `requested`. Nothing else in it changes, its env included. */
export declare function applyFacetLimits<C extends object>(kind: FacetKind, code: C, requested?: Partial<FacetResourceLimits>): C & {
    limits: {
        cpuMs: number;
        subRequests: number;
    };
};
//# sourceMappingURL=facet-limits.d.ts.map