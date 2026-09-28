export const DEFAULT_HOST_NAMESPACE = 'NIMBUS_SESSION';
export const DEFAULT_HOST_DISPATCH_METHOD = 'supervisorOp';
let composition = null;
let ctxExports = null;
/**
 * A program's filesystem errors reach it across workerd RPC, from the host
 * that answers its supervisor binding, and the program branches on the POSIX
 * `code` each one carries. workerd carries an error's own properties across
 * RPC only when the sending AND the receiving isolate have
 * `enhanced_error_serialization`, on by compatibility date from 2026-04-21:
 * the serializer writes a native error as a host object with its own
 * properties only under the flag (src/workerd/jsg/ser.c++,
 * Serializer::IsHostObject), and the receiver reads that detail back only
 * under it (src/workerd/jsg/util.c++, decodeTunneledException); see
 * https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/.
 * Programs load at CF_COMPAT_DATE, past it. The host runs at its embedder's
 * date, and below it every ENOENT would reach every program as a bare message
 * it maps to EIO. So composing refuses such a host, at startup, which on
 * Cloudflare fails the deploy. Off workerd (bun, node) there is no RPC hop and
 * no `Cloudflare` global to read.
 */
function requireEnhancedErrorSerialization() {
    // `typeof` of an undeclared global is 'undefined', not a ReferenceError.
    if (typeof Cloudflare === 'undefined')
        return;
    if (Cloudflare.compatibilityFlags.enhanced_error_serialization === true)
        return;
    throw new Error('fabric: this Worker runs without enhanced_error_serialization, so the code on a '
        + "program's filesystem error (ENOENT, EEXIST, ...) would not survive the RPC back to it. "
        + 'Set compatibility_date to 2026-04-21 or later.');
}
/**
 * Compose once per isolate. A second call with the same values is a no-op;
 * a second call with different values throws, naming both, so an embedder
 * whose composition lost to an earlier import learns it at startup rather
 * than from a facet that reached the wrong host. A host without
 * `enhanced_error_serialization` is refused.
 */
export function composeFabric(value) {
    requireEnhancedErrorSerialization();
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
