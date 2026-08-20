# @nimbus-sh/loom

> Part of [Nimbus](https://github.com/AshishKumar4/Nimbus), my hobby/research
> cloud OS. This README is edited and maintained with Claude (AI) and
> presented as-is.

An actor framework for Cloudflare Durable Objects. On top it is
[partyserver](https://github.com/cloudflare/partykit/tree/main/packages/partyserver)'s
surface, unchanged: `Actor extends Server`, so routing, connections, tags,
broadcast, and hibernation work exactly as partyserver documents them.
Underneath it is [`@nimbus-sh/fabric`](https://www.npmjs.com/package/@nimbus-sh/fabric),
the Durable Object machinery Nimbus runs in production, pre-wired so an
embedder writes one class instead of the wiring.

Cloudflare's own Agents SDK takes the same shape (`Agent extends Server`).
Where the two overlap, loom keeps the SDK's API and wire protocol so its
clients are not surprised, and swaps the machinery for fabric's where
fabric's is measurably stronger. Every such claim below was verified against
the shipped `agents` 0.20.1 dist, not its docs. partyserver is pinned to an
exact version (0.5.10); loom extends its prototype surface, and a floating
prototype dependency is a drift channel.

## One class

```ts
import { Actor, callable, routeActorRequest } from '@nimbus-sh/loom';

interface CounterState {
  count: number;
}

export class Counter extends Actor<Env, CounterState> {
  static options = { hibernate: true };
  initialState: CounterState = { count: 0 };

  @callable()
  increment(by: number): number {
    this.setState({ count: this.state.count + by });
    return this.state.count;
  }

  async remind(payload: { what: string }): Promise<void> {
    this.broadcast(`reminder: ${payload.what}`);
  }

  async onRequest(request: Request): Promise<Response> {
    await this.schedule(60, 'remind', { what: 'tea' });
    return Response.json(this.state);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routeActorRequest(request, env))
      ?? new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

`routeActorRequest` and `getActorByName` are partyserver's router
re-exported, URL convention included (`/parties/<binding>/<name>`); a
parallel implementation would drift. Actor classes must be SQLite-backed
Durable Objects (`new_sqlite_classes`, the default for new classes); state
and schedules live in the actor's own SQLite.

## The floor you inherit

**Nothing async on the init gate.** The constructor is synchronous.
partyserver's gate runs exactly your `onStart`, and a gate callback still
pending at ~30 s is cancelled and resets the object, so `onStart` must stay
short. Work that belongs to a fresh incarnation goes through
`this.deferToColdStart(task)` and runs on the first turn the actor owns.
Generation adoption (`this.generation`, fabric's incarnation counter) and
fenced-work recovery ride the same turn.

**One alarm, many reasons.** A Durable Object has one alarm, and a second
`setAlarm()` silently overwrites the first. `alarm()` therefore dispatches
fabric's reason map: register a reason with `registerTimerReason` in the
constructor, arm it with `this.timers.schedule(reason, whenMs)`, re-arm by
returning `{ rearmAt }` from the handler. The schedule API and every outbox
are reasons in the same map, so nothing clobbers anything.

**Scheduling.** `schedule(when, callback, payload?)` takes a delay in
seconds, a `Date`, or a cron expression; `scheduleEvery(intervalSeconds,
...)` is a fixed interval. `getScheduleById`, `listSchedules`,
`cancelSchedule` read and cancel. The callback receives
`(payload, invocation)` where the invocation carries the schedule, the
attempt number, and the platform's `alarmInfo` (`isRetry`, `retryCount`),
which the Agents SDK drops. Retries are durable: a failed attempt writes its
backed-off deadline into the row, so the budget survives an instance reset
instead of sleeping inside the alarm turn. Times are epoch milliseconds.

**State sync.** Declare `initialState`, read `this.state`, write
`setState(next)`. State persists to SQLite and broadcasts to every
connection as a `cf_agent_state` frame (the Agents wire protocol, so its
clients work as-is). A client can send the same frame back;
`validateStateChange(next, source)` vetoes synchronously before anything
persists, and `onStateChanged(state, source)` runs after. A refused client
update earns a `cf_agent_state_error` frame.

**Callable RPC.** Mark a method `@callable()` and any connection can invoke
it by name; everything unmarked is refused. `@callable({ streaming: true })`
prepends a `StreamingResponse` to the arguments for chunked replies. The
caller side is `actorClient(socket)` from `@nimbus-sh/loom/client.js` —
dependency-free and workerd-free, with `call(method, args)` and a typed
`stub<T>()` proxy.

**Per-connection state.** `this.connections(schema)` is fabric's typed,
validated, hibernation-durable attachment state over partyserver's
`Connection` surface: `read` validates instead of casting (an attachment
written by a previous deploy is untrusted input), `write` validates on the
way in, tags address connections. partyserver owns the accept; tag
connections in `getConnectionTags`. Hibernating actors only — the state
rides the hibernatable socket attachment, and a non-hibernating actor is
refused with an error rather than corrupted later.

**Durable messaging.** `this.outbox(name, policy)` is a write-ahead retry
outbox (dispositions, per-key ordering, dead letters), its drain registered
as a timer reason the moment you create it. Create outboxes in the
constructor: a queued row survives an instance reset, but the alarm
dispatcher drops a fired reason no handler answers, so an outbox first
created inside a request path is unregistered until that path runs again.
`this.journal(name)` is an append-only event log with dedupe and
self-expiring delivery leases.

**Processes and facets.** `this.facets` leases DO facets so reclaiming
storage is the default and leaking it takes an explicit `detach()`.
`this.processes` is fabric's process fabric over a substrate you declare by
overriding `processHost()`. `this.derived` / `this.derivedAsync` are the
watermark memos.

**Hibernation, configured.** `static options = { hibernate: true }` opts
into partyserver's hibernation and also applies fabric's config: `ping`/
`pong` auto-response (a matched frame no longer wakes the actor) and the 5 s
hibernatable-event timeout. `this.hibernation` reports what the runtime
supported. State your fabric composition once, on the class:
`static options = { fabric: { supervisorEntrypoint: '...' } }`.

Define hooks (`onMessage`, `onConnect`, ...) as methods, not instance
fields. Loom wraps them at construction to pay the floor work and consume
protocol frames; an instance field assigns over the wiring.

## What this is not

There is no chat surface, no MCP, no email routing, no React hooks, and no
Workflows integration. That is the Agents SDK's product surface; loom stops
at the framework layer. If you need those today, use `agents` — its `Agent`
and loom's `Actor` are siblings on the same partyserver base, and they do
not share a Durable Object.

## Importing it

Your Worker must set `compatibility_flags: ["nodejs_compat"]`. Loom dispatches
timers through fabric, and fabric's dispatcher imports `AsyncLocalStorage`
from `node:async_hooks`. Without the flag the module fails to load at deploy
time.

The root export pulls `partyserver`, which imports `cloudflare:workers`, so
`import ... from '@nimbus-sh/loom'` resolves only inside a Worker. Outside
workerd (unit tests, browsers) import subpaths: `@nimbus-sh/loom/client.js`
and `@nimbus-sh/loom/protocol.js` are workerd-free by design, and
`@nimbus-sh/loom/schedules.js` is structurally typed for plain-process
tests, the same discipline as fabric.
