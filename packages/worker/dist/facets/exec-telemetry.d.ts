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
/** Singleton-per-isolate ring of recent exec records. */
export interface ExecTelemetryRecord {
    /** User-facing command label (e.g. `tsc --version`, `node -e ...`). */
    command: string;
    /** buildPrefetchBundle wall time (real I/O — clock advances). */
    bundleMs: number;
    /** LOADER.load + getEntrypoint wall time. */
    loadMs: number;
    /** entrypoint.fetch() wall time (the run + supervisor RPC). */
    runMs: number;
    /** Startup-drain pass count, read from the facet's `__pass` counter
     *  (NOT wall-clock: workerd freezes Date.now() in a no-I/O drain). */
    drainPasses: number;
    /** Generated module-map size in UTF-8 bytes (runner.js + sidecars). */
    moduleMapBytes: number;
    /** Supervisor RPC writes the facet issued (__queueRpcWrite calls). */
    rpcWrites: number;
    /** Whether the prefetch bundle was served from cache (no VFS walk). */
    cacheHit: boolean;
    /** Exit code, for cross-referencing telemetry against failures. */
    exitCode: number;
    /** Wall-clock at record time (supervisor side). */
    at: number;
}
/**
 * True when exec telemetry is enabled. Read once at exec entry; callers
 * skip building the record entirely when this is false so the path stays
 * zero-overhead in production.
 */
export declare function isExecDiagEnabled(): boolean;
/** Append a record to the ring. No-op when telemetry is disabled. */
export declare function recordExecTelemetry(rec: ExecTelemetryRecord): void;
/** Snapshot the ring (newest last). Caller mutations don't affect it. */
export declare function readExecTelemetry(): ExecTelemetryRecord[];
/** Clear the ring — used to open a fresh measurement window from a probe. */
export declare function resetExecTelemetry(): void;
//# sourceMappingURL=exec-telemetry.d.ts.map