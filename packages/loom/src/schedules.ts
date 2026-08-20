/**
 * schedules.ts — named-method schedules persisted in the actor's own SQLite,
 * dispatched from ONE reason in fabric's timer map.
 *
 * The API shape follows the Agents SDK (`agents` 0.20.1, verified in its
 * shipped dist): `when` is a delay in seconds, a Date, or a cron string;
 * recurrence is either `cron` (recomputed per fire) or `interval` (fixed
 * seconds); rows carry the callback METHOD NAME and a JSON payload, and
 * dispatch resolves the method on the target at fire time. Where the two
 * differ, fabric's mechanism is the reason:
 *
 *   - RETRIES ARE DURABLE. The Agents SDK retries a failed callback
 *     in-process, sleeping inside the alarm turn (dist `retries.js`, "Full
 *     Jitter"); an instance reset mid-backoff loses the remaining attempts.
 *     Here a failed attempt writes the backed-off deadline into the row and
 *     the alarm re-fires on it — the attempt budget survives the reset.
 *     Backoff is `min(maxDelayMs, baseDelayMs * 2**(attempt-1))`, no jitter:
 *     the contended resource jitter exists for is a shared endpoint, and one
 *     actor's own alarm is not shared.
 *   - `alarmInfo` REACHES THE CALLBACK. The platform reports alarm retries
 *     (`isRetry`, `retryCount`); the Agents SDK drops the report (zero
 *     references in its dist). Fabric's dispatcher forwards it, and every
 *     schedule callback receives it in its invocation argument.
 *   - NO INTERVAL MUTEX. The Agents SDK guards overlapping interval runs
 *     with a `running` flag and a hung-run timeout. Fabric's timer chain
 *     already serializes dispatches on the instance, so overlap cannot
 *     happen and the flag would be dead state.
 *
 * Times are epoch MILLISECONDS everywhere, matching fabric's timer map (the
 * Agents SDK stores unix seconds).
 *
 * This module is deliberately partyserver-free: it owns rows and dispatch,
 * and the Actor owns the timer-reason wiring around it.
 */

import { parseCronExpression } from 'cron-schedule';
import { z } from 'zod/v4';
import type { TimerAlarmInfo } from '@nimbus-sh/fabric/timers.js';

/** Synchronous DO SQLite, as the store uses it. */
export interface ScheduleSqlExec {
  exec(query: string, ...bindings: Array<string | number | null>): Iterable<unknown>;
}

export interface ScheduleContext {
  storage: { sql: ScheduleSqlExec };
}

/**
 * Attempts and backoff for one schedule's callback. Defaults match the
 * Agents SDK's (`maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 3000`,
 * dist `index.js:303-308`).
 */
export interface ScheduleRetryPolicy {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export const SCHEDULE_RETRY_DEFAULTS: Required<ScheduleRetryPolicy> = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 3000,
};

export interface ScheduleOptions {
  retry?: ScheduleRetryPolicy;
}

/** One schedule, as `getScheduleById`/`listSchedules` return it. */
export type Schedule<T = unknown> = {
  id: string;
  /** The method name dispatch resolves on the actor at fire time. */
  callback: string;
  payload: T;
  retry?: ScheduleRetryPolicy;
} & (
  | { type: 'scheduled'; time: number }
  | { type: 'delayed'; time: number; delayInSeconds: number }
  | { type: 'cron'; time: number; cron: string }
  | { type: 'interval'; time: number; intervalSeconds: number }
);

export type ScheduleType = Schedule['type'];

export interface ScheduleCriteria {
  id?: string;
  type?: ScheduleType;
  /** Bounds on the next fire time. */
  timeRange?: { start?: Date; end?: Date };
}

/** The second argument every schedule callback receives. */
export interface ScheduleInvocation<T = unknown> {
  schedule: Schedule<T>;
  /** 1 on the first try; grows with the durable retry rows. */
  attempt: number;
  /** The platform's alarm-invocation report, when the platform gave one. */
  alarmInfo?: TimerAlarmInfo;
}

export interface ScheduleDispatchResult {
  ran: number;
  /** The earliest remaining deadline, for the timer handler's re-arm. */
  rearmAt: number | null;
}

const RowSchema = z.object({
  id: z.string(),
  callback: z.string(),
  payload: z.string().nullable(),
  type: z.enum(['scheduled', 'delayed', 'cron', 'interval']),
  time: z.number(),
  delay_s: z.number().nullable(),
  cron: z.string().nullable(),
  interval_s: z.number().nullable(),
  attempt: z.number(),
  retry: z.string().nullable(),
});

type Row = z.infer<typeof RowSchema>;

export class ScheduleStore {
  private schemaReady = false;

  constructor(private readonly ctx: ScheduleContext) {}

  private ensureSchema(): void {
    if (this.schemaReady) return;
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS loom_schedules (
      id         TEXT    PRIMARY KEY,
      callback   TEXT    NOT NULL,
      payload    TEXT,
      type       TEXT    NOT NULL CHECK (type IN ('scheduled', 'delayed', 'cron', 'interval')),
      time       INTEGER NOT NULL,
      delay_s    INTEGER,
      cron       TEXT,
      interval_s INTEGER,
      attempt    INTEGER NOT NULL DEFAULT 0,
      retry      TEXT,
      created_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_loom_schedules_time ON loom_schedules (time)`);
    this.schemaReady = true;
  }

  /**
   * Persist one schedule. `when` selects the type: a non-negative number is
   * a delay in seconds, a Date is an absolute fire time, a string is a cron
   * expression (validated here; an invalid one throws now, not at the
   * alarm).
   */
  create<T>(when: number | Date | string, callback: string, payload?: T, options: ScheduleOptions & { now?: number } = {}): Schedule<T> {
    if (typeof callback !== 'string' || callback === '') {
      throw new Error('loom: a schedule callback must be a method name');
    }
    const now = options.now ?? Date.now();
    let partial: Pick<Row, 'type' | 'time' | 'delay_s' | 'cron'>;
    if (when instanceof Date) {
      partial = { type: 'scheduled', time: when.getTime(), delay_s: null, cron: null };
    } else if (typeof when === 'number') {
      if (!Number.isFinite(when) || when < 0) {
        throw new Error(`loom: a schedule delay must be a non-negative number of seconds, got ${when}`);
      }
      partial = { type: 'delayed', time: now + when * 1000, delay_s: when, cron: null };
    } else if (typeof when === 'string') {
      const next = parseCronExpression(when).getNextDate(new Date(now)).getTime();
      partial = { type: 'cron', time: next, delay_s: null, cron: when };
    } else {
      throw new Error(`loom: invalid schedule time ${JSON.stringify(when)} for callback '${callback}'`);
    }
    return this.insert(callback, payload, { ...partial, interval_s: null }, options.retry, now);
  }

  /** Persist a fixed-interval schedule. First fire is one interval from now. */
  every<T>(intervalSeconds: number, callback: string, payload?: T, options: ScheduleOptions & { now?: number } = {}): Schedule<T> {
    if (typeof callback !== 'string' || callback === '') {
      throw new Error('loom: a schedule callback must be a method name');
    }
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error(`loom: a schedule interval must be a positive number of seconds, got ${intervalSeconds}`);
    }
    const now = options.now ?? Date.now();
    return this.insert(
      callback,
      payload,
      { type: 'interval', time: now + intervalSeconds * 1000, delay_s: null, cron: null, interval_s: intervalSeconds },
      options.retry,
      now,
    );
  }

  private insert<T>(
    callback: string,
    payload: T | undefined,
    partial: Pick<Row, 'type' | 'time' | 'delay_s' | 'cron' | 'interval_s'>,
    retry: ScheduleRetryPolicy | undefined,
    now: number,
  ): Schedule<T> {
    this.ensureSchema();
    const id = crypto.randomUUID();
    const payloadJson = payload === undefined ? null : JSON.stringify(payload);
    this.ctx.storage.sql.exec(
      `INSERT INTO loom_schedules (id, callback, payload, type, time, delay_s, cron, interval_s, attempt, retry, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      id, callback, payloadJson, partial.type, partial.time, partial.delay_s, partial.cron, partial.interval_s,
      retry === undefined ? null : JSON.stringify(retry), now,
    );
    return toSchedule<T>({ id, callback, payload: payloadJson, attempt: 0, retry: retry === undefined ? null : JSON.stringify(retry), ...partial });
  }

  byId<T = unknown>(id: string): Schedule<T> | undefined {
    this.ensureSchema();
    const rows = [...this.ctx.storage.sql.exec(`SELECT * FROM loom_schedules WHERE id = ?`, id)];
    return rows.length > 0 ? toSchedule<T>(RowSchema.parse(rows[0])) : undefined;
  }

  list<T = unknown>(criteria: ScheduleCriteria = {}): Array<Schedule<T>> {
    this.ensureSchema();
    const where: string[] = [];
    const bindings: Array<string | number> = [];
    if (criteria.id !== undefined) { where.push('id = ?'); bindings.push(criteria.id); }
    if (criteria.type !== undefined) { where.push('type = ?'); bindings.push(criteria.type); }
    if (criteria.timeRange?.start !== undefined) { where.push('time >= ?'); bindings.push(criteria.timeRange.start.getTime()); }
    if (criteria.timeRange?.end !== undefined) { where.push('time <= ?'); bindings.push(criteria.timeRange.end.getTime()); }
    const rows = [...this.ctx.storage.sql.exec(
      `SELECT * FROM loom_schedules${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY time, id`,
      ...bindings,
    )];
    return rows.map((row) => toSchedule<T>(RowSchema.parse(row)));
  }

  /** True when the id existed and is now gone. */
  cancel(id: string): boolean {
    this.ensureSchema();
    const existing = [...this.ctx.storage.sql.exec(`SELECT 1 AS present FROM loom_schedules WHERE id = ?`, id)];
    if (existing.length === 0) return false;
    this.ctx.storage.sql.exec(`DELETE FROM loom_schedules WHERE id = ?`, id);
    return true;
  }

  /** The earliest pending deadline, or null when nothing is scheduled. */
  nextDue(): number | null {
    this.ensureSchema();
    const rows = [...this.ctx.storage.sql.exec(`SELECT MIN(time) AS next FROM loom_schedules`)] as Array<{ next: number | null }>;
    return rows[0]?.next ?? null;
  }

  /**
   * Fire every due schedule against the target, in deadline order.
   *
   * Each callback is `target[callback](payload, invocation)`, awaited in
   * place. Success advances the row: a cron recomputes from its expression,
   * an interval re-arms `intervalSeconds` from this dispatch, a one-shot
   * row is deleted. Failure spends one attempt of the row's retry policy:
   * with budget left, the row's deadline moves to the backed-off time and
   * the row survives; with the budget spent — or when the callback is not a
   * method on the target, which no retry can fix — `onError` hears about it
   * and the row advances as if it had run.
   */
  async dispatchDue(
    target: object,
    now: number,
    alarmInfo?: TimerAlarmInfo,
    onError?: (schedule: Schedule, error: unknown) => void,
  ): Promise<ScheduleDispatchResult> {
    this.ensureSchema();
    const due = [...this.ctx.storage.sql.exec(
      `SELECT * FROM loom_schedules WHERE time <= ? ORDER BY time, id`, now,
    )].map((row) => RowSchema.parse(row));
    for (const row of due) {
      const schedule = toSchedule(row);
      const attempt = row.attempt + 1;
      const method = (target as Record<string, unknown>)[row.callback];
      const callable = typeof method === 'function';
      try {
        if (!callable) throw new Error(`loom: schedule callback 'this.${row.callback}' is not a method on this actor`);
        const payload: unknown = row.payload === null ? undefined : JSON.parse(row.payload);
        const invocation: ScheduleInvocation = { schedule, attempt, alarmInfo };
        await (method as (payload: unknown, invocation: ScheduleInvocation) => unknown).call(target, payload, invocation);
        this.advance(row, now);
      } catch (error) {
        const policy = { ...SCHEDULE_RETRY_DEFAULTS, ...(schedule.retry ?? {}) };
        if (callable && attempt < policy.maxAttempts) {
          const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
          this.ctx.storage.sql.exec(
            `UPDATE loom_schedules SET attempt = ?, time = ? WHERE id = ?`, attempt, now + delay, row.id,
          );
        } else {
          onError?.(schedule, error);
          this.advance(row, now);
        }
      }
    }
    return { ran: due.length, rearmAt: this.nextDue() };
  }

  /** Move a row past a completed (or abandoned) fire. */
  private advance(row: Row, now: number): void {
    const sql = this.ctx.storage.sql;
    if (row.type === 'cron' && row.cron !== null) {
      const next = parseCronExpression(row.cron).getNextDate(new Date(now)).getTime();
      sql.exec(`UPDATE loom_schedules SET time = ?, attempt = 0 WHERE id = ?`, next, row.id);
    } else if (row.type === 'interval' && row.interval_s !== null) {
      sql.exec(`UPDATE loom_schedules SET time = ?, attempt = 0 WHERE id = ?`, now + row.interval_s * 1000, row.id);
    } else {
      sql.exec(`DELETE FROM loom_schedules WHERE id = ?`, row.id);
    }
  }
}

function toSchedule<T>(row: Row): Schedule<T> {
  const payload = (row.payload === null ? undefined : JSON.parse(row.payload)) as T;
  const retry = row.retry === null ? undefined : (JSON.parse(row.retry) as ScheduleRetryPolicy);
  const base = { id: row.id, callback: row.callback, payload, ...(retry !== undefined ? { retry } : {}) };
  switch (row.type) {
    case 'scheduled':
      return { ...base, type: 'scheduled', time: row.time };
    case 'delayed':
      return { ...base, type: 'delayed', time: row.time, delayInSeconds: row.delay_s ?? 0 };
    case 'cron':
      return { ...base, type: 'cron', time: row.time, cron: row.cron ?? '' };
    case 'interval':
      return { ...base, type: 'interval', time: row.time, intervalSeconds: row.interval_s ?? 0 };
  }
}
