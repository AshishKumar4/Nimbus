/** Shared composition state for core workspaces and the process fabric. */
export type EntrypointLoopbackFactory = <Stub = unknown>(options: { props: object }) => Stub;
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

export const DEFAULT_HOST_NAMESPACE = 'NIMBUS_SESSION';
export const DEFAULT_HOST_DISPATCH_METHOD = 'supervisorOp';
let composition: FabricComposition | null = null;
let ctxExports: CtxExports | null = null;

/** Composition and loopback exports are first-write-wins for this isolate. */
export function composeFabric(value: FabricComposition): void {
  if (!composition) composition = value;
}

export function adoptCtxExports(value: CtxExports): void {
  if (!ctxExports) ctxExports = value;
}

export function getCtxExports(): CtxExports | null {
  return ctxExports;
}

export function supervisorEntrypoint(exportsObj?: unknown): EntrypointLoopbackFactory | null {
  const exports = exportsObj ?? ctxExports;
  const name = composition?.supervisorEntrypoint;
  if (!name) return null;
  if ((typeof exports !== 'object' && typeof exports !== 'function') || exports === null) return null;
  const factory = (exports as Record<string, unknown>)[name];
  return typeof factory === 'function' ? factory as EntrypointLoopbackFactory : null;
}

export function supervisorEntrypointName(): string | null {
  return composition?.supervisorEntrypoint ?? null;
}

export function hostNamespace(): string {
  return composition?.hostNamespace ?? DEFAULT_HOST_NAMESPACE;
}

export function hostDispatchMethod(): string {
  return composition?.hostDispatchMethod ?? DEFAULT_HOST_DISPATCH_METHOD;
}

export function stagedBootAssembler(): StagedBootAssembler {
  const assembler = composition?.stagedBootAssembler;
  if (!assembler) {
    throw new Error(
      'fabric: no staged-boot assembler composed; a \'staged\' boot spec '
        + 'cannot be assembled without one (composeFabric)',
    );
  }
  return assembler;
}
