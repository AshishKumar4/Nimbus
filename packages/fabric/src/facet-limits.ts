/** Resource policy for every fabric-created Worker and Durable Object facet. */
const FACET_CPU_MS = 300_000;

export const FACET_LIMITS = Object.freeze({
  // A resident's whole life is one invocation, and every filesystem call it
  // makes is a subrequest of it: 10,000 ran out within minutes (astro dev,
  // 2026-10-08). 10M is the Workers maximum, and a Dynamic Worker's limits
  // only lower its parent's, so the hosting Worker declares the same
  // (MAX_FACET_SUBREQUESTS, enforced by deployment validation).
  process: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 10_000_000 }),
  build: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
  esbuild: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
  transform: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
  git: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 1_000_000 }),
  isolate: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
  fanout: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
  worker: Object.freeze({ cpuMs: FACET_CPU_MS, subRequests: 100_000 }),
});

export type FacetKind = keyof typeof FACET_LIMITS;
export interface FacetResourceLimits { cpuMs: number; subRequests: number }
export interface FacetCodePolicy { kind: FacetKind; limits: FacetResourceLimits }

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
const CALL_DEADLINES: Readonly<Partial<Record<FacetKind, number>>> = Object.freeze({
  build: COMPUTE_CALL_DEADLINE_MS,
  esbuild: COMPUTE_CALL_DEADLINE_MS,
  transform: COMPUTE_CALL_DEADLINE_MS,
  git: COMPUTE_CALL_DEADLINE_MS,
  fanout: COMPUTE_CALL_DEADLINE_MS,
});

/** One call's wall deadline for `kind`, or undefined: the kind runs processes, which have none. */
export function facetCallDeadlineMs(kind: FacetKind): number | undefined {
  return CALL_DEADLINES[kind];
}

/** What the hosting Worker must declare at least, since a facet's limits only lower its parent's. */
export const MAX_FACET_CPU_MS = Math.max(...Object.values(FACET_LIMITS).map(limits => limits.cpuMs));
export const MAX_FACET_SUBREQUESTS = Math.max(...Object.values(FACET_LIMITS).map(limits => limits.subRequests));

export function facetLimits(kind: FacetKind): Readonly<FacetResourceLimits> {
  const { cpuMs, subRequests } = FACET_LIMITS[kind];
  return { cpuMs, subRequests };
}

/** A cached worker must not retain an earlier policy's limits or guest binding. */
export function facetPolicyKey(kind: FacetKind, limits: Readonly<FacetResourceLimits> = facetLimits(kind)): string {
  return `${kind}:${limits.cpuMs}:${limits.subRequests}`;
}

/**
 * The Loader id `key` is cached under with `kind`'s policy: the policy, then
 * the raw id's length, then the raw id. The policy key has no `/` and the
 * length fixes where the raw id ends, so no two (id, policy) pairs share an
 * encoding, whatever a raw id contains (a guest names its own ids through the
 * Loader shim). Applied once, at the boundary that creates the cached worker.
 */
export function facetLoaderKey(kind: FacetKind, key: string, limits: Readonly<FacetResourceLimits> = facetLimits(kind)): string {
  return `${facetPolicyKey(kind, limits)}/${key.length}/${key}`;
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

/**
 * The policy of code a guest hands Nimbus's Worker Loader shim (a user's
 * Worker under `nimbus wrangler dev`): the worker kind, lowered by the limits
 * the code asks for. Nothing in the code can claim another kind; the guest
 * is not who decides its own ceiling.
 */
export function guestFacetPolicy(code: { limits?: Partial<FacetResourceLimits> }): FacetCodePolicy {
  return { kind: 'worker', limits: effectiveFacetLimits('worker', code.limits) };
}

/** `code` with `kind`'s native limits, lowered by `requested`. Nothing else in it changes, its env included. */
export function applyFacetLimits<C extends object>(kind: FacetKind, code: C, requested?: Partial<FacetResourceLimits>) {
  return { ...code, limits: { ...effectiveFacetLimits(kind, requested) } };
}
