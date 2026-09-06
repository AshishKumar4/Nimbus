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
import { type HostedProcess, type OneShotParams, type ProcessHostParams, type ResidentBootSpec, type ResidentDiskReader, type ResidentSupervisorProps } from './process-fabric.js';
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
 *
 * `get` stays wide on purpose: the platform passes a null id for the unkeyed
 * call and answers the callback with the code object or a promise of it, so a
 * narrower declaration would refuse the real binding. The fabric itself always
 * passes a string id and a promise callback.
 */
interface WorkerLoaderBinding {
    get(id: string | null, code: () => unknown): {
        getDurableObjectClass(name: string): unknown;
    };
    load(code: unknown): LoadedWorkerStub;
}
/**
 * The bindings `processes` needs off whichever DO is hosting. A
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
export declare function cloneStorage(ctx: DurableObjectState, clone: {
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
 * What `processes(ctx, env).spawn` hands back: a running process, minus its placement.
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
 * The process surface of one hosting actor: how a resident process comes
 * into existence on workerd, and how a one-shot program runs to completion.
 *
 * `spawn` is the ONE way a resident process comes into existence, and every
 * substrate goes through it: the facet host calls it with the coordinator's
 * own `ctx`, the peer host calls it — over one RPC — with a sibling session
 * DO's. Everything a substrate could plausibly want to special-case is a
 * PARAMETER here rather than a branch: which actor hosts the child, and how
 * the boot spec's by-path members are read.
 */
export declare function processes(ctx: DurableObjectState, env: ResidentFacetEnv): Processes;
export declare class Processes {
    private readonly ctx;
    private readonly env;
    constructor(ctx: DurableObjectState, env: ResidentFacetEnv);
    /** Open a resident process as a facet of this actor, and start its runner. */
    spawn(disk: () => ResidentDiskReader, supervisor: ResidentSupervisorProps, params: ProcessHostParams): ResidentFacet;
    /**
     * Run one program to completion as an UNKEYED dynamic worker.
     *
     * Unkeyed is the whole difference from `spawn`: nothing can re-resolve this
     * worker into a later request's context, so it can never be a routeable
     * target and never has to be released by name. It exists for the duration
     * of one call and its stubs are dropped as that call unwinds.
     *
     * Shared by both substrates on purpose. `peer` places processes that have a
     * residency to place; a one-shot has none, and shipping its fully-inline
     * map across a sibling hop would meet the 32 MiB RPC ceiling that by-path
     * boot specs exist to avoid — for a run that gains nothing by moving.
     */
    run<T>(supervisor: ResidentSupervisorProps, params: OneShotParams, consume: (response: Response) => Promise<T>): Promise<T>;
}
/**
 * The WorkerCode the loader callback returns for one resident boot: the
 * module map from {@link residentLoaderConfig} (or the staged assembler),
 * plus the isolate's env and network posture.
 *
 * A `code` boot with an explicit `env` — defined, even as `{}` — is the
 * embedder's whole statement about the isolate: the env rides through
 * exactly as minted (loopback stubs by reference) with `globalOutbound`
 * and `limits` beside it, and the composed supervisor
 * entrypoint is not consulted at all, so no SUPERVISOR binding appears.
 * Without one, the default holds: inherited network plus a SUPERVISOR
 * minted from the composed entrypoint for the coordinator's identity.
 */
export declare function residentWorkerConfig(env: ResidentFacetEnv, disk: () => ResidentDiskReader, supervisor: ResidentSupervisorProps, boot: ResidentBootSpec): Promise<Record<string, unknown>>;
export {};
//# sourceMappingURL=workerd-facet-host.d.ts.map