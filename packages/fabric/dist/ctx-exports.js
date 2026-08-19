/**
 * ctx-exports.ts — leaf module holding the ctx.exports reference.
 *
 * Isolated from the embedder's entry module so helpers (notably
 * loader-pool.ts) can read `ctx.exports` without transitively importing the
 * Durable Object classes. Keeping this a leaf (no imports) lets the pool be
 * unit-tested in a plain Node/Bun process.
 *
 * The embedder's fetch handler calls `setCtxExports(ctx.exports)` on the
 * first request; callers like the loader pool read via `getCtxExports()`.
 * If the pool is constructed before the first fetch (unlikely) it just gets
 * null — the caller decides how to degrade.
 */
let _ctxExports = null;
export function setCtxExports(value) {
    if (_ctxExports)
        return; // first-write-wins, same as the prior inline impl
    _ctxExports = value;
}
export function getCtxExports() {
    return _ctxExports;
}
/**
 * The fabric mints supervisor bindings for the programs it hosts, but the
 * entrypoint class that answers them belongs to the embedder, so its
 * ctx.exports name is registered once at composition time rather than
 * hardcoded here. First-write-wins, same as the ctx.exports holder above.
 */
let _supervisorEntrypointName = null;
export function setSupervisorEntrypointName(name) {
    if (_supervisorEntrypointName)
        return;
    _supervisorEntrypointName = name;
}
/**
 * Resolve the registered supervisor entrypoint on an exports object —
 * `exportsObj` when given (a WorkerEntrypoint reads its own ctx.exports),
 * the held ctx.exports otherwise. Calling the result with props mints one
 * supervisor binding (`env.SUPERVISOR`) for one hosted program. Null when
 * either half is missing; the caller decides whether that degrades or throws.
 */
export function supervisorEntrypoint(exportsObj) {
    const exports = exportsObj ?? _ctxExports;
    if (!_supervisorEntrypointName)
        return null;
    if ((typeof exports !== 'object' && typeof exports !== 'function') || exports === null)
        return null;
    const factory = exports[_supervisorEntrypointName];
    return typeof factory === 'function' ? factory : null;
}
/** The registered name, for error messages that point at the missing export. */
export function supervisorEntrypointName() {
    return _supervisorEntrypointName;
}
