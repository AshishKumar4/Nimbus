/**
 * composition.ts — the ONE seam an embedder wires the fabric through.
 *
 * The fabric mints supervisor bindings and assembles staged boots for the
 * programs it hosts, but the entrypoint class that answers those bindings and
 * the artifact sources a stage names both belong to the embedder. The
 * embedder states them once, in its composition root, with one call:
 *
 *   composeFabric({
 *     supervisorEntrypoint: 'SupervisorRPC',
 *     stagedBootAssembler: (env, stage) => assembleConfig(env, stage),
 *   });
 *
 * First-write-wins, like every holder in this module: the composition root's
 * module scope runs once per isolate, before any request.
 *
 * `ctx.exports` is runtime state, not composition: workerd mints it per
 * instance, so the embedder captures it where the platform hands it over —
 * the first fetch, or the DO constructor — with {@link adoptCtxExports}.
 *
 * This module stays a leaf (no fabric imports) so helpers (notably
 * isolate-pool.ts) can read `ctx.exports` without transitively importing the
 * Durable Object classes, which is what lets the pool be unit-tested in a
 * plain Node/Bun process.
 */
/**
 * One entry of `ctx.exports`: a top-level entrypoint's loopback factory, which
 * mints a Service Binding stub for that entrypoint when called with props.
 *
 * The stub's RPC surface belongs to the entrypoint CLASS, which this leaf
 * cannot see — `Cloudflare.Exports` is derived from the embedder's own main
 * module, so for a library it evaluates to `{}`. A caller that knows the class
 * names the surface it expects (`factory<MySupervisorRpc>({ props })`); one
 * that does not gets `unknown` and has to narrow, same as
 * `DurableObjectNamespace<T>` and `RpcStub<T>` in @cloudflare/workers-types.
 */
export type EntrypointLoopbackFactory = <Stub = unknown>(options: {
    props: object;
}) => Stub;
/**
 * `ctx.exports` itself — one factory per top-level entrypoint export, keyed by
 * export name. Absent names read as undefined, which is how a caller finds out
 * the embedder's entry module does not re-export the class it needs.
 */
export type CtxExports = Record<string, EntrypointLoopbackFactory | undefined>;
/**
 * Assemble a complete Worker Loader config from a staged-artifact spec. The
 * embedder supplies this: a stage names artifact sources only the embedder
 * knows how to fetch (Nimbus's largest staged artifact is a ~23 MB module map
 * from ASSETS), and the assembler runs inside the loader's cache-miss callback
 * so those sources are materialized only while the facet actually loads.
 * `env` is whichever hosting actor's env the facet is opened with.
 */
export type StagedBootAssembler = (env: unknown, stage: unknown) => Promise<object>;
/** What an embedder states about itself, once, in its composition root. */
export interface FabricComposition {
    /**
     * The ctx.exports name of the embedder's supervisor WorkerEntrypoint. The
     * fabric mints one supervisor binding per hosted program from it
     * (`env.SUPERVISOR` inside the facet).
     */
    supervisorEntrypoint: string;
    /** Only embedders that use 'staged' boot specs supply one. */
    stagedBootAssembler?: StagedBootAssembler;
}
/** Register the embedder's composition. First-write-wins. */
export declare function composeFabric(composition: FabricComposition): void;
/**
 * Capture `ctx.exports` for the helpers that mint loopback bindings. The
 * embedder calls this where the platform hands the bag over — the first
 * fetch, or the DO constructor. First-write-wins.
 */
export declare function adoptCtxExports(value: CtxExports): void;
export declare function getCtxExports(): CtxExports | null;
/**
 * Resolve the composed supervisor entrypoint on an exports object —
 * `exportsObj` when given (a WorkerEntrypoint reads its own ctx.exports),
 * the adopted ctx.exports otherwise. Calling the result with props mints one
 * supervisor binding (`env.SUPERVISOR`) for one hosted program. Null when
 * either half is missing; the caller decides whether that degrades or throws.
 */
export declare function supervisorEntrypoint(exportsObj?: unknown): EntrypointLoopbackFactory | null;
/** The composed name, for error messages that point at the missing export. */
export declare function supervisorEntrypointName(): string | null;
/** The composed assembler; a 'staged' boot spec cannot assemble without one. */
export declare function stagedBootAssembler(): StagedBootAssembler;
//# sourceMappingURL=composition.d.ts.map