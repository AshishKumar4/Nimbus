# @nimbus-sh/loom

> Part of [Nimbus](https://github.com/AshishKumar4/Nimbus), my hobby/research
> cloud OS. This README is edited and maintained with Claude (AI) and
> presented as-is.

An actor framework for Cloudflare Durable Objects.

`Actor extends Server`, so it keeps
[partyserver](https://github.com/cloudflare/partykit/tree/main/packages/partyserver)'s
surface unchanged. Routing, connections, tags, broadcast, and hibernation
work as partyserver documents them. The machinery under that surface is
[`@nimbus-sh/fabric`](https://www.npmjs.com/package/@nimbus-sh/fabric), the
Durable Object code Nimbus runs in production. It arrives pre-wired, so you
write one class instead of the wiring.

Use it for anything that lives in a Durable Object and holds state between
requests. An agent, a room, a job runner, a session.

## Install

```bash
npm install @nimbus-sh/loom
```

## Requirements

Set `compatibility_flags: ["nodejs_compat"]` in your Worker. Loom dispatches
timers through fabric, and fabric's dispatcher imports `AsyncLocalStorage`
from `node:async_hooks`. Without the flag the module fails to load at deploy
time.

Actor classes must be SQLite-backed Durable Objects. State and schedules
live in the actor's own SQLite.

The root export pulls `partyserver`, which imports `cloudflare:workers`, so
`import ... from '@nimbus-sh/loom'` resolves only inside a Worker. Outside
workerd (unit tests, browsers), import the subpaths.
`@nimbus-sh/loom/client.js` and `@nimbus-sh/loom/protocol.js` need no
workerd. `@nimbus-sh/loom/schedules.js` is structurally typed for
plain-process tests, like fabric's. partyserver is pinned to an exact
version (0.5.10), because loom extends its prototype surface.

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

Bind the class, and give it a SQLite migration:

```jsonc
// wrangler.jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "Counter", "class_name": "Counter" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }]
}
```

`POST /parties/counter/room-1` now reaches `onRequest` on the actor named
`room-1`. `routeActorRequest` and `getActorByName` are partyserver's router,
re-exported with its URL convention: the path segment is the binding name in
kebab case.

Define hooks (`onMessage`, `onConnect`, ...) as methods, not instance
fields. Loom wraps them at construction to do the floor work and consume
protocol frames. An instance field assigns over that wiring.

## Cold start and the init gate

Nothing async belongs on the init gate. The constructor is synchronous, and
partyserver's gate runs your `onStart`. A gate callback still pending at
~30 s is cancelled, and that resets the object, so keep `onStart` short.

Work that belongs to a fresh incarnation goes through
`this.deferToColdStart(task)` and runs on the first turn the actor owns.
Generation adoption (`this.generation`, fabric's incarnation counter) and
fenced-work recovery run on that same turn.

## Timers

A Durable Object has one alarm, and a second `setAlarm()` silently
overwrites the first. `alarm()` therefore dispatches fabric's reason map.
Register a reason with `registerTimerReason` in the constructor. Arm it with
`this.timers.schedule(reason, whenMs)`. Re-arm it by returning
`{ rearmAt }` from the handler. The schedule API and every outbox are
reasons in the same map, so they do not overwrite each other.

## Scheduling

`schedule(when, callback, payload?)` takes a delay in seconds, a `Date`, or
a cron expression. `scheduleEvery(intervalSeconds, ...)` is a fixed
interval. `getScheduleById`, `listSchedules`, `cancelSchedule` read and
cancel. The callback receives `(payload, invocation)`. The invocation
carries the schedule, the attempt number, and the platform's `alarmInfo`
(`isRetry`, `retryCount`), which the Agents SDK drops.

Retries are durable. A failed attempt writes its backed-off deadline into
the row, so the budget survives an instance reset. Nothing sleeps inside the
alarm turn. Times are epoch milliseconds.

## State sync

Declare `initialState`, read `this.state`, write `setState(next)`. State
persists to SQLite and broadcasts to every connection as a `cf_agent_state`
frame (the Agents wire protocol, so its clients work as-is).

A client can send the same frame back.
`validateStateChange(next, source)` vetoes it synchronously before anything
persists, and `onStateChanged(state, source)` runs after. A refused client
update gets a `cf_agent_state_error` frame.

## Callable RPC

Mark a method `@callable()` and any connection can invoke it by name;
everything unmarked is refused. `@callable({ streaming: true })` prepends a
`StreamingResponse` to the arguments for chunked replies.

The caller side is `actorClient(socket)` from `@nimbus-sh/loom/client.js`.
It has no dependencies, needs no workerd, and gives you `call(method, args)`
and a typed `stub<T>()` proxy.

## Per-connection state

`this.connections(schema)` is fabric's attachment state over partyserver's
`Connection` surface: typed, validated, and durable across hibernation.
`read` validates rather than casts, because an attachment written by a
previous deploy is untrusted input. `write` validates on the way in, and
tags address connections. partyserver owns the accept; tag connections in
`getConnectionTags`.

The state rides the hibernatable socket attachment, so a non-hibernating
actor is refused with an error.

## Durable messaging

`this.outbox(name, policy)` is a write-ahead retry outbox with
dispositions, per-key ordering, and dead letters. `this.journal(name)` is an
append-only event log with dedupe and self-expiring delivery leases.

Create outboxes in the constructor. An outbox registers its drain as a timer
reason the moment you create it. The alarm dispatcher drops a fired reason
that no handler answers. An outbox first created inside a request path stays
unregistered until that path runs again. A queued row survives an instance
reset.

## Processes and facets

`this.facets` leases DO facets, so the lease reclaims their storage by
default. An explicit `detach()` leaves the storage behind. `this.processes`
is fabric's process fabric over a substrate you declare by overriding
`processHost()`. `this.derived` / `this.derivedAsync` are the watermark
memos.

Declare the fabric composition on the class:
`static options = { fabric: { supervisorEntrypoint: '...' } }`.

## Hibernation

`static options = { hibernate: true }` opts into partyserver's hibernation.
It also applies fabric's config: `ping`/`pong` auto-response (a matched
frame no longer wakes the actor) and the 5 s hibernatable-event timeout.
`this.hibernation` reports what the runtime supported.

## Compared to the Agents SDK

Cloudflare's own Agents SDK takes the same shape (`Agent extends Server`).
Where the two overlap, loom keeps the SDK's API and wire protocol, so its
clients keep working. Underneath it swaps the machinery for fabric's. The
comparison here holds against the shipped `agents` 0.20.1 dist.

Loom has no chat surface, no MCP, no email routing, no React hooks, and no
Workflows integration. Those belong to the Agents SDK's product surface, and
loom stops at the framework layer. If you need them today, use `agents`. Its
`Agent` and loom's `Actor` are siblings on the same partyserver base, and
they do not share a Durable Object.
