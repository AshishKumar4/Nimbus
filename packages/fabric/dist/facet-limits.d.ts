export declare const FACET_LIMITS: Readonly<{
    process: Readonly<{
        cpuMs: 300000;
        subRequests: 1000000;
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
        subRequests: 1000000;
    }>;
    vfs: Readonly<{
        cpuMs: 300000;
        subRequests: 100000;
    }>;
}>;
export type FacetKind = keyof typeof FACET_LIMITS;
export interface FacetResourceLimits {
    cpuMs: number;
    subRequests: number;
}
export interface FacetInvocationLimits extends FacetResourceLimits {
    diagnosticReserve: number;
}
/** Hosting Worker constraint; the policy remains the sole source of these values. */
export declare const MAX_FACET_CPU_MS: number;
export declare function facetLimits(kind: FacetKind): Readonly<FacetResourceLimits>;
/** Native enforcement and the guest's earlier, reportable refusal share one policy. */
export declare function applyFacetLimits<C extends object>(kind: FacetKind, code: C): C & {
    limits: {
        cpuMs: number;
        subRequests: number;
    };
    env: {
        NIMBUS_FACET_LIMITS: string;
    };
};
//# sourceMappingURL=facet-limits.d.ts.map