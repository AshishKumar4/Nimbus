/** Shared composition state for core workspaces and the process fabric. */
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