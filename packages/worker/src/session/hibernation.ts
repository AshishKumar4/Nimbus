/**
 * session/hibernation.ts — W9 hibernation persistence + alarm dispatch.
 *
 * Workerd hibernates Durable Objects between requests to free memory.
 * On wake, the new isolate must rebuild its in-memory state from
 * SQL — but it also needs to know "is this the same lifecycle as
 * before, or did workerd recycle me?" That distinction matters for
 * recovery (warmJoin vs cold init) and is captured by isolateGen,
 * a counter persisted across hibernations.
 *
 * Surfaces:
 *   - wireHibernationOnConstruct(ctx) — runs configureWsHibernation in
 *     the DO ctor; graceful-degrades on throw.
 *   - wireProcessLogPersist(host, ctx) — installs the SQL-backed
 *     PersistAdapter on host.processLogs; patches append/markExit to
 *     schedule debounced flushes.
 *   - ensureHibSchema(host, ctx) — idempotent CREATE TABLE for
 *     w9_proc_logs + w9_proc_exits.
 *   - scheduleHibFlush(host, ctx) — debounced setTimeout + best-effort
 *     setAlarm for post-hibernation drain.
 *   - dispatchAlarm(host) — alarm() handler body.
 *   - maybeBumpIsolateGen(host, ctx) — increment + persist isolate-gen
 *     counter once per fresh isolate.
 *   - flushOnClose(host) — synchronous flush on ws close.
 *
 * **`ctx` taken as a separate arg from `host`** because the parent
 * `CloudflareDurableObject` class declares `ctx` as `protected`, which
 * is nominal-typed in TS and cannot appear on a public interface
 * (DEFECT-D1 found at S3; documented in session-refactor-build-progress.md).
 *
 * Per plan §VI.7 F.2 invariant: `_w9PersistWired` must be reset
 * between `processLogs` replacement and re-wire on
 * `/api/_test/hib/simulate`. The class-side handler is responsible for
 * setting `host._w9PersistWired = false` BEFORE calling
 * wireProcessLogPersist again.
 */

import type { LogChunk, PersistAdapter, ProcessExitInfo, ProcessLogStore } from '../runtime/process-logs.js';
import { configureWsHibernation, type WsHibernationConfigResult } from './ws-hibernation-config.js';
import { W9_ISOLATE_GEN_KEY, W9_FLUSH_DEBOUNCE_MS, W1_NEXT_ALARM_REASONS_KEY } from './keys.js';

export type { WsHibernationConfigResult };

/**
 * Minimal host shape. `_w9*` fields drop `private` on the class so
 * this interface can declare them. `processLogs` is a public class
 * field (always was) so no relaxation needed there.
 *
 * `ctx` is NOT in this interface — passed as a separate arg.
 */
export interface HibHost {
  processLogs: ProcessLogStore;
  _w9IsolateGen: number;
  _w9IsolateGenPersisted: boolean;
  _w9SchemaInit: boolean;
  _w9PersistWired: boolean;
  _w9FlushTimer: any;
}

/**
 * Run at DO ctor time. Returns the result for the class to assign to
 * `_w9WsConfig`. Failures are non-fatal — older workerd builds may lack
 * the API; the result lands in /api/_diag/memory.hib for verification.
 */
export function wireHibernationOnConstruct(ctx: any): WsHibernationConfigResult {
  try {
    return configureWsHibernation(ctx);
  } catch (e: any) {
    console.warn('[nimbus/W9] configureWsHibernation threw:', e?.message);
    return {
      autoResponseConfigured: false,
      timeoutSetMs: null,
      autoResponseError: e?.message,
      timeoutError: e?.message,
    };
  }
}

/**
 * W9: install the SQL-backed PersistAdapter on host.processLogs.
 *
 * NOTE: any future alarm-driven subsystem MUST coordinate via a single
 * `alarm()` dispatcher (e.g., a `nextAlarmReason` storage key checked
 * inside the dispatcher). Today W9 is the only consumer; the dispatcher
 * lives in `dispatchAlarm()` below, invoked from the class's `alarm()`
 * handler.
 *
 * Idempotent: gated by host._w9PersistWired. Caller MUST reset that
 * flag to false before re-invoking after a host.processLogs replacement
 * (per /api/_test/hib/simulate flow; plan §VI.7 F.2 invariant).
 */
export function wireProcessLogPersist(host: HibHost, ctx: any): void {
  if (host._w9PersistWired) return;
  host._w9PersistWired = true;
  const adapter: PersistAdapter = {
    load(pid: number) {
      try {
        ensureHibSchema(host, ctx);
        const sql: any = ctx.storage.sql;
        const chunkRows = [...sql.exec(
          'SELECT pid, seq, ts, stream, data, binary FROM w9_proc_logs WHERE pid = ? ORDER BY seq ASC',
          pid,
        )] as any[];
        const exitRows = [...sql.exec(
          'SELECT code, at, reason FROM w9_proc_exits WHERE pid = ?',
          pid,
        )] as any[];
        const chunks: LogChunk[] = chunkRows.map((r) => ({
          ts: Number(r.ts),
          stream: r.stream === 'stderr' ? 'stderr' : 'stdout',
          data: String(r.data),
          binary: !!r.binary,
          ...(r.seq !== undefined ? { seq: Number(r.seq) } : {}),
        } as any));
        const exit: ProcessExitInfo | null = exitRows.length > 0
          ? {
              code: Number(exitRows[0].code),
              at: Number(exitRows[0].at),
              reason: exitRows[0].reason ?? undefined,
            }
          : null;
        return { chunks, exit };
      } catch {
        return null;
      }
    },
    persistChunks(pid, rows) {
      if (rows.length === 0) return;
      try {
        ensureHibSchema(host, ctx);
        const sql: any = ctx.storage.sql;
        // Use a single transactionSync wrapping the per-row INSERTs so
        // a partial write either fully lands or fully rolls back. Real
        // multi-row VALUES (?,?,?), (?,?,?), … is faster but requires
        // dynamic-arity SQL building — clarity wins here; flushes
        // happen at most once per debounce window so the volume is low.
        ctx.storage.transactionSync(() => {
          for (const r of rows) {
            const c = r.chunk;
            sql.exec(
              'INSERT OR REPLACE INTO w9_proc_logs (pid, seq, ts, stream, data, binary) VALUES (?, ?, ?, ?, ?, ?)',
              pid, r.seq, c.ts, c.stream, c.data, c.binary ? 1 : 0,
            );
          }
        });
      } catch (e: any) {
        console.warn('[nimbus/W9] persistChunks failed:', e?.message);
      }
    },
    persistExit(pid, info) {
      try {
        ensureHibSchema(host, ctx);
        const sql: any = ctx.storage.sql;
        sql.exec(
          'INSERT OR REPLACE INTO w9_proc_exits (pid, code, at, reason) VALUES (?, ?, ?, ?)',
          pid, info.code, info.at, info.reason ?? null,
        );
      } catch (e: any) {
        console.warn('[nimbus/W9] persistExit failed:', e?.message);
      }
    },
    dropPid(pid) {
      try {
        ensureHibSchema(host, ctx);
        const sql: any = ctx.storage.sql;
        ctx.storage.transactionSync(() => {
          sql.exec('DELETE FROM w9_proc_logs WHERE pid = ?', pid);
          sql.exec('DELETE FROM w9_proc_exits WHERE pid = ?', pid);
        });
      } catch (e: any) {
        console.warn('[nimbus/W9] dropPid failed:', e?.message);
      }
    },
    pruneBeforeSeq(pid, seq) {
      try {
        ensureHibSchema(host, ctx);
        const sql: any = ctx.storage.sql;
        sql.exec('DELETE FROM w9_proc_logs WHERE pid = ? AND seq < ?', pid, seq);
      } catch (e: any) {
        console.warn('[nimbus/W9] pruneBeforeSeq failed:', e?.message);
      }
    },
  };
  host.processLogs.setPersist(adapter);

  // Wrap append/markExit on the store to schedule a debounced flush.
  // We patch via method override rather than monkey-patching because
  // the store doesn't (and shouldn't) know about timers — flush
  // scheduling is the host's responsibility.
  const origAppend = host.processLogs.append.bind(host.processLogs);
  const origMarkExit = host.processLogs.markExit.bind(host.processLogs);
  host.processLogs.append = (pid, stream, data) => {
    origAppend(pid, stream, data);
    scheduleHibFlush(host, ctx);
  };
  host.processLogs.markExit = (pid, code, reason) => {
    origMarkExit(pid, code, reason);
    // Exit-on-process-end is a strong "flush soon" signal — if the
    // process crashed we want the dump persisted before the actor
    // can hibernate. Schedule but don't bypass debounce, so a fast
    // exit-after-spawn doesn't double-fire.
    scheduleHibFlush(host, ctx);
  };
}

/** W9: idempotent SQL schema bootstrap. */
export function ensureHibSchema(host: HibHost, ctx: any): void {
  if (host._w9SchemaInit) return;
  host._w9SchemaInit = true;
  try {
    const sql: any = ctx.storage.sql;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS w9_proc_logs (' +
        'pid INTEGER NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, ' +
        'stream TEXT NOT NULL, data TEXT NOT NULL, binary INTEGER NOT NULL, ' +
        'PRIMARY KEY (pid, seq))',
    );
    sql.exec('CREATE INDEX IF NOT EXISTS w9_proc_logs_ts ON w9_proc_logs(ts)');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS w9_proc_exits (' +
        'pid INTEGER PRIMARY KEY, code INTEGER NOT NULL, at INTEGER NOT NULL, ' +
        'reason TEXT)',
    );
  } catch (e: any) {
    console.warn('[nimbus/W9] schema init failed:', e?.message);
    host._w9SchemaInit = false; // retry next time
  }
}

/**
 * W1: canonical alarm-reason strings. Stored in the
 * `W1_NEXT_ALARM_REASONS_KEY` map. Forward-compat: dispatcher silently
 * drops unknown reasons so a rollback from a future deploy that added
 * new reasons doesn't leave the alarm stuck.
 */
export type AlarmReason = 'w9-flush' | 'log-janitor';

/**
 * W1: schedule (or re-schedule) an alarm reason. Coordinated via a
 * single map in DO storage so multiple subsystems (W9 debounced flush +
 * W1 log-janitor sweep) don't clobber each other's `setAlarm()` calls.
 *
 * Semantics:
 *   - Reads the existing reasons map.
 *   - Sets `map[reason] = whenMs` IF `whenMs` is sooner than the
 *     currently-pending deadline for that reason (or no entry exists).
 *     Later-than-pending requests are silently ignored — the existing
 *     alarm will fire and re-arm anyway.
 *   - Writes the map back and calls `ctx.storage.setAlarm(min(deadlines))`.
 *
 * Cost: 1 storage read + 1 storage write + 1 setAlarm per call. setAlarm
 * itself is billed as 1 row written per DO pricing. At W1's 60s
 * cadence, this is ~$0.05/mo/session at scale — dwarfed by the
 * hibernation duration savings.
 *
 * Fail-soft: any throw is swallowed with a warn. On older runtimes /
 * wrangler-dev where setAlarm is unavailable, this is a no-op (the
 * subsystem's in-isolate setTimeout fallback continues to work).
 */
export async function scheduleAlarm(
  ctx: any,
  reason: AlarmReason,
  whenMs: number,
): Promise<void> {
  try {
    const setAlarmFn = (ctx?.storage as any)?.setAlarm;
    if (typeof setAlarmFn !== 'function') return;
    const existing = (await ctx.storage.get(W1_NEXT_ALARM_REASONS_KEY)) as
      | Record<string, number>
      | undefined;
    const map: Record<string, number> = { ...(existing || {}) };
    // Earliest-deadline-first: only update if new request is sooner or
    // this reason has no pending entry.
    if (!(reason in map) || whenMs < map[reason]) {
      map[reason] = whenMs;
      await ctx.storage.put(W1_NEXT_ALARM_REASONS_KEY, map);
    }
    const earliest = Math.min(...Object.values(map));
    setAlarmFn.call(ctx.storage, earliest);
  } catch (e: any) {
    console.warn('[nimbus/W1] scheduleAlarm threw:', e?.message);
  }
}

/**
 * W9: ensure the alarm is set for the next flush window. Cheap to
 * call repeatedly — we only schedule the in-isolate flush timer if
 * it isn't already set. The persistent alarm goes through scheduleAlarm
 * so it coordinates with W1's log-janitor sweep.
 */
export function scheduleHibFlush(host: HibHost, ctx: any): void {
  if (host._w9FlushTimer) return;
  // Local timer for fast in-isolate flush. SHORT-LIVED (250 ms); the
  // callback nulls itself so this timer does not persistently prevent
  // hibernation — once it fires, the DO is timer-free again.
  // Per CF docs, transient setTimeout during an active request is the
  // expected pattern; what blocks hibernation is a RECURRING timer.
  host._w9FlushTimer = setTimeout(() => {
    host._w9FlushTimer = null;
    try {
      host.processLogs.flush();
    } catch (e: any) {
      console.warn('[nimbus/W9] flush threw:', e?.message);
    }
  }, W9_FLUSH_DEBOUNCE_MS);
  // Persistent alarm: fires post-hibernation if the in-isolate timer
  // didn't get a chance to run (DO evicted under memory pressure
  // before the 250ms debounce expired). Coordinated via scheduleAlarm
  // so W1's log-janitor doesn't clobber it (or vice-versa).
  // Fire-and-forget — scheduleAlarm is fail-soft.
  void scheduleAlarm(ctx, 'w9-flush', Date.now() + W9_FLUSH_DEBOUNCE_MS * 4);
}

/**
 * W1: multi-reason alarm dispatcher. Called from the DO's `alarm()`
 * handler.
 *
 * For each pending reason whose deadline has passed, run its handler.
 * Reasons supported today:
 *   - `'w9-flush'` → processLogs.flush()
 *   - `'log-janitor'` → processLogs.dropOlderThan(orphanCheck); re-arm
 *     for next 60s cycle.
 *
 * `janitorOrphanCheck` is the orphan-pid predicate provided by the
 * caller (typically `(pid) => !host.processTable.get(pid)`). Decoupled
 * so HibHost doesn't need to import ProcessTable.
 *
 * After running fireable reasons, re-arms `ctx.storage.setAlarm` at the
 * earliest remaining deadline. If no reasons remain, deletes the map
 * key and does NOT call setAlarm — the DO becomes hibernation-eligible
 * after the 10s idle window.
 *
 * Forward/back-compat: unknown reasons silently dropped.
 */
export async function dispatchAlarm(
  host: HibHost,
  ctx: any,
  janitorOrphanCheck?: (pid: number) => boolean,
): Promise<void> {
  try {
    const now = Date.now();
    const existing = (await ctx?.storage?.get?.(W1_NEXT_ALARM_REASONS_KEY)) as
      | Record<string, number>
      | undefined;
    // Legacy path: pre-W1 deploys had no map. dispatchAlarm was called
    // with no map and unconditionally ran processLogs.flush(). Preserve
    // that on a missing map (one-time post-deploy, then the map is
    // populated by the next scheduleHibFlush / scheduleAlarm call).
    if (!existing || Object.keys(existing).length === 0) {
      try { host.processLogs.flush(); } catch (e: any) {
        console.warn('[nimbus/W9] legacy flush threw:', e?.message);
      }
      return;
    }
    const map: Record<string, number> = { ...existing };
    // Snapshot fireable reasons BEFORE running any of them, so a
    // handler that schedules itself for the next cycle doesn't get
    // immediately re-fired in the same dispatch.
    const fired: AlarmReason[] = [];
    for (const [reason, when] of Object.entries(map)) {
      if (when <= now) fired.push(reason as AlarmReason);
    }
    for (const reason of fired) {
      delete map[reason];
      try {
        if (reason === 'w9-flush') {
          host.processLogs.flush();
        } else if (reason === 'log-janitor') {
          host.processLogs.dropOlderThan(undefined, janitorOrphanCheck);
          // Self-renew: schedule next sweep 60s out.
          map['log-janitor'] = now + 60_000;
        }
        // Unknown reasons silently dropped (forward-compat).
      } catch (e: any) {
        console.warn(`[nimbus/W1] dispatch ${reason} threw:`, e?.message);
      }
    }
    // Re-arm or clear.
    const setAlarmFn = (ctx?.storage as any)?.setAlarm;
    if (Object.keys(map).length > 0) {
      await ctx.storage.put(W1_NEXT_ALARM_REASONS_KEY, map);
      const earliest = Math.min(...Object.values(map));
      if (typeof setAlarmFn === 'function') {
        setAlarmFn.call(ctx.storage, earliest);
      }
    } else {
      try { await ctx.storage.delete(W1_NEXT_ALARM_REASONS_KEY); } catch {}
      // No remaining reasons → no setAlarm call → DO becomes
      // hibernation-eligible after the 10s idle window.
    }
  } catch (e: any) {
    console.warn('[nimbus/W1] dispatchAlarm threw:', e?.message);
  }
}

/** W9: increment + persist isolate-gen counter once per fresh isolate. */
export async function maybeBumpIsolateGen(host: HibHost, ctx: any): Promise<void> {
  if (host._w9IsolateGenPersisted) return;
  host._w9IsolateGenPersisted = true;
  try {
    const prev = (await ctx.storage.get(W9_ISOLATE_GEN_KEY)) as number | undefined;
    const next = (typeof prev === 'number' ? prev : 0) + 1;
    host._w9IsolateGen = next;
    await ctx.storage.put(W9_ISOLATE_GEN_KEY, next);
  } catch (e: any) {
    console.warn('[nimbus/W9] isolate-gen bump failed:', e?.message);
  }
}

/**
 * W9: synchronous flush of the process-log ring on session close.
 * Wraps `processLogs.flush()` in a try/catch so a flush failure
 * doesn't take down the close handler. Cheap when there's nothing
 * dirty (idempotent inside the store).
 */
export function flushOnClose(host: HibHost): void {
  try {
    host.processLogs.flush();
  } catch (e: any) {
    console.warn('[nimbus/W9] flush-on-close failed:', e?.message);
  }
}
