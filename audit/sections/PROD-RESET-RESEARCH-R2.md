# PROD-RESET-RESEARCH — R2: Dynamic Worker Loader (workerd)

Research scope: confirm whether each `env.LOADER.load()` / `.get()`
call yields its own isolate (and own 128 MB cap), what the actual
concurrent-worker limits are (the ~5-6 we hit empirically), the stub
lifecycle (when it gets evicted, when it's reused), and why
SupervisorRPC stub caching is legitimate.

---

## R2.1 The Worker Loader API — public, GA

✓ CONFIRMED ([Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)):

> Spin up Workers at runtime to execute code on-demand in a secure,
> sandboxed environment.
>
> Dynamic Workers let you spin up an unlimited number of Workers to
> execute arbitrary code specified at runtime. Dynamic Workers can be
> used as a lightweight alternative to containers for securely
> sandboxing code you don't trust.

The phrase **"unlimited number of Workers"** is in the marketing
copy, but R2.4 below shows the actual limit IS bounded — by isolate
eviction, not by API quotas.

### Configuration ([Getting started](https://developers.cloudflare.com/dynamic-workers/getting-started/))

```jsonc
{ "worker_loaders": [{ "binding": "LOADER" }] }
```

This is what Nimbus's `wrangler.jsonc:30+` already configures.

### Two loading modes

> * `load(code)` creates a fresh Dynamic Worker for one-time execution.
> * `get(id, callback)` caches a Dynamic Worker by ID so it can stay
>   warm across requests.

Nimbus uses `get(id, callback)` everywhere via `NimbusFacetPool`; the
"facet" naming is internal-Nimbus, not platform terminology.

---

## R2.2 Each Dynamic Worker IS its own isolate

✓ CONFIRMED, but with the **same caveat as R1.1**:

[Workers reference — Isolates](https://developers.cloudflare.com/workers/reference/how-workers-works/#isolates):

> A single instance of the runtime can run hundreds or thousands of
> isolates, seamlessly switching between them. Each isolate's memory
> is completely isolated, so each piece of code is protected from
> other untrusted or user-written code on the runtime.

[Workers — Limits, Memory](https://developers.cloudflare.com/workers/platform/limits/#memory):

> Memory per isolate: 128 MB

Each Dynamic Worker created via `LOADER.load()` or `LOADER.get()`
gets a fresh isolate with its own 128 MB cap. The caveat: the
**parent supervisor DO + the dynamic Worker** cohabit the same
runtime process. They are SEPARATE isolates, so they don't share
heap. But the platform may still co-tenant other DOs from your same
account in the same runtime process. The 128 MB cap is per-isolate,
not per-account, not per-DO-instance, not per-script.

❗ ARCHITECTURE-IMPACTING: `LOADER.get()` ≠ guaranteed-fresh-isolate.

[Dynamic Workers API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/#get):

> When a new ID is seen the first time, a new isolate is loaded. But,
> the isolate may be kept warm in memory for a while. ... **It is
> never guaranteed that two requests will go to the same isolate.**
> Even if you use the same WorkerStub to make multiple requests,
> they could execute in different isolates. The callback passed to
> loader.get() could be called any number of times (although it is
> unusual for it to be called more than once).

This means:
- Same-ID `LOADER.get()` calls usually hit the same warm isolate
  (good for our facet-reuse pattern).
- But the runtime is allowed to re-spawn or evict at any time.
- Multiple in-flight requests on the same stub MAY run in PARALLEL
  isolates (this is interesting — see R2.4).

---

## R2.3 The "5-6 concurrent dynamic worker limit" — what's real

⚠ UNVERIFIED specific number, but architecturally bounded.

Nimbus has empirically observed ~5-6 concurrent dynamic-worker
isolates being reasonable; the codebase chose `PRE_BUNDLE_CONCURRENCY=1`
specifically because higher values caused supervisor-isolate resets
(`src/npm-installer.ts:1400-1416`).

The public docs do NOT advertise a specific concurrent-loader cap.
What they DO say:

[Workers reference — Isolates](https://developers.cloudflare.com/workers/reference/how-workers-works/#isolates):

> A given isolate has its own scope, but **isolates are not
> necessarily long-lived**. An isolate may be spun down and evicted
> for a number of reasons:
>
> * Resource limitations on the machine.
> * A suspicious script - anything seen as trying to break out of
>   the isolate sandbox.
> * Individual resource limits.

[Dynamic Workers — Custom limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/):

> By default, each Dynamic Worker invocation uses your Workers plan
> limits for CPU time and subrequests. Custom limits allow you to
> programmatically enforce limits on the Dynamic Worker's resource
> usage.
>
> You can set limits for the maximum CPU time and number of
> subrequests per invocation. If a Dynamic Worker hits either of
> these limits, it will immediately throw an exception.

So per-Worker limits are configurable (down only — you can't
exceed your plan), but **there is no documented cap on the number
of concurrent dynamic Workers loaded by a single supervisor**.

Mechanism for the empirical ~5-6 limit:

1. Each loaded Dynamic Worker is a V8 isolate.
2. Each isolate has 128 MB.
3. The runtime process hosting the supervisor + N Dynamic Workers
   has a TOTAL memory ceiling on the physical machine — not
   documented but obviously finite.
4. Workerd evicts isolates under memory pressure ("Resource
   limitations on the machine" per the citation above).
5. The 5-6 concurrent number Nimbus saw IS likely a function of
   our Dynamic Worker peak heap usage (the pre-bundle facet uses
   ~80 MiB of its 128 MB budget — `src/npm-installer.ts:670`
   "pLimit(3) to keep its heap peak under ~87 MiB inside its
   128 MiB cap"). Six × 87 MiB = 522 MiB. Plus our 128 MiB
   supervisor cap = ~650 MiB. That's the practical ceiling.

**Takeaway**: spawning more Dynamic Workers PARALLELLY does not
help because the runtime starts evicting under memory pressure.
The right strategy is to MINIMIZE per-Dynamic-Worker peak heap, not
parallelize harder.

---

## R2.4 Stub lifecycle and same-ID parallelism

✓ CONFIRMED ([API Reference — get](https://developers.cloudflare.com/dynamic-workers/api-reference/#get)):

> `get()` returns a `WorkerStub`, which can be used to send requests
> to the loaded Worker. Note that the stub is returned synchronously
> — you do not have to await it. If the Worker is not loaded yet,
> requests made to the stub will wait for the Worker to load before
> being delivered. If loading fails, the request will throw an
> exception.

[API Reference — get](https://developers.cloudflare.com/dynamic-workers/api-reference/#get):

> It is never guaranteed that two requests will go to the same
> isolate. Even if you use the same WorkerStub to make multiple
> requests, **they could execute in different isolates**.

This is an important platform property:

❗ ARCHITECTURE-IMPACTING — **same-ID `LOADER.get()` may execute in
parallel isolates**. If we send 2 concurrent `worker.fetch()` requests
to the same stub, they MAY hit two distinct isolates concurrently,
each with 128 MB. This is genuinely parallel platform-level work for
"the same logical worker".

This is the feature Nimbus's `NimbusFacetPool` should be exploiting.
Today the pool handles concurrency itself with `pLimit(3)` inside ONE
facet; if we trusted the platform's per-stub multi-isolate behaviour
we could potentially fan out across isolates for parallel work
without manual concurrency management.

But: the docs warn that re-isolation of the same ID is "unusual" —
the platform treats it as an optimization. We can't build correctness
on it. We CAN build performance optimism on it (i.e. fanning out to
multiple stubs each with a different ID is the explicit way to get
guaranteed parallelism — see R2.5).

---

## R2.5 Multi-isolate parallelism via DIFFERENT IDs

✓ CONFIRMED by the API contract: `LOADER.get(id, ...)` with N distinct
IDs returns N distinct stubs. Each stub is a different logical Worker.
The platform may co-tenant them (R2.3) but we tell the runtime
"these are independent units of work" — making it more likely to
distribute across isolates.

For Nimbus this means: instead of `concurrency=3` inside one
`pre-bundle-facet` Worker (today), spawn N `pre-bundle-facet-<i>`
Workers each handling 1 spec, where each unique spec produces a
unique ID. The IDs would be:

- `pre-bundle:react@18.3.1` — package + version + sliceCap
- `pre-bundle:framer-motion@12.0.0` — etc.

Each gets its own isolate with its own 128 MB. Parallelism is NOT
limited by `pLimit(3)` inside a single isolate — it's limited by
the runtime's willingness to host concurrent isolates (R2.3, ~5-6
in practice).

**Tradeoffs**:
- Pro: each isolate's heap headroom is its own. Pre-bundle peak
  isn't shared.
- Pro: failure isolation — one bad pre-bundle Worker doesn't OOM
  any others.
- Con: more isolate-startup overhead per spec (N startups vs. 1).
- Con: more memory across the runtime, sooner-evicted.
- Con: more complex orchestration code (we already have
  `NimbusFacetPool`, but reshaping it for "per-spec ID" is work).

This is a Track A' candidate; quantify only after Bug B fix
(C'.1 estimator) gives us real heap measurement.

---

## R2.6 Service Bindings and `ctx.exports` (loopback)

✓ CONFIRMED ([API Reference — env](https://developers.cloudflare.com/dynamic-workers/api-reference/#env)):

> `env` is serialized and transferred into the dynamic Worker, where
> it is used directly as the value of `env` there. It may contain:
> * Structured clonable types
> * Service Bindings, including loopback bindings from ctx.exports.
>
> The second point is the key to creating custom bindings: you can
> define a binding with any arbitrary API, by defining a
> WorkerEntrypoint class implementing an RPC API, and then giving
> it to the dynamic Worker as a Service Binding.

This is exactly the mechanism Nimbus uses for SupervisorRPC:
`src/index.ts:50-61` re-exports the inner-Worker classes
(`NimbusAssetsRPC`, `NimbusLoaderRPC`, `NimbusLoadedWorker`,
`NimbusLoadedEntrypoint`, `NimbusDurableObjectNamespace`,
`NimbusDOStub`, `CirrusHmrRPC`, `SupervisorRPC`). The
inner-do-registry pattern at `src/inner-do-registry.ts` is the
"give the dynamic Worker a fake env mirroring our env" facade.

This explains why our facet pattern works at all: the dynamic
Worker spawned via `LOADER.get()` receives an `env` object that
LOOKS like a real Worker env, but every binding in it is a
`ctx.exports.X(...)` loopback service stub pointing at one of OUR
classes. This is a legitimate, public, GA pattern.

❗ ARCHITECTURE-IMPACTING for plan §3 framing: the term "facet"
in plan §3 needs disambiguation. It can mean:
- (a) Nimbus's NimbusFacetPool — a pool of `LOADER.get()`-spawned
  dynamic Workers managed by `src/parallel/facet-pool.ts`. NOT a
  platform primitive.
- (b) The PUBLIC Cloudflare DO Facet — `this.ctx.facets.get('name', ...)`
  inside a DO, gives the inner class its own SQLite database and
  its own isolate (see R2.7). A DIFFERENT primitive.

Plan §3 / Track A'.4 talks about "deprecating the in-supervisor
viteDevServer for cirrus-real" — cirrus-real IS a Nimbus-style facet
(a). The DO Facets primitive (b) was not on our radar but is
extremely relevant — see R3.

---

## R2.7 DO Facets (the platform primitive — NEW finding)

❗ ARCHITECTURE-IMPACTING — covered fully in R3, summarized here for
its R2 connection.

[DO Facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/):

> Durable Object Facets let you load a Durable Object class from a
> Dynamic Worker and run it as a child of your own Durable Object.
> The child (the facet) gets its own isolated SQLite database, while
> your class acts as a supervisor that controls access.

The supervisor's `this.ctx.facets.get('app', callback)` returns a
stub to a child DO that:
1. **Has its own isolated SQLite database** within the parent DO.
2. Runs in **its own isolate**.
3. Inherits the parent's DO ID by default (or takes an explicit one).
4. Cannot read the parent's storage.

For Nimbus this is a NEW architectural option:
- `NimbusSession` (the supervisor) could spawn child DO Facets per
  workload — `npmInstallFacet`, `preBundleFacet`, `viteDevFacet`
  — each with its own SQLite (10 GB) AND its own 128 MB heap.
- The supervisor only routes; it never holds bulk bytes.
- Storage per workload is isolated — npm install's tarball cache
  doesn't fight with vite's transform cache for pages in supervisor
  SQLite.

This is plan §3 Track A' realized with a much stronger isolation
model than what plan §3 originally drafted (which was "stream slice
through RPC" — still going through the supervisor isolate).

The dispatch-order implication: DO Facets may BLOCK on the
`compatibility_date >= 2026-04-01` we're already on (✓ confirmed
in `wrangler.jsonc:5`) and require migration entries. R3 deep-dives.

---

## R2.8 Concurrent connection limits revisited

✓ CONFIRMED ([Workers — Limits, Simultaneous open connections](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections)):

> Each Worker invocation can have up to six connections simultaneously
> waiting for response headers. ... Outbound WebSocket connections
> also count toward this limit.
>
> The runtime measures simultaneous open connections from the
> top-level request. Workers triggered via Service bindings share
> the same connection limit.

❗ ARCHITECTURE-IMPACTING for the "fan out across N Dynamic Workers"
plan from R2.5: each `worker.fetch()` is a service-binding subrequest
under-the-hood. The 6-simultaneous-headers cap applies. So we can fire
~6 dynamic-worker fetches in flight before stacking. 

For pre-bundle: 6 in-flight `worker.fetch()` calls is plenty for a
typical 8-module starter. For larger projects it's still binding,
but works against the 5-6 isolate-eviction ceiling — they
accidentally line up.

For npm install (15 packages): the 6-concurrent ceiling means we
can't dispatch all 15 in parallel from one supervisor invocation.
Need to chain them or use the existing batch-facet's internal
pLimit-3 design, which is already inside-one-isolate so it doesn't
hit the 6-cap.

---

## R2.9 R2 summary — what changes for plan §3

| Claim from current plan §3 / current code | R2 verdict |
|---|---|
| "Each LOADER.get() gets its own 128 MB" | ✓ CONFIRMED per-isolate, but isolate may be evicted at any time |
| "Same-ID get() is always the same isolate" | ❗ FALSE — never guaranteed; usually true; can split into parallel isolates |
| "5-6 concurrent dynamic workers" | ⚠ UNVERIFIED specific number, but R2.3 explains the mechanism — runtime evicts under memory pressure |
| "DO Facets are Nimbus-internal naming" | ❗ MIXED — Nimbus uses the term for its own pool, but THE PLATFORM ALSO HAS A PRIMITIVE WITH THE SAME NAME (R3) |
| "fan out across N stubs gives parallelism" | ✓ CONFIRMED per the API contract; capped by 6-simultaneous-headers + isolate-eviction at ~5-6 concurrent |
| "Service Binding env injection is legitimate" | ✓ CONFIRMED public + documented pattern |

R2 strengthens plan §3 on the "use Dynamic Workers for heavy work"
shape but reveals two NEW options for that shape:

1. **DO Facets (`ctx.facets.get`)** — a stronger isolation model
   than what plan §3 sketched. Each facet gets own SQLite + own
   isolate. R3 deep-dives.

2. **Per-spec-ID fan-out** — instead of one pre-bundle facet doing
   N specs internally, N facets each doing 1 spec. Each gets its
   own 128 MB. Limited by 6-concurrent-headers cap.

Both are pre-Bug-B-fix unverifiable (need real heap signal), but
both should be evaluated AFTER C' lands.
