# The Durable Object platform, measured

> Part of [Nimbus](https://github.com/AshishKumar4/Nimbus), my hobby/research
> cloud OS. This document is edited and maintained with Claude (AI) and
> presented as-is.

This is a catalog of Cloudflare's Durable Object platform, for anyone
building on it. It merges two records made independently on the same
account: the evidence-graded platform catalog of Proteus (a sibling agent
platform) and the measured invariants in this package's source. The two
projects hit the same walls, measured them separately, and cite each other.
Where they agree, this catalog states the fact once. Where they disagree,
the entry says so.

Every measured number comes from deployed production workerd between June
and August 2026, unless the entry says otherwise. `wrangler dev` does not
enforce the isolate memory cap (a probe isolate reached 822 MiB unkilled),
and its clock, storage, and trace behavior differ. A local run measures
bytes and API surface, not enforcement points.

## How to read an entry

Each entry carries an evidence label, so you can tell "Cloudflare documents
128 MB" from "we measured 128 MB".

- **probe** — a designed experiment against deployed production workerd,
  config pinned to what we ship.
- **source** — read in workerd's (or a dependency's) own source code.
- **production** — incident or log evidence, not a designed experiment.
- **documented** — Cloudflare publishes it. I re-read the documented entries
  from the live docs on 2026-08-17. I re-checked the memory, startup,
  subrequest, connection, size, and WebSocket figures on 2026-08-20.

Each entry also says who acts on it:

- **Enforced:** this library prevents or handles it in code; the named
  export does it.
- **Named:** this library detects the failure and names it honestly, but
  does not prevent it.
- **Yours:** advice. You follow it yourself.

Units are exact: MB and GB are decimal (10^6, 10^9 bytes), MiB and GiB are
binary (2^20, 2^30). Cloudflare writes storage sizes in decimal. Where a
number is Nimbus's own budget rather than the platform's, the entry says
**self-imposed**. Do not read a self-imposed number as a platform limit.

## Storage and durability

**`await put()` resolves before durability.** The output gate holds the
guarantee: a response cannot leave the object before the turn's writes
commit. `ctx.storage.sync()` is the explicit barrier. Measured live
(production, staging 2026-08-13): a launch killed in its first chunks left NO
journal row for the replacement instance to find. A confirmed `put` resolved
in 0 ms, because the await never waits for disk.
Enforced: `FencedWork.journal` writes put-then-`sync()` before the first byte
of real work. `release` deletes-then-syncs, so a reset moments later cannot
resurrect a process the user watched end.

**A reset destroys every write its turn had outstanding.** The platform
re-delivers a failed alarm to the replacement instance, so the first turn
after a reset can be a recovery turn. A promise still in flight when the
object resets is cancelled where it stands. No `.catch()` runs, nothing is
logged, and the caller was already told the operation succeeded (probe,
2026-08-17: a delayed write landed in 3,035 ms when awaited in the
invocation, returned in 12 ms under `waitUntil` and 10 ms as a bare floating
promise, and in both unawaited cases was LOST when `ctx.abort()` landed
first). Enforced: `FencedWork.recoverInterrupted` re-drives journalled
launches once (`FENCED_WORK_MAX_ATTEMPT` = 1). A reset that recurs is not
transient.

**`ctx.waitUntil()` is a no-op inside a Durable Object** (documented, and
proven by the probe above). workerd treats every task in an actor as a
wait-until task, so `ctx.waitUntil(p)` and a bare floating `p` are the same
code path. It exists for API compatibility with `ExecutionContext`. The name
suggests a durability decision, which is the hazard. The 30 s `waitUntil`
grace period is Worker scope only.
Yours: the only retention a Durable Object has is an await inside the
invocation. Journal work you cannot afford to lose. This library's own
recovery relies on the journal plus alarm re-delivery, never on `waitUntil`.

**SQLite caps a row at 2 MB, key length included** (documented). The bound is
per ROW, not per value. The measured single-value ceiling is 2,199,981 bytes
(probe). The same figure appears in workerd's own bounds check at
util/sqlite.c++:1362-1380 (source, 2026-07-24). Overflow throws a clean,
catchable `SQLITE_TOOBIG`, and reads and deletes keep working.
`SQLITE_MAX_ROW_BYTES` (2,000,000) in `@nimbus-sh/platform/limits.js` carries
the bound. Nimbus's VFS chunks file content at `CHUNK_SIZE` (65,536), so no
chunk row approaches it.

**Statement text caps at 100 KB, bound parameters at 100, columns at 100 per
table** (documented). The catalog reads 100 KB as binary KiB, because the
value is SQLite's compile-time `SQLITE_MAX_SQL_LENGTH` rather than a billing
quantity. That reading is unverified. The parameter cap is the easiest to hit
by accident: a batched insert of more than 100/columns rows in one statement
breaches it. Yours: bound generated statements; hand-written SQL never gets
there. `SQLITE_MAX_STATEMENT_BYTES` and `SQLITE_MAX_BOUND_PARAMETERS` carry
the numbers.

**Storage per SQLite-backed object is 10 GB (10^10 bytes), shared by the root
object, every facet beneath it, and every clone** (documented; quota sharing
proven by probe, 2026-07-24). A copy-on-write clone charges its FULL logical
bytes with no credit. At the wall, ordinary writes fail catchably
("database or disk is full: SQLITE_FULL") while SELECT, get(), list() and
DELETE keep working, so the recovery is to drain. A facet CLONE that crosses
the quota does NOT fail catchably: the object is reset and the destination is
left empty ("Internal error in Durable Object storage caused object to be
reset"). A deployed bisect put the real wall between 10,580,000,000 bytes
(fit) and 11,600,000,000 bytes (failed). 10 GiB (10,737,418,240) sits inside
that window, so it describes where the wall is and is not a number to design
to. Yours: budget against the published 10^10. Decide clone admission BEFORE
the clone, with reserve, on the arithmetic X·(N+1) ≤ quota. An alert at 99%
comes too late on a limit whose breach destroys the destination.
`DO_STORAGE_LIMIT_BYTES` carries the figure.

**`ctx.storage.sql.databaseSize` reports the calling object's own database
only** (probe, 2026-08-17). No platform API returns the shared quota total. A
headroom metric built on one facet's reading reports plenty of room while the
tree sits near the quota. Yours: aggregate the readings yourself, each
labeled with the scope it came from.

**The platform resets an object over what one turn has outstanding in
storage, not over what it eventually writes.** A 22.9 MB module map written
in one turn took the session down about 25% of the time (production). A
45.7 MB single-turn write reset the object once, then succeeded 12/12 on
retry. Enforced: `ImageStore` writes images in slices of
`FACET_IMAGE_WRITE_SLICE_BYTES` (a whole number of VFS chunks under the
1 MiB transaction bound, `MAX_TX_BLOB_BYTES`), paced across turns through a
`TurnBudget`.

**`ctx.storage` accepts a compiled `WebAssembly.Module` on `put()` and can
never read it back** (probe, 2026-07-24). The write succeeds; every later
`get` fails with "internal error". Yours: store bytes, compile at module
load.

**A facet's own SQLite survives isolate recycling.** 7,141 rows / 45.7 MB
came through a fresh module scope intact (production). Yours: keep
provenance in rows, never in the heap.

## Object lifecycle and resets

**Silent resets are detectable positively, with a persisted generation
counter.** Several platform terminations deliver no signal at all (see the
eviction entry), so no error taxonomy can construct a code for them. A
counter that increments once per fresh isolate turns the reset into a
measurement on the next call. Nimbus multiplies the generation into its
pid space, and observed it stepping 1000001 → 2000001 → 3000001 → 4000002
across four resets (probe, 2026-08-17). The counter must be persisted and
incremented in the constructor. Do not derive it from boot or isolate
identity. `ctx.facets.abort` kills in-flight work and KEEPS the same isolate,
so a boot-derived generation misses the most common way a child dies (probe,
2026-08-17). Enforced: `adoptGeneration(ctx)` adopts the persisted value
first and bumps only after the `put` resolves. `generation(ctx)` reads it.
The reset predicate is `pid <= generation base` with `PID_GEN_STRIDE` =
1,000,000.

**Eviction delivers nothing the object can catch** (production; eviction
cannot be forced, so no designed probe exists). workerd labels five reasons — `lru` (memory pressure),
`condemned` (operator or abuse kill), `inactive` (roughly 70-140 s without
traffic), `dynamic_worker` (per-owner LRU cap, default 50),
`dynamic_worker_banned` — and delivers none of them. The object stops, and
in-memory state and any promise driving work are gone. Yours: recover
from durable state alone, and simulate eviction as silent disappearance, not
as a throw. `WORKERD_EVICTION_LABELS` in `@nimbus-sh/platform` carries the
taxonomy.

**Some resets are safe to retry and some recur, and only the wording tells
them apart** (production). Transient: "Durable Object reset because its code
was updated.", "Internal error while starting up Durable Object storage
caused object to be reset", "Internal error in Durable Object storage caused
object to be reset", "Durable Object storage operation exceeded timeout which
caused the object to be reset." Recurring: "Durable Object's isolate exceeded
its memory limit and was reset" and the CPU twin. Both also end in "was
reset", so a matcher keyed on "reset" alone loops forever on a real OOM.
Enforced: `isTransientDoReset`, `classifyError`, and `classifyDoCall` in
`@nimbus-sh/platform/oom-classify.js` pin the signatures. Retries are
bounded, so the one storage-reset wording that is NOT transient (the quota
wall) recurs, exhausts the budget, and surfaces.

**One invocation has a CPU budget of about 30 s, and yielding inside it buys
nothing** (documented: default 30 s, configurable to 300 s; measured killed
with `exceededCpu` at 31.8 s and 32.5 s, and a facet burn died at roughly
33.8 s; the line is not stable in either direction, and one workload passed
in the morning and hit the limit the same afternoon under account load). CPU
accrues to the invocation. Only re-entering the object resets it.
Each incoming request or WebSocket message resets the remaining budget, but
burning past the limit BETWEEN inbound traffic raises the chance of eviction.
Enforced: `TurnBudget` and `PacedWork` suspend long work every
`TURN_CHUNK_MAX_BYTES` (2,000,000 bytes) and resume it on an alarm-granted
fresh turn. The invocation that grants the turn awaits the chunk it
released.

**A long turn drops the object's WebSockets even when the work succeeds**
(production: a launch turn finished `outcome=ok` and the terminal died
anyway). A Durable Object is single-threaded; a pinned thread cannot service
its sockets. A success response is not evidence the object survived the work:
a 128 MiB allocate-and-free returned 200 and the object died about 1.7 s
later (probe, 2026-07-24). Enforced: the same turn pacing as above.

**One alarm per object; a second `setAlarm()` silently overwrites the
first** (production). An alarm handler gets 15 minutes of wall clock
(documented, 900,000 ms). A turn resumed from an alarm inherits that bound.
An HTTP-triggered turn keeps an unlimited budget while its caller stays
connected. A past-due alarm is delivered as soon as the object is free,
which makes scheduling one at `Date.now()` a re-enter-now primitive.
The platform retries a failed `alarm()` and reports `isRetry`/`retryCount`.
Enforced: `timers(host, ctx)` multiplexes every alarm consumer through one
reason→deadline map. `dispatch` snapshots fireable reasons before running
any, so a handler that re-arms itself is not re-fired in the same dispatch.
It silently drops unknown reasons, because a rollback must not wedge the
alarm. It forwards the platform's `alarmInfo` to every handler, and deletes
the map when nothing remains so the object can hibernate.

**No pending alarm and no traffic means hibernation-eligible after about 10 s
idle** (production). `setTimeout`/`setInterval` with a pending callback
prevent hibernation. Yours: one-shot self-nulling timers only, and let the
alarm map empty itself.

**Module top level must evaluate within 1 second** (documented), and a Worker
bundle caps at 10 MB gzipped on Paid, 3 MB Free, 64 MB uncompressed
(documented). Every cold activation of every Durable Object pays the startup
cost. The startup window is also the only place code generation is allowed
(see the Worker Loader section).

**An in-flight request gets a 30 s grace period across a runtime update,
a few times a week** (documented). A runtime update is one non-code source
of a mid-turn death. Yours: treat any turn as interruptible.

## Facets

Facets are named child actors of a Durable Object, each with its own SQLite,
spawned with `ctx.facets.get(name, startCallback)`. Cloudflare opened them as
a public beta on 2026-04-13 (Workers Paid; announced with Dynamic Workers).
The docs cover `get`, `abort`, and `delete`. Everything else below
(`clone`, the count limit, the alarm restriction, the memory and CPU shape)
is measured, not documented, and carries no compatibility promise.

**Facet memory is independent; facet CPU is shared** (probe, 2026-07-24). A
facet's ceiling measured 208 MiB whether its parent held 0 or 128 MiB.
Eight facets at 192 MiB plus a 128 MiB parent were live at once: 1,664 MiB
under one object, across 40 confirmed-distinct isolates. Facets are separate
isolates inside ONE actor thread. Awaited I/O yields that thread (sibling
impact 0 ms). A deliberate 9,956 ms CPU burn stalled a sibling for 9,966 ms.
A sibling RPC that normally answers in 1 ms took 5,476, 6,082, and 5,146 ms
during a neighbour's burn. Against a neighbour running to the CPU cap it
took 33,833 ms. Two PEER Durable Objects under the same load measured 4 ms.
Yours: fan out across peer objects when you need CPU parallelism. More
facets parallelize memory, never CPU. A facet call can also exceed your own
RPC deadline because a sibling was busy, so read such a timeout as a
measurement of the neighbour.

**A facet cannot set an alarm** (probe: `setAlarm` from a facet throws
"Error: Facets currently cannot set alarms."). Everything time-driven routes
through the root object's single alarm. Enforced: `timers()` on the root is
that fan-in; `facetPool` documents the constraint on every lease.

**A facet stub is coordinator-local** (probe: any transfer attempt throws
"DataCloneError: Durable Object Facet stubs cannot be transferred between
Workers"). It cannot be stored, transferred, or re-invoked indirectly. Only
the parent can talk to its facets; every observation of a facet has to be
relayed. Yours: design the parent as the relay.

**`ctx.facets.abort` rejects pending work but KEEPS the isolate, its boot
identity, and its retained memory** (probe, 2026-08-17). `delete` is the
verb that wipes storage; `abort` keeps it. The two are indistinguishable at
the call site, and only one gives storage back. Proteus leaked a permanent
database for every exploration head by calling `abort` where terminal
teardown needed `delete`. Enforced: `facetPool(ctx).acquire(name, start)`
returns a lease whose disposal retires the facet (abort, then delete);
keeping storage takes an explicit `detach()`. A failed reclaim throws loudly,
because storage not given back is a permanent charge against the shared
quota.

**A Durable Object gets 65,536 facet ids over its LIFETIME, append-only,
never reclaimed** (source: workerd's FacetTreeIndex format, 2026-07-24).
Reusing a NAME costs no new id; a fresh name always does. Crossing the wall
is permanent for the object. The id count binds long before bytes. A fresh
facet database is 4,096 bytes, so Proteus's leak (15 fresh names per search)
would have hit the id wall at roughly 4,400 searches. A byte dashboard would
have read healthy the whole way. Enforced: the process fabric names facets
from a per-object free list (`proc-slot-<n>`, lowest first), so resident
processes reuse names. `facetIdBudget(ctx)` reports `{ consumed, budget }`
from a durable ledger that counts first uses only. `withFacetBudgetNamed`
names the budget on a creation failure at the wall, and `facetPool` refuses
a NEW name once the ledger reads 65,536.

**`ctx.facets.clone` is O(1) copy-on-write in time and full price in quota**
(probe). Measured flat across scale. One project: 18 ms for a 4 MB facet
and 54 ms for 1.05 GB. The other: 18-31 ms for a 45.73 MB corpus and
34-54 ms for 1 GB. It is same-object only, still absent from the public
docs and from `@cloudflare/workers-types`, and carries no compatibility
promise. ANY
unresolvable source name (`''`, `'.'`, `'..'`, `'/'`, `'root'`, `'0'`, or a
typo) SUCCEEDS, silently EMPTIES the destination, and reports nothing
(probe, 2026-08-17). An emptied facet still shows a 4,096-byte database, so
a size check proves nothing. Enforced:
`cloneStorage` is the one way this library calls clone. It takes the
caller's `populated(name)` probe and asserts it positively on the source
before the clone and on the destination after. A typo is refused before the
platform call, and a wiped destination is never reported as success.

**A parent and its facets evict together after 2-5 minutes idle** (probe:
observed window 120,000-300,000 ms). Facet SQLite persists; in-memory state
does not. An OOM is contained in BOTH directions: a facet OOM leaves the
parent running, and a parent OOM leaves the facet alive, same boot id, still
holding its memory. Yours: never assume in-memory facet state
between two RPCs.

**A facet's `ctx.id` is minted from the ROOT object's namespace** (probe,
2026-08-17). An id-keyed roster, log field, or UI grouping silently labels
every facet as its root. Yours: correlate on the object path, never on
`ctx.id`.

### The Worker Loader

A facet's class can come from a dynamically loaded Worker
(`env.LOADER.get(id, callback)`), which is how this library runs real
programs. The loader has its own walls.

**Code generation from strings is blocked at request time, everywhere**
(probe matrix plus workerd source jsg/setup.c++, 2026-07-24). `eval`,
`new Function(src)`, and WebAssembly compilation from bytes throw
synchronously ("Code generation from strings disallowed for this context";
"Wasm code generation disallowed by embedder") in a DO constructor, at
request time, in an alarm handler, inside a dynamically imported module, and
at loader-child request time. Allowed only at module top level, and that
window is a compat flag (`allow_eval_during_startup`, default on for compat
dates ≥ 2025-06-01). Two carve-outs: `new Function()` with no arguments
succeeds everywhere, and `WebAssembly.validate` is allowed everywhere.
`WebAssembly.compileStreaming` does not exist in workerd. Enforced:
`IsolatePool` ships wasm through the loader's modules map as
`{ wasm: ArrayBuffer }`, compiled at module load. That is the only path
that works: RPC of a compiled `Module` is refused by structured clone, and
inlining bytes into module source OOMs the parent.

**`env.LOADER.get(name, cb)` never re-runs the callback for a name already
loaded** (probe, 2026-07-24). New source under an old name silently serves
the FIRST bytes. Yours: version the loader id when the code changes; this
library folds a content hash into every loader key.

**A loaded child's `limits` cannot express memory, and its `cpuMs` is
accepted and then dropped by workerd OSS** (source, 2026-08-17). Nothing an
application writes bounds a child isolate's memory. Do not read the accepted
`cpuMs` value as a guard. Yours: design around the measured ceilings.

**The dynamic-worker module map caps at 67,108,864 bytes total, shared across
every member** (probe: 62 MiB lands, 64 MiB refused with "Dynamic Worker code
size (N bytes) exceeds the maximum allowed size of 67108864 bytes", five
sizes, two trials each). Boot cost is roughly linear in map bytes and not the
bottleneck: 40 MiB loaded in 1.42 s across 6,553 modules. A ruby process is
34.3 MiB down before its disk is counted. Enforced:
`assertModuleMapWithinCodeLimit` runs before the loader sees any map this
library assembles, and names the largest members. The platform's refusal
names none. `DYNAMIC_WORKER_CODE_LIMIT_BYTES` carries the number.

**One module's text has its own ceiling: 8 MiB raw was observed to fail
boot** (probe, 2026-07-24). The measurement is one-sided: the boots half of
the original boots/fails bracket was lost. The gate is on
JSON-encoded UTF-8 bytes, not raw content (escaping adds bytes; measure with
`TextEncoder`, since `String.length` undercounts non-ASCII). Nimbus's own
ceiling of 22 MiB encoded is self-imposed. Yours: name big members by path
and load their bytes lazily. This library's boot specs do this
(`vfsWasmModules`, `vfsTextModules`).

**A Durable Object admits about 5-6 concurrent dynamic workers, one DO method
drives at most 4 concurrent loader fetches, and a keyed `loader.get(id)`
permanently consumes a slot** (production; the refusal reads "Too many
concurrent dynamic workers"). The caps are the platform's and approximate.
Enforced: `Fanout` keeps small batches local (`IN_DO_THRESHOLD` = 5 sits
under the fetch cap by construction). It shards wider batches across up to 32
sibling objects, dispatched in phases of 4 to bound simultaneous cold starts.
Transient-reset retries run at 250/750/1500 ms, and overload retries at
1/3/6 s. Named: the loader ledger (`recordLoaderId`, `beginLoaderFetch`,
`loaderLedgerStats`) counts ids and live fetches per object, and
`withDynamicWorkerCapNamed` annotates a cap refusal with the ids that hold
slots. There is no admission control, on purpose: a gate on an approximate
platform number would refuse work the platform would have run.

**A warm loader isolate is a security boundary** (production incident).
Without a session term in the cache key, session B's pool reused session A's
warm isolate, which still carried A's supervisor binding. B's writes landed
silently in A's filesystem while B reported success. Enforced: `IsolatePool`
folds the owning object's id into every loader key; `cacheScope: 'global'`
is an explicit opt-in reserved for stateless compute that takes no
supervisor binding.

## RPC and stubs

**Serialized RPC arguments and return values cap at 32 MiB** (probe: the
runtime's own words, "Serialized RPC arguments or return values are limited
to 32MiB", on the facet path). This retires an older unsourced 32 MiB claim
for ordinary Workers RPC. That claim had the right number and no citation.
Nimbus ships at most 28 MiB per value (`MAX_RPC_SAFE_PAYLOAD_BYTES`,
self-imposed: about 6% structured-clone headroom). Real payloads cross the
cap fast: one node disk snapshot serialized to 44,252,709 bytes. Enforced:
boot specs name large members by VFS path and the host reads bytes in 4 MiB
ranges, so nothing large is ever an RPC argument.

**Some values refuse to cross any boundary at any size** (probe): a compiled
`WebAssembly.Module` ("Unable to deserialize cloned data.", including a
same-isolate `structuredClone`), a WorkerLoader binding ("Could not serialize
object of type \"WorkerLoader\"."), and a WebSocket. Proteus paid for the
last one in production: an upgrade path passed a WebSocket as a DO-RPC
argument and 500'd every daemon connect. Named: `classifyError` maps clone
refusals to their own class (`clone_refused`), distinct from OOM.

**RPC resolves a method on the receiver's PROTOTYPE CHAIN** (probe, verified
against workerd 1.20260601.1, 2026-08-16). TypeScript `private` is erased and
therefore callable from any stub-holder by a cast. Superclass methods are
reachable too: an inherited `sql` helper hands any caller arbitrary SQL. Own
instance properties are NOT reachable, and workerd rejects them as it
rejects a missing name ("The RPC receiver does not implement the method
\"x\"."). Only `#private` is hidden. Enforced: `sealRpcSurface(instance,
surface)` shadows every reachable name not on the declared surface with a
non-enumerable own property. In-process behavior does not change, and RPC
access is gone. `PLATFORM_RPC_SURFACE` and `AGENTS_FACET_RPC_SURFACE` are
the shipped, versioned allowlists (verified against `agents@0.20.1` and
`partyserver@0.5.10`, 2026-08-19; a CI test diffs them against the installed
packages so SDK drift fails the build instead of leaking a method).

**A stub is an I/O object bound to the request that minted it** (production:
"Cannot perform I/O on behalf of a different request"). Store CODE, never
stubs, and re-resolve through `LOADER.get(id, cb)` in the current context.
Repeated loads are close to free, because workerd caches by id. The code map
must be bounded: an unbounded one grew under `wrangler dev`'s rebuild loop
to a
128 MiB isolate crash. Enforced: the binding shims (`NimbusLoaderRPC` and
friends) store code behind a hard-capped LRU of 32 entries.

**`WorkerStub` does not serialize, and entrypoints to dynamically loaded
workers cannot transfer across Workers** (production: "Entrypoints to
dynamically-loaded workers cannot be transferred"). Each hop is its own
`WorkerEntrypoint` class; HTTP crosses a hop as parts with plain
`ReadableStream` bodies, re-piped through an identity stream the receiving
isolate owns. An RPC method is also a wildcard property:
`method.call(ep, request)` builds the pipelined path `method.call` and
serializes `ep` as an argument, which workerd refuses. Always write
`ep.method(request)`. Enforced: the shims in `bindings.js` implement the
per-hop classes and the parts transport.

**An RPC stub call must stay a direct property call awaited by its own
frame** (production, staging: wrapping the call in an accounting-owned async
frame poisoned the hosting object after every pooled dispatch, 7/7 measured,
gone 3/3 with the direct call restored). Enforced: `beginLoaderFetch(ctx)`
returns a begin/end pair that BRACKETS the call instead of wrapping it.

**workerd constructs a NEW `WorkerEntrypoint` instance per RPC call**
(production). Instance fields are write-only across calls. Yours: fold state
through return values or durable storage.

**A binding minted BY an actor lives as long as the actor; one minted by a
stateless entrypoint dies with the request** (production). A hosted
process's supervisor binding therefore comes from the Durable Object, so
nothing has to hold a call open to keep it alive.

**RPC resources need explicit disposal, including on error paths**
(production: a timeout's reject closure rooted a 28 MiB payload for the full
timeout). Enforced: `disposeRpcResource` / `useRpcResource` in
`@nimbus-sh/platform/rpc-dispose.js`; every pool and verb in this library
disposes the stubs it mints.

**Retry only what cannot have run, on a fresh stub, and never retry an
overloaded object** (documented error-handling contract plus both projects'
production experience). Many exceptions leave a stub permanently broken, so
each attempt needs a fresh one. A wrapper error drops the `.retryable` and
`.overloaded` properties, so classification also matches the rendered cause
chain (production). Enforced: `idempotent(op, stubResolver, call)` retries
transient classes up to 3 attempts with full-jitter backoff in
[0, 2^attempt × 60 ms). `mutating(op, stubResolver, call)` NEVER retries,
because a dropped call that appends, sends, charges, or mints may already
have run. It surfaces a typed `DoCallError` carrying the classification.
`classifyDoCall` names the classes; `overloaded` is never retried by either
verb.

## Isolate memory

**The documented limit is "each isolate can consume up to 128 MB", and it is
not the operative ceiling of a Durable Object.** Four probes put four
different walls, each answering a different question:

- **Single-burst allocation, catchable:** 248 MiB allocates, 256 MiB throws
  "Error: Worker exceeded memory limit." The object survives and the
  caller can degrade (probe, 2026-07-16).
- **Memory that must survive across RPCs, silent:** the wall is roughly
  180-200 MiB. Past it the object is reset with NOTHING thrown or logged on
  any surface; the boot id changes and in-memory state is gone (probe,
  2026-07-23). The same bytes either throw or silently destroy the object,
  depending on whether they outlive one turn.
- **Transient allocate-and-free in the DO context:** 96 MiB survived,
  128 MiB reset the object about 1.7 s later, after the request returned
  200 (probe, 2026-07-24).
- **Real workloads die lower than ladders:** a natural workload was killed
  at 130-150 MB on a worker whose deliberate allocation ladder reached
  200-250 MB. The kill is burst- and pressure-sensitive, not a static
  capacity line (probe, 2026-07-24). A budget derived from a ladder
  overstates what real work gets. Read this bullet before you trust any
  other memory number here.

Facets get their own independent envelope (~208 MiB each, previous section),
and peer Durable Objects measured 1.2 GiB live across 8 peers. Yours: budget
the retained working set against the silent wall, not the catchable one.
Prefer reducing allocation rate over shaving static bytes.

**Peer Durable Objects normally get their own isolates, and memory pressure
between them is real but conditional** (probe, 2026-07-23: eight peers on
eight distinct isolates; four peers held 100 MB each without incident; at
120 MB each, one of four silently lost its retained bytes). Nimbus earlier
read its resets-below-apparent-usage as peers sharing one 128 MiB isolate.
The probe found peers of one class on distinct isolates, so conditional
pressure fits the evidence better. Both projects agree that a peer's budget
is real but not guaranteed: one peer can silently lose its retained bytes
while its siblings continue.

**`process.memoryUsage()` returns 0 for every field inside a Durable Object**
(source). Any containment check built on it is vacuous. Enforced:
`@nimbus-sh/platform/heap-estimate.js` sums instrumented allocation sources
into a deterministic lower bound and lists what it cannot see
(`HEAP_BLIND_SPOTS`). The supervisor's 64 MiB soft ceiling
(`SUPERVISOR_HEAP_CEILING_BYTES`) and 40 MiB in-flight allocation budget are
self-imposed admission numbers, not measurements.

**`exceededMemory` and `exceededCpu` are uncatchable inside the dying
isolate** (production). The strings are observable only by a caller across
an RPC boundary, and isolates also vanish with no message at all. A missing
error message is not evidence that no kill happened. Named: `classifyError`
pins the message families (memory: "Worker exceeded memory limit.",
"Durable Object's isolate exceeded its memory limit and was reset",
"Memory limit exceeded"; CPU: "Worker exceeded CPU time limit.",
"Durable Object exceeded its CPU
time limit and was reset."). Never fold the two: a CPU kill recurs on the
same input, a memory kill on the same working set, and they need different
remedies.

**`SQLITE_NOMEM` and `SQLITE_FULL` are storage-layer refusals, distinct from
isolate OOM and from each other** (production). NOMEM wants a smaller
transaction. FULL (the 10 GB wall) wants a drain, and reads and deletes
still work. Named: `classifyError` keeps all three classes separate.

**workerd runs V8 with pointer compression, and per-element cost is not
flat** (probe, 2026-08-17): 12.6 bytes per array element at 1,000 elements
falls to 4.64 at 13,107 as the fixed heap floor amortizes. Node 22 measures
8.04 in-heap. Use the asymptotic 4.6-5.2 figure, and only at the large end.
The probe also confirmed `wrangler dev` does not enforce the production cap
(822 MiB unkilled locally).

**A Durable Object dies at roughly 200 MiB of live wasm linear memory, and
reserved pages count the same as written ones** (production). Lazy growth
buys nothing. Yours: bound guest memory by rewriting the wasm memory
section, not by hoping pages stay untouched.

## WebSockets and hibernation

**A hibernated WebSocket keeps its serialized attachment and its tags;
everything in isolate memory is gone on wake** (source, 2026-08-16). An
in-memory per-connection allowlist silently widens to full access on wake,
so authorization state belongs in a tag. Enforced: `connections(ctx, schema)`
keeps NO in-memory mirror and re-derives `ctx.getWebSockets` on every read.
It validates every attachment read and write against the caller's schema,
because an attachment outlives the deploy that wrote it and is untrusted
input on the way back.

**The attachment caps at 16,384 serialized bytes** (source: workerd
v1.20260603.1, web-socket.h, `MAX_ATTACHMENT_SIZE = 1024 * 16`; the same
figure is now documented). Older references say 2,048 bytes. That limit has
moved, so do not design to the stale figure. The bound is on the serialized
form (workerd re-serializes on every `serializeAttachment` call to check
it), so a JSON length is only an approximation. Attachments are
structured-cloned, not JSON-encoded: a `Set` survives as a `Set` and
silently fails an array schema on read (probe). Enforced: `connections`
validates on WRITE, turning the silent read-side null into a loud
write-side error, and names the platform's refusal ("A WebSocket
'attachment' cannot be larger than 16384 bytes.") with the approximate size.
`WS_ATTACHMENT_LIMIT_BYTES` carries the number.

**A Durable Object can receive a WebSocket message up to 32 MiB**
(documented). Nothing is published for the outbound direction.

**The runtime answers RFC 6455 protocol pings itself without waking a
hibernated object** (documented). An application-level keepalive is an
ordinary message, so it wakes the object every interval. An idle tab pinging
once a minute costs about 2,880 wakes per day (production). Enforced:
`configureWsHibernation(ctx)` registers a `ping`/`pong` auto-response pair
(matched text frames stop waking the actor; the config survives
hibernation) and bounds each hibernatable event handler at 5,000 ms
(`NIMBUS_HIBERNATION_EVENT_TIMEOUT_MS`). The wall-time bound is not the CPU
budget: a handler blocked on I/O trips it without burning CPU, so
`classifyError` does not bucket it as `cpu_exceeded`.

**Whether Cloudflare's edge reaps an idle WebSocket at about 100 s is
UNVERIFIED.** The claim traces to a deleted audit document that said
"documented" and cited nothing. Cloudflare's limits and best-practices pages
publish no such figure (read 2026-08-17). The mitigation is verified: a 25 s
application heartbeat kept a connection alive through 110 s of idleness
(probe). That heartbeat is the expensive wake the auto-response entry above
avoids.

**A hibernatable WebSocket owned by a Durable Object cannot be written from
a sibling `WorkerEntrypoint` isolate** (production). Sends must happen in
the object's own context; relay into it.

**A WebSocket upgrade cannot ride an RPC hop** (production). A 101 response
owns a live socket, and RPC's Request/Response transport reconstructs values
rather than handing sockets over. A hosted process CAN serve WebSockets.
The upgrade takes the fetch-semantic path on every hop: a facet is fetched
directly, and a peer is fetched as a service binding, which then fetches its
hosted facet. A per-process capability pair rides in headers, so nothing
that did not open the process can forge the route. A target without that
entrypoint answers 501. Earlier versions of this library could not serve a
WebSocket from a resident process; that limitation is gone. Enforced: the
hosts behind `createProcessHost` keep upgrades on `fetch` for every hop.

## Subrequests and external I/O

**Subrequests cap at 10,000 per invocation on Paid, 50 on Free**
(documented). Every `fetch()` plus every KV, R2, D1, or binding call counts,
and each hop of a redirect chain counts separately. A refused subrequest is
catchable: "Too many subrequests." One conflict between the two projects
stands unresolved: Nimbus also lists the subrequest cap among terminations
it has NO first-party signal for. Two distinct situations probably explain
it: a refusal your code can catch, and a platform-side termination it
cannot. Nobody has probed the second. Named:
`classifyError` maps the catchable refusal to `subrequest_cap`.

**At most six connections per invocation wait for response headers at once;
the seventh call QUEUES rather than fails** (documented). Workers reached
through a service binding share the budget of the top-level request. Once
headers arrive a connection stops counting. The breach presents as latency,
never as an error: N parallel outbound calls inside one invocation serialize
past six. Yours: spread wide fan-out across objects, and suspect this before
you blame the upstream.

**A single Durable Object sustains roughly 1,000 requests per second, soft**
(documented). Past it the runtime queues and then sheds with "Durable Object
is overloaded." The object is alive and the work never started, so the call
is safe to re-attempt. Back off long enough for the queue to drain, because
retrying hot is what overloaded it. Enforced: `isDoOverloaded`
detects the shed. `Fanout` retries overloaded peers on the 1/3/6 s schedule,
an order of magnitude longer than its reset schedule. The `idempotent` /
`mutating` verbs never retry overloaded at all.

## Coherence

**The input gate closes around STORAGE operations, not around network
awaits** (probe, 2026-08-16). An object parked inside a long await answers a
pure read in 1 ms. A slow read on a busy object is a cold start or an
activation gate, never "the object is single-threaded and busy talking to
the network." Input gates do close across `get`/`put`, so set-if-absent is
atomic per object with no CAS loop.

**The output gate holds a response until the turn's storage writes commit**
(source: workerd io-gate.h). It makes `await put()` look synchronous, makes
sync KV writes safe, and leaves an await inside the invocation as the only
durability an object has (see Storage).

**A `blockConcurrencyWhile` callback still pending at about 30 s is
cancelled and the object is RESET** (probe, 2026-08-16: reset observed at
31 s against a 31 s-busy dependency; cold activations tracked a busy
neighbour 1:1 at 2,303 / 10,215 / 25,212 ms; a clean gate on the same busy
neighbour cost 339 ms worst-of-four). Every event queued behind the gate
dies with it: "A call to blockConcurrencyWhile() in a Durable Object waited
for too long. The call was canceled and the Durable Object was reset."
partyserver runs `onStart()` inside this gate. Its
`void | Promise<void>` signature lets an `async` override typecheck while it
resets the object under load. Enforced: `onColdStart(ctx, task)` defers
per-incarnation reconciliation off the gate entirely; `runColdStart` drains
it on the first turn the embedder owns (loom wires this as
`deferToColdStart`). `BLOCK_CONCURRENCY_CANCEL_MS` carries the threshold.
Yours: never await a cross-object call on the gate path.

**`ctx.storage.kv` on a SQLite-backed object is synchronous, with
a per-value cap of about 2.2 MB** (behavior probe 2026-07-24; the cap read
in workerd util/sqlite.c++:1362-1380, source). A local storage read is a
blocking pread on a local file; it cannot stall the init gate. This sharpens
the gate rule: local reads are free, and the cross-object AWAIT is the risk.

**`Date.now()` does not advance between I/O operations** (source; 0 ms
across 200,000 consecutive reads). It is a timing side-channel mitigation,
not a bug. Wall-clock durations measured inside a turn advance only across
awaits; a CPU-bound span reads as 0 ms however long it burns. Enforced:
`TurnBudget` paces work in BYTES, which the work is proportional to.
Deadlines go to the alarm, which the host clock does honor.

**`Atomics.wait` is unavailable in every context, with no flag to enable
it** (probe plus source: `SetAllowAtomicsWait(false)` appears once in
workerd, unconditional, before any worker code runs). SharedArrayBuffer,
growable SABs, shared wasm memory, and `Atomics.waitAsync` all work. A
spin-wait substitute cannot work: one thread, no concurrent mutator, and a
frozen clock the loop cannot observe.

**A wasm stack suspended by JSPI in one request cannot resume in another**
(probe: three same-context resumes took 6 ms; the first cross-context resume
hung to a 30 s timeout). A suspended computation is request-scoped. Yours:
complete or checkpoint wasm work within the invocation that started it.

## What this catalog covers

It lists Nimbus's own policy numbers only where they are routinely mistaken
for platform facts, and each of those says self-imposed. Where a measurement
survived only in part (the per-module boot bracket), or a claim traces to
nothing (the 100 s edge reap), the entry says so. Every entry carries its
date. If you re-measure an entry and get a different number, the platform
may have moved.
