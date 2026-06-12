/**
 * exec-telemetry.ts — per-exec phase timing for the foreground hot path.
 *
 * The foreground `node`/`.bin` exec path (facets/manager.ts:exec) pays a
 * fixed cost on every spawn: a full VFS prefetch-bundle walk + esbuild
 * ESM→CJS pass, a fresh Worker Loader isolate, and a 238 KiB shim
 * recompile. There was no per-exec timing, so optimizing it was blind.
 *
 * This singleton ring records `{ bundleMs, loadMs, runMs, drainPasses,
 * moduleMapBytes, rpcWrites, cacheHit }` for the last few execs, gated on
 * `NIMBUS_DIAG_EXEC=1`. Surfaced via `GET /api/_diag/exec` so behavioral
 * probes can read measured deltas before/after an optimization.
 *
 * Cost when off: a single env-var read at exec entry (`isExecDiagEnabled`)
 * short-circuits every record; nothing is allocated and the ring stays
 * empty. Same pattern as the install-pipeline diag flag
 * (NIMBUS_DIAG_INSTALL_PIPELINE).
 *
 * drainPasses + rpcWrites originate INSIDE the facet isolate (the
 * supervisor can't see them, and `Date.now()` is frozen in the no-I/O
 * drain so a wall-clock proxy would read 0). The generated runner reports
 * them in its result envelope; the supervisor folds them into the record.
 */
const EXEC_RING_MAX = 32;
const _ring = [];
/**
 * True when exec telemetry is enabled. Read once at exec entry; callers
 * skip building the record entirely when this is false so the path stays
 * zero-overhead in production.
 */
export function isExecDiagEnabled() {
    return globalThis.process?.env?.NIMBUS_DIAG_EXEC === '1';
}
/** Append a record to the ring. No-op when telemetry is disabled. */
export function recordExecTelemetry(rec) {
    if (!isExecDiagEnabled())
        return;
    _ring.push(rec);
    if (_ring.length > EXEC_RING_MAX)
        _ring.shift();
}
/** Snapshot the ring (newest last). Caller mutations don't affect it. */
export function readExecTelemetry() {
    return _ring.map((r) => ({ ...r }));
}
/** Clear the ring — used to open a fresh measurement window from a probe. */
export function resetExecTelemetry() {
    _ring.length = 0;
}
