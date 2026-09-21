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

export const DEFAULT_HOST_NAMESPACE = 'NIMBUS_SESSION';
export const DEFAULT_HOST_DISPATCH_METHOD = 'supervisorOp';
let composition: FabricComposition | null = null;
let ctxExports: CtxExports | null = null;

/**
 * Compose once per isolate. A second call with the same values is a no-op;
 * a second call with different values throws, naming both, so an embedder
 * whose composition lost to an earlier import learns it at startup rather
 * than from a facet that reached the wrong host.
 */
export function composeFabric(value: FabricComposition): void {
  if (!composition) {
    composition = value;
    return;
  }
  const differences = (['supervisorEntrypoint', 'hostNamespace', 'hostDispatchMethod', 'stagedBootAssembler'] as const)
    .filter((key) => composition?.[key] !== value[key]);
  if (differences.length === 0) return;
  const describe = (c: FabricComposition) => JSON.stringify({
    supervisorEntrypoint: c.supervisorEntrypoint,
    hostNamespace: c.hostNamespace ?? DEFAULT_HOST_NAMESPACE,
    hostDispatchMethod: c.hostDispatchMethod ?? DEFAULT_HOST_DISPATCH_METHOD,
    stagedBootAssembler: c.stagedBootAssembler ? 'set' : 'unset',
  });
  throw new Error(
    `fabric: composed twice with different values (${differences.join(', ')}): `
      + `first ${describe(composition)}, then ${describe(value)}. `
      + 'One composition per isolate; a Worker that imports another Nimbus entry inherits its composition.',
  );
}

export function adoptCtxExports(value: CtxExports): void {
  if (!ctxExports) ctxExports = value;
}

export function getCtxExports(): CtxExports | null {
  return ctxExports;
}

export function supervisorEntrypoint(exportsObj?: unknown, name = composition?.supervisorEntrypoint): EntrypointLoopbackFactory | null {
  const exports = exportsObj ?? ctxExports;
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

/**
 * The composed route, for the props of a binding minted in this isolate.
 * Null when nothing is composed, like {@link supervisorEntrypoint}: a
 * program run without a composition gets no supervisor binding, and needs
 * no route back to a host it cannot reach.
 */
export function hostRoute(): HostRoute | null {
  if (!composition) return null;
  return {
    supervisorEntrypoint: composition.supervisorEntrypoint,
    hostNamespace: hostNamespace(),
    hostDispatchMethod: hostDispatchMethod(),
  };
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
