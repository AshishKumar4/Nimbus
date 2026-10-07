/** Resource policy for every fabric-created Worker and Durable Object facet. */
const FACET_CPU_MS = 300_000;
export const FACET_LIMITS = Object.freeze({
    process: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 1_000_000 }),
    build: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
    esbuild: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
    transform: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
    git: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 1_000_000 }),
    isolate: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
    fanout: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
    worker: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 1_000_000 }),
    vfs: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
});
/** Hosting Worker constraint; the policy remains the sole source of these values. */
export const MAX_FACET_CPU_MS = Math.max(...Object.values(FACET_LIMITS).map(limits => limits.cpuMs));
const DIAGNOSTIC_RESERVE = 64;
export function facetLimits(kind) {
    return FACET_LIMITS[kind];
}
/** Native enforcement and the guest's earlier, reportable refusal share one policy. */
export function applyFacetLimits(kind, code) {
    const limits = facetLimits(kind);
    const invocation = { ...limits, diagnosticReserve: DIAGNOSTIC_RESERVE };
    const env = code.env;
    return {
        ...code,
        limits: { ...limits },
        env: { ...env, NIMBUS_FACET_LIMITS: JSON.stringify(invocation) },
    };
}
