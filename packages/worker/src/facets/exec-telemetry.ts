/**
 * exec-telemetry.ts — per-exec phase timing for the foreground hot path.
 *
 * The foreground `node`/`.bin` exec path (facets/manager.ts:exec) pays a
 * fixed cost on every spawn: a full VFS prefetch-bundle walk + esbuild
 * ESM→CJS pass, a fresh Worker Loader isolate, and a 238 KiB shim
 * recompile. There was no per-exec timing, so optimizing it was blind.
 *
 * This singleton ring records `{ bundleMs, loadMs, runMs, drainPasses,
 * moduleMapBytes, rpcWrites, fsRpcReads, cacheHit }` for the last few execs, gated on
 * `NIMBUS_DIAG_EXEC=1`. Surfaced via `GET /api/_diag/exec` so behavioral
 * probes can read measured deltas before/after an optimization.
 *
 * Cost when off: a single env-var read at exec entry (`isExecDiagEnabled`)
 * short-circuits every record; nothing is allocated and the ring stays
 * empty. Same pattern as the install-pipeline diag flag
 * (NIMBUS_DIAG_INSTALL_PIPELINE).
 *
 * drainPasses + rpcWrites + fsRpcReads originate INSIDE the facet isolate
 * (the supervisor can't see them, and `Date.now()` is frozen in the no-I/O
 * drain so a wall-clock proxy would read 0). The generated runner reports
 * them in its result envelope; the supervisor folds them into the record.
 */

/** Singleton-per-isolate ring of recent exec records. */
export interface ExecTelemetryRecord {
  /** User-facing command label (e.g. `tsc --version`, `node -e ...`). */
  command: string;
  /** buildPrefetchBundle wall time (real I/O — clock advances). */
  bundleMs: number;
  /**
   * `_materializeFacetImages` wall time — resident processes only.
   *
   * A one-shot hands its module map to LOADER.load by value and never
   * materializes anything, so this stays 0 there. A resident process writes
   * the map to the content-addressed image store first, and that write is on
   * the same DO turn as everything else in the launch.
   */
  materializeMs: number;
  /** LOADER.load + getEntrypoint wall time. */
  loadMs: number;
  /** entrypoint.fetch() wall time (the run + supervisor RPC). */
  runMs: number;
  /** Startup-drain pass count, read from the facet's `__pass` counter
   *  (NOT wall-clock: workerd freezes Date.now() in a no-I/O drain). */
  drainPasses: number;
  /** Generated module-map size in UTF-8 bytes (runner.js + sidecars). */
  moduleMapBytes: number;
  /**
   * What that total is made of, in the same UTF-8 bytes.
   *
   * The total alone says the map is large and nothing about which pass to
   * cut, so an optimization aimed at it is aimed at a guess. It cost this
   * project a wave: `pi --version` was diagnosed as a snapshot REBUILD on the
   * strength of `bundleMs`, which workerd's frozen clock reports as 0 on a
   * warm read, while the 12 s sat in `runMs` — the fresh isolate parsing this
   * map and pre-compiling every cell in it.
   */
  bundleBytes: number;
  manifestBytes: number;
  metadataBytes: number;
  /** Supervisor RPC writes the facet issued (__queueRpcWrite calls). */
  rpcWrites: number;
  /** Supervisor fs READ round trips the facet issued. A whole-file async
   *  read costs one per READ_STREAM_CHUNK_BYTES, so this is the count that
   *  moves when reads are batched, coalesced or pipelined. */
  fsRpcReads: number;
  /** Whether the prefetch bundle was served from cache (no VFS walk). */
  cacheHit: boolean;
  /** Exit code, for cross-referencing telemetry against failures. */
  exitCode: number;
  /** Wall-clock at record time (supervisor side). */
  at: number;
}

/**
 * The fields `_execViaLoader` fills in on its way through, for the caller to
 * fold into a record. Derived from the record so the two cannot drift.
 */
export type ExecDiagSink = Pick<
  ExecTelemetryRecord,
  'loadMs' | 'runMs' | 'moduleMapBytes' | 'bundleBytes' | 'manifestBytes' | 'metadataBytes'
>;

const EXEC_RING_MAX = 32;
const _ring: ExecTelemetryRecord[] = [];

/**
 * True when exec telemetry is enabled. Read once at exec entry; callers
 * skip building the record entirely when this is false so the path stays
 * zero-overhead in production.
 */
export function isExecDiagEnabled(): boolean {
  return (globalThis as any).process?.env?.NIMBUS_DIAG_EXEC === '1';
}

/** Append a record to the ring. No-op when telemetry is disabled. */
export function recordExecTelemetry(rec: ExecTelemetryRecord): void {
  if (!isExecDiagEnabled()) return;
  _ring.push(rec);
  if (_ring.length > EXEC_RING_MAX) _ring.shift();
}

/** Snapshot the ring (newest last). Caller mutations don't affect it. */
export function readExecTelemetry(): ExecTelemetryRecord[] {
  return _ring.map((r) => ({ ...r }));
}

/** Clear the ring — used to open a fresh measurement window from a probe. */
export function resetExecTelemetry(): void {
  _ring.length = 0;
}
