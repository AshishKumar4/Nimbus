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
/** Hosting Worker constraint; the policy remains the sole source of these values. */
export declare const MAX_FACET_CPU_MS: number;
export declare function facetLimits(kind: FacetKind): Readonly<FacetResourceLimits>;
/** A cached worker must not retain an earlier policy's limits or guest binding. */
export declare function facetPolicyKey(kind: FacetKind, limits?: Readonly<FacetResourceLimits>): string;
export declare function facetLoaderKey(kind: FacetKind, key: string, limits?: Readonly<FacetResourceLimits>): string;
/** Callers can lower, never raise, a kind's native ceiling. */
export declare function effectiveFacetLimits(kind: FacetKind, requested?: Partial<FacetResourceLimits>): FacetResourceLimits;
/** Kind and code ceiling survive the inner-Loader RPC/loopback route. */
export declare function codeFacetPolicy(code: {
    env?: Record<string, unknown>;
    limits?: Partial<FacetResourceLimits>;
}): FacetCodePolicy;
/** Native policy and its consumed inner-Loader carrier; no unused guest budget. */
export declare function applyFacetLimits<C extends object>(kind: FacetKind, code: C, requested?: Partial<FacetResourceLimits>): C & {
    limits: {
        cpuMs: number;
        subRequests: number;
    };
    env: {
        NIMBUS_FACET_POLICY: string;
    };
};
//# sourceMappingURL=facet-limits.d.ts.map