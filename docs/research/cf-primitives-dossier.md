# Cloudflare's New Multi-Processing Primitives — Unified Research Dossier

> Synthesised from two parallel deep-research passes — one across **workerd OSS + public docs** ([codebase dossier, 1432 lines](vfs://local/research/cloudflare-dynamic-primitives.md)), one across **internal Cloudflare sources** — wiki RFCs, GitLab control plane, Jira epics ([internal dossier, 926 lines](vfs://local/research/cf-internal-dossier.md)). This file is the executive synthesis. The two source dossiers are the depth references; every load-bearing claim here cites back to them.

## TL;DR

Cloudflare ships five primitives that, together, give you a credible "multi-processing on the edge" substrate today:

1. **Worker Loaders / Dynamic Workers** — `env.LOADER.get(id, getCode).getEntrypoint(name).method(...)` returns a **caller-controlled, ms-cold-start, capability-sandboxed Worker isolate** loaded from code you supply at runtime. Best fit for ephemeral "thread-per-job" pools.
2. **Durable Object Facets** — `ctx.facets.get(name, callback)` gives a parent DO any number of **co-located sub-actors with their own SQLite, input gates, and broken-state cascade**. Best fit for stateful in-memory "thread pool sharing one host."
3. **Container Durable Objects** — a DO with an attached Linux VM (`standard-1` … `standard-4`). Best fit for **CPU-bound or non-JS** jobs.
4. **Named Entrypoints + Workers JS-RPC** — `class Foo extends WorkerEntrypoint`, callable across service-binding/loader/dispatch boundaries with **promise pipelining**. The transport for everything else.
5. **Dispatch Namespaces (Workers for Platforms)** — `env.NS.get(scriptName).fetch(req)` for **pre-deployed multi-tenant** scripts. Adjacent primitive; compete with Loaders at different scopes.

For a "multi-processing" library, the centre of gravity is **(1) Worker Loaders** for stateless fan-out and **(2) Facets** for stateful pools, with **(3) Containers** as an escape hatch and **(4) RPC** as the universal transport. Section 7 of the [codebase dossier](vfs://local/research/cloudflare-dynamic-primitives.md) has the full fitness scorecard.

---

## 1. Worker Loaders (a.k.a. Dynamic Workers, "Code Mode")

### What it is
A binding that lets one Worker instantiate **another Worker at runtime** from code provided in the request handler. The loaded Worker runs in its own V8 isolate with its own `env`, gets RPC-callable, and is cached by `(loaderBindingId, name)` for warm reuse.

```ts
// In the calling Worker
const stub = env.LOADER.get("user-script-v3", async () => ({
  compatibilityDate: "2026-04-01",
  mainModule: "main.js",
  modules: { "main.js": userCode },
  env: { COORDINATOR: ctx.exports.Coordinator(), DB: env.D1_DB },
  globalOutbound: null,                    // capability-only network
}));
const result = await stub.getEntrypoint("Worker").run(args);
```

### Where it lives in the runtime
- Surface: [`workerd/src/workerd/api/worker-loader.h` / `.c++`](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/worker-loader.h) — `WorkerLoader.get`, `WorkerStub.getEntrypoint`, `getDurableObjectClass`.
- Wire schema: [`workerd/src/workerd/server/workerd.capnp`](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp) — `WorkerLoaderBinding`.
- Server-side cache: `Server::WorkerLoaderNamespace`, declared at `server.h:193-194` (named) and `:194` (anonymous), keyed by `(server-level binding id, name)`.
- Internal mirror: `cloudflare/ew/edgeworker` — `pipeline.capnp:1575` `WorkerLoaderBinding`, `worker-set.c++` `DynamicWorkerTracker`, `dynamic-worker.ew-test`.

### Provisioning model
- Two entry points: `load(name, getCode)` always invokes `getCode`; `get(name, getCode)` reuses a cached isolate when one exists for that `(loaderId, name)` and only calls `getCode` on miss.
- `getCode` may be **async** ([`worker-loader-test.js:712-737`](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/tests/worker-loader-test.js)). The first request blocks until it resolves.
- `env` passed in `getCode`'s return is **rewritten on the fly** — JS RPC stubs become server-level capabilities in the new isolate (`server.c++:4298-4323`).
- `props` can be supplied per-`getEntrypoint` call ([`worker-loader.c++:38-61`](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/worker-loader.c%2B%2B)). Same loaded class can be specialised per-tenant via `props` — no reload.

### Lifecycle & invariants
| Invariant | Source |
|---|---|
| Cache key: `(loaderBindingId, name)` | `server.c++:4182-4220` |
| **Per-owner LRU cap = 50 isolates per process** (default; `dynamicWorkersPerOwnerLimit @215`) | `cloudflare/ew/edgeworker/src/edgeworker/server/config.capnp:692`; proven by `dynamic-worker-owner-limit.ew-test` |
| Anonymous bindings (no `id`) get a **separate namespace per binding** — never shared | `server.h:194`, `A8` in codebase dossier |
| Named bindings with the same `id` across different Workers in OSS **share the namespace** at `Server` scope | `server.c++:4974-4988`; `CR-1` correction in §10 of codebase dossier — production-scoped behavior is open question |
| Cold start: ms (V8 isolate boot, not container) | Code Mode blog post |
| `globalOutbound: null` ⇒ no `fetch` to anywhere not in `env` | `server.c++:4225-4227` |
| Loaded module total size: not stated as a hard byte cap in OSS; production cap unknown (open question WL-8) | — |
| Compat flags inherit *down* — child can target newer date than parent; `experimental` requires parent itself experimental | `worker-loader.c++:267-295`, `A7` |
| Billing: per-day per-unique-Worker fee + standard CPU/duration; rolls up to caller today | `dynamic-worker.c++:1050` literal comment "This is not really right but…"; [public pricing](https://developers.cloudflare.com/dynamic-workers/pricing/) |
| **Status:** Open Beta. GA in flight ([RM-27238](https://jira.cfdata.org/browse/RM-27238)); High-Risk PSR ([REVIEW-14667](https://jira.cfdata.org/browse/REVIEW-14667)) Sprint-135; GA gated by [REVIEW-17120](https://jira.cfdata.org/browse/REVIEW-17120). Dice abuse-detection wired ([EW-9653/9655/9656](https://jira.cfdata.org/browse/EW-9653) Closed). | Internal dossier §1 |

### Use case fit for "multi-processing"
**Best primitive for ephemeral fan-out.** A coordinator can `LOADER.get(jobHash, …)` one isolate per distinct unit of work, pass capability-scoped `env`, run, await. For higher-throughput pools, hash to a small set of stable `id`s to amortise the per-day uniqueness fee and stay under the 50-cap.

---

## 2. Durable Object Facets

### What it is
`ctx.facets.get(name, callback)` gives a parent DO **any number of co-located sub-actors**, each:
- A real `Worker::Actor` with its own `InputGate` (genuine handler-level parallelism — `worker.c++:3735`).
- Its own SQLite (`<actor>.<facetId>.sqlite`), partitioned via an **append-only on-disk index** (`facet-tree-index.h`, `facet-tree-index.c++`).
- Its own `DurableObjectClass`, which can be loaded from a Worker Loader (`worker.getDurableObjectClass("ClassName")`) — i.e. **facet code can come from runtime-loaded Worker code**.
- Independently abortable / deletable (`ctx.facets.abort(name, reason)`, `ctx.facets.delete(name)`); `requireNotBroken` cascades from a broken root, poisoning the subtree (`server.c++:2709-2728`).

```ts
class Coordinator extends DurableObject {
  async runOnWorker(workerName: string, args: unknown) {
    const workerStub = await this.ctx.facets.get(workerName, async () => {
      const { worker } = env.LOADER.get(`worker-${workerName}-code`, () => userCode);
      return { class: worker.getDurableObjectClass("WorkerClass") };
    });
    return workerStub.run(args);
  }
}
```

### Where it lives in the runtime
- Surface: [`workerd/src/workerd/api/actor-state.h`](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/actor-state.h) — `DurableObjectFacets`, `FacetStartupOptions`.
- Container: `server.c++:2331-2333` — `class ActorContainer final: ... public Worker::Actor::FacetManager`. Every actor *is* a FacetManager.
- Storage: `facet-tree-index.h` (append-only ordering, **65,536 total facets per actor including root** — i.e. 1 root + 65,535 non-root).
- Internal mirror: `cloudflare/ew/edgeworker/src/edgeworker/tests/actors-storage/facets.storage-ew-test`, `actors/facets.ew-test`. Pattern `runDynamicFacet` shows the canonical "facet whose code comes from a Worker Loader" usage.

### Lifecycle & invariants
| Invariant | Source |
|---|---|
| Facet has its own InputGate ⇒ true per-facet parallelism | `worker.c++:3735` |
| 65,536 facets per parent (root + 65,535 non-root) | `facet-tree-index.h` header comment |
| **Facets share the parent DO's colo placement** — they are NOT a horizontal-scale primitive across machines | Internal dossier §2; routing-supervisor never sees facets as actor IDs |
| **Alarms not supported in non-root facets** | `server.c++:2812-2822` (root-vs-facet branching) |
| **`ctx.props` cannot carry capabilities into facets yet** — `JSG_FAIL_REQUIRE` "Facet classes do not yet support ctx.props containing capabilities" | `pipeline.c++:1838` |
| Cross-facet output gate ordering is weaker than within a facet (TODO at `worker-set.c++:2142`) | Internal dossier §2 |
| `monitorOnBroken` cascades to children — broken root poisons subtree until actor recreated | `server.c++:2715-2728` (`requireNotBroken`) |
| `DurableObjectClass` is `JSG_SERIALIZABLE` — can be passed across RPC boundaries | `actor.h:382` (codebase dossier `A1`) |
| Same facet name can be reloaded with a new class while preserving SQLite | `facets.storage-ew-test:160-190` |
| 10s post-eviction timer in `server.c++:2755-2800` | — |

### Use case fit for "multi-processing"
**Best primitive for stateful "thread pool sharing one host."** A coordinator DO with N facets gives N parallel-handler "threads" with persistent SQLite each. Pair with Worker Loader for runtime-loaded user code per facet. Cap is one host's compute.

---

## 3. Container Durable Objects

### What it is
A DO with an **attached Linux VM** (`@cloudflare/containers`). The DO supervises lifecycle, the container runs the work. Useful for non-JS or CPU-bound workloads.

| Invariant | Source |
|---|---|
| 1 container per DO instance | [`containers/`](https://developers.cloudflare.com/containers/) |
| **Container may be in a different colo from the DO** — placement picks "nearest pre-fetched image" | Public docs + internal dossier §3 (`RM-24991` cloudchamberd in flight) |
| Cold start ~1-3s | Public docs |
| Lifecycle hooks: `sleepAfter`, SIGTERM grace, SIGKILL | `@cloudflare/containers` |
| Egress goes through Worker fetch interception (capability gating) | `container.capnp:13-14` |
| Container destroyed when DO drops capability | `container.capnp:13-14` |
| Instance types: `lite`, `standard-1`, `standard-2`, `standard-3`, `standard-4` | Public docs |
| Billing: per-vCPU + memory + image-storage | Public docs |

### Use case fit
Heavy CPU/native workloads. Slowest cold start; highest cost; not the default for a multi-processing library, but a viable backend.

---

## 4. Named Entrypoints + Workers JS-RPC

### What it is
The transport layer. `class Foo extends WorkerEntrypoint`, callable from service bindings, Worker Loader stubs, DO RPC, dispatch, and DO Facet stubs. Promise pipelining lets you chain calls without round-trips.

| Invariant | Source |
|---|---|
| **Stub forwarding lifetime ≤ introducing context** — once the introducer's request returns, downstream consumers' stubs break | Codebase dossier §4 (RPC-3) + `A3` (`server.c++:4395-4404`, `:4423-4433`) |
| 32-fan-out cap per request | Public docs |
| `RpcStub`, `Request`, `Response`, `ReadableStream`, `WritableStream` are RPC-serialisable | Public docs |
| `DurableObjectClass` is RPC-serialisable | `actor.h:382` (`A1`) |
| `props` per-call specialises an `ActorClassChannel` | `worker-loader.c++:38-61` (`A2`) |

### Use case fit
**Universal transport.** Library uses it for coordinator↔worker calls. The lifetime invariant is the single biggest constraint: any backend that hands out RPC stubs from the coordinator requires the coordinator's request to remain in flight (or to be a DO holding the request open).

---

## 5. Dispatch Namespaces (Workers for Platforms)

### What it is
`env.NS.get(scriptName).fetch(req)` invokes a **pre-deployed** Worker by name. Multi-tenant routing for hosted user code.

| Invariant | Source |
|---|---|
| Pipeline IDs derived as `HMAC-SHA256(namespaceKey, scriptName)` — deterministic, no QS lookup | Internal dossier §4 |
| EWC is the choke point: ~40 REST routes for namespace mgmt | Internal dossier §4 |
| RPC support unclear in OSS docs (fetch-only documented) — open question (DN-1) | Codebase dossier §5 |
| Untrusted-by-default isolation invariants enforced | [`workers-for-platforms/reference/worker-isolation/`](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/) |

### Use case fit
**Adjacent, not central.** Loader is a closer match for a multi-processing library. Dispatch wins when jobs map to *deployed* customer scripts (a SaaS-platform flavour of multi-processing).

---

## 6. Cross-Cutting Invariants for Multi-Processing

These are the load-bearing constraints any library must respect. Every entry has a citation in one of the two source dossiers.

| # | Invariant | Implication for the library |
|---|---|---|
| I1 | **Worker Loader: 50 isolates per owner per process LRU** | Hard ceiling on parallel "ephemeral threads" per process. To exceed, hash to a small set of stable `id`s OR multiplex multiple bindings OR fan out across DOs/colos. |
| I2 | **32 fan-out per request** | Single `Promise.all(32)` is the limit. Higher concurrency requires batching or a coordinator-DO sequencing the work. |
| I3 | **Stub forwarding lifetime ≤ introducer's request** | Coordinator can't be a transient Worker if jobs outlive its request. Default to coordinator-as-DO (or keep a request open via WebSocket/Workflow). |
| I4 | **Facets share parent placement** | Facet pool gives parallel handlers but not horizontal scale across machines. For horizontal scale, fan out across a DO namespace (different parent IDs ⇒ different colos). |
| I5 | **`ctx.props` can't carry capabilities into facets yet** | Pass capability stubs via the loaded class's `env` (rewritten by server) instead of `ctx.props`. |
| I6 | **Facet alarms not supported in non-root facets** | Drive timing from supervisor's alarm; supervisor multiplexes wake-ups to children. |
| I7 | **`requireNotBroken` cascades** | Broken root facet poisons subtree until actor recreated. Library needs supervisor-level recovery; don't rely on per-facet recovery. |
| I8 | **`monitorOnBroken`** lets parent observe child failure | Coordinator can react to broken workers. |
| I9 | **Container DO may not co-locate with parent DO** | Don't assume container is local to coordinator. Latency budget grows. |
| I10 | **Per-day Dynamic Worker uniqueness billing** | Use **stable `id`s** (e.g. hash of code) — each unique `id` per day is billed once. Mass-unique `id`s are a cost trap. |
| I11 | **Loader env capabilities are rewritten on entry** | A coordinator can pass arbitrary RPC stubs into a loaded Worker — including a stub back to the coordinator. This is the multi-processing primitive in disguise. |
| I12 | **`DurableObjectClass` is RPC-serialisable** | A loaded class can be shipped across RPC; one Worker can load a class and another can use it as a facet supervisor. Enables "supervisor templates." |
| I13 | **`ActorClassChannel`s specialise per-call by `props`** | One loaded class → N tenants via per-call `props`, no reload. |
| I14 | **Compat flags inherit down**; `experimental` requires parent experimental | Coordinator's compat date dictates which user code is loadable. |
| I15 | **Billing rolls up to the caller today** for facets and loaded workers | The whole loader-spawned tree bills as one logical script. Pool size matters mostly via duration/CPU; isolate count is the secondary knob (uniqueness fee + eviction-driven cold starts). |
| I16 | **Worker Loader status: Open Beta**, GA in flight; High-Risk PSR | Build for Beta semantics; expect changes. Internal dossier §1 has the GA tracking tickets. |

---

## 7. Open Questions (handed back from research)

| ID | Question | Status |
|---|---|---|
| WL-1 | Production isolate eviction policy beyond per-owner LRU 50 default — does prod override? | Internal: 50 default in OSS schema; production override not verified. |
| WL-3 | Stubs survive eviction for named Dynamic Workers in production | Eviction-mid-flight is real (Dice integration); precise stub semantics unconfirmed. |
| F-8 | Are facet alarms broken in production, or only in workerd OSS? | Unknown — internal dossier didn't address; treat as broken everywhere for safety. |
| C-2 | Container colo vs DO colo — typical latency hit | RM-24991 in flight; sometimes co-located, sometimes not. |
| RPC-3 | Concrete behaviour when introducer ends while a forwarded stub is in use | Resolved by codebase dossier `A3`: stub releases when introducer's request completes. |
| DN-1 | Does dispatch namespace support RPC? | Open. OSS docs say fetch-only; production may differ. |
| WL-8 | Production cap on `WorkerCode.modules` total bytes | Custom limits epic ([EW-10547](https://jira.cfdata.org/browse/EW-10547)) closed but specific byte cap not found. |

---

## 8. Source Dossiers — depth references

| File | Lines | Coverage |
|---|---:|---|
| [cloudflare-dynamic-primitives.md](vfs://local/research/cloudflare-dynamic-primitives.md) | 1432 | workerd OSS + public docs + blog. 6 primitives × 12-row matrix; §7 multi-processing fitness scorecard; §10 rigor review trail (CR-1, CR-2 corrections + 8 post-review additions A1-A8). |
| [cf-internal-dossier.md](vfs://local/research/cf-internal-dossier.md) | 926 | wiki.cfdata.org RFCs, `cloudflare/ew/edgeworker` GitLab, Jira RM/REVIEW/EW epics. 50-cap default verified, billing rollup, GA gating, Dice integration. §13 self-review with 15+ live citation re-checks. |

Both dossiers cite **path:line** for every load-bearing claim. When this synthesis says something, the proof lives in one of them.

---

## 9. What's next

The research is descriptive and complete. Library design is in flight at session `mp-library-design` (plan mode). The plan will land at `/workspace/research/multi-processing-library-design-plan.md`; once reviewed and iterated, build mode will produce `/workspace/research/multi-processing-library-design.md` and (if scope expands) a reference TypeScript scaffold under `/workspace/packages/cf-multi-processing/`.

The library will respect every invariant in §6, expose backends matching §7's three viable shapes (loader pool, facet pool, container pool), and treat coordinator-as-DO as the default (because of I3).
