/** Resource policy for every fabric-created Worker and Durable Object facet. */
const FACET_CPU_MS = 300_000;
// Wall time includes awaited I/O; it is not the platform's CPU accounting.
const FACET_TASK_TIMEOUT_MS = 300_000;

export const FACET_LIMITS = Object.freeze({
  // Resident filesystem transport retains its charging scope across HTTP
  // calls (native 10000 failed on the tenth 1000-write call). Workers documents
  // a 10M maximum, and Loader custom limits only lower platform limits:
  // https://developers.cloudflare.com/workers/platform/limits/#subrequests
  // https://developers.cloudflare.com/dynamic-workers/usage/limits/
  // Acceptance of a larger input is not proof of a larger enforced ceiling.
  // This finite lifetime bound eventually stops 10M transport operations, not
  // necessarily quickly. CPU bounds hot loops per invocation; the separate
  // task wall deadline bounds one-shot I/O. A low-CPU resident loop spanning
  // requests may run until this lifetime ceiling; do not promise fast shutdown.
  process: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 10_000_000, taskTimeoutMs: FACET_TASK_TIMEOUT_MS }),
  build: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000, taskTimeoutMs: FACET_TASK_TIMEOUT_MS }),
  esbuild: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000, taskTimeoutMs: FACET_TASK_TIMEOUT_MS }),
  transform: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000, taskTimeoutMs: FACET_TASK_TIMEOUT_MS }),
  git: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 1_000_000, taskTimeoutMs: FACET_TASK_TIMEOUT_MS }),
  isolate: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000, taskTimeoutMs: FACET_TASK_TIMEOUT_MS }),
  fanout: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000, taskTimeoutMs: FACET_TASK_TIMEOUT_MS }),
  worker: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000, taskTimeoutMs: FACET_TASK_TIMEOUT_MS }),
});

export type FacetKind = keyof typeof FACET_LIMITS;
export interface FacetResourceLimits { cpuMs: number; subRequests: number }
export interface FacetInvocationLimits extends FacetResourceLimits {
  diagnosticReserve: number;
}

/** Hosting Worker constraint; the policy remains the sole source of these values. */
export const MAX_FACET_CPU_MS = Math.max(...Object.values(FACET_LIMITS).map(limits => limits.cpuMs));
const DIAGNOSTIC_RESERVE = 64;

export function facetLimits(kind: FacetKind): Readonly<FacetResourceLimits> {
  const { cpuMs, subRequests } = FACET_LIMITS[kind];
  return { cpuMs, subRequests };
}

/** A cached worker must not retain an earlier policy's limits or guest binding. */
export function facetLoaderKey(kind: FacetKind, key: string): string {
  const { cpuMs, subRequests } = FACET_LIMITS[kind];
  return `${key}:limits:${kind}:${cpuMs}:${subRequests}:${DIAGNOSTIC_RESERVE}`;
}

/** Native enforcement and the guest's earlier, reportable refusal share one policy. */
export function applyFacetLimits<C extends object>(kind: FacetKind, code: C) {
  const limits = facetLimits(kind);
  const invocation: FacetInvocationLimits = { ...limits, diagnosticReserve: DIAGNOSTIC_RESERVE };
  const env = (code as { env?: Record<string, unknown> }).env;
  return {
    ...code,
    limits: { ...limits },
    env: { ...env, NIMBUS_FACET_LIMITS: JSON.stringify(invocation) },
  };
}
