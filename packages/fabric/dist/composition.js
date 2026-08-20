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
let _composition = null;
/** Register the embedder's composition. First-write-wins. */
export function composeFabric(composition) {
    if (_composition)
        return;
    _composition = composition;
}
let _ctxExports = null;
/**
 * Capture `ctx.exports` for the helpers that mint loopback bindings. The
 * embedder calls this where the platform hands the bag over — the first
 * fetch, or the DO constructor. First-write-wins.
 */
export function adoptCtxExports(value) {
    if (_ctxExports)
        return;
    _ctxExports = value;
}
export function getCtxExports() {
    return _ctxExports;
}
/**
 * Resolve the composed supervisor entrypoint on an exports object —
 * `exportsObj` when given (a WorkerEntrypoint reads its own ctx.exports),
 * the adopted ctx.exports otherwise. Calling the result with props mints one
 * supervisor binding (`env.SUPERVISOR`) for one hosted program. Null when
 * either half is missing; the caller decides whether that degrades or throws.
 */
export function supervisorEntrypoint(exportsObj) {
    const exports = exportsObj ?? _ctxExports;
    const name = _composition?.supervisorEntrypoint;
    if (!name)
        return null;
    if ((typeof exports !== 'object' && typeof exports !== 'function') || exports === null)
        return null;
    const factory = exports[name];
    return typeof factory === 'function' ? factory : null;
}
/** The composed name, for error messages that point at the missing export. */
export function supervisorEntrypointName() {
    return _composition?.supervisorEntrypoint ?? null;
}
/** The composed assembler; a 'staged' boot spec cannot assemble without one. */
export function stagedBootAssembler() {
    const assembler = _composition?.stagedBootAssembler;
    if (!assembler) {
        throw new Error('fabric: no staged-boot assembler composed; a \'staged\' boot spec '
            + 'cannot be assembled without one (composeFabric)');
    }
    return assembler;
}
