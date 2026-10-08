/** Resource policy for every fabric-created Worker and Durable Object facet. */
const FACET_CPU_MS = 300_000;
export const FACET_LIMITS = Object.freeze({
    // Resident filesystem transport retains its charging scope across HTTP
    // calls (native 10000 failed on the tenth 1000-write call). Workers documents
    // a 10M maximum, and Loader custom limits only lower platform limits:
    // https://developers.cloudflare.com/workers/platform/limits/#subrequests
    // https://developers.cloudflare.com/dynamic-workers/usage/limits/
    // Acceptance of a larger input is not proof of a larger enforced ceiling.
    // This finite lifetime bound eventually stops 10M transport operations, not
    // necessarily quickly. Platform CPU accounting can span overlapping calls;
    // separate tail events do not prove independent CPU windows. Neither setting
    // promises an unlimited resident lifetime or fast shutdown of low-CPU work
    // across calls.
    process: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 10_000_000 }),
    build: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
    esbuild: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
    transform: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
    git: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 1_000_000 }),
    isolate: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
    fanout: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
    worker: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
});
/**
 * Wall deadlines, for the kinds whose calls are direct compute: a build, an
 * esbuild or Oxc transform, a git network step, a fan-out task. Each call
 * answers one request, and one that never answers is a fault. Wall time
 * includes awaited I/O; it is not the platform's CPU accounting.
 *
 * A process has none (`process`, and `isolate`, the kind a runtime's facet
 * host opens for a program's run): it runs until it exits or is killed, by
 * kill or Ctrl-C, and the platform's CPU limit ends a runaway one. Measured
 * live (2026-10-07): a 30 s deadline killed clang over 10,000 files at 9,199,
 * and any fixed one would kill a process waiting on stdin or a long build.
 */
const COMPUTE_CALL_DEADLINE_MS = 300_000;
const CALL_DEADLINES = Object.freeze({
    build: COMPUTE_CALL_DEADLINE_MS,
    esbuild: COMPUTE_CALL_DEADLINE_MS,
    transform: COMPUTE_CALL_DEADLINE_MS,
    git: COMPUTE_CALL_DEADLINE_MS,
    fanout: COMPUTE_CALL_DEADLINE_MS,
});
/** One call's wall deadline for `kind`, or undefined: the kind runs processes, which have none. */
export function facetCallDeadlineMs(kind) {
    return CALL_DEADLINES[kind];
}
/** Hosting Worker constraint; the policy remains the sole source of these values. */
export const MAX_FACET_CPU_MS = Math.max(...Object.values(FACET_LIMITS).map(limits => limits.cpuMs));
export function facetLimits(kind) {
    const { cpuMs, subRequests } = FACET_LIMITS[kind];
    return { cpuMs, subRequests };
}
/** A cached worker must not retain an earlier policy's limits or guest binding. */
export function facetPolicyKey(kind, limits = facetLimits(kind)) {
    return `${kind}:${limits.cpuMs}:${limits.subRequests}`;
}
export function facetLoaderKey(kind, key, limits = facetLimits(kind)) {
    const suffix = `:limits:${facetPolicyKey(kind, limits)}`;
    return key.endsWith(suffix) ? key : key + suffix;
}
/** Callers can lower, never raise, a kind's native ceiling. */
export function effectiveFacetLimits(kind, requested) {
    const policy = facetLimits(kind);
    for (const [name, value] of Object.entries(requested ?? {})) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
            throw new Error(`Nimbus: invalid ${kind} facet limit ${name}=${value}`);
        }
    }
    return {
        cpuMs: Math.min(policy.cpuMs, requested?.cpuMs ?? policy.cpuMs),
        subRequests: Math.min(policy.subRequests, requested?.subRequests ?? policy.subRequests),
    };
}
/** Kind and code ceiling survive the inner-Loader RPC/loopback route. */
export function codeFacetPolicy(code) {
    const raw = code.env?.NIMBUS_FACET_POLICY;
    const carrier = typeof raw === 'string' ? JSON.parse(raw) : undefined;
    const kind = carrier?.kind && Object.hasOwn(FACET_LIMITS, carrier.kind) ? carrier.kind : 'worker';
    return { kind, limits: effectiveFacetLimits(kind, code.limits) };
}
/** Native policy and its consumed inner-Loader carrier; no unused guest budget. */
export function applyFacetLimits(kind, code, requested) {
    const limits = effectiveFacetLimits(kind, requested);
    const env = code.env;
    return {
        ...code,
        limits: { ...limits },
        env: { ...env, NIMBUS_FACET_POLICY: JSON.stringify({ kind, limits }) },
    };
}
