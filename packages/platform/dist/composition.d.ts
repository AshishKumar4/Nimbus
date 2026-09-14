/**
 * composition.ts — the ONE seam an embedder wires the fabric through.
 *
 * The fabric mints supervisor bindings and assembles staged boots for the
 * programs it hosts, but the entrypoint class that answers those bindings
 * and the artifact sources a stage names both belong to the embedder. The
 * embedder states them once, in its composition root, with one call:
 *
 *   composeFabric({
 *     supervisorEntrypoint: 'SupervisorRPC',
 *     stagedBootAssembler: (env, stage) => assembleConfig(env, stage),
 *   });
 *
 * First-write-wins, like every holder in this module: the composition
 * root's module scope runs once per isolate, before any request.
 *
 * `ctx.exports` is runtime state, not composition: workerd mints it per
 * instance, so the embedder captures it where the platform hands it over —
 * the first fetch, or the DO constructor — with {@link adoptCtxExports}.
 *
 * This module stays a leaf (no fabric imports) so helpers (notably
 * isolate-pool.ts) can read `ctx.exports` without transitively importing
 * the Durable Object classes, which is what lets the pool be unit-tested
 * in a plain Node/Bun process.
 */
export type EntrypointLoopbackFactory = <Stub = unknown>(options: {
    props: object;
}) => Stub;
export type CtxExports = Record<string, EntrypointLoopbackFactory | undefined>;
export type StagedBootAssembler = (env: unknown, stage: unknown) => Promise<object>;
export interface FabricComposition {
    supervisorEntrypoint: string;
    stagedBootAssembler?: StagedBootAssembler;
    /** Durable Object namespace binding that owns the workspace. */
    hostNamespace?: string;
    /** RPC method the host forwards to workspace.supervisorOp. */
    hostDispatchMethod?: string;
}
export declare const DEFAULT_HOST_NAMESPACE = "NIMBUS_SESSION";
export declare const DEFAULT_HOST_DISPATCH_METHOD = "supervisorOp";
/** Composition and loopback exports are first-write-wins for this isolate. */
export declare function composeFabric(value: FabricComposition): void;
export declare function adoptCtxExports(value: CtxExports): void;
export declare function getCtxExports(): CtxExports | null;
export declare function supervisorEntrypoint(exportsObj?: unknown): EntrypointLoopbackFactory | null;
export declare function supervisorEntrypointName(): string | null;
export declare function hostNamespace(): string;
export declare function hostDispatchMethod(): string;
export declare function stagedBootAssembler(): StagedBootAssembler;
//# sourceMappingURL=composition.d.ts.map