export const DEFAULT_HOST_NAMESPACE = 'NIMBUS_SESSION';
export const DEFAULT_HOST_DISPATCH_METHOD = 'supervisorOp';
let composition = null;
let ctxExports = null;
/**
 * Compose once per isolate. A second call with the same values is a no-op;
 * a second call with different values throws, naming both, so an embedder
 * whose composition lost to an earlier import learns it at startup rather
 * than from a facet that reached the wrong host.
 */
export function composeFabric(value) {
    if (!composition) {
        composition = value;
        return;
    }
    const differences = ['supervisorEntrypoint', 'hostNamespace', 'hostDispatchMethod', 'stagedBootAssembler']
        .filter((key) => composition?.[key] !== value[key]);
    if (differences.length === 0)
        return;
    const describe = (c) => JSON.stringify({
        supervisorEntrypoint: c.supervisorEntrypoint,
        hostNamespace: c.hostNamespace ?? DEFAULT_HOST_NAMESPACE,
        hostDispatchMethod: c.hostDispatchMethod ?? DEFAULT_HOST_DISPATCH_METHOD,
        stagedBootAssembler: c.stagedBootAssembler ? 'set' : 'unset',
    });
    throw new Error(`fabric: composed twice with different values (${differences.join(', ')}): `
        + `first ${describe(composition)}, then ${describe(value)}. `
        + 'One composition per isolate; a Worker that imports another Nimbus entry inherits its composition.');
}
export function adoptCtxExports(value) {
    if (!ctxExports)
        ctxExports = value;
}
export function getCtxExports() {
    return ctxExports;
}
export function supervisorEntrypoint(exportsObj, name = composition?.supervisorEntrypoint) {
    const exports = exportsObj ?? ctxExports;
    if (!name)
        return null;
    if ((typeof exports !== 'object' && typeof exports !== 'function') || exports === null)
        return null;
    const factory = exports[name];
    return typeof factory === 'function' ? factory : null;
}
export function supervisorEntrypointName() {
    return composition?.supervisorEntrypoint ?? null;
}
export function hostNamespace() {
    return composition?.hostNamespace ?? DEFAULT_HOST_NAMESPACE;
}
export function hostDispatchMethod() {
    return composition?.hostDispatchMethod ?? DEFAULT_HOST_DISPATCH_METHOD;
}
/**
 * The composed route, for the props of a binding minted in this isolate.
 * Null when nothing is composed, like {@link supervisorEntrypoint}: a
 * program run without a composition gets no supervisor binding, and needs
 * no route back to a host it cannot reach.
 */
export function hostRoute() {
    if (!composition)
        return null;
    return {
        supervisorEntrypoint: composition.supervisorEntrypoint,
        hostNamespace: hostNamespace(),
        hostDispatchMethod: hostDispatchMethod(),
    };
}
export function stagedBootAssembler() {
    const assembler = composition?.stagedBootAssembler;
    if (!assembler) {
        throw new Error('fabric: no staged-boot assembler composed; a \'staged\' boot spec '
            + 'cannot be assembled without one (composeFabric)');
    }
    return assembler;
}
