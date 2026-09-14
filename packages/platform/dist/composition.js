export const DEFAULT_HOST_NAMESPACE = 'NIMBUS_SESSION';
export const DEFAULT_HOST_DISPATCH_METHOD = 'supervisorOp';
let composition = null;
let ctxExports = null;
/** Composition and loopback exports are first-write-wins for this isolate. */
export function composeFabric(value) {
    if (!composition)
        composition = value;
}
export function adoptCtxExports(value) {
    if (!ctxExports)
        ctxExports = value;
}
export function getCtxExports() {
    return ctxExports;
}
export function supervisorEntrypoint(exportsObj) {
    const exports = exportsObj ?? ctxExports;
    const name = composition?.supervisorEntrypoint;
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
export function stagedBootAssembler() {
    const assembler = composition?.stagedBootAssembler;
    if (!assembler) {
        throw new Error('fabric: no staged-boot assembler composed; a \'staged\' boot spec '
            + 'cannot be assembled without one (composeFabric)');
    }
    return assembler;
}
