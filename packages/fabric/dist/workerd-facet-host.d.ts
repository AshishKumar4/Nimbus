/**
 * workerd-facet-host.ts — how a resident process is actually made, on workerd.
 *
 * `process-fabric.ts` says what a resident process IS, in terms no
 * runtime owns: a boot spec, a start contract, a handle that can be routed to
 * and released. This module is the one implementation of that on Cloudflare,
 * and everything here is a workerd mechanism rather than a Nimbus concept —
 * `ctx.facets`, the Worker Loader, `ctx.exports`, and the facet-index
 * arithmetic the slot book exists to satisfy.
 *
 * The split is what lets the contract be read without the platform: a host
 * that is not a Durable Object implements `ProcessHost` against the same
 * `HostedProcess` and never imports this file.
 */
import { type HostedProcess, type OneShotParams, type ProcessHostParams, type ResidentDiskReader, type ResidentSupervisorProps } from './process-fabric.js';
/** Structural surface of a NimbusLoadedEntrypoint RPC stub. */
export interface LoadedWorkerEntrypointStub {
    handleHttpRequest?: (request: Request) => Promise<Response>;
    fetch?(request: Request): Promise<Response>;
}
export interface NimbusCtxExports {
    NimbusLoadedEntrypoint?: (options: {
        props: {
            key: string;
            name: string | null;
            depth: number;
            supervisor: {
                doId: string;
                pid: number;
                writerId: string;
            };
            stage?: unknown;
        };
    }) => LoadedWorkerEntrypointStub;
}
export declare function getNimbusCtxExports(): NimbusCtxExports;
/**
 * Mint a NimbusLoadedEntrypoint stub for a keyed dynamic worker. Used by the
 * one-shot runtime paths, which run a program to completion inside a single
 * request rather than leaving it resident: their module map is assembled in
 * that stateless entrypoint's own isolate, never in a session DO.
 */
export declare function createLoadedWorkerEntrypoint(ctxExports: NimbusCtxExports, supervisor: {
    doId: string;
    pid: number;
    writerId: string;
}, stage: unknown, name?: string | null): Promise<LoadedWorkerEntrypointStub>;
/**
 * Total bytes a dynamic Worker's module map may carry, across every member of
 * it. A hard platform limit, not a policy knob: 62 MiB lands and 64 MiB is
 * refused with "Dynamic Worker code size (N bytes) exceeds the maximum allowed
 * size of 67108864 bytes", confirmed at five sizes with two trials each. The
 * budget is shared, so a ruby process is already 34.3 MiB down before its disk
 * is counted.
 */
export declare const DYNAMIC_WORKER_CODE_LIMIT_BYTES = 67108864;
/**
 * Refuse a module map over {@link DYNAMIC_WORKER_CODE_LIMIT_BYTES}, naming
 * the largest members. The platform's own refusal reports one number for a
 * budget shared across every member of the map, which tells the operator
 * nothing about WHAT to shrink — so every fabric seam that assembles a map
 * runs this before the loader sees it.
 *
 * Costed to its two paths. Under the ceiling: one length read per member —
 * UTF-16 code units for text, which equal UTF-8 bytes for the ASCII module
 * text the generators emit and undercount otherwise; the platform's own
 * refusal still backstops the exotic case, because this check exists to name
 * members, not to be the ceiling. Over it: exact UTF-8 sizes, computed only
 * then, sorted so the biggest lever is first.
 */
export declare function assertModuleMapWithinCodeLimit(modules: Record<string, unknown>): void;
/** What an unkeyed `LOADER.load` hands back. */
interface LoadedWorkerStub {
    getEntrypoint(): LoadedWorkerEntrypointStub;
}
/**
 * `env.LOADER` — the Worker Loader binding, as used from inside a DO.
 *
 * Both arms are here because both are the same platform affordance seen from
 * the two lifetimes Nimbus runs programs under: `get` is keyed and yields a
 * Durable Object class, so a resident process can be re-entered; `load` is
 * unkeyed and yields a stateless entrypoint, which is all a program that ends
 * with its call can ever need.
 */
interface WorkerLoaderBinding {
    get(id: string, code: () => Promise<unknown>): {
        getDurableObjectClass(name: string): unknown;
    };
    load(code: unknown): LoadedWorkerStub;
}
/**
 * The bindings `openResidentFacet` needs off whichever DO is hosting. A
 * staged boot's assembler may read more off the same env (Nimbus's reads
 * ASSETS); the env travels to it whole, so nothing further is named here.
 */
export interface ResidentFacetEnv {
    LOADER?: WorkerLoaderBinding;
}
/**
 * Fork one facet's entire SQLite into another by copy-on-write — the one way
 * the fabric calls `ctx.facets.clone`, because the raw call carries a hazard
 * measured on production workerd: ANY `src` that does not resolve to a
 * populated facet — a typo, a name not created yet, not merely the obvious
 * `''`/`'.'`/`'/'` — silently EMPTIES the destination and reports success. A
 * blocklist of bad names would pass a typo straight through and wipe a
 * process's filesystem while returning ok, so validation is positive on both
 * ends: the source must answer as populated before the clone runs, the
 * destination must answer as populated after it, and anything else fails
 * loud.
 *
 * `populated` is the caller's probe because populated-ness is the caller's
 * schema. The hosting actor cannot read a facet's SQLite from outside it, and
 * an EMPTIED facet still reports a 4,096-byte database — one page, the empty
 * file — so only a check that positively finds the caller's own data means
 * anything. The post-clone probe is not redundant with the pre-clone one: the
 * probe answers off the caller's accounting, and the capture races un-awaited
 * writes to the source, so the destination is verified rather than inferred.
 *
 * The primitive itself, measured: a reflink, 18–31 ms for a 45.73 MB corpus
 * and 34–54 ms for 1 GB — flat, because nothing is copied — with the data
 * visible from the destination's constructor. Same-Durable-Object only.
 * Quiesce and await writes to the source first; the destination name consumes
 * a facet ID on first use like any other facet name; and the shared ~10 GiB
 * storage budget grants no copy-on-write credit — crossing it resets the
 * object rather than raising an error.
 */
export declare function cloneFacetStorage(ctx: DurableObjectState, clone: {
    src: string;
    dst: string;
    populated(name: string): boolean | Promise<boolean>;
}): Promise<void>;
/**
 * The facet name for a slot. Reused, and that is the entire point.
 *
 * A Durable Object admits 65,536 facets over its LIFETIME: the IDs are
 * append-only and are never reclaimed, so the bound is on facets ever CREATED,
 * not facets alive at once. Naming a facet after its pid, when pids never
 * repeat, therefore burned one of those IDs on every spawn — a long-lived
 * session would eventually exhaust its facet index with no way back, and the
 * failure is unrecoverable rather than merely slow.
 *
 * Reusing a NAME costs no new ID. So the name comes from a free list and the
 * pid stays what it always was: the process identity in the ProcessTable. The
 * two were only ever conflated because one of them happened to be handy.
 */
export declare function residentFacetName(slot: number): string;
/**
 * Facet IDs a Durable Object is granted over its LIFETIME. Append-only and
 * never reclaimed, so crossing it is unrecoverable for the object — which is
 * why the ledger below counts consumption durably instead of leaving the
 * bound as prose the slot book merely respects.
 */
export declare const FACET_ID_LIFETIME_BUDGET = 65536;
/** Where the ledger persists the count of facet names ever minted. */
export declare const FACET_NAME_HIGH_WATER_KEY = "fabric_facet_name_high_water";
/**
 * The lifetime facet-ID ledger: how many facet names this fabric has ever
 * minted on the Durable Object, against the 65,536 the platform will ever
 * grant it. `consumed` only ever counts FIRST uses — a reused name, in this
 * incarnation or any earlier one, cost no new ID, which is the slot book's
 * whole reason to exist. Surfaced so an operator can see proximity to a wall
 * whose crossing is unrecoverable, instead of discovering it from the
 * platform's opaque failure.
 */
export declare function facetIdBudget(ctx: DurableObjectState): Promise<{
    consumed: number;
    budget: number;
}>;
/**
 * What `openResidentFacet` hands back: a running process, minus its placement.
 *
 * `slot` rides along because the caller's `describe` needs the facet's real
 * name and the slot is not derivable from the pid — that indirection is the
 * whole point of the free list. Reading it back out of the book later would
 * also race the release that empties it.
 */
export type ResidentFacet = Omit<HostedProcess, 'describe'> & {
    slot: number;
};
/**
 * Open a resident process as a facet of the actor whose `ctx` and `env` are
 * given, and start its runner.
 *
 * This is the ONE way a resident process comes into existence, and every
 * substrate goes through it: the facet host calls it with the coordinator's
 * own `ctx`, the peer host calls it — over one RPC — with a sibling session
 * DO's. Everything a substrate could plausibly want to special-case is a
 * PARAMETER here rather than a branch: which actor hosts the child, and how
 * the boot spec's by-path members are read.
 */
export declare function openResidentFacet(ctx: DurableObjectState, env: ResidentFacetEnv, disk: () => ResidentDiskReader, supervisor: ResidentSupervisorProps, params: ProcessHostParams): ResidentFacet;
/**
 * Run one program to completion as an UNKEYED dynamic worker.
 *
 * Unkeyed is the whole difference from `openResidentFacet`: nothing can
 * re-resolve this worker into a later request's context, so it can never be a
 * routeable target and never has to be released by name. It exists for the
 * duration of one call and its stubs are dropped as that call unwinds.
 *
 * Shared by both substrates on purpose. `peer` places processes that have a
 * residency to place; a one-shot has none, and shipping its fully-inline map
 * across a sibling hop would meet the 32 MiB RPC ceiling that by-path boot
 * specs exist to avoid — for a run that gains nothing by moving.
 */
export declare function runOneShotWorker<T>(ctx: DurableObjectState, env: ResidentFacetEnv, supervisor: ResidentSupervisorProps, params: OneShotParams, consume: (response: Response) => Promise<T>): Promise<T>;
export {};
//# sourceMappingURL=workerd-facet-host.d.ts.map