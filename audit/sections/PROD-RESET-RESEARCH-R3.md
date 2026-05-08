# PROD-RESET-RESEARCH — R3: workerd "facets" — Nimbus's pool vs. the public DO Facets primitive

Research scope: disambiguate the two distinct things in our codebase
that both get called "facet"; document the public DO Facets primitive
and its memory/lifecycle/storage isolation; quantify the 32 MiB
structured-clone wall and how W7 streaming bypasses it; understand
cross-facet RPC overhead vs in-supervisor.

---

## R3.0 Two distinct concepts both called "facet"

❗ ARCHITECTURE-IMPACTING — terminology collision.

| Name | What it is | Memory model | Storage model |
|---|---|---|---|
| **Nimbus "facet"** (lowercase) | A `LOADER.get(id, ...)`-spawned dynamic Worker, managed by `src/parallel/facet-pool.ts` (NimbusFacetPool). Used for npm install, pre-bundle, cirrus-real, etc. | Each spawned Worker is its own V8 isolate with its own 128 MB cap (per R2.2). | No persistent storage — it's a stateless Worker. Bytes flow via RPC stub or via R2/KV bindings injected through env. |
| **Cloudflare DO Facet** (capitalized "Facet") | A child Durable Object class spawned via `this.ctx.facets.get(name, callback)` inside a parent DO. Public, GA. | Each Facet is a separate isolate w/ own 128 MB AND lives within the parent DO instance (R3.4). | **Each Facet has its OWN ISOLATED SQLite database** within the parent's overall DO. |

Nimbus today uses ONLY the lowercase form. The capitalized public
primitive was not on plan §3's radar. R3.5 evaluates whether to
adopt it.

---

## R3.1 Nimbus's NimbusFacetPool — what it actually is

✓ CONFIRMED via source code review.

`src/parallel/facet-pool.ts` is a custom Nimbus abstraction layered on
top of `env.LOADER.get(id, callback)`. The "facet" terminology
predates the public DO Facets primitive (which shipped with the
2026-04-01 compat date per `wrangler.jsonc:5`); the codebase chose
the name because each pool slot LOOKS like a "side facet" of the
supervisor.

What NimbusFacetPool actually does:
- Maintains a pool of `WorkerStub`s (returned by `env.LOADER.get(...)`)
  keyed by a per-pool tag (e.g. `'pre-bundle'`, `'pre-resolve'`,
  `'pre-bundle-batch'`).
- Caches stubs across pool.submit() calls so isolates stay warm.
- Submits work via `stub.getEntrypoint().fetch(req)` — using the
  Service Binding loopback pattern.
- Handles `concurrency` via internal `pLimit` rather than fanning
  out across multiple stubs (i.e. relies on per-stub PARALLEL
  isolate execution from R2.4 — but that's "never guaranteed",
  so today's pLimit is single-isolate-bound work).

Key file:line references:
- `src/parallel/facet-pool.ts:461` — "W5 Lever 5: record the
  dispatch so /api/_diag/memory shows the dispatch path"
- `src/parallel/facet-pool.ts:519-521` — "~56 MiB of slice memory in
  the supervisor heap for a full ... Mossaic ... enough to push a
  shared isolate over the 128 MiB cap"
- `src/npm-installer.ts:1485-1491` — `new NimbusFacetPool(this.env,
  this.ctx!, { concurrency: PRE_BUNDLE_CONCURRENCY, timeoutMs:
  60_000, retries: 0, tag: 'pre-bundle', preamble: PRE_BUNDLE_PREAMBLE,
  wasmModules: { 'esbuild.wasm': wasmBytes } })`

The stub-caching at `src/supervisor-rpc.ts:38-220` is **legitimate
per the public docs** — the platform's `LOADER.get()` is itself a
caching primitive, and the docs explicitly say "isolates may be kept
warm in memory for a while" (R2.2).

---

## R3.2 Per-Nimbus-facet memory: own 128 MB

✓ CONFIRMED per R2.2. Each `NimbusFacetPool.submit()` dispatches a
`stub.fetch()` which executes in a Dynamic Worker isolate with its
own 128 MB.

The slice-walker comment at `src/npm-installer.ts:1393-1416` already
documents the calculation:

> Peak supervisor footprint during this phase:
>   max-in-flight = PRE_BUNDLE_CONCURRENCY (= 1)
>   per-in-flight = up to SLICE_CAP_BYTES (28 MiB) slice + few-MiB
>   bundle output + spec metadata ≈ ~34 MiB
> ...
> Multiple DOs from the same script can land in the same V8 isolate,
> sharing its 128 MiB cap.

So Nimbus correctly understands per-facet 128 MiB AS WELL AS the
shared-isolate-cohort risk for the parent DO. What plan §3 §3.2.2
A'.2 ("stream pre-bundle slices via RPC handle") does is push the
slice OUT of the supervisor — moving its peak from supervisor heap
(128 MB shared) to facet heap (128 MB own).

---

## R3.3 Lifecycle / teardown / reuse — Nimbus facets

⚠ UNVERIFIED specific TTL but architecturally bounded.

Per [Dynamic Workers — get](https://developers.cloudflare.com/dynamic-workers/api-reference/#get):

> the isolate may be kept warm in memory for a while

No documented TTL. The runtime decides. The empirical observation in
Nimbus tail data (audit/probes/prod-reset-investigation/tail-LIVE.jsonl)
showed 36 `outcome=canceled` SupervisorRPC frames in the 14-minute
window — these are normal facet teardowns AFTER work completes.
wallTime for canceled frames ranged 23 ms – 2662 ms; typical
~600 ms. So Nimbus facets get torn down within ~3 s of completing
their fetch. They DO NOT persist across multiple supervisor
invocations unless `LOADER.get()` is re-called with the same ID,
in which case the platform may reuse a still-warm isolate (R2.2).

Cross-facet RPC overhead:
- Same-runtime-process: ~submillisecond (in-process Cap'n Proto).
- Cross-region (Smart Placement disabled per ws-hibernation comment
  ✓ CONFIRMED via [RPC limitations](https://developers.cloudflare.com/workers/runtime-apis/rpc/) "Smart Placement is currently
  ignored when making RPC calls. ... Worker A will run locally,
  on the same machine."): no cross-region cost.
- Structured-clone overhead: bounded by 32 MiB per RPC call (R3.6).
- Stream-bridge overhead: zero — bytes flow with backpressure.

For Nimbus this means cross-facet RPC is effectively free in CPU
terms. The only real cost is the 32 MiB structured-clone wall
(R3.6) and the 6-simultaneous-headers cap (R2.8).

---

## R3.4 The PUBLIC DO Facets primitive — `this.ctx.facets`

❗ ARCHITECTURE-IMPACTING — this is the platform feature plan §3 was
ignorant of.

[Durable Object Facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/):

> Durable Object Facets let you load a Durable Object class from a
> Dynamic Worker and run it as a child of your own Durable Object.
> The child (the facet) gets its own isolated SQLite database, while
> your class acts as a supervisor that controls access.

### Architectural model

> A facet-based setup has three layers:
> * **Supervisor class** — A normal Durable Object class
> * **Dynamic code** — Code loaded at runtime through the Worker
>   Loader API. This code exports a class that extends DurableObject.
> * **Facet** — An instance of the dynamic class, created by calling
>   `this.ctx.facets.get()` inside your supervisor. Each facet has
>   its own SQLite database, separate from the supervisor's.

> The supervisor's database and the facet's database are stored
> together as part of the same overall Durable Object. The dynamic
> code cannot read the supervisor's database — **it only has access
> to its own.**

### API surface

```js
// Inside the supervisor DO:
const facet = this.ctx.facets.get('app', async () => {
  const worker = this.env.LOADER.get(codeId, async () => ({
    compatibilityDate: '2026-04-01',
    mainModule: 'worker.js',
    modules: { 'worker.js': AGENT_CODE },
    globalOutbound: null,
  }));
  const appClass = worker.getDurableObjectClass('App');
  return { class: appClass };
});
return await facet.fetch(request);
```

> If the facet has not started yet, or has hibernated, the runtime
> calls `getStartupOptions` to determine what code to load.
> Otherwise, the existing facet is reused and the callback is not
> invoked.

> #### `abort(name, reason)`
> Shuts down a running facet and invalidates all existing stubs.
> Any subsequent call on an invalidated stub throws `reason`.
> **The facet's storage is preserved.** After aborting, you can
> call `get()` again to restart the facet — including with a
> different class.

> #### `delete(name)`
> Aborts the facet (if running) and **permanently deletes its
> SQLite database**. If you call `get()` with the same name
> afterward, the facet starts with an empty database.

### Memory model — same isolate or different?

The docs do NOT explicitly state whether DO Facets get their OWN
isolate or share the parent supervisor's 128 MB. But:

1. The dynamic-code path goes through `env.LOADER.get(...)` →
   spawns a Dynamic Worker (R2.2 — own isolate w/ own 128 MB).
2. `this.ctx.facets.get` uses `worker.getDurableObjectClass(...)`
   which yields a DurableObject CLASS, not an instance. The class
   is loaded INTO the Dynamic Worker's isolate.
3. The facet IS a DO running inside that Dynamic Worker isolate.

⚠ UNVERIFIED but strongly implied: each DO Facet is a DO instance
running inside its own LOADER.get() Dynamic Worker isolate. So:

- Own 128 MB heap (R2.2).
- Own SQLite database within the parent's overall DO.
- Own constructor / lifecycle.
- Cannot read parent's storage.
- Hibernates independently of parent (the docs say "If the facet has
  not started yet, or has hibernated").

This is **architecturally what plan §3 was reaching for** with
Track A' but cleaner. The Facet primitive bundles the
"separate isolate + separate SQLite + supervisor controls access"
pattern as one platform feature.

### What about Nimbus's existing patterns?

Nimbus today does NOT use `this.ctx.facets`. We use:
- `env.LOADER.get(...)` to spawn a Dynamic Worker that DOES NOT
  extend DurableObject (just a `WorkerEntrypoint`).
- The Worker's RPC entry-point (`SupervisorRPC` / etc.) is called via
  the stub.

To use DO Facets, we would need our facet class to `extends
DurableObject` (not WorkerEntrypoint) AND we'd need to migrate it
into a class that `worker.getDurableObjectClass(...)` can extract.

The migration cost is meaningful — every facet class we have today
(`SupervisorRPC`, `CirrusHmrRPC`, the npm-resolve-facet, etc.) is a
WorkerEntrypoint. Moving them to DurableObject changes their
contract (they get `this.ctx.storage` instead of `this.ctx.props`,
they participate in the DO lifecycle including hibernation).

But the payoff is large for the heavy-storage facets:
- pre-bundle facet would get its OWN SQLite for caching transformed
  bytes — currently we round-trip through R2 + supervisor SQLite.
- npm install facet would get its OWN SQLite for tarball metadata
  — currently the supervisor's VFS holds extracted package files.
- vite dev facet (cirrus-real) would get its OWN SQLite for vite's
  dep-cache — currently it stores via supervisor VFS RPC.

---

## R3.5 Should Nimbus migrate to DO Facets? Decision matrix

**Pros**:
1. Each heavy workload gets ITS OWN SQLite (10 GB). The supervisor's
   storage stops being a shared bottleneck.
2. Each heavy workload gets ITS OWN 128 MB heap (already true for
   Nimbus facets, but DO Facets formalize it).
3. Facets hibernate independently — vite dev facet can hibernate
   while terminal facet stays alive.
4. The platform handles facet lifecycle. Less code in
   `NimbusFacetPool`, `npm-installer.ts`, etc.

**Cons**:
1. Migration is non-trivial — every WorkerEntrypoint becomes a
   DurableObject. Constructor signature changes. Storage API is
   different. Lifecycle changes.
2. DO Facets are NEWER (compat date 2026-04-01-ish; Nimbus already
   uses this date so we're OK on the floor). Less battle-tested.
3. The `ctx.facets.delete(name)` semantic is "permanently deletes
   SQLite" — we'd need a careful schema design so we don't
   accidentally drop user state.
4. Facet hibernation is independent — a facet that's been idle
   may need cold-start time on next use. For pre-bundle this is
   probably fine; for vite dev, less ideal.

**Verdict for plan §3**: DO Facets are a SUPERSET of Nimbus's
NimbusFacetPool capability. The migration is a multi-wave effort
that should follow Track A'/B'/C' completion, not precede it.
Plan §3 should reference DO Facets as the LONG-TERM target shape
but should NOT require migration to DO Facets in the first round
of architectural fixes.

Specifically:
- Track A'.2 ("stream pre-bundle slices via RPC handle") — keep as
  drafted; doesn't require DO Facets.
- Track A'.4 ("default cirrus-real, deprecate in-supervisor vite") —
  cirrus-real today is a Nimbus-style facet. Migration to a real
  DO Facet is a follow-up wave.
- Track B' (state in SQL) — plan §3 says "supervisor's SQL". If we
  later migrate to DO Facets, that storage would split per facet.
  Design Track B' so migrating later is easy (e.g. each subsystem
  owns a clearly-named SQL namespace within the supervisor's DB,
  so moving it to a Facet's own DB is a name-scope change).

---

## R3.6 32 MiB structured-clone wall

✓ CONFIRMED ([Workers RPC limitations](https://developers.cloudflare.com/workers/runtime-apis/rpc/)):

> The maximum serialized RPC limit is 32 MiB. Consider using
> ReadableStream when returning more data.

> ## ReadableStream, WriteableStream, Request and Response
>
> You can send and receive ReadableStream, WriteableStream, Request,
> and Response using RPC methods. When doing so, bytes in the body
> are automatically streamed with appropriate flow control. This
> allows you to send messages over RPC which are larger than the
> typical 32 MiB limit.
>
> Only byte-oriented streams (streams with an underlying byte source
> of `type: "bytes"`) are supported.

So the W7-style streaming pattern Nimbus uses (ReadableStream over
RPC for large bytes) is the official Cloudflare-recommended way to
go past 32 MiB. ✓ CONFIRMED Nimbus uses this correctly (see
`src/sqlite-vfs.ts:1172` "W7 — streaming bulk-write").

For plan §3 Track A'.2 (pre-bundle slice streaming): the proposed
"facet pulls bytes via SUPERVISOR.readSliceChunk(specifier, offset,
len) RPC" is one valid pattern. An EVEN BETTER pattern per the docs
is:

```js
class SupervisorRPC extends WorkerEntrypoint {
  getSliceStream(specifier): ReadableStream {
    return new ReadableStream({
      type: 'bytes',
      start(controller) { /* ... pump chunks ... */ }
    });
  }
}
// In facet:
const stream = await env.SUPERVISOR.getSliceStream(specifier);
const reader = stream.getReader();
// Pull bytes with backpressure, no 32 MiB cap.
```

This avoids the chunked-RPC pattern entirely. The docs even say
"This puts a lot of memory pressure on the isolate. If possible,
streaming the data from its original source is much preferred."

---

## R3.7 ctx.exports + ctx.props (loopback bindings) — what's legitimate

✓ CONFIRMED ([Context — exports](https://developers.cloudflare.com/workers/runtime-apis/context/#exports)):

> `ctx.exports` provides automatically-configured "loopback" bindings
> for all of your top-level exports.
>
> * For each top-level export that `extends WorkerEntrypoint` (or
>   simply implements a fetch handler), `ctx.exports` automatically
>   contains a Service Binding.
> * For each top-level export that `extends DurableObject` (and which
>   has been configured with storage via a migration), `ctx.exports`
>   automatically contains a Durable Object namespace binding.

[Compatibility flags — enable_ctx_exports](https://developers.cloudflare.com/workers/configuration/compatibility-flags#enable-ctxexports):

> Default as of: 2025-11-17

Nimbus's `wrangler.jsonc:5` sets compat date `2026-04-01`, so
`ctx.exports` is **default-enabled** for us. ✓ CONFIRMED at
`wrangler.jsonc` and source-code usage at
`src/index.ts:50-61` re-exports the inner-Worker classes for
`ctx.exports.X(...)` auto-population.

[ctx.props serialization](https://developers.cloudflare.com/workers/runtime-apis/context/#props):

> `ctx.props` is an arbitrary JSON value. ... designed to ensure
> that ctx.props can only be set by someone who has permission to
> edit and deploy the worker to which it is being delivered. This
> means that you can trust that the content of ctx.props is
> authentic. There is no need to use secret keys or cryptographic
> signatures in a ctx.props value.

> Note that props values specified in this way are allowed to
> contain any "persistently" serializable type. This includes all
> basic structured clonable data types. **It also includes Service
> Bindings themselves: you can place a Service Binding into the
> props of another Service Binding.**

This is HUGE for Nimbus. We can pass a service-binding stub through
props to a dynamic Worker. The dynamic Worker can then call back
into the supervisor over that stub. This is exactly how
`SupervisorRPC` is plumbed today.

---

## R3.8 R3 summary — what changes for plan §3

| Claim from current plan §3 / current code | R3 verdict |
|---|---|
| "facet" = NimbusFacetPool | ⚠ TERMINOLOGY COLLISION — also a public Cloudflare DO Facet primitive (different thing) |
| "per-facet 128 MB" | ✓ CONFIRMED (R2.2) |
| "32 MiB RPC cap matters" | ✓ CONFIRMED — but ReadableStream over RPC bypasses it |
| "ctx.exports loopback is legitimate" | ✓ CONFIRMED — default-enabled at 2025-11-17 compat; Nimbus already uses it |
| "ctx.props for per-facet config" | ✓ CONFIRMED — can carry service bindings nested inside |
| "DO Facets is a Nimbus-internal naming" | ❗ FALSE — also a public primitive |
| "stream pre-bundle slices via RPC chunks" | ✓ Valid; better via ReadableStream-over-RPC (R3.6) |
| "migrate to DO Facets" | NOT in plan §3 yet; recommend as long-term target |

**Major plan §3 update from R3**: Track A'.2 should specify
**ReadableStream-over-RPC** (per R3.6) rather than chunked-RPC
because it's the platform-recommended pattern with no 32 MiB cap
and built-in flow control. Track A'.4 (cirrus-real default)
remains drafted but with a forward-link to "DO Facets migration"
as a follow-up wave.

R3 also reveals that **DO Facets are the long-term architectural
target shape** Nimbus should migrate to. Plan §4 dispatch order
should add a long-term track:

```
Track D' — DO Facets migration (follow-up to A'/B'/C')
  D'.1 migrate cirrus-real to DO Facet
  D'.2 migrate pre-bundle pool to DO Facets
  D'.3 migrate npm-install batch to DO Facets
  D'.* etc.
```

Each `D'.x` is its own multi-wave effort. Total 10+ waves over
months. The architectural argument for it is:
- Each facet gets own SQLite (storage isolation).
- Each facet hibernates independently (compute isolation).
- The supervisor stops mediating bulk bytes (memory isolation).

But the IMMEDIATE Bug C fix doesn't require Track D'. It requires
A' + B' + C', as already in plan §3.

---

## R3.9 What still needs verification (carries forward)

⚠ UNVERIFIED:
- Whether DO Facets get their own isolate vs share the parent's.
  Strongly implied by the architecture (R3.4) but not explicitly
  documented. Resolve by either (a) workerd source code reference
  for `ctx.facets.get` or (b) post-Bug-B-fix empirical measurement.
- Whether `ctx.facets.get` in the supervisor counts toward the
  6-simultaneous-headers cap when calling `facet.fetch()`. R2.8
  says service-binding subrequests do count; DO Facets likely do
  too but not explicitly stated.

These should be resolved before plan §4 commits to a specific
"migrate to DO Facets" timeline. Mark as research follow-ups.
