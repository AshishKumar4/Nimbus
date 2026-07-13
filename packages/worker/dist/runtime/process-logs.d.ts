/**
 * ProcessLogStore — per-PID ring buffer for facet stdout/stderr.
 *
 * Problem we solve:
 *   Facet stdout/stderr flows through `_rpcStdout`/`_rpcStderr` in
 *   NimbusSession. If the WebSocket terminal is attached, data reaches
 *   the user. If not — or if a process crashes synchronously before its
 *   output has been flushed through — the data is gone.
 *
 * What this does:
 *   - Buffer every stdout/stderr chunk in a fixed-byte ring, keyed by PID.
 *   - Split oversize chunks at 4 KB so no single write can swamp a PID's
 *     allotted 64 KB.
 *   - Tag binary chunks (null bytes / high non-printable ratio) as
 *     `{type: 'binary', size: N}` so replay shows `[N bytes of binary
 *     output]` instead of garbled terminal state.
 *   - Track process exit separately from the append stream so `logs` can
 *     print a clean footer and `_emitExitDump` can fire exactly once.
 *   - Retain logs for `retainAfterExitMs` (default 10 min) past exit —
 *     far longer than ProcessTable.reap's 60 s — so users have time to
 *     read a crash dump.
 *   - Provide pub-sub via `subscribe(pid, cb)` so `logs -f` is O(1) per
 *     chunk, not a poll loop.
 *
 * Non-goals:
 *   - Routing raw Uint8Array. RPC boundary already strings the data
 *     (SupervisorRPC.stdout(data: string)), so we store strings.
 *
 * W9 — hibernation persistence (CF-INTERNAL-OPTIMIZATION-RESEARCH §C.2,
 * Lever 11):
 *   The store optionally accepts a `PersistAdapter` (set via
 *   `setPersist`). When set:
 *     - `append` / `markExit` mark the pid dirty in memory; the actual
 *       SQL write is batched into `flush()`. Callers schedule `flush()`
 *       from a debounced alarm OR a webSocketClose handler so writes
 *       don't run on the hot stdout path.
 *     - First read of a pid (`tail`/`all`/`subscribe`/`getExit`/`has`)
 *       lazily hydrates from the adapter. Subsequent reads stay in
 *       memory until eviction.
 *     - Eviction (per-pid byte cap, dropOlderThan, maxPids) cascades
 *       to the adapter on the next `flush()` — never inline, so eviction
 *       under load doesn't write-amplify.
 *   When NOT set: behaviour is byte-identical to pre-W9 (in-memory only).
 */
export type LogStream = 'stdout' | 'stderr';
export interface LogChunk {
    ts: number;
    stream: LogStream;
    /**
     * `data` is the raw chunk content (ANSI escapes preserved). For
     * binary-detected chunks it's a placeholder like
     * `[237 bytes of binary output]\n`; the original bytes are dropped.
     */
    data: string;
    /** Set for chunks we flagged as binary — lets UI render differently. */
    binary?: boolean;
}
export interface SequencedLogChunk extends LogChunk {
    seq: number;
}
export interface ProcessLogReadOptions {
    cursor?: number;
    lines?: number;
    bytes?: number;
}
export interface ProcessExitInfo {
    code: number;
    /** When the exit was recorded (ms epoch). */
    at: number;
    /** Optional synthetic reason, used by external-exit path (timeout/abort). */
    reason?: string;
}
/**
 * live in NimbusSession (production: ctx.storage.sql) and in test
 * harnesses (functional probes: in-memory mock).
 *
 * Contract:
 *   - load(pid) is called at most once per pid per isolate-gen, before
 *     the first read for that pid. Returning `null` means "no row" —
 *     the store treats the pid as fresh. Returning `{ chunks: [], exit: null }`
 *     means "explicitly empty" (also fresh).
 *   - persistChunks / persistExit are called ONLY from `flush()`. Each
 *     call carries every NEW chunk since the last flush for that pid;
 *     the adapter MUST insert all of them in seq order.
 *   - dropPid removes ALL rows for the pid from BOTH tables. Called on
 *     dropOlderThan + maxPids eviction.
 *   - pruneBeforeSeq removes chunk rows below the given seq. Called
 *     inside flush after the per-pid byte cap is exceeded; the store
 *     computes the cutoff seq from its own ring state.
 *   - Adapters MUST be synchronous from the store's POV. Real SQL
 *     calls in the DO are synchronous (storage.sql.exec is blocking
 *     against the SQLite engine); KV is not used by W9.
 */
export interface PersistAdapter {
    load(pid: number): {
        chunks: LogChunk[];
        exit: ProcessExitInfo | null;
    } | null;
    persistChunks(pid: number, rows: {
        seq: number;
        chunk: LogChunk;
    }[]): void;
    persistExit(pid: number, info: ProcessExitInfo): void;
    dropPid(pid: number): void;
    pruneBeforeSeq(pid: number, seq: number): void;
}
export interface ProcessLogStoreOptions {
    /** Per-PID ring cap in bytes. Default 64 KB. */
    perPidBytes?: number;
    /**
     * Max chunk length in bytes. Writes longer than this are split into
     * multiple chunks. Default 4 KB. Splitting may break a single ANSI
     * escape sequence across chunks — tolerated because replay tools
     * concatenate chunks before rendering.
     */
    maxChunkBytes?: number;
    /** Retention past process exit. Default 10 min. */
    retainAfterExitMs?: number;
    /**
     * Global cap on the number of tracked PIDs. When `_getOrCreate`
     * would push the count above this, the store evicts in this order
     * of preference:
     *   1. Oldest EXITED pid with zero subscribers.
     *   2. Oldest pid by `lastActivity` (any state) with zero subscribers.
     *   3. Fail silently — an edge case where every pid is actively
     *      subscribed; the new entry is still inserted and the cap is
     *      briefly exceeded.
     * Default 500. Protects against a 1000-pid fork-bomb pinning
     * ~50 MB of ring buffers for 10 minutes (STABILITY-AUDIT.md M-S5).
     */
    maxPids?: number;
}
/**
 * Strip ANSI CSI escape sequences (colors, cursor, etc.) for --plain mode.
 * Keeps the rest of the text intact.
 */
export declare function stripAnsi(s: string): string;
export declare class ProcessLogStore {
    private readonly perPidBytes;
    private readonly maxChunkBytes;
    private readonly retainAfterExitMs;
    private readonly maxPids;
    private pids;
    /** Cumulative count of PIDs evicted by the cap (STABILITY-AUDIT.md M-S5). */
    private _droppedPids;
    /** Optional persistence backend. When null, store is in-memory only. */
    private _persist;
    /**
     * Pids whose rows are dropped on next flush (eviction queue). Keyed by
     * pid; value is `true` for "pid was evicted from memory; ask adapter to
     * delete all rows". Distinct from dirtyChunks because the adapter call
     * is dropPid, not persistChunks.
     */
    private _dropQueue;
    /**
     * Pids that need pruneBeforeSeq on next flush — keyed by pid → cutoff
     * seq (delete all rows with seq < cutoff). Set whenever an in-memory
     * `_evict` shifts the chunks array; the cutoff is the lowest seq that
     * remains in memory.
     */
    private _pruneQueue;
    /** Cumulative flushed-bytes counter (telemetry). */
    private _flushedChunks;
    private _flushedBytes;
    private _flushCount;
    private _lastFlushAt;
    private _lastFlushDurationMs;
    /** Cumulative hydrate counters. */
    private _hydratedPids;
    private _hydratedChunks;
    private _hydratedBytes;
    constructor(opts?: ProcessLogStoreOptions);
    /**
     * W9: install a persistence adapter. Call once at NimbusSession init,
     * after the SQL tables exist. Pre-existing in-memory state is NOT
     * pushed to the adapter — only state mutated AFTER setPersist is
     * subject to flush. This is fine in practice: NimbusSession sets the
     * adapter in the constructor, before any append happens.
     */
    setPersist(adapter: PersistAdapter): void;
    /**
     * Fire for EVERY appended chunk / recorded exit, across all pids, in
     * addition to the per-pid `subscribe`/`subscribeExit` callbacks.
     *
     * This is the hibernation-safe fan-out seam for the process-terminal
     * WebSockets: per-connection subscriptions are closures on ONE DO
     * instance and silently vanish when the instance is reset or restarted
     * (the accepted WebSocket itself survives via the hibernation API, so
     * a surviving client would otherwise stream nothing forever). The DO
     * wires one broadcast hook per instance that routes chunks to accepted
     * sockets by their serialized attachment — state that survives resets.
     */
    private _broadcastChunk;
    private _broadcastExit;
    setBroadcast(onChunk: (pid: number, chunk: LogChunk) => void, onExit: (pid: number, exit: ProcessExitInfo) => void): void;
    /** Is there ANY state for this pid (including exit-only)? */
    has(pid: number): boolean;
    /** Current buffered bytes for this PID (post-eviction). */
    size(pid: number): number;
    getExit(pid: number): ProcessExitInfo | null;
    /**
     * W9: read-side helper. If we have an adapter and the pid has any rows
     * in SQL, lazy-create the in-memory state (which triggers hydrate).
     * Returns the state or null. Performs at most one adapter `load` per
     * pid per isolate-gen by routing through `_getOrCreate` → `_hydrate`,
     * which is guarded by `state.hydrated`.
     */
    private _maybeHydrateRead;
    /**
     * Append a chunk. `data` may be huge or binary; we split / tag as
     * needed. Notifies any `subscribe()`rs for this pid.
     */
    append(pid: number, stream: LogStream, data: string): void;
    /** W9: shared insert path — assigns a seq, marks dirty, evicts, fans out. */
    private _appendChunk;
    /**
     * Return chunks with stable per-PID sequence numbers. `cursor` is an
     * exclusive read position: pass the previous returned `cursor` to receive only
     * newer chunks. If older chunks have been evicted, `truncated` is true
     * and the response starts at the oldest retained chunk.
     */
    read(pid: number, opts?: ProcessLogReadOptions): {
        chunks: SequencedLogChunk[];
        cursor: number;
        truncated: boolean;
    };
    /** Return the last N chunks (by line count) in chronological order. */
    tail(pid: number, opts?: Pick<ProcessLogReadOptions, 'lines' | 'bytes'>): LogChunk[];
    private _tailStartIndex;
    /** All chunks for a pid, chronological. */
    all(pid: number): LogChunk[];
    /** Record exit. Idempotent: second call is ignored (preserves first). */
    markExit(pid: number, code: number, reason?: string): void;
    /**
     * Subscribe to new chunks for this pid. Returns unsubscribe fn.
     * Subscriber is called synchronously from within `append`.
     * W9: also hydrates from SQL on first touch so a post-hibernate
     * subscriber sees pre-hibernate context in the next backlog frame.
     */
    subscribe(pid: number, cb: (c: LogChunk) => void): () => void;
    /** Subscribe to the exit event. Fires once. */
    subscribeExit(pid: number, cb: (e: ProcessExitInfo) => void): () => void;
    /**
     * Drop all state for any PID whose process exited more than `ageMs`
     * ago. Returns the number of PIDs purged.
     *
     * Optional `isOrphan(pid)` callback identifies PIDs whose owning
     * process vanished without a recorded exit (e.g., a long-running
     * facet that hung and was GC'd). Such entries are dropped after a
     * longer grace window so leaked buffers don't accumulate forever.
     */
    dropOlderThan(ageMs?: number, isOrphan?: (pid: number) => boolean): number;
    /**
     * W9: drain dirty buffers into the persist adapter. Synchronous from
     * the store's POV (the adapter's calls are sync; the production
     * adapter wraps them in `ctx.storage.transactionSync`). Idempotent —
     * second call without new data is a no-op.
     *
     * Order of operations (matters for crash resilience):
     *   1. dropPid for every pid in the drop queue (frees SQL space first).
     *   2. pruneBeforeSeq for any pid with a queued cutoff.
     *   3. persistChunks for every pid with dirty chunks.
     *   4. persistExit for every pid with a dirty exit.
     *
     * Step 3 BEFORE step 4 is the key crash-resilience invariant: if the
     * actor terminates between (3) and (4), the chunks are persisted but
     * the exit is not — on next hydrate we'll see the chunks but no exit
     * row, which is the same state we'd be in if the process were still
     * running. The reverse (exit row but missing chunks) would surface a
     * misleading "exited cleanly with no output" frame.
     */
    flush(): void;
    /**
     * W9: counters for /api/_diag/memory hibernation telemetry. Cumulative
     * since this isolate-gen started. Reset only when the store itself is
     * reconstructed (i.e., on hibernation/wake).
     */
    hibStats(): {
        rehydratedPids: number;
        rehydratedChunks: number;
        rehydratedBytes: number;
        flushedChunks: number;
        flushedBytes: number;
        flushCount: number;
        lastFlushAt: number;
        lastFlushDurationMs: number;
        pendingDirtyPids: number;
        pendingDropPids: number;
    };
    /** Introspection. Used by `ps -l` for LOGS column. */
    snapshot(pid: number): {
        bytes: number;
        chunks: number;
        exit: ProcessExitInfo | null;
    } | null;
    private _getOrCreate;
    /**
     * W9: pull rows from the persist adapter for this pid into the in-memory
     * ring. Idempotent — guarded by `state.hydrated`. Bounded by
     * `perPidBytes`: if SQL has more bytes than the in-memory cap, we keep
     * only the newest rows that fit and queue a `pruneBeforeSeq` for the
     * next flush so SQL converges.
     *
     * Called from `_getOrCreate` (covers append/tail/all/has/snapshot/
     * subscribe — any first-touch read or write). Failures are swallowed:
     * a broken adapter must not break the in-memory ring's correctness.
     */
    private _hydrate;
    /**
     * Evict one PID to make room when the map hits its global cap.
     *
     * Policy (in order of preference):
     *   1. Oldest EXITED pid with zero subscribers — safe: nobody's
     *      reading, process is done, ring buffer is cold.
     *   2. Oldest pid by `lastActivity` with zero subscribers — any
     *      state; covers the case where every exited pid has a live
     *      subscriber (log tab open).
     *   3. Give up — an actively-subscribed long-running pid flood is
     *      degenerate; we'd rather let the map briefly exceed the cap
     *      than silently drop a subscribed stream.
     *
     * Map iteration order in JS is insertion order, so "oldest" here
     * means "earliest inserted." That's a reasonable proxy for
     * `lastActivity` for PIDs that haven't been written to recently.
     * We still check `lastActivity` explicitly so active-write pids
     * beat cold ones even if they were inserted earlier.
     */
    private _evictOnePid;
    /** Diagnostics snapshot for /api/stats rollup. */
    get stats(): {
        totalPids: number;
        maxPids: number;
        runningPids: number;
        exitedPids: number;
        totalBufferBytes: number;
        subscribers: number;
        droppedPids: number;
    };
    private _evict;
    private _fanout;
}
//# sourceMappingURL=process-logs.d.ts.map