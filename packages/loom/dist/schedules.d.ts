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
import type { TimerAlarmInfo } from '@nimbus-sh/fabric/timers.js';
/** Synchronous DO SQLite, as the store uses it. */
export interface ScheduleSqlExec {
    exec(query: string, ...bindings: Array<string | number | null>): Iterable<unknown>;
}
export interface ScheduleContext {
    storage: {
        sql: ScheduleSqlExec;
    };
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
export declare const SCHEDULE_RETRY_DEFAULTS: Required<ScheduleRetryPolicy>;
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
} & ({
    type: 'scheduled';
    time: number;
} | {
    type: 'delayed';
    time: number;
    delayInSeconds: number;
} | {
    type: 'cron';
    time: number;
    cron: string;
} | {
    type: 'interval';
    time: number;
    intervalSeconds: number;
});
export type ScheduleType = Schedule['type'];
export interface ScheduleCriteria {
    id?: string;
    type?: ScheduleType;
    /** Bounds on the next fire time. */
    timeRange?: {
        start?: Date;
        end?: Date;
    };
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
export declare class ScheduleStore {
    private readonly ctx;
    private schemaReady;
    constructor(ctx: ScheduleContext);
    private ensureSchema;
    /**
     * Persist one schedule. `when` selects the type: a non-negative number is
     * a delay in seconds, a Date is an absolute fire time, a string is a cron
     * expression (validated here; an invalid one throws now, not at the
     * alarm).
     */
    create<T>(when: number | Date | string, callback: string, payload?: T, options?: ScheduleOptions & {
        now?: number;
    }): Schedule<T>;
    /** Persist a fixed-interval schedule. First fire is one interval from now. */
    every<T>(intervalSeconds: number, callback: string, payload?: T, options?: ScheduleOptions & {
        now?: number;
    }): Schedule<T>;
    private insert;
    byId<T = unknown>(id: string): Schedule<T> | undefined;
    list<T = unknown>(criteria?: ScheduleCriteria): Array<Schedule<T>>;
    /** True when the id existed and is now gone. */
    cancel(id: string): boolean;
    /** The earliest pending deadline, or null when nothing is scheduled. */
    nextDue(): number | null;
    /**
     * Fire every due schedule against the target, in deadline order.
     *
     * Each callback is `target[callback](payload, invocation)`, awaited in
     * place. The due set is snapshotted up front, and every row is re-read
     * before it fires — a callback that cancels or reschedules a SIBLING due
     * row must win over the snapshot, or `cancel()`'s true would be a lie.
     * Success advances the row: a cron recomputes from its expression, an
     * interval re-arms `intervalSeconds` from this dispatch, a one-shot row
     * is deleted. Failure spends one attempt of the row's retry policy: with
     * budget left, the row's deadline moves to the backed-off time and the
     * row survives; with the budget spent — or on a failure no retry can fix
     * (the callback is not a method on the target; the stored payload does
     * not parse) — `onError` hears about it and the row advances as if it
     * had run.
     */
    dispatchDue(target: object, now: number, alarmInfo?: TimerAlarmInfo, onError?: (schedule: Schedule, error: unknown) => void): Promise<ScheduleDispatchResult>;
    /** Move a row past a completed (or abandoned) fire. */
    private advance;
}
//# sourceMappingURL=schedules.d.ts.map