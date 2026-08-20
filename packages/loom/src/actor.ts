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

import { Server, type Connection, type ConnectionContext, type WSMessage } from 'partyserver';
import {
  adoptGeneration,
  generation as fabricGeneration,
  onColdStart as fabricOnColdStart,
  runColdStart,
  type GenerationContext,
} from '@nimbus-sh/fabric/generation.js';
import {
  timers as fabricTimers,
  type TimerAlarmInfo,
  type TimerContext,
  type TimerHandlerResult,
  type TimerHandlers,
  type Timers,
} from '@nimbus-sh/fabric/timers.js';
import { outbox as fabricOutbox, type Outbox, type OutboxContext, type OutboxPolicy } from '@nimbus-sh/fabric/outbox.js';
import { journal as fabricJournal, type Journal, type JournalContext } from '@nimbus-sh/fabric/journal.js';
import { facetPool, type FacetPool, type FacetPoolContext } from '@nimbus-sh/fabric/facet-pool.js';
import {
  derived as fabricDerived,
  derivedAsync as fabricDerivedAsync,
  type Derived,
  type DerivedAsync,
} from '@nimbus-sh/fabric/derived.js';
import {
  connections as fabricConnections,
  type ConnectionSocket,
  type ConnectionsContext,
} from '@nimbus-sh/fabric/connections.js';
import {
  FencedWork,
  type FencedWorkHost,
  type FencedWorkRecord,
  type FencedWorkStorage,
} from '@nimbus-sh/fabric/fenced-work.js';
import {
  adoptCtxExports,
  composeFabric,
  type CtxExports,
  type FabricComposition,
} from '@nimbus-sh/fabric/composition.js';
import {
  configureWsHibernation,
  type WsHibernationConfigResult,
} from '@nimbus-sh/fabric/ws-hibernation-config.js';
import { ProcessFabric, type ProcessHost } from '@nimbus-sh/fabric/process-fabric.js';
import type { z } from 'zod/v4';
import {
  ScheduleStore,
  type Schedule,
  type ScheduleContext,
  type ScheduleCriteria,
  type ScheduleOptions,
} from './schedules.js';
import { dispatchRpc } from './rpc.js';
import { isRpcRequestFrame, isStateFrame, STATE_ERROR_FRAME_TYPE, STATE_FRAME_TYPE } from './protocol.js';

/** The timer reason the schedule store dispatches under. */
export const SCHEDULE_TIMER_REASON = 'loom:schedule';

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

function resolveOption<K extends keyof ActorOptions>(cls: unknown, key: K): ActorOptions[K] {
  for (
    let current = cls as { options?: ActorOptions } | null;
    current;
    current = Object.getPrototypeOf(current) as { options?: ActorOptions } | null
  ) {
    const value = current.options?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

export class Actor<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>,
> extends Server<Env, Props> {
  declare static options: ActorOptions;

  /** fabric `TimerHost`: the chain serializing this instance's timer map. */
  _timerChain?: Promise<unknown>;

  /**
   * Fabric's ws-hibernation configuration result, when
   * `options.hibernate` asked for it; null otherwise. Reports honestly
   * which half the runtime supported.
   */
  readonly hibernation: WsHibernationConfigResult | null = null;

  /**
   * The state broadcast to (and settable by) connections. Assign it in the
   * subclass; leave it unassigned for a stateless actor.
   */
  declare initialState: State;

  readonly #schedules: ScheduleStore;
  readonly #timerHandlers: TimerHandlers = {};
  readonly #outboxes = new Map<string, Outbox<never>>();
  readonly #journals = new Map<string, Journal<never>>();
  #processes: ProcessFabric | null = null;
  #facets: FacetPool | null = null;
  readonly #hibernate: boolean;
  #state: State | undefined;
  #stateLoaded = false;
  #stateSchemaReady = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const cls = (Object.getPrototypeOf(this) as { constructor: unknown }).constructor;
    const fabric = resolveOption(cls, 'fabric');
    if (fabric) composeFabric(fabric);
    const ctxExports = (ctx as { exports?: CtxExports }).exports;
    if (ctxExports) adoptCtxExports(ctxExports);
    this.#hibernate = resolveOption(cls, 'hibernate') === true;
    if (this.#hibernate) {
      this.hibernation = configureWsHibernation(ctx);
    }
    this.#schedules = new ScheduleStore(ctx as unknown as ScheduleContext);
    this.registerTimerReason(SCHEDULE_TIMER_REASON, (now, info) => this.#dispatchSchedules(now, info));
    this.#wrapHooks();
  }

  // ── The floor, per turn ────────────────────────────────────────────────

  /**
   * The deferred floor work of one incarnation, paid by the first turn that
   * owns it: adopt the persisted generation counter (once per instance),
   * then drain the cold-start queue — fenced-work recovery and whatever the
   * embedder deferred. Never the init gate: every call site here is a turn
   * that already passed initialization. A failed cold-start task is
   * reported and does not fail the turn that happened to drain it.
   */
  async #enterTurn(): Promise<void> {
    await adoptGeneration(this.ctx as unknown as GenerationContext);
    try {
      await runColdStart(this.ctx);
    } catch (e) {
      console.error(`[loom] ${this.#className()} cold-start task failed:`, e);
    }
  }

  /**
   * Instance-level wraps around the embedder's hooks, so every entry point
   * pays {@link #enterTurn} and protocol frames never reach `onMessage`.
   * Captured at construction: hooks defined as instance FIELDS would
   * assign over these wrappers — define hooks as methods.
   */
  #wrapHooks(): void {
    const onConnect = this.onConnect.bind(this);
    const onMessage = this.onMessage.bind(this);
    const onRequest = this.onRequest.bind(this);
    const onClose = this.onClose.bind(this);
    const onError = this.onError.bind(this);
    this.onConnect = async (connection: Connection, ctx: ConnectionContext): Promise<void> => {
      await this.#enterTurn();
      this.#sendStateOnConnect(connection);
      await onConnect(connection, ctx);
    };
    this.onMessage = async (connection: Connection, message: WSMessage): Promise<void> => {
      await this.#enterTurn();
      if (await this.#consumeProtocolFrame(connection, message)) return;
      await onMessage(connection, message);
    };
    this.onRequest = async (request: Request): Promise<Response> => {
      await this.#enterTurn();
      return onRequest(request);
    };
    this.onClose = async (connection: Connection, code: number, reason: string, wasClean: boolean): Promise<void> => {
      await this.#enterTurn();
      await onClose(connection, code, reason, wasClean);
    };
    this.onError = async (connection: Connection, error: unknown): Promise<void> => {
      await this.#enterTurn();
      await onError(connection, error);
    };
  }

  /**
   * The native-RPC entry point (`getActorByName` calls it before any
   * embedder RPC method) pays the turn entry too, after partyserver has
   * initialized.
   */
  override async setName(name: string, props?: Props): Promise<void> {
    await super.setName(name, props);
    await this.#enterTurn();
  }

  // ── One alarm, many reasons ────────────────────────────────────────────

  /**
   * partyserver initialization, then the floor, then `onAlarm`, then
   * fabric's dispatcher runs every due reason with the platform's
   * `alarmInfo`. Handlers re-arm through their return value; the map's
   * earliest remaining deadline re-arms the platform alarm.
   * `__unsafe_ensureInitialized` is partyserver's documented escape hatch
   * for frameworks; calling it here (instead of `super.alarm()`) is what
   * lets `onAlarm` run AFTER the floor, like every other embedder hook.
   */
  override async alarm(alarmInfo?: TimerAlarmInfo): Promise<void> {
    await this.__unsafe_ensureInitialized();
    await this.#enterTurn();
    await this.onAlarm();
    await this.timers.dispatch(this.#timerHandlers, undefined, alarmInfo);
  }

  /** partyserver logs "implement onAlarm" per fire; an empty hook is the default here. */
  override onAlarm(): void | Promise<void> {}

  /**
   * Register the handler for one timer reason. Reasons are the alarm's
   * multiplexing key: register in the constructor, arm with
   * `this.timers.schedule(reason, whenMs)`, re-arm by returning
   * `{ rearmAt }` from the handler. One handler per reason, for the
   * instance's lifetime.
   */
  protected registerTimerReason(
    reason: string,
    handler: (now: number, info?: TimerAlarmInfo) => TimerHandlerResult | Promise<TimerHandlerResult>,
  ): void {
    if (reason in this.#timerHandlers) {
      throw new Error(`loom: timer reason '${reason}' is already registered on ${this.#className()}`);
    }
    this.#timerHandlers[reason] = handler;
  }

  // ── Scheduling ─────────────────────────────────────────────────────────

  /**
   * Schedule a method call: `when` is a delay in seconds, an absolute
   * `Date`, or a cron expression. The callback fires as
   * `this[callback](payload, invocation)`; the invocation carries the
   * schedule, the attempt number, and the platform's `alarmInfo`. Retries
   * are durable rows (see schedules.ts), governed by `options.retry`.
   */
  async schedule<T = unknown>(
    when: number | Date | string,
    callback: keyof this & string,
    payload?: T,
    options?: ScheduleOptions,
  ): Promise<Schedule<T>> {
    this.#assertScheduleCallback(callback);
    const schedule = this.#schedules.create(when, callback, payload, options);
    await this.timers.schedule(SCHEDULE_TIMER_REASON, schedule.time);
    return schedule;
  }

  /** Schedule a method call every `intervalSeconds`, first fire one interval from now. */
  async scheduleEvery<T = unknown>(
    intervalSeconds: number,
    callback: keyof this & string,
    payload?: T,
    options?: ScheduleOptions,
  ): Promise<Schedule<T>> {
    this.#assertScheduleCallback(callback);
    const schedule = this.#schedules.every(intervalSeconds, callback, payload, options);
    await this.timers.schedule(SCHEDULE_TIMER_REASON, schedule.time);
    return schedule;
  }

  async getScheduleById<T = unknown>(id: string): Promise<Schedule<T> | undefined> {
    return this.#schedules.byId<T>(id);
  }

  async listSchedules<T = unknown>(criteria?: ScheduleCriteria): Promise<Array<Schedule<T>>> {
    return this.#schedules.list<T>(criteria);
  }

  /** True when the id existed and is now cancelled. */
  async cancelSchedule(id: string): Promise<boolean> {
    return this.#schedules.cancel(id);
  }

  /**
   * A schedule's retry budget is spent (or its callback is not a method).
   * The default names the failure; override to route it.
   */
  onScheduleError(schedule: Schedule, error: unknown): void {
    console.error(
      `[loom] ${this.#className()} schedule '${schedule.id}' (${schedule.callback}) failed for good:`,
      error,
    );
  }

  #assertScheduleCallback(callback: string): void {
    if (typeof (this as unknown as Record<string, unknown>)[callback] !== 'function') {
      throw new Error(`loom: this.${callback} is not a function`);
    }
  }

  async #dispatchSchedules(now: number, info?: TimerAlarmInfo): Promise<TimerHandlerResult> {
    const result = await this.#schedules.dispatchDue(this, now, info, (schedule, error) => {
      try {
        this.onScheduleError(schedule, error);
      } catch (e) {
        console.error(`[loom] ${this.#className()} onScheduleError itself failed:`, e);
      }
    });
    return result.rearmAt === null ? undefined : { rearmAt: result.rearmAt };
  }

  // ── State sync ─────────────────────────────────────────────────────────

  /**
   * The synced state. Loaded from SQLite on first read; `initialState`
   * before anything was ever set; undefined for a stateless actor.
   */
  get state(): State {
    if (!this.#stateLoaded) {
      this.#ensureStateSchema();
      const rows = [...this.#sql.exec(`SELECT state FROM loom_state WHERE id = 1`)] as Array<{ state: string }>;
      this.#state = rows.length > 0 ? (JSON.parse(rows[0].state) as State) : this.initialState;
      this.#stateLoaded = true;
    }
    return this.#state as State;
  }

  /** Replace the state: validate, persist, broadcast, notify. */
  setState(state: State): void {
    this.#setStateInternal(state, 'server');
  }

  /**
   * Synchronous veto over every state change, the embedder's own and a
   * connection's alike. Runs BEFORE anything persists; throw to refuse.
   * A refused connection update earns the client a
   * `cf_agent_state_error` frame.
   */
  validateStateChange(_next: State, _source: Connection | 'server'): void {}

  /** The state changed and is already persisted and broadcast. */
  onStateChanged(_state: State, _source: Connection | 'server'): void | Promise<void> {}

  #setStateInternal(state: State, source: Connection | 'server'): void {
    this.validateStateChange(state, source);
    const json = JSON.stringify(state);
    if (json === undefined) {
      throw new Error('loom: state must be JSON-serializable, and undefined is not a state');
    }
    this.#ensureStateSchema();
    this.#sql.exec(
      `INSERT OR REPLACE INTO loom_state (id, state, updated_at) VALUES (1, ?, ?)`,
      json,
      Date.now(),
    );
    this.#state = state;
    this.#stateLoaded = true;
    this.broadcast(
      JSON.stringify({ type: STATE_FRAME_TYPE, state }),
      source === 'server' ? [] : [source.id],
    );
    // The change already persisted and broadcast, so an onStateChanged
    // failure — sync or async — is the hook's problem, never a refusal.
    try {
      const hook = this.onStateChanged(state, source);
      if (hook && typeof (hook as Promise<void>).then === 'function') {
        this.ctx.waitUntil(
          (hook as Promise<void>).catch((e) => {
            console.error(`[loom] ${this.#className()} onStateChanged failed:`, e);
          }),
        );
      }
    } catch (e) {
      console.error(`[loom] ${this.#className()} onStateChanged failed:`, e);
    }
  }

  #sendStateOnConnect(connection: Connection): void {
    const state = this.state;
    if (state === undefined) return;
    try {
      connection.send(JSON.stringify({ type: STATE_FRAME_TYPE, state }));
    } catch (e) {
      console.warn(`[loom] ${this.#className()} could not send state on connect:`, e);
    }
  }

  #ensureStateSchema(): void {
    if (this.#stateSchemaReady) return;
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS loom_state (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      state      TEXT    NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.#stateSchemaReady = true;
  }

  get #sql(): { exec(query: string, ...bindings: Array<string | number | null>): Iterable<unknown> } {
    return (this.ctx as unknown as ScheduleContext).storage.sql;
  }

  // ── Protocol frames ────────────────────────────────────────────────────

  /** True when the message was a protocol frame and is now handled. */
  async #consumeProtocolFrame(connection: Connection, message: WSMessage): Promise<boolean> {
    if (typeof message !== 'string' || message[0] !== '{') return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return false;
    }
    if (isStateFrame(parsed)) {
      try {
        this.#setStateInternal(parsed.state as State, connection);
      } catch (e) {
        console.warn(`[loom] ${this.#className()} refused a state update from ${connection.id}:`, e);
        try {
          connection.send(JSON.stringify({ type: STATE_ERROR_FRAME_TYPE, error: 'State update rejected' }));
        } catch { /* peer gone; the refusal has no one to reach */ }
      }
      return true;
    }
    if (isRpcRequestFrame(parsed)) {
      await dispatchRpc(this, connection, parsed);
      return true;
    }
    return false;
  }

  // ── The fabric floor, as accessors ─────────────────────────────────────

  /** This actor's reason map over its ONE platform alarm. */
  get timers(): Timers {
    return fabricTimers(this, this.ctx as unknown as TimerContext);
  }

  /** This incarnation's generation. Zero until the first turn adopted it. */
  get generation(): number {
    return fabricGeneration(this.ctx);
  }

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
  outbox<M>(name: string, policy: OutboxPolicy<M>): Outbox<M> {
    const existing = this.#outboxes.get(name);
    if (existing) return existing as Outbox<M>;
    const box = fabricOutbox<M>(this, this.ctx as unknown as OutboxContext, name, policy);
    this.registerTimerReason(box.reason, box.handler());
    this.#outboxes.set(name, box as Outbox<never>);
    return box;
  }

  /** The named append-only event journal. One instance per name. */
  journal<P>(name: string): Journal<P> {
    const existing = this.#journals.get(name);
    if (existing) return existing as Journal<P>;
    const created = fabricJournal<P>(this.ctx as unknown as JournalContext, name);
    this.#journals.set(name, created as Journal<never>);
    return created;
  }

  /** Leased facets: disposal retires (storage wiped), `detach()` keeps it. */
  get facets(): FacetPool {
    return (this.#facets ??= facetPool(this.ctx as unknown as FacetPoolContext));
  }

  /**
   * The process fabric over this actor's substrate. Declare the substrate
   * by overriding {@link processHost}; the fabric is built once, on first
   * use.
   */
  get processes(): ProcessFabric {
    return (this.#processes ??= new ProcessFabric(this.processHost()));
  }

  /** The substrate {@link processes} runs on. Override to declare one. */
  protected processHost(): ProcessHost {
    throw new Error(
      `loom: ${this.#className()} used this.processes without a substrate — override processHost()`,
    );
  }

  /** A watermark memo: derive a cheap key, compare, rebuild only on change. */
  derived<T>(watermark: () => string | number, build: () => T): Derived<T> {
    return fabricDerived(watermark, build);
  }

  /** The async memo; a watermark or build failure serves the last good value. */
  derivedAsync<T>(watermark: () => Promise<string | number>, build: () => Promise<T>): DerivedAsync<T> {
    return fabricDerivedAsync(watermark, build);
  }

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
  connections<T>(schema: z.ZodType<T>): TypedConnections<T> {
    if (!this.#hibernate) {
      throw new Error(
        `loom: ${this.#className()}.connections() needs hibernation — the typed state rides the `
          + `hibernatable socket attachment; set static options = { hibernate: true }`,
      );
    }
    const adapter: ConnectionsContext = {
      acceptWebSocket: () => {
        throw new Error(
          'loom: partyserver owns the accept — tag connections via getConnectionTags() and write state with write()',
        );
      },
      getWebSockets: (tag?: string) => [...this.getConnections(tag)] as unknown as ConnectionSocket[],
      getTags: (ws: ConnectionSocket) => [...(ws as unknown as Connection).tags],
    };
    const inner = fabricConnections(adapter, schema);
    return {
      get: (tag) => inner.get(tag) as Connection | null,
      list: (tag) => inner.list(tag) as unknown as Connection[],
      tags: (connection) => inner.tags(connection as unknown as ConnectionSocket),
      read: (connection) => inner.read(connection as unknown as ConnectionSocket),
      write: (connection, attachment) => inner.write(connection as unknown as ConnectionSocket, attachment),
    };
  }

  /**
   * A fenced-work journal whose recovery is pumped on the first turn of
   * every incarnation — reconnects after a reset included. The host defines
   * what a launch is and how to re-drive it; call once, in the constructor.
   */
  protected fenceWork<R extends FencedWorkRecord>(host: FencedWorkHost<R>): FencedWork<R> {
    const work = new FencedWork<R>(this.ctx.storage as unknown as FencedWorkStorage, host);
    fabricOnColdStart(this.ctx, () => work.recoverInterrupted());
    return work;
  }

  /**
   * Defer async reconciliation to the first turn of this incarnation —
   * never the init gate. Safe to call from the constructor; that is the
   * point.
   */
  protected deferToColdStart(task: () => Promise<unknown>): void {
    fabricOnColdStart(this.ctx, task);
  }

  #className(): string {
    return (Object.getPrototypeOf(this) as { constructor: { name: string } }).constructor.name;
  }
}
