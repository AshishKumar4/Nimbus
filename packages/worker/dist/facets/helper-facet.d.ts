/**
 * helper-facet.ts — a Durable Object's loader-backed helper facets: the
 * transform facet (Oxc), the esbuild facet and the build facet (rolldown).
 * Each is one child actor whose worker owns an engine's wasm, so the
 * object's own isolate never instantiates it.
 */
import type { DurableObject } from 'cloudflare:workers';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
import { type FacetKind } from '@nimbus-sh/fabric/facet-limits.js';
import type { StagedSourceEnv } from '../runtime/staged-source.js';
/** What a helper facet is: its worker id and facet name, its class, and its code, built from the staged assets. */
export interface HelperFacetSpec {
    kind?: FacetKind;
    id: string;
    className: string;
    /** How a missing binding names it: "the transform facet". */
    what: string;
    /**
     * The child facet's name, when it is not `id`: the same worker code run as
     * a second actor (the esbuild CLI's facet, apart from its compute calls).
     */
    facetName?: string;
    /**
     * The facet runs processes (the esbuild CLI): its calls have no wall
     * deadline. Without it every call is a compute call, bounded by the kind's
     * call deadline (boundedCalls).
     */
    runsProcesses?: true;
    code(assets: Required<StagedSourceEnv>): Promise<WorkerCode>;
}
/**
 * Load a helper facet: the worker `spec.id` from `env.LOADER`, its code
 * built from `env.ASSETS` the first time, and its class as the child facet
 * named `spec.id`. Needs `env.LOADER`, `env.ASSETS` and `ctx.facets`, and
 * nothing of any host.
 */
export declare function loadHelperFacet<T extends DurableObject>(ctx: DurableObjectState, env: unknown, spec: HelperFacetSpec): Promise<Fetcher<T>>;
/**
 * A helper facet's compute call that outlived its kind's call deadline. Not
 * retried: the same input would wait as long again (buildFacetPrebundler and
 * oxcTransformHost let it through as it is).
 */
export declare class FacetCallDeadlineError extends Error {
    readonly what: string;
    readonly method: string;
    readonly kind: FacetKind;
    readonly deadlineMs: number;
    constructor(what: string, method: string, kind: FacetKind, deadlineMs: number);
}
/**
 * One stub per Durable Object: a caller that starts while another is still
 * loading the facet waits on that load. A load or call that failed drops the
 * entry; the next caller loads a fresh stub.
 */
export declare class SharedHelperFacet<T extends DurableObject> {
    #private;
    private readonly spec;
    constructor(spec: HelperFacetSpec);
    stub(ctx: DurableObjectState, env: unknown): Promise<Fetcher<T>>;
    /** Drop `stub`, a stub that threw and may be broken for good, unless a newer one replaced it. */
    forget(ctx: DurableObjectState, stub: Promise<Fetcher<T>>): void;
}
//# sourceMappingURL=helper-facet.d.ts.map