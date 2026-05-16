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

export interface ProcessExitInfo {
  code: number;
  /** When the exit was recorded (ms epoch). */
  at: number;
  /** Optional synthetic reason, used by external-exit path (timeout/abort). */
  reason?: string;
}

interface PidState {
  chunks: LogChunk[];
  /** Total bytes of `data` across all chunks (for ring eviction). */
  bytes: number;
  exit: ProcessExitInfo | null;
  /** Last touch (append, markExit) — used by dropOlderThan. */
  lastActivity: number;
  subscribers: Set<(c: LogChunk) => void>;
  exitSubscribers: Set<(e: ProcessExitInfo) => void>;
  /**
   * W9: monotonic per-pid sequence. Each `append` increments by 1
   * regardless of in-memory eviction; persisted alongside the chunk so
   * after-hibernate hydrate restores chunks in append order. Resets only
   * when the pid is fully dropped (dropPid / dropOlderThan / maxPids
   * eviction) — same lifetime as the SQL row set for this pid.
   */
  nextSeq: number;
  /**
   * W9: chunks not yet flushed to the persist adapter. Indexed by `seq`,
   * not by chunks-array offset, because in-memory eviction may shift
   * the chunks array out from under a pending flush. The flush path
   * iterates this list and posts to `persistChunks`.
   */
  dirtyChunks: { seq: number; chunk: LogChunk }[];
  /** W9: set when `markExit` ran but exit not yet flushed. */
  dirtyExit: boolean;
  /** W9: hydrated from the adapter at least once this isolate-gen. */
  hydrated: boolean;
  /** W9: highest seq present in SQL after the last flush. Used by
   *  pruneBeforeSeq to tell the adapter how far to keep rows. */
  flushedHighSeq: number;
}

/**
 * W9 PersistAdapter — see audit/sections/W9-plan.md §3.1. Implementations
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
  load(pid: number): { chunks: LogChunk[]; exit: ProcessExitInfo | null } | null;
  persistChunks(pid: number, rows: { seq: number; chunk: LogChunk }[]): void;
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

/** Detect binary content — rough but good enough for "this is not text". */
function looksBinary(s: string): boolean {
  if (s.length === 0) return false;
  // Null byte is the strongest signal.
  if (s.indexOf('\x00') !== -1) return true;
  // Otherwise sample up to 512 chars for non-printable non-whitespace.
  const sample = s.length > 512 ? s.substring(0, 512) : s;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    // Allow tab (9), LF (10), CR (13), ESC (27 — ANSI), and >= 32.
    if (c === 9 || c === 10 || c === 13 || c === 27 || c >= 32) continue;
    bad++;
  }
  return bad / sample.length > 0.1;
}

/**
 * Strip ANSI CSI escape sequences (colors, cursor, etc.) for --plain mode.
 * Keeps the rest of the text intact.
 */
export function stripAnsi(s: string): string {
  // Match CSI and OSC sequences.
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[=>()]/g, '');
}

export class ProcessLogStore {
  private readonly perPidBytes: number;
  private readonly maxChunkBytes: number;
  private readonly retainAfterExitMs: number;
  private readonly maxPids: number;
  private pids = new Map<number, PidState>();
  /** Cumulative count of PIDs evicted by the cap (STABILITY-AUDIT.md M-S5). */
  private _droppedPids = 0;

  // ── W9 persistence state ────────────────────────────────────────────
  /** Optional persistence backend. When null, store is in-memory only. */
  private _persist: PersistAdapter | null = null;
  /**
   * Pids whose rows are dropped on next flush (eviction queue). Keyed by
   * pid; value is `true` for "pid was evicted from memory; ask adapter to
   * delete all rows". Distinct from dirtyChunks because the adapter call
   * is dropPid, not persistChunks.
   */
  private _dropQueue = new Set<number>();
  /**
   * Pids that need pruneBeforeSeq on next flush — keyed by pid → cutoff
   * seq (delete all rows with seq < cutoff). Set whenever an in-memory
   * `_evict` shifts the chunks array; the cutoff is the lowest seq that
   * remains in memory.
   */
  private _pruneQueue = new Map<number, number>();
  /** Cumulative flushed-bytes counter (telemetry). */
  private _flushedChunks = 0;
  private _flushedBytes = 0;
  private _flushCount = 0;
  private _lastFlushAt = 0;
  private _lastFlushDurationMs = 0;
  /** Cumulative hydrate counters. */
  private _hydratedPids = 0;
  private _hydratedChunks = 0;
  private _hydratedBytes = 0;

  constructor(opts: ProcessLogStoreOptions = {}) {
    this.perPidBytes = opts.perPidBytes ?? 64 * 1024;
    this.maxChunkBytes = opts.maxChunkBytes ?? 4 * 1024;
    this.retainAfterExitMs = opts.retainAfterExitMs ?? 10 * 60 * 1000;
    this.maxPids = opts.maxPids ?? 500;
  }

  /**
   * W9: install a persistence adapter. Call once at NimbusSession init,
   * after the SQL tables exist. Pre-existing in-memory state is NOT
   * pushed to the adapter — only state mutated AFTER setPersist is
   * subject to flush. This is fine in practice: NimbusSession sets the
   * adapter in the constructor, before any append happens.
   */
  setPersist(adapter: PersistAdapter): void {
    this._persist = adapter;
  }

  /** Is there ANY state for this pid (including exit-only)? */
  has(pid: number): boolean {
    if (this.pids.has(pid)) return true;
    return this._maybeHydrateRead(pid) !== null;
  }

  /** Current buffered bytes for this PID (post-eviction). */
  size(pid: number): number {
    return this.pids.get(pid)?.bytes ?? 0;
  }

  getExit(pid: number): ProcessExitInfo | null {
    const s = this._maybeHydrateRead(pid);
    return s?.exit ?? null;
  }

  /**
   * W9: read-side helper. If we have an adapter and the pid has any rows
   * in SQL, lazy-create the in-memory state (which triggers hydrate).
   * Returns the state or null. Performs at most one adapter `load` per
   * pid per isolate-gen by routing through `_getOrCreate` → `_hydrate`,
   * which is guarded by `state.hydrated`.
   */
  private _maybeHydrateRead(pid: number): PidState | null {
    let s = this.pids.get(pid) ?? null;
    if (s) return s;
    if (!this._persist) return null;
    // _getOrCreate triggers _hydrate which calls load(). To avoid an
    // extra load() just to decide whether to materialise, we always
    // create and then check whether hydrate populated anything. If it
    // didn't, drop the empty state to keep the maxPids cap clean.
    s = this._getOrCreate(pid);
    if (s.chunks.length === 0 && !s.exit) {
      // Nothing came back from SQL — drop the empty state so we don't
      // pin a cap slot for a pid that never existed.
      this.pids.delete(pid);
      return null;
    }
    return s;
  }

  /**
   * Append a chunk. `data` may be huge or binary; we split / tag as
   * needed. Notifies any `subscribe()`rs for this pid.
   */
  append(pid: number, stream: LogStream, data: string): void {
    if (!data) return;
    const state = this._getOrCreate(pid);

    // Binary detection on the raw incoming chunk (before splitting).
    if (looksBinary(data)) {
      const placeholder = `[${data.length} bytes of binary output]\n`;
      const chunk: LogChunk = {
        ts: Date.now(),
        stream,
        data: placeholder,
        binary: true,
      };
      this._appendChunk(pid, state, chunk);
      return;
    }

    // Split oversize writes into multiple chunks.
    let offset = 0;
    while (offset < data.length) {
      const slice = data.substring(offset, offset + this.maxChunkBytes);
      const chunk: LogChunk = {
        ts: Date.now(),
        stream,
        data: slice,
      };
      this._appendChunk(pid, state, chunk);
      offset += slice.length;
    }
  }

  /** W9: shared insert path — assigns a seq, marks dirty, evicts, fans out. */
  private _appendChunk(pid: number, state: PidState, chunk: LogChunk): void {
    const seq = state.nextSeq++;
    state.chunks.push(chunk);
    state.bytes += chunk.data.length;
    state.lastActivity = chunk.ts;
    if (this._persist) {
      state.dirtyChunks.push({ seq, chunk });
    }
    this._evict(state, pid);
    this._fanout(state, chunk);
  }

  /** Return the last N chunks (by line count) in chronological order. */
  tail(pid: number, opts: { lines?: number; bytes?: number } = {}): LogChunk[] {
    const state = this._maybeHydrateRead(pid);
    if (!state) return [];
    if (!opts.lines && !opts.bytes) return [...state.chunks];

    // Walk from newest → oldest, accumulate until we hit the limit.
    const out: LogChunk[] = [];
    let lines = 0;
    let bytes = 0;
    for (let i = state.chunks.length - 1; i >= 0; i--) {
      const c = state.chunks[i];
      out.unshift(c);
      bytes += c.data.length;
      if (opts.lines) {
        // Count \n in chunk + 1 if chunk doesn't end with \n but has content.
        for (let j = 0; j < c.data.length; j++) if (c.data.charCodeAt(j) === 10) lines++;
        if (lines >= opts.lines) break;
      }
      if (opts.bytes && bytes >= opts.bytes) break;
    }
    return out;
  }

  /** All chunks for a pid, chronological. */
  all(pid: number): LogChunk[] {
    const state = this._maybeHydrateRead(pid);
    return state ? [...state.chunks] : [];
  }

  /** Record exit. Idempotent: second call is ignored (preserves first). */
  markExit(pid: number, code: number, reason?: string): void {
    const state = this._getOrCreate(pid);
    if (state.exit) return;
    const info: ProcessExitInfo = { code, at: Date.now(), reason };
    state.exit = info;
    state.lastActivity = info.at;
    if (this._persist) state.dirtyExit = true;
    for (const cb of state.exitSubscribers) {
      try { cb(info); } catch { /* swallow subscriber errors */ }
    }
  }

  /**
   * Subscribe to new chunks for this pid. Returns unsubscribe fn.
   * Subscriber is called synchronously from within `append`.
   * W9: also hydrates from SQL on first touch so a post-hibernate
   * subscriber sees pre-hibernate context in the next backlog frame.
   */
  subscribe(pid: number, cb: (c: LogChunk) => void): () => void {
    const state = this._getOrCreate(pid);
    state.subscribers.add(cb);
    return () => { state.subscribers.delete(cb); };
  }

  /** Subscribe to the exit event. Fires once. */
  subscribeExit(pid: number, cb: (e: ProcessExitInfo) => void): () => void {
    const state = this._getOrCreate(pid);
    state.exitSubscribers.add(cb);
    return () => { state.exitSubscribers.delete(cb); };
  }

  /**
   * Drop all state for any PID whose process exited more than `ageMs`
   * ago. Returns the number of PIDs purged.
   *
   * Optional `isOrphan(pid)` callback identifies PIDs whose owning
   * process vanished without a recorded exit (e.g., a long-running
   * facet that hung and was GC'd). Such entries are dropped after a
   * longer grace window so leaked buffers don't accumulate forever.
   */
  dropOlderThan(
    ageMs: number = this.retainAfterExitMs,
    isOrphan?: (pid: number) => boolean,
  ): number {
    const now = Date.now();
    const cutoff = now - ageMs;
    const orphanCutoff = now - ageMs * 3; // 30 min default for orphans
    let dropped = 0;
    for (const [pid, state] of this.pids) {
      if (state.subscribers.size !== 0) continue;
      if (state.exit && state.exit.at < cutoff) {
        this.pids.delete(pid);
        if (this._persist) this._dropQueue.add(pid);
        dropped++;
        continue;
      }
      // Orphan sweep: no exit recorded, no live subscribers, last
      // activity older than the orphan cutoff, AND the process table
      // confirms the process is gone.
      if (
        !state.exit &&
        state.lastActivity < orphanCutoff &&
        isOrphan?.(pid)
      ) {
        this.pids.delete(pid);
        if (this._persist) this._dropQueue.add(pid);
        dropped++;
      }
    }
    return dropped;
  }

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
  flush(): void {
    if (!this._persist) {
      // No adapter — clear any dirty markers so the booleans stay sane.
      this._dropQueue.clear();
      this._pruneQueue.clear();
      for (const state of this.pids.values()) {
        state.dirtyChunks.length = 0;
        state.dirtyExit = false;
      }
      return;
    }
    const t0 = Date.now();
    const adapter = this._persist;

    // Step 1: drop evicted pids first — the SQL DELETE for them might
    // free space the chunk INSERTs need under tight memory.
    for (const pid of this._dropQueue) {
      try { adapter.dropPid(pid); } catch { /* fail-soft */ }
    }
    this._dropQueue.clear();

    // Step 2: prune over-capped chunks for still-resident pids.
    for (const [pid, cutoff] of this._pruneQueue) {
      try { adapter.pruneBeforeSeq(pid, cutoff); } catch { /* fail-soft */ }
    }
    this._pruneQueue.clear();

    let chunkBytesFlushed = 0;
    let chunksFlushedCount = 0;

    // Step 3: persist new chunks (per-pid batch).
    for (const [pid, state] of this.pids) {
      if (state.dirtyChunks.length === 0) continue;
      const rows = state.dirtyChunks;
      try {
        adapter.persistChunks(pid, rows);
        for (const r of rows) {
          chunkBytesFlushed += r.chunk.data.length;
          if (r.seq > state.flushedHighSeq) state.flushedHighSeq = r.seq;
        }
        chunksFlushedCount += rows.length;
      } catch { /* fail-soft — leave dirty for next flush */
        continue;
      }
      state.dirtyChunks = [];
    }

    // Step 4: persist exits AFTER chunks (crash resilience).
    for (const [pid, state] of this.pids) {
      if (!state.dirtyExit || !state.exit) continue;
      try {
        adapter.persistExit(pid, state.exit);
        state.dirtyExit = false;
      } catch { /* fail-soft */ }
    }

    this._flushCount++;
    this._lastFlushAt = t0;
    this._lastFlushDurationMs = Date.now() - t0;
    this._flushedChunks += chunksFlushedCount;
    this._flushedBytes += chunkBytesFlushed;
  }

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
  } {
    let pendingDirtyPids = 0;
    for (const state of this.pids.values()) {
      if (state.dirtyChunks.length > 0 || state.dirtyExit) pendingDirtyPids++;
    }
    return {
      rehydratedPids: this._hydratedPids,
      rehydratedChunks: this._hydratedChunks,
      rehydratedBytes: this._hydratedBytes,
      flushedChunks: this._flushedChunks,
      flushedBytes: this._flushedBytes,
      flushCount: this._flushCount,
      lastFlushAt: this._lastFlushAt,
      lastFlushDurationMs: this._lastFlushDurationMs,
      pendingDirtyPids,
      pendingDropPids: this._dropQueue.size,
    };
  }

  /** Introspection. Used by `ps -l` for LOGS column. */
  snapshot(pid: number): { bytes: number; chunks: number; exit: ProcessExitInfo | null } | null {
    const s = this._maybeHydrateRead(pid);
    if (!s) return null;
    return { bytes: s.bytes, chunks: s.chunks.length, exit: s.exit };
  }

  // ── Private ──────────────────────────────────────────────────────────

  private _getOrCreate(pid: number): PidState {
    let s = this.pids.get(pid);
    if (!s) {
      // Enforce the global cap BEFORE inserting (STABILITY-AUDIT.md
      // M-S5). A 1000-pid fork-bomb would otherwise pin ~50 MB of
      // buffers for the full 10-min retention window, crowding the
      // 128 MB DO isolate cap alongside npm install / git clone peaks.
      if (this.pids.size >= this.maxPids) {
        this._evictOnePid();
      }
      s = {
        chunks: [],
        bytes: 0,
        exit: null,
        lastActivity: Date.now(),
        subscribers: new Set(),
        exitSubscribers: new Set(),
        nextSeq: 0,
        dirtyChunks: [],
        dirtyExit: false,
        hydrated: false,
        flushedHighSeq: -1,
      };
      this.pids.set(pid, s);
      // W9: lazy hydrate the freshly-created state from persistent
      // storage. If we have an adapter and rows exist for this pid
      // (e.g., DO was hibernated and now woke), pull them into the
      // ring before any caller can observe an empty ring.
      this._hydrate(pid, s);
    }
    return s;
  }

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
  private _hydrate(pid: number, state: PidState): void {
    if (state.hydrated) return;
    state.hydrated = true;
    if (!this._persist) return;
    let loaded: { chunks: LogChunk[]; exit: ProcessExitInfo | null } | null;
    try {
      loaded = this._persist.load(pid);
    } catch {
      return;
    }
    if (!loaded) return;

    // Restore exit first so pid-existence checks are correct even if
    // we drop chunks below.
    if (loaded.exit) {
      state.exit = loaded.exit;
      state.lastActivity = loaded.exit.at;
    }

    if (loaded.chunks.length === 0) return;

    // Trim to perPidBytes from the newest end. Each persisted chunk has
    // a `seq` (we appended it during `persistChunks`); fall back to
    // index-based seq when a chunk lacks it (defensive).
    const newest: LogChunk[] = [];
    let bytes = 0;
    let oldestKeptSeq = Number.POSITIVE_INFINITY;
    let highestSeq = -1;
    for (let i = loaded.chunks.length - 1; i >= 0; i--) {
      const c = loaded.chunks[i];
      const seq = (c as any).seq ?? i;
      if (seq > highestSeq) highestSeq = seq;
      const size = c.data.length;
      if (bytes + size > this.perPidBytes && newest.length > 0) {
        // Anything below this seq is overshoot — schedule a prune.
        this._pruneQueue.set(pid, oldestKeptSeq);
        break;
      }
      newest.unshift({ ts: c.ts, stream: c.stream, data: c.data, binary: c.binary });
      bytes += size;
      oldestKeptSeq = seq;
    }
    state.chunks = newest;
    state.bytes = bytes;
    state.nextSeq = highestSeq + 1;
    state.flushedHighSeq = highestSeq;
    if (loaded.chunks[loaded.chunks.length - 1]) {
      state.lastActivity = Math.max(state.lastActivity, loaded.chunks[loaded.chunks.length - 1].ts);
    }
    this._hydratedPids++;
    this._hydratedChunks += newest.length;
    this._hydratedBytes += bytes;
  }

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
  private _evictOnePid(): void {
    // Tier 1: oldest exited + no subscribers.
    let bestPid: number | null = null;
    let bestActivity = Infinity;
    for (const [pid, state] of this.pids) {
      if (state.exit && state.subscribers.size === 0 && state.exitSubscribers.size === 0) {
        if (state.lastActivity < bestActivity) {
          bestPid = pid;
          bestActivity = state.lastActivity;
        }
      }
    }
    if (bestPid !== null) {
      this.pids.delete(bestPid);
      this._droppedPids++;
      if (this._persist) this._dropQueue.add(bestPid);
      return;
    }

    // Tier 2: oldest by lastActivity with zero subscribers.
    bestPid = null;
    bestActivity = Infinity;
    for (const [pid, state] of this.pids) {
      if (state.subscribers.size === 0 && state.exitSubscribers.size === 0) {
        if (state.lastActivity < bestActivity) {
          bestPid = pid;
          bestActivity = state.lastActivity;
        }
      }
    }
    if (bestPid !== null) {
      this.pids.delete(bestPid);
      this._droppedPids++;
      if (this._persist) this._dropQueue.add(bestPid);
      return;
    }

    // Tier 3: every pid has a subscriber. Don't silently drop a
    // subscribed stream — let the cap be briefly exceeded.
  }

  /** Diagnostics snapshot for /api/stats rollup. */
  get stats() {
    let running = 0;
    let exited = 0;
    let totalBytes = 0;
    let subscribers = 0;
    for (const state of this.pids.values()) {
      if (state.exit) exited++;
      else running++;
      totalBytes += state.bytes;
      subscribers += state.subscribers.size + state.exitSubscribers.size;
    }
    return {
      totalPids: this.pids.size,
      maxPids: this.maxPids,
      runningPids: running,
      exitedPids: exited,
      totalBufferBytes: totalBytes,
      subscribers,
      droppedPids: this._droppedPids,
    };
  }

  private _evict(state: PidState, pid?: number): void {
    let droppedAny = false;
    while (state.bytes > this.perPidBytes && state.chunks.length > 0) {
      const dropped = state.chunks.shift()!;
      state.bytes -= dropped.data.length;
      droppedAny = true;
    }
    if (!droppedAny || pid === undefined || !this._persist) return;

    // W9: cutoff = lowest in-memory seq. Any persisted seq below this is
    // dead weight in SQL (and dead weight in the dirty queue if not yet
    // flushed). Drop them from BOTH:
    //
    //   1. Queue a `pruneBeforeSeq(pid, cutoff)` so already-flushed rows
    //      below cutoff are deleted from SQL on next flush.
    //   2. Drop entries from `dirtyChunks` whose seq is below cutoff —
    //      they were evicted from memory before they ever made it to SQL,
    //      no point persisting now.
    //
    // Without (2), a chatty process whose in-memory ring runs hot would
    // still write every byte to SQL on the first flush, defeating the
    // per-pid byte cap.
    const cutoff = state.nextSeq - state.chunks.length;
    const existing = this._pruneQueue.get(pid) ?? -1;
    if (cutoff > existing) this._pruneQueue.set(pid, cutoff);
    if (state.dirtyChunks.length > 0) {
      state.dirtyChunks = state.dirtyChunks.filter((d) => d.seq >= cutoff);
    }
  }

  private _fanout(state: PidState, chunk: LogChunk): void {
    if (state.subscribers.size === 0) return;
    for (const cb of state.subscribers) {
      try { cb(chunk); } catch { /* swallow subscriber errors */ }
    }
  }
}
