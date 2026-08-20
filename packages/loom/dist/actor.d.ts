/**
 * actor.ts — `Actor`, a partyserver `Server` standing on the fabric floor.
 *
 * partyserver contributes the surface: routing, connections, tags,
 * broadcast, hibernation opt-in, `onStart`/`onConnect`/`onMessage`/
 * `onRequest`/`onClose`/`onError`. Fabric contributes the machinery a
 * Durable Object needs under that surface, and this class wires it so an
 * embedder never does:
 *
 *   - ONE ALARM, MANY REASONS. `alarm()` dispatches fabric's reason map;
 *     the embedder registers reasons ({@link Actor.registerTimerReason})
 *     and arms them (`this.timers`). The schedule API and every outbox are
 *     reasons in the same map. The platform's `alarmInfo` rides through to
 *     every handler.
 *   - NOTHING ASYNC ON THE INIT GATE. The constructor is synchronous.
 *     partyserver's own gate runs exactly `onStart` (its `#ensureInitialized`,
 *     a `blockConcurrencyWhile`); a gate callback still pending at ~30 s is
 *     cancelled and RESETS the object, so `onStart` must stay short.
 *     Everything the floor defers — generation adoption, cold-start
 *     reconciliation, fenced-work recovery — runs on the first turn the
 *     actor already owns: every entry point passes {@link Actor.#enterTurn}
 *     after initialization and before embedder code. One platform
 *     exception: partyserver's fetch asks `getConnectionTags` during the
 *     accept, before the connect turn's floor entry — keep that hook pure.
 *   - HIBERNATION CONFIGURED, NOT JUST ENABLED. With
 *     `static options = { hibernate: true }`, the constructor also applies
 *     fabric's ws-hibernation config: ping/pong auto-response (a matched
 *     frame no longer wakes the actor) and the 5 s hibernatable-event
 *     timeout. The result is on `this.hibernation` for diagnostics.
 *   - COMPOSITION STATED ONCE. `static options = { fabric: {...} }` feeds
 *     `composeFabric`, and the constructor captures `ctx.exports` where the
 *     platform hands it over. Both are first-write-wins.
 *
 * Protocol frames (state sync, callable RPC — see protocol.ts) are consumed
 * before `onMessage`; everything else reaches the embedder untouched. For
 * that interception to hold, hooks must be prototype METHODS — an instance
 * field (`onMessage = () => {}`) assigns over the wiring.
 *
 * The state and schedule tables live in the actor's own SQLite, so an Actor
 * class must be SQLite-backed (`new_sqlite_classes` — the default for new
 * classes).
 */
import { Server, type Connection } from 'partyserver';
import { type TimerAlarmInfo, type TimerHandlerResult, type Timers } from '@nimbus-sh/fabric/timers.js';
import { type Outbox, type OutboxPolicy } from '@nimbus-sh/fabric/outbox.js';
import { type Journal } from '@nimbus-sh/fabric/journal.js';
import { type FacetPool } from '@nimbus-sh/fabric/facet-pool.js';
import { type Derived, type DerivedAsync } from '@nimbus-sh/fabric/derived.js';
import { FencedWork, type FencedWorkHost, type FencedWorkRecord } from '@nimbus-sh/fabric/fenced-work.js';
import { type FabricComposition } from '@nimbus-sh/fabric/composition.js';
import { type WsHibernationConfigResult } from '@nimbus-sh/fabric/ws-hibernation-config.js';
import { ProcessFabric, type ProcessHost } from '@nimbus-sh/fabric/process-fabric.js';
import type { z } from 'zod/v4';
import { type Schedule, type ScheduleCriteria, type ScheduleOptions } from './schedules.js';
/** The timer reason the schedule store dispatches under. */
export declare const SCHEDULE_TIMER_REASON = "loom:schedule";
/** Static configuration, inherited through the class chain like partyserver's. */
export interface ActorOptions {
    /** partyserver's hibernation opt-in; loom also applies fabric's ws config. */
    hibernate?: boolean;
    /**
     * The embedder's fabric composition, stated once on the class. Fed to
     * `composeFabric` (first-write-wins) before anything can need it.
     */
    fabric?: FabricComposition;
}
/**
 * Typed, validated per-connection state over partyserver's `Connection`
 * surface — fabric's `connections` machinery with the accept half left to
 * partyserver, which owns the accept.
 */
export interface TypedConnections<T> {
    /** The open connection holding a tag, or null. */
    get(tag: string): Connection | null;
    /** Every open connection (optionally: holding a tag). */
    list(tag?: string): Connection[];
    /** A connection's tags — its id first, then `getConnectionTags`' additions. */
    tags(connection: Connection): string[];
    /**
     * The attachment, validated. Null when it does not parse — an attachment
     * written by a previous deploy is untrusted input.
     */
    read(connection: Connection): T | null;
    /** Replace the attachment, validated on the way in. */
    write(connection: Connection, attachment: T): void;
}
export declare class Actor<Env extends Cloudflare.Env = Cloudflare.Env, State = unknown, Props extends Record<string, unknown> = Record<string, unknown>> extends Server<Env, Props> {
    #private;
    static options: ActorOptions;
    /** fabric `TimerHost`: the chain serializing this instance's timer map. */
    _timerChain?: Promise<unknown>;
    /**
     * Fabric's ws-hibernation configuration result, when
     * `options.hibernate` asked for it; null otherwise. Reports honestly
     * which half the runtime supported.
     */
    readonly hibernation: WsHibernationConfigResult | null;
    /**
     * The state broadcast to (and settable by) connections. Assign it in the
     * subclass; leave it unassigned for a stateless actor.
     */
    initialState: State;
    constructor(ctx: DurableObjectState, env: Env);
    /**
     * The native-RPC entry point (`getActorByName` calls it before any
     * embedder RPC method) pays the turn entry too, after partyserver has
     * initialized.
     */
    setName(name: string, props?: Props): Promise<void>;
    /**
     * partyserver initialization, then the floor, then `onAlarm`, then
     * fabric's dispatcher runs every due reason with the platform's
     * `alarmInfo`. Handlers re-arm through their return value; the map's
     * earliest remaining deadline re-arms the platform alarm.
     * `__unsafe_ensureInitialized` is partyserver's documented escape hatch
     * for frameworks; calling it here (instead of `super.alarm()`) is what
     * lets `onAlarm` run AFTER the floor, like every other embedder hook.
     */
    alarm(alarmInfo?: TimerAlarmInfo): Promise<void>;
    /** partyserver logs "implement onAlarm" per fire; an empty hook is the default here. */
    onAlarm(): void | Promise<void>;
    /**
     * Register the handler for one timer reason. Reasons are the alarm's
     * multiplexing key: register in the constructor, arm with
     * `this.timers.schedule(reason, whenMs)`, re-arm by returning
     * `{ rearmAt }` from the handler. One handler per reason, for the
     * instance's lifetime.
     */
    protected registerTimerReason(reason: string, handler: (now: number, info?: TimerAlarmInfo) => TimerHandlerResult | Promise<TimerHandlerResult>): void;
    /**
     * Schedule a method call: `when` is a delay in seconds, an absolute
     * `Date`, or a cron expression. The callback fires as
     * `this[callback](payload, invocation)`; the invocation carries the
     * schedule, the attempt number, and the platform's `alarmInfo`. Retries
     * are durable rows (see schedules.ts), governed by `options.retry`.
     */
    schedule<T = unknown>(when: number | Date | string, callback: keyof this & string, payload?: T, options?: ScheduleOptions): Promise<Schedule<T>>;
    /** Schedule a method call every `intervalSeconds`, first fire one interval from now. */
    scheduleEvery<T = unknown>(intervalSeconds: number, callback: keyof this & string, payload?: T, options?: ScheduleOptions): Promise<Schedule<T>>;
    getScheduleById<T = unknown>(id: string): Promise<Schedule<T> | undefined>;
    listSchedules<T = unknown>(criteria?: ScheduleCriteria): Promise<Array<Schedule<T>>>;
    /** True when the id existed and is now cancelled. */
    cancelSchedule(id: string): Promise<boolean>;
    /**
     * A schedule's retry budget is spent (or its callback is not a method).
     * The default names the failure; override to route it.
     */
    onScheduleError(schedule: Schedule, error: unknown): void;
    /**
     * The synced state. Loaded from SQLite on first read; `initialState`
     * before anything was ever set; undefined for a stateless actor.
     */
    get state(): State;
    /** Replace the state: validate, persist, broadcast, notify. */
    setState(state: State): void;
    /**
     * Synchronous veto over every state change, the embedder's own and a
     * connection's alike. Runs BEFORE anything persists; throw to refuse.
     * A refused connection update earns the client a
     * `cf_agent_state_error` frame.
     */
    validateStateChange(_next: State, _source: Connection | 'server'): void;
    /** The state changed and is already persisted and broadcast. */
    onStateChanged(_state: State, _source: Connection | 'server'): void | Promise<void>;
    /** This actor's reason map over its ONE platform alarm. */
    get timers(): Timers;
    /** This incarnation's generation. Zero until the first turn adopted it. */
    get generation(): number;
    /**
     * The named durable retry outbox, its drain registered as a timer reason
     * on first call. One instance per name; later calls return the first and
     * ignore their policy argument.
     *
     * Create outboxes in the CONSTRUCTOR. A queued row survives an instance
     * reset, but the dispatcher drops a fired reason no handler answers
     * (rollback forward-compat) — an outbox first created inside a request
     * path is not registered when the next incarnation's alarm fires, and
     * its queued rows sit until some later `queue()` happens to re-arm.
     */
    outbox<M>(name: string, policy: OutboxPolicy<M>): Outbox<M>;
    /** The named append-only event journal. One instance per name. */
    journal<P>(name: string): Journal<P>;
    /** Leased facets: disposal retires (storage wiped), `detach()` keeps it. */
    get facets(): FacetPool;
    /**
     * The process fabric over this actor's substrate. Declare the substrate
     * by overriding {@link processHost}; the fabric is built once, on first
     * use.
     */
    get processes(): ProcessFabric;
    /** The substrate {@link processes} runs on. Override to declare one. */
    protected processHost(): ProcessHost;
    /** A watermark memo: derive a cheap key, compare, rebuild only on change. */
    derived<T, C = void>(watermark: (context: C) => string | number, build: (context: C, key: string | number) => T): Derived<T, C>;
    /** The async memo; a watermark or build failure serves the last good value. */
    derivedAsync<T, C = void>(watermark: (context: C) => Promise<string | number>, build: (context: C, key: string | number) => Promise<T>): DerivedAsync<T, C>;
    /**
     * Typed, validated per-connection state over the WebSocket attachment,
     * hibernation-durable. partyserver owns the accept (tag connections via
     * `getConnectionTags`); this reads, writes, and addresses by tag. To
     * replace-on-reconnect, close the other holders of the identity tag in
     * `onConnect`.
     *
     * Hibernation-only: the state rides the hibernatable socket attachment,
     * and partyserver's non-hibernating connections neither wrap nor persist
     * it — so a non-hibernating actor is refused here, not corrupted later.
     */
    connections<T>(schema: z.ZodType<T>): TypedConnections<T>;
    /**
     * A fenced-work journal whose recovery is pumped on the first turn of
     * every incarnation — reconnects after a reset included. The host defines
     * what a launch is and how to re-drive it; call once, in the constructor.
     */
    protected fenceWork<R extends FencedWorkRecord>(host: FencedWorkHost<R>): FencedWork<R>;
    /**
     * Defer async reconciliation to the first turn of this incarnation —
     * never the init gate. Safe to call from the constructor; that is the
     * point.
     */
    protected deferToColdStart(task: () => Promise<unknown>): void;
}
//# sourceMappingURL=actor.d.ts.map