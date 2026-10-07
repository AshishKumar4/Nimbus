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
  // necessarily quickly. Platform CPU accounting can span overlapping calls;
  // separate tail events do not prove independent CPU windows. The separate
  // task wall deadline bounds one-shot I/O. Neither setting promises an
  // unlimited resident lifetime or fast shutdown of low-CPU work across calls.
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
export interface FacetCodePolicy { kind: FacetKind; limits: FacetResourceLimits }

/** Hosting Worker constraint; the policy remains the sole source of these values. */
export const MAX_FACET_CPU_MS = Math.max(...Object.values(FACET_LIMITS).map(limits => limits.cpuMs));

export function facetLimits(kind: FacetKind): Readonly<FacetResourceLimits> {
  const { cpuMs, subRequests } = FACET_LIMITS[kind];
  return { cpuMs, subRequests };
}

/** A cached worker must not retain an earlier policy's limits or guest binding. */
export function facetPolicyKey(kind: FacetKind, limits: Readonly<FacetResourceLimits> = facetLimits(kind)): string {
  return `${kind}:${limits.cpuMs}:${limits.subRequests}`;
}

export function facetLoaderKey(kind: FacetKind, key: string, limits: Readonly<FacetResourceLimits> = facetLimits(kind)): string {
  const suffix = `:limits:${facetPolicyKey(kind, limits)}`;
  return key.endsWith(suffix) ? key : key + suffix;
}

/** Callers can lower, never raise, a kind's native ceiling. */
export function effectiveFacetLimits(kind: FacetKind, requested?: Partial<FacetResourceLimits>): FacetResourceLimits {
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
export function codeFacetPolicy(code: { env?: Record<string, unknown>; limits?: Partial<FacetResourceLimits> }): FacetCodePolicy {
  const raw = code.env?.NIMBUS_FACET_POLICY;
  const carrier = typeof raw === 'string' ? JSON.parse(raw) as { kind?: string } : undefined;
  const kind = carrier?.kind && Object.hasOwn(FACET_LIMITS, carrier.kind) ? carrier.kind as FacetKind : 'worker';
  return { kind, limits: effectiveFacetLimits(kind, code.limits) };
}

/** Native policy and its consumed inner-Loader carrier; no unused guest budget. */
export function applyFacetLimits<C extends object>(kind: FacetKind, code: C, requested?: Partial<FacetResourceLimits>) {
  const limits = effectiveFacetLimits(kind, requested);
  const env = (code as { env?: Record<string, unknown> }).env;
  return {
    ...code,
    limits: { ...limits },
    env: { ...env, NIMBUS_FACET_POLICY: JSON.stringify({ kind, limits }) },
  };
}
