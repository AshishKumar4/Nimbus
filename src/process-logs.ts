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
 *   - Persistence across DO hibernation. The store is in-memory; if the
 *     DO restarts, logs are gone. Acceptable because hibernation is rare
 *     during active sessions and logs are mostly useful in-session.
 *   - Routing raw Uint8Array. RPC boundary already strings the data
 *     (SupervisorRPC.stdout(data: string)), so we store strings.
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

  constructor(opts: ProcessLogStoreOptions = {}) {
    this.perPidBytes = opts.perPidBytes ?? 64 * 1024;
    this.maxChunkBytes = opts.maxChunkBytes ?? 4 * 1024;
    this.retainAfterExitMs = opts.retainAfterExitMs ?? 10 * 60 * 1000;
    this.maxPids = opts.maxPids ?? 500;
  }

  /** Is there ANY state for this pid (including exit-only)? */
  has(pid: number): boolean {
    return this.pids.has(pid);
  }

  /** Current buffered bytes for this PID (post-eviction). */
  size(pid: number): number {
    return this.pids.get(pid)?.bytes ?? 0;
  }

  getExit(pid: number): ProcessExitInfo | null {
    return this.pids.get(pid)?.exit ?? null;
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
      state.chunks.push(chunk);
      state.bytes += chunk.data.length;
      state.lastActivity = chunk.ts;
      this._evict(state);
      this._fanout(state, chunk);
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
      state.chunks.push(chunk);
      state.bytes += chunk.data.length;
      state.lastActivity = chunk.ts;
      this._evict(state);
      this._fanout(state, chunk);
      offset += slice.length;
    }
  }

  /** Return the last N chunks (by line count) in chronological order. */
  tail(pid: number, opts: { lines?: number; bytes?: number } = {}): LogChunk[] {
    const state = this.pids.get(pid);
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
    const state = this.pids.get(pid);
    return state ? [...state.chunks] : [];
  }

  /** Record exit. Idempotent: second call is ignored (preserves first). */
  markExit(pid: number, code: number, reason?: string): void {
    const state = this._getOrCreate(pid);
    if (state.exit) return;
    const info: ProcessExitInfo = { code, at: Date.now(), reason };
    state.exit = info;
    state.lastActivity = info.at;
    for (const cb of state.exitSubscribers) {
      try { cb(info); } catch { /* swallow subscriber errors */ }
    }
  }

  /**
   * Subscribe to new chunks for this pid. Returns unsubscribe fn.
   * Subscriber is called synchronously from within `append`.
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
        dropped++;
      }
    }
    return dropped;
  }

  /** Introspection. Used by `ps -l` for LOGS column. */
  snapshot(pid: number): { bytes: number; chunks: number; exit: ProcessExitInfo | null } | null {
    const s = this.pids.get(pid);
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
      };
      this.pids.set(pid, s);
    }
    return s;
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

  private _evict(state: PidState): void {
    while (state.bytes > this.perPidBytes && state.chunks.length > 0) {
      const dropped = state.chunks.shift()!;
      state.bytes -= dropped.data.length;
    }
  }

  private _fanout(state: PidState, chunk: LogChunk): void {
    if (state.subscribers.size === 0) return;
    for (const cb of state.subscribers) {
      try { cb(chunk); } catch { /* swallow subscriber errors */ }
    }
  }
}
