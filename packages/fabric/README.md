# @nimbus-sh/fabric

> Part of [Nimbus](https://github.com/AshishKumar4/Nimbus), my hobby/research
> cloud OS. This README is edited and maintained with Claude (AI) and
> presented as-is.

Run long-lived programs on Cloudflare Durable Objects.

A Durable Object gives you one alarm, one 128 MiB isolate, a 30-second CPU
turn, and storage that can reset under you. This package turns those into
things you can build on: many timers on the one alarm, work that survives a
reset, CPU work that spans turns, and real processes in their own isolates.

Use it if you host something that outlives a request. A dev server, a build,
an agent, a terminal session.

## Requirements

Set `compatibility_flags: ["nodejs_compat"]` in your Worker. The timer
dispatcher needs `AsyncLocalStorage`, which workerd ships only under that
flag. Without it the module fails to load at deploy time.

Import the root inside a Worker. Outside workerd, import subpaths such as
`@nimbus-sh/fabric/timers.js`, which are typed against plain objects and run
in bun or node.

## Setup

Declare your composition once, in your Worker's entry module.

```ts
import { composeFabric, adoptCtxExports } from '@nimbus-sh/fabric';

// Module scope of the Worker entry, once per isolate:
composeFabric({
  // The name of your supervisor WorkerEntrypoint export. The fabric mints one
  // binding per hosted program from it (env.SUPERVISOR inside the facet).
  supervisorEntrypoint: 'MySupervisorRPC',
  // Only if you use 'staged' boot specs; 'code' boots need no assembler.
  stagedBootAssembler: async (env, stage) => assembleLoaderConfig(env, stage),
});

// ctx.exports is runtime state, not composition. Capture it where the
// platform hands it over — the first fetch, or the DO constructor:
adoptCtxExports(ctx.exports);
```

Both calls take the first value they are given.

## Timers

A Durable Object has one alarm, and a second `setAlarm()` overwrites the
first. Route every timer through one dispatcher instead.

```ts
import { DurableObject } from 'cloudflare:workers';
import { timers } from '@nimbus-sh/fabric';

export class MySession extends DurableObject {
  _timerChain?: Promise<unknown>;   // serializes the map's read-modify-write

  async fetch(request: Request): Promise<Response> {
    await timers(this, this.ctx).schedule('janitor', Date.now() + 60_000);
    return new Response('ok');
  }

  async alarm(): Promise<void> {
    await timers(this, this.ctx).dispatch({
      janitor: async (now) => {
        await this.cleanUp();
        return { rearmAt: now + 60_000 };   // re-arm through the return value
      },
    });
  }
}
```

`schedule` stores a deadline per reason and arms the alarm at the earliest
one. `dispatch` runs the reasons that are due, ignores reasons it does not
know, and stops re-arming when none are left, which lets the object
hibernate. A handler re-arms itself by returning `{ rearmAt }`.

## Generations and reset detection

Workerd hands you a fresh isolate on cold starts, hibernation wakes, and
resets. The generation counter tells you which incarnation you are in, and
process IDs derive from it.

```ts
import { adoptGeneration, generation } from '@nimbus-sh/fabric';

export class MySession extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    await adoptGeneration(this.ctx);   // idempotent per instance
    // generation(this.ctx) is now this incarnation's generation
  }
}
```

This gives you one reliable test for stale state: **an ID at or below the
current generation's base came from a previous incarnation.**

Adopt the persisted value before bumping it. `await put()` returning is not
durability, so a bump that has not landed can be re-issued to the next boot,
and two instances would share a generation.

## Fenced work

A reset destroys whatever the current turn had in flight, including a
half-built process. Journal the work first, and a later instance can finish
it.

```ts
import { FencedWork, type FencedWorkRecord } from '@nimbus-sh/fabric';

interface MyLaunch extends FencedWorkRecord {
  argv: string[];   // whatever your redrive needs; the journal never reads it
}

const journal = new FencedWork<MyLaunch>(this.ctx.storage, {
  generationBase: () => this.pidBase,
  waitUntil: (p) => this.ctx.waitUntil(p),
  redrive: (record, attempt) => this.launch(record.argv, attempt),
});

// Before the launch's first byte of real work:
await journal.journal({ pid, command, attempt: 0, phase: 'starting', argv });
// When the PROCESS (not the launch) ends:
await journal.release(pid);
// On the first turn after any reset (the turn pump calls this):
await journal.recoverInterrupted();
```

Write the row before the work starts and release it when the process ends,
not when the launch ends. Resets usually arrive after a launch settles, so a
launch-scoped row is already gone when recovery looks for it.

The journal writes through `ctx.storage.sync()`, because `await put()`
resolves before the write is durable. Recovery re-drives each stale row once.

## Turn pacing

One turn gets about 30 seconds of CPU. Yielding inside a turn does not help,
because CPU accrues to the invocation. Only re-entering the object resets the
budget, and a long turn also blocks the actor's thread and drops WebSockets.

```ts
import { TurnBudget, PacedWork, onColdStart, timers } from '@nimbus-sh/fabric';

const pump = new PacedWork(this.ctx, {
  requestTurn: () => { void timers(this, this.ctx).schedule('launch-turn', Date.now()); },
});
// Deferred reconciliation rides the first pump, off the init gate:
onColdStart(this.ctx, () => journal.recoverInterrupted());
const budget = new TurnBudget(pump);

// Inside the launch, after each unit of work:
await budget.spend(bytesJustProcessed);   // suspends every TURN_CHUNK_MAX_BYTES (2 MB)
// In alarm(), as one of the dispatcher's reasons:
'launch-turn': () => pump.pump(),
```

Account in bytes, not milliseconds: the in-DO clock does not advance without
I/O. `spend()` suspends every 2 MB and resumes on a fresh turn. Scheduling a
past deadline re-enters the object immediately.

## Isolate pool

Run plain functions in warm dynamic-worker isolates.

```ts
import { IsolatePool } from '@nimbus-sh/fabric';

const pool = new IsolatePool(env, this.ctx, {
  concurrency: 4,
  tag: 'checksum',
  omitSupervisor: true,   // this pool needs no callback into the DO
});
try {
  const sums = await pool.map(async (text: string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }, inputs);
} finally {
  pool.dispose();   // releases the pool's long-lived RPC stubs
}
```

Functions are serialized with `fn.toString()`, so they must be
self-contained: no captured variables, no `this`. Bindings arrive as the last
parameter. Slots are stable, so a batch of 67 tasks reuses 4 warm isolates
instead of paying 67 cold starts.

Ship wasm through the loader's modules map as `{ wasm: ArrayBuffer }`. It is
the only path that works. Request-time `WebAssembly.compile` is blocked by
CSP, structured clone refuses a compiled `Module`, and inlining bytes into
the source exhausts the supervisor's memory.

Warm isolates are scoped to one session. A pool may opt into
`cacheScope: 'global'` only if it takes no supervisor binding and keeps no
user state.

`Fanout` handles wider batches. One DO method can drive at most 4 concurrent
loader fetches, so batches under 5 run in the coordinator and larger ones
shard across up to 32 sibling objects, 4 at a time.

Each keyed `loader.get(id)` permanently holds one of roughly 5–6
dynamic-worker slots. `loaderLedgerStats(ctx)` reports what you have
consumed, and a cap refusal names the IDs holding slots.

## Process fabric

A resident process is a Durable Object facet running a class from a dynamic
worker.

```ts
import { ProcessFabric, createProcessHost } from '@nimbus-sh/fabric';

const fabric = new ProcessFabric(createProcessHost('facet', this.ctx, env, () => diskReader));

const handle = await fabric.startResidentProcess({
  startContract: 'boot',            // or 'lifetime' — see below
  pid,
  workerKey: `nimbus-process:${this.ctx.id}:${pid}`,
  boot: { kind: 'code', code: spec },   // a ResidentCodeSpec
  startArgs: { port: 3000 },
  onWriterActivated: (writerId) => this.writers.add(writerId),
  onWriterRetired: (writerId) => this.writers.delete(writerId),
});

const payload = await handle.booted();
// Inbound HTTP for the process's ports:
const response = await handle.routeTarget.handleHttpRequest(request);
// Teardown:
handle.kill();
await handle.done;
```

The worker exports a Durable Object class named `NimbusProcess` with
`startProcess(args)` and `handleHttpRequest(request)`. `startProcess`
declares one of two contracts. Use `'lifetime'` when the call should stay
open for the process's life, as an attached terminal does. Use `'boot'` when
it should return once the process is up and leave the facet resident, as a
server does.

**Facet names come from a free list.** A Durable Object allows 65,536 facets
over its lifetime, and IDs are never reclaimed, so the limit counts facets
ever created. Reusing a name costs no new ID. `facetIdBudget(ctx)` reports
`{ consumed, budget }`.

**Large boot members travel as VFS paths.** A structured-clone RPC value caps
at 32 MiB. Use `vfsWasmModules` and `vfsTextModules`; the host reads the
bytes during the load and verifies each image against the digest its path
claims.

**The substrate is one deployment-wide setting**, `'facet'` or `'peer'`,
never a per-spawn choice.

| | spawn | memory | CPU | SQLite |
|---|---|---|---|---|
| facet | 8–16 ms | independent (~208 MiB each) | shared | own |
| peer | 242–359 ms | independent | independent | own |

Facets are separate isolates in one actor thread, so they scale memory but
not CPU. Awaiting I/O yields the thread; a 9,956 ms CPU burn stalled a
sibling for 9,966 ms. A peer costs about 20× the spawn time and buys real CPU
isolation, and it verifies it did not co-locate.

A facet shares its session's object, so it can copy the session's store by
reflink (`ctx.facets.clone`, 18–31 ms for 45.73 MB, 34–54 ms for 1 GB) and
shares the session's ~10 GiB budget. A peer brings its own storage and cannot
reflink.

Call clone through `cloneStorage`. An unresolvable `src` empties the
destination and reports success, so the wrapper checks the source before the
call and the destination after. An emptied facet still shows a 4,096-byte
database, so check for your own data rather than a non-zero size.

## Image store

`ImageStore` writes generated boot images into a content-addressed store at
`var/lib/nimbus/facet-images/<sha256>.js`, through an `ImageBlobStore` port
you implement.

It registers the whole root set before writing any byte, so a sweep never
sees an unclaimed image. Writes are sliced to stay inside the 1 MiB
transaction bound; a 22.9 MB map written in one turn reset the session about
a quarter of the time. Because a write only grows the file from offset zero,
matching size means a complete write, and the reader verifies the digest
before the loader sees the bytes. Images stay live while a process boots from
them, rooted in the process table, with no TTL.

## Binding shims

`NimbusLoaderRPC`, `NimbusLoadedWorker`, `NimbusLoadedEntrypoint`,
`NimbusAssetsRPC`, `NimbusDurableObjectNamespace`, and `NimbusDOStub` give a
dynamically-loaded inner Worker working `env` bindings.

Three platform rules shape them. A `WorkerStub` does not serialize, so each
hop is its own `WorkerEntrypoint` class. A stub belongs to the request that
minted it, so the shims store code rather than stubs and re-resolve through
`LOADER.get(id, cb)`; workerd caches by ID, and the code map is capped at 32
entries. An RPC method is a wildcard property, so call `ep.method(request)`
and never `method.call(ep, request)`, which workerd refuses.

Nesting is capped at depth 4. Raise it with `NIMBUS_INNER_LOADER_DEPTH`.

## Measured platform limits

Figures below come from production workerd, June to August 2026. The code
above enforces them where it can. [PLATFORM.md](PLATFORM.md) is the full
catalog: every entry dated, graded by evidence, and marked as enforced here
or left to you.

### Durable Object storage

| Invariant | Evidence |
|---|---|
| `await put()` resolves BEFORE durability; `ctx.storage.sync()` is the barrier; the output gate holds the guarantee | a launch killed in its first chunks left NO journal row (staging, 2026-08-13) |
| A reset destroys every write its turn had outstanding; an alarm write rolls back with it and the platform re-delivers the alarm to the replacement instance | the first turn after a reset is a recovery turn, for free |
| SQLite value cap is 2 MB per ROW, key length included | single-value ceiling 2,199,981 B with a 12-char key; overflow throws clean, catchable `SQLITE_TOOBIG` |
| One alarm per object; a second `setAlarm()` silently overwrites | why `TIMER_REASONS_KEY` is a map |
| Input gates stay closed across `get`/`put` | set-if-absent is atomic per DO with no CAS loop |
| A facet's own SQLite survives a fresh module scope | 7,141 rows / 45.7 MB intact across recycling — keep provenance in rows, never heap |
| ~10 GiB storage budget shared by the DO root and every facet and clone under it, with no copy-on-write credit | N clones of X bytes cost X·(N+1); crossing RESETS the object rather than raising an error |

### Lifecycle and CPU

| Invariant | Evidence |
|---|---|
| No pending alarm ⇒ hibernation-eligible after ~10 s idle | why `timers.dispatch` deletes the map when nothing remains |
| One-turn CPU budget ~30 s; yielding inside an invocation buys nothing; only genuine re-entry (an alarm) resets it | killed with `exceededCpu` at 31.8 s and 32.5 s |
| A long turn drops the object's WebSockets even when the work succeeds | the launch turn finished `outcome=ok` and the terminal died anyway |
| The in-DO clock does not advance without I/O | 0 ms across 200,000 consecutive `Time.now` reads — pace in bytes, hand deadlines to the host |
| Isolate generation increments on EVERY fresh isolate: cold start and hibernation wake, not only resets | `adoptGeneration` adopts persisted truth first |
| `pid <= generation base` ⇒ previous generation | THE reset predicate; `PID_GEN_STRIDE` = 1,000,000 |
| `setTimeout`/`setInterval` prevent hibernation | one-shot self-nulling timers only |

### Facets and dynamic workers

| Invariant | Evidence |
|---|---|
| Facet memory independent, ~208–256 MiB each; facet CPU SHARED across siblings | 9,956 ms burn stalled a sibling 9,966 ms; awaited I/O costs siblings 0 ms |
| 65,536 facets per DO LIFETIME; IDs append-only, never reclaimed; reusing a NAME costs no new ID | the slot book exists for this; `facetIdBudget` counts consumption durably and a failure at the wall names the budget |
| Dynamic-worker module map hard ceiling 67,108,864 bytes, shared across every member | 62 MiB lands, 64 MiB refused; boot cost roughly linear in map bytes and not the bottleneck (40 MiB → 1.42 s across 6,553 modules); every assembly seam refuses an over-ceiling map listing the largest members by size, because the platform's refusal names none |
| Request-time `WebAssembly.compile`/`instantiate` CSP-blocked; wasm rides the loader modules map as `{ wasm: ArrayBuffer }`, compiled at module load | RPC of a compiled `Module` refused by structured clone; inlined bytes OOMed the supervisor |
| Module scope bans I/O; `new Function` succeeds at module scope and throws at request time | code reaches a facet through the module map or not at all |
| The facet start callback fires at most once | re-running it would re-execute the user's program |
| ~5–6 concurrent dynamic workers per DO; at most 4 concurrent Loader fetches per DO method; loader-cache entries are never released | `IN_DO_THRESHOLD` = 5 sits under the fetch cap; every `loader.get(id)` permanently consumes a slot — counted per DO by the loader ledger, and a cap refusal names the ids holding them |
| `ctx.facets.clone` is same-object only, absent from `@cloudflare/workers-types` and the pinned workerd, present in production | 18–31 ms / 45.7 MB, 34–54 ms / 1 GB; an unresolvable `src` silently EMPTIES the destination and reports success — `cloneStorage` enforces the both-ends validation |
| A DO dies at ~200 MiB of live wasm linear memory; reserved and written pages die at the same ceiling | lazy growth buys nothing; bound guest memory by rewriting the memory section |
| A wasm stack suspended (JSPI) in one request cannot resume in another | 3 in-context resumes took 6 ms; the first cross-context one hit a 30 s timeout |

### RPC and stubs

| Invariant | Evidence |
|---|---|
| workerd constructs a NEW `WorkerEntrypoint` instance per RPC call | instance fields are write-only; fold state through return values |
| A stub minted in one invocation throws in another ("Cannot perform I/O on behalf of a different request") | store CODE, not stubs; re-resolve via `LOADER.get(id, cb)` — cached by id, ~free |
| `WorkerStub` does not serialize | one chained `WorkerEntrypoint` proxy class per hop |
| An RPC method is a wildcard property: `method.call(ep, r)` serializes `ep` as an argument and is refused | always `ep.method(r)` |
| Entrypoints to dynamically-loaded workers cannot transfer across Workers | HTTP travels as parts with plain `ReadableStream` bodies, re-piped through an identity stream this isolate owns |
| Structured-clone RPC cap 32 MiB | ship ≤ 28 MiB (`~6%` clone overhead); clone refusal is classified distinctly |
| RPC resources need explicit `Symbol.dispose`, including on error paths | a timeout's reject closure otherwise roots a 28 MiB payload for the full timeout |
| A binding minted BY AN ACTOR lives as long as the process; nothing holds a call open | why the facet's `SUPERVISOR` binding comes from the DO, not a stateless entrypoint |

### WebSockets

| Invariant | Evidence |
|---|---|
| Without `setWebSocketAutoResponse(ping/pong)`, every idle-tab ping wakes the actor | ~2,880 wakes/day per idle tab; the config survives hibernation |
| A hibernatable WS owned by a DO cannot be written from a sibling `WorkerEntrypoint` isolate | sends happen in the DO's own context (relay pattern) |
| A WebSocket upgrade cannot ride the RPC hop a resident's HTTP takes | a 101 owns a live socket and RPC reconstructs values rather than handing sockets over; an upgrade takes the separate fetch-semantic entrypoint and stays on `fetch` for every hop (a facet is fetched directly; a peer fetches its own facet), and a target without that entrypoint answers 501 |

### Sharing an isolate

| Invariant | Evidence |
|---|---|
| The isolate heap ceiling is 128 MiB, and multiple DOs from one script can SHARE one isolate | resets observed below any single object's apparent usage |
| `exceededMemory` and `exceededCpu` are both uncatchable inside the dying isolate, observable only across an RPC boundary | absence of the error is not evidence of its absence |
| `process.memoryUsage()` returns 0 in DO context | any heap estimate is a lower bound; say so |

## Related packages

[`@nimbus-sh/core`](https://www.npmjs.com/package/@nimbus-sh/core) is the
backend-agnostic OS: filesystem, shell, process contracts.
[`@nimbus-sh/platform`](https://www.npmjs.com/package/@nimbus-sh/platform)
holds the limits tables, the error taxonomy, RPC disposal, and the supervisor
budget machinery.
[`@nimbus-sh/worker`](https://www.npmjs.com/package/@nimbus-sh/worker) is the
reference embedder, with the supervisor entrypoint and the session protocol.
For the full hosted product, start from `npx create-nimbus-app`.

## License

MIT.
