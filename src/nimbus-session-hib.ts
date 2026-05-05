/**
 * nimbus-session-hib.ts — W9 hibernation persistence + alarm dispatch.
 *
 * Extracted from src/nimbus-session.ts per
 * audit/sections/SESSION-REFACTOR-PLAN.md §B.3.3 + S4.
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

import type { LogChunk, PersistAdapter, ProcessExitInfo, ProcessLogStore } from './process-logs.js';
import { configureWsHibernation, type WsHibernationConfigResult } from './ws-hibernation-config.js';
import { W9_ISOLATE_GEN_KEY, W9_FLUSH_DEBOUNCE_MS } from './nimbus-session-keys.js';

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
 * W9: ensure the alarm is set for the next flush window. Cheap to
 * call repeatedly — we only set the alarm if it isn't already set.
 * `setAlarm` writes to storage, so we additionally bracket with a
 * timer-based fallback so tests + hot-path appends don't block.
 */
export function scheduleHibFlush(host: HibHost, ctx: any): void {
  if (host._w9FlushTimer) return;
  // Local timer for fast in-isolate flush; alarm ensures the post-
  // hibernation case also drains.
  host._w9FlushTimer = setTimeout(() => {
    host._w9FlushTimer = null;
    try {
      host.processLogs.flush();
    } catch (e: any) {
      console.warn('[nimbus/W9] flush threw:', e?.message);
    }
  }, W9_FLUSH_DEBOUNCE_MS);
  // Best-effort alarm (storage). On older runtimes / wrangler-dev where
  // setAlarm is unavailable this is a no-op.
  try {
    const fn = (ctx.storage as any).setAlarm;
    if (typeof fn === 'function') {
      fn.call(ctx.storage, Date.now() + W9_FLUSH_DEBOUNCE_MS * 4);
    }
  } catch { /* fail-soft */ }
}

/**
 * W9: alarm handler. Today only flush; if more subsystems need alarms,
 * route through a single `nextAlarmReason` storage key checked here.
 */
export async function dispatchAlarm(host: HibHost): Promise<void> {
  try {
    host.processLogs.flush();
  } catch (e: any) {
    console.warn('[nimbus/W9] alarm flush threw:', e?.message);
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
