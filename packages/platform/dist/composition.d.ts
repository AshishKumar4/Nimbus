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
 * The composition belongs at module scope: it is per isolate, and the
 * platform serves a worker's entrypoints from whichever isolate it likes,
 * so an isolate that never ran an embedder's request path must still know
 * the composition. Composing again with the same values is a no-op;
 * composing again with different values throws, because the second caller
 * would otherwise run against a host it never named (a Worker that imports
 * Nimbus's own entry and composes its own host would be that caller).
 *
 * The one thing the entrypoints need from the composition, the route back
 * to the host, travels with every binding the fabric mints
 * ({@link hostRoute}), so an entrypoint answers correctly in an isolate
 * whose composition is absent or different.
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
/**
 * The way back to the host from a binding the fabric minted: the namespace
 * binding the host's Durable Object lives under, the method it forwards
 * supervisor envelopes through, and the entrypoint export that answers
 * supervisor bindings. Minted from the composition in the host's isolate
 * and carried in the binding's props, so the entrypoint that receives the
 * call resolves the host from the props rather than from its own isolate's
 * composition.
 */
export interface HostRoute {
    supervisorEntrypoint: string;
    hostNamespace: string;
    hostDispatchMethod: string;
}
export declare const DEFAULT_HOST_NAMESPACE = "NIMBUS_SESSION";
export declare const DEFAULT_HOST_DISPATCH_METHOD = "supervisorOp";
/**
 * Compose once per isolate. A second call with the same values is a no-op;
 * a second call with different values throws, naming both, so an embedder
 * whose composition lost to an earlier import learns it at startup rather
 * than from a facet that reached the wrong host.
 */
export declare function composeFabric(value: FabricComposition): void;
export declare function adoptCtxExports(value: CtxExports): void;
export declare function getCtxExports(): CtxExports | null;
export declare function supervisorEntrypoint(exportsObj?: unknown, name?: string | undefined): EntrypointLoopbackFactory | null;
export declare function supervisorEntrypointName(): string | null;
export declare function hostNamespace(): string;
export declare function hostDispatchMethod(): string;
/**
 * The composed route, for the props of a binding minted in this isolate.
 * Null when nothing is composed, like {@link supervisorEntrypoint}: a
 * program run without a composition gets no supervisor binding, and needs
 * no route back to a host it cannot reach.
 */
export declare function hostRoute(): HostRoute | null;
export declare function stagedBootAssembler(): StagedBootAssembler;
//# sourceMappingURL=composition.d.ts.map