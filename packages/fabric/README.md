# @nimbus-sh/fabric

> Part of [Nimbus](https://github.com/AshishKumar4/Nimbus), my hobby/research
> cloud OS. This README is edited and maintained with Claude (AI) and
> presented as-is.

The Cloudflare-specific half of Nimbus: the machinery for running real
programs on Durable Objects, DO facets, and the Worker Loader. Where
[`@nimbus-sh/core`](https://www.npmjs.com/package/@nimbus-sh/core) is the
backend-agnostic OS (filesystem, shell, process contracts), this package is
what that OS stands on when the host is Cloudflare. It imports core's shared
primitives and none of its policy.

I extracted it because almost none of it is specific to Nimbus. Anyone who
hosts long-lived processes on Durable Objects meets the same platform
behaviors we did: `await put()` resolving before durability, one alarm per
object, a 65,536-facet lifetime budget, a frozen in-DO clock, RPC stubs that
die with their request context. This package is the machinery we built against
those behaviors. The doc comments carry the measured numbers that justified
each mechanism, so the design record stays with the code.

I measured everything below on deployed production workerd between June and
August 2026. Where a specific date matters it is given.

## Importing it

Your Worker must set `compatibility_flags: ["nodejs_compat"]`. The timer
dispatcher imports `AsyncLocalStorage` from `node:async_hooks`, which workerd
ships only under that flag. Without it the module fails to load, and the
failure arrives at deploy time. The dispatcher needs
async-local state because several Durable Objects from one script can share a
V8 isolate, and a module-scoped variable would leak the dispatch context
between them.

The root export pulls `cloudflare:workers`, so `import ... from
'@nimbus-sh/fabric'` resolves only inside a Worker. Outside workerd (unit
tests, tooling), import the subpath modules directly:
`@nimbus-sh/fabric/timers.js`, `@nimbus-sh/fabric/fenced-work.js`, and so
on. Most of the package is structurally typed against plain objects, so it
can be tested in bun or node.

An embedder states its composition once, in its composition root:

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

Both calls are first-write-wins.

Before a release reaches the registry, consumers link it by packed tarball:
`npm pack` here, a `file:` path there. One bun behavior matters when you do.
Bun pins a `file:` tarball by the integrity hash in its lockfile and keeps
serving the extraction it already has. Repacking the tarball at the same path
changes nothing at the consumer. After a repack, bump the version you
pack or delete the tarball's lockfile entry; a plain `bun install` is not
enough.

## One alarm, many reasons

A Durable Object has ONE alarm, and a second `setAlarm()` silently overwrites
the first. Every alarm-driven subsystem therefore coordinates through a single
reason→deadline map in storage, with one dispatcher:

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

`schedule` keeps the earliest deadline per reason and arms the real alarm
at the minimum across all of them. `dispatch` snapshots the fireable set
before running any handler, so a handler that re-schedules itself is not
re-fired in the same dispatch. It drops unknown reasons silently, because a
rollback from a deploy that added reasons must not wedge the alarm. When no
reasons remain it deletes the map and does not re-arm, which lets the object
hibernate.

## Knowing which incarnation you are

Workerd recycles isolates freely: cold starts, hibernation wakes, and resets
all hand you a fresh module scope over the same storage. The isolate
generation is a persisted counter that increments once per fresh isolate.
Process IDs derive from it (`PID_GEN_STRIDE` = 1,000,000 in core's process
table). That gives the reset predicate everything else builds on: **a pid at
or below the current generation's base was allocated by a previous
incarnation.**

```ts
import { adoptGeneration, generation } from '@nimbus-sh/fabric';

export class MySession extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    await adoptGeneration(this.ctx);   // idempotent per instance
    // generation(this.ctx) is now this incarnation's generation
  }
}
```

The ordering inside matters: adopt the persisted value first, and bump only
after the `put` resolves. An unpersisted bump would be re-read by the next
boot and re-issued. Two instances would then share one generation, which is
the pid aliasing the counter exists to prevent. `await put()` returning is not
durability. The output gate keeps a pid from generation N from escaping before
N is on disk.

## The launch journal: surviving resets

The platform resets a Durable Object over what one turn has outstanding in
storage, and the reset destroys every write that turn had in flight. A
long-running launch holds everything in memory, so the process it is building
dies silently with the instance. A later instance reads the journal to learn
that this happened:

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

Two details cost us incidents before they became mechanisms:

- **`put` then `sync()`.** `await storage.put()` resolves before durability.
  Measured live: a launch killed in its first chunks left NO row for the
  replacement instance to find. The recovery this feeds sat inert while its own
  test stayed green. `sync()` is the storage layer's durability barrier. The
  journal writes through it on the way in and on the way out. The way out is
  delete-then-sync, so a reset moments after release cannot resurrect a process
  the user watched end.
- **The row lives for the process's lifetime, not the launch's.** Measured on
  staging, 2026-08-13: every observed reset struck seconds AFTER the launch
  settled. A launch-scoped row would already have been deleted when recovery
  went looking.

Recovery applies the generation predicate (`pid <= generationBase()`), deletes
each stale row, and re-drives once per record (`FENCED_WORK_MAX_ATTEMPT` =
1). One attempt is the limit, because a reset that recurs is not transient.

## Pacing big work across turns

One DO turn has a CPU budget of about 30 s. We were killed with `exceededCpu`
at 31.8 s and 32.5 s. Yielding inside an invocation buys nothing: CPU accrues
to the invocation, and only re-entering the object resets it. A long turn also
pins the actor's only thread, so the terminal WebSocket dies even when the work
succeeds. Progress cannot be measured in milliseconds, because the in-DO clock
does not advance without I/O (0 ms across 200,000 consecutive reads). The pacer
therefore accounts in bytes:

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

The pump awaits each resumed chunk, so the invocation that granted the turn
pays for the work. Nothing runs detached in a handler's microtask drain. A
past-deadline alarm is delivered as soon as the object is free, which makes
`schedule(..., Date.now())` a "re-enter now" primitive. Without an
alarm-capable host the pump degrades to a same-context timer. That is the
single-turn behaviour this path always had, and it is less responsive.

## Running programs: the isolate pool

`IsolatePool` runs plain functions in warm dynamic-worker isolates over
`env.LOADER`. Functions are serialized with `fn.toString()`, so they must be
self-contained: no captured variables, no `this` (rejected at dispatch), and
their last parameter receives the forwarded bindings.

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

Slots are stable (`slot = index % concurrency`), so a batch of 67 tarball
extractions reuses 4 warm isolates instead of paying 67 cold starts. Wasm
rides the loader's modules map as `{ wasm: ArrayBuffer }`. That is the only
path that works: request-time `WebAssembly.compile` is CSP-blocked, RPC of a
compiled `Module` is refused by structured clone, and inlining bytes into the
module source OOMs the supervisor.

The cache key folds the function hash, the preamble hash, a wasm fingerprint,
and the first 12 characters of the owning DO's id. That last term is a
security fix. Without it, session B's pool reused session A's warm isolate,
which still carried A's `env.SUPERVISOR` binding. B's writes landed silently
in A's filesystem while B's install reported success. Warm isolates are scoped
to one session unless a pool opts into `cacheScope: 'global'`, which is
reserved for stateless compute pools that take no supervisor binding and
retain no user state.

`Fanout` is the tier above. A single DO method can drive at most 4 concurrent
Worker Loader fetches. Batches of fewer than 5 tasks therefore run in the
coordinator through an `IsolatePool`. Wider batches shard deterministically
across sibling DOs, up to 32, dispatched in phases of 4 to bound simultaneous
cold starts. Transient peer resets retry on a 250/750/1500 ms schedule; an
overloaded peer gets the 1/3/6 s one.

Every fabric call into the loader lands on a per-DO ledger (`budgets.js`,
which also owns the module-map ceiling and the facet-ID count). The ledger
counts distinct ids ever gotten, plus live and peak concurrent Loader fetches,
read via `loaderLedgerStats(ctx)`. Each id permanently holds one of the ~5–6
dynamic-worker slots, because a keyed `loader.get(id)` is never released. A
"Too many concurrent dynamic workers" refusal classifies as
`dynamic_worker_cap` and names the ids holding slots. The ledger measures and
names failures; it does not gate admission. The platform's cap is approximate,
and a gate on an approximate number would refuse work the platform would have
run.

## Running processes: the resident fabric

A resident process (a dev server, a socket runner, an attached TUI) is a DO
facet whose class comes from a dynamic worker. `processes(ctx, env).spawn` is
the one way such a process comes into existence, and `ProcessFabric` is the
lifecycle around it:

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

The dynamic worker must export a Durable Object class named `NimbusProcess`
(`RESIDENT_PROCESS_CLASS`) with `startProcess(args)` and
`handleHttpRequest(request)`. Its `startProcess` declares one of two
contracts. `'lifetime'` holds the call open for the process's whole life and
settles at exit, as an attached TUI does. `'boot'` returns a payload once the
process is up, and the facet stays resident, as a server does.

Four pieces are worth knowing about:

- **The slot book.** A Durable Object admits 65,536 facets over its LIFETIME.
  The IDs are append-only and never reclaimed, so the bound counts facets ever
  created. Naming facets after pids burned one ID per spawn with no way back.
  Reusing a NAME costs no new ID, so facet names come from a per-DO free list
  (`proc-slot-<n>`, lowest reused first). A slot is released only after
  `facets.abort` + `facets.delete`, because a slot handed out during teardown
  would put two processes on one name. The book counts the names it mints
  durably: `facetIdBudget(ctx)` reports `{ consumed, budget }`, first uses
  only, adopted across resets. A creation failure with the budget consumed
  names the budget and the count, rather than repeating the platform's opaque
  message. Exhaustion is permanent for the object.
- **At-most-once start.** The facet's start callback re-running would
  re-execute the user's program, answering a request from a process the user
  never started. Both re-entry cases (released, lost) throw instead.
- **Boot specs name large members by VFS path.** A whole structured-clone RPC
  value caps at 32 MiB, and one node snapshot alone serialized to 44,252,709
  bytes. `vfsWasmModules` and `vfsTextModules` send paths. The hosting actor
  reads the bytes through the `ResidentDiskReader` it was given, inside the
  loader's cache-miss callback, so they exist only for the duration of the
  load. Text images are verified against the digest their own path claims,
  because a truncated image would otherwise boot as silently-wrong code.
- **The substrate is one deployment-wide value** (`createProcessHost`'s mode,
  `'facet'` or `'peer'`), never per-spawn. No program name, mode, or payload
  size reaches the choice.

What each substrate costs, measured on the production shape:

| | spawn | memory | CPU | SQLite |
|---|---|---|---|---|
| facet | 8–16 ms | independent (~208 MiB each) | SHARED | own |
| peer | 242–359 ms | independent | independent | own |

Facet CPU is shared because facets are separate isolates inside one actor
thread. Awaiting I/O yields the thread completely, but a deliberate 9,956 ms
CPU burn stalled a sibling for 9,966 ms. A peer pays roughly 20× the spawn
cost to buy that back. A peer also verifies its placement: it compares a
module-scope UUID token across the hop, and tries up to 4 sibling names. A peer
that co-located would share the CPU it was chosen to escape.

The substrates also differ in image delivery, and the `ProcessImageDelivery`
contract states the difference. A facet shares its session's Durable Object,
so the session's store is reachable by copy-on-write (`ctx.facets.clone`:
18–31 ms for a 45.73 MB corpus, 34–54 ms for 1 GB, flat because nothing is
copied). A facet also shares the session's ~10 GiB storage budget. A peer
brings its own budget and no reflink: clone is same-object-only, and workerd
exposes no `VACUUM INTO`, `ATTACH`, or `sqlite3_backup` across objects. Clone
carries a hazard we measured. ANY unresolvable `src`, such as a typo or a name
not created yet, silently EMPTIES the destination and reports success.
`cloneStorage` is the one way the fabric calls clone. It takes the caller's
`populated(name)` probe and asserts it positively on the source before the
clone and on the destination after. A typo is refused before the platform
call, and a wiped destination is never reported as success. An emptied facet
still shows a 4,096-byte database, one page, so the probe must find the
caller's own data rather than a non-zero size.

## The image store

`ImageStore` materializes generated boot images into a content-addressed
store (`var/lib/nimbus/facet-images/<sha256>.js`) through a small
`ImageBlobStore` port. The embedder owns the disk, and the store owns the
protocol:

- **Root before the first byte.** The whole root set is registered
  synchronously before any byte lands, so the sweep can never observe a
  written-but-unclaimed image, however many turns the write spans.
- **Sliced writes.** One transaction takes `FACET_IMAGE_WRITE_SLICE_BYTES`
  (a whole number of VFS chunks under the 1 MiB transaction bound). A slice
  ending mid-chunk forces a read-back, and an oversize write falls back to
  copy-on-write, which is quadratic. A 22.9 MB map written in one turn took
  the session down with it about 25% of the time. Slicing and pacing the write
  removed that.
- **Size equality is completeness.** A write only ever grows the file from
  offset zero, so an interrupted write leaves a strictly shorter file; the
  reader verifies the digest before the loader sees the bytes.
- **The sweep roots off the process table.** An image is live for as long as
  a process boots from it. There is no TTL and no eviction heuristic. After a
  reset the table is empty, so every orphan goes.

## Binding shims for inner workers

`NimbusLoaderRPC`, `NimbusLoadedWorker`, `NimbusLoadedEntrypoint`,
`NimbusAssetsRPC`, `NimbusDurableObjectNamespace`, and `NimbusDOStub` give a
dynamically-loaded inner Worker working `env` bindings. They exist because of
three platform behaviors, and each one cost a debugging session:

- **`WorkerStub` does not serialize**, so each hop a caller makes
  (`load → getEntrypoint → fetch`) is its own `WorkerEntrypoint` class.
- **Stubs are I/O objects bound to the request that minted them** ("Cannot
  perform I/O on behalf of a different request"). The shims therefore store
  CODE, never stubs, and re-resolve through `LOADER.get(id, cb)` in the
  current context. Workerd caches by id, so repeated loads are close to free.
  The code map is a hard-capped LRU of 32 entries: `wrangler dev`'s
  rebuild-on-save loop once grew it without bound to a 128 MiB isolate crash.
- **An RPC stub's method is a wildcard property**: `method.call(ep, request)`
  builds the pipelined path `method.call` and serializes `ep` as an argument,
  which workerd refuses ("Entrypoints to dynamically-loaded workers cannot be
  transferred"). Calls must be written `ep.method(request)`.

Nesting is capped at depth 4, and `NIMBUS_INNER_LOADER_DEPTH` raises it.
Nimbus-in-Nimbus works; five levels is a runaway.

## The platform, measured

These tables are the part of this package I most wanted to publish. They are
enforced by the code above where code can enforce them; the rest is here so
the next person does not have to measure them again. All figures are from
production workerd, June–August 2026.

The tables are the short form. [PLATFORM.md](PLATFORM.md) is the full
catalog: the same invariants merged with a sibling project's independent
measurements, every entry graded by evidence (probe / source / production /
documented), dated, and marked for whether this library enforces it or you
handle it yourself.

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

## Relation to the other packages

`@nimbus-sh/core` is the OS this machinery hosts; core never imports fabric.
[`@nimbus-sh/platform`](https://www.npmjs.com/package/@nimbus-sh/platform) is
the zero-dependency leaf under both: the measured limits tables, the error
taxonomy, RPC disposal, and the supervisor budget machinery.
[`@nimbus-sh/worker`](https://www.npmjs.com/package/@nimbus-sh/worker) is the
canonical embedder: it supplies the seams above, the supervisor entrypoint,
the session protocol, and everything user-facing. If you want the full hosted
product shape, start from `npx create-nimbus-app`. If you are building your
own thing on Durable Objects, take this package and its doc comments on their
own.

## License

MIT.
