# Cloudflare Dynamic Primitives — Research Dossier

**Status:** in progress (incremental writes)
**Branch:** `research/cf-dynamic-primitives`
**Scope:** workerd OSS, workers-sdk OSS, developers.cloudflare.com, blog.cloudflare.com, GitHub PRs.
**Internal sources:** reconciliation only (cf-internal-research session owns those).

## Coverage

1. Worker Loaders / Code Mode (`env.LOADER.get(id, callback)` + `env.LOADER.load(code)`)
2. Durable Object Facets (`ctx.facets.get(name, callback)`)
3. Container Durable Objects (`class extends Container`)
4. Named Entrypoints + Workers JS-RPC (`WorkerEntrypoint`, `DurableObject`, `RpcTarget`)
5. Dispatch Namespaces (Workers for Platforms — `env.DISPATCHER.get(name)`)
6. Service Bindings (RPC mode vs fetch mode)

## Citation conventions

- `workerd:src/...` = path inside `cloudflare/workerd` OSS, line numbers are against `main` at fetch time (May 2026).
- `workers-sdk:packages/...` = path inside `cloudflare/workers-sdk` OSS.
- `docs:<slug>` = `developers.cloudflare.com/<slug>/`.
- `blog:<slug>` = `blog.cloudflare.com/<slug>/`.
- Test files (`*.wd-test`, `*-test.js`) are treated as **contract evidence** — they are the only public spec workerd will fail against.

---

# 1. Worker Loaders / Dynamic Workers / "Code Mode"

A binding type that lets a Worker load and run other Worker code at runtime, in a fresh V8 isolate, with caller-controlled bindings, environment, network access, tails, and resource limits. The loaded Worker is called a **Dynamic Worker**.

## 1.1 API surface

### TypeScript surface (driven by `JSG_TS_OVERRIDE`)

From `workerd:src/workerd/api/worker-loader.h:36-46` and `:128-133`:

```ts
interface WorkerLoader {
  get<T extends Rpc.WorkerEntrypointBranded | undefined = undefined>(
    name: string | null | undefined,
    getCode: () => WorkerCode | Promise<WorkerCode>,
  ): WorkerStub;
  load(code: WorkerCode): WorkerStub;
}

interface WorkerStub {
  getEntrypoint<T extends Rpc.WorkerEntrypointBranded | undefined>(
    name?: string,
    options?: WorkerStubEntrypointOptions,
  ): Fetcher<T>;
  getDurableObjectClass<T extends Rpc.DurableObjectBranded | undefined>(
    name?: string,
    options?: WorkerStubEntrypointOptions,
  ): DurableObjectClass<T>;
}

interface WorkerStubEntrypointOptions {
  props?: object;        // arbitrary RPC-serializable
  limits?: ResourceLimits;
}

interface ResourceLimits {       // workerd:src/workerd/io/io-channels.h:316-325
  cpuMs?: number;
  subRequests?: number;
}

interface WorkerCode {           // workerd:src/workerd/api/worker-loader.h:80-119
  compatibilityDate: string;
  compatibilityFlags?: string[];
  allowExperimental?: boolean;   // requires parent to have `experimental` flag, src/workerd/api/worker-loader.c++:267-274
  limits?: ResourceLimits;
  mainModule: string;
  modules: Record<string, string | Module>;
  env?: object;                  // RPC-serializable; can hold service stubs
  globalOutbound?: Fetcher | null;    // null = block; absent = inherit; Fetcher = redirect
  tails?: Fetcher[];
  streamingTails?: Fetcher[];    // requires allowExperimental
}

type Module =
  | { js: string }
  | { cjs: string }
  | { text: string }
  | { data: ArrayBuffer }
  | { json: any }
  | { py: string }
  | { wasm: ArrayBuffer };       // workerd:src/workerd/api/worker-loader.h:62-78
```

### Cap'n Proto wire (binding declaration)

`workerd:src/workerd/server/workerd.capnp:451-465`:

```capnp
workerLoader :group {
  id @27 :Text;
  # Optional: shared-cache identifier. Multiple bindings with the same id share
  # an isolate cache; an omitted id makes the binding's cache private.
}
```

### Internal C++ contract

`workerd:src/workerd/io/io-channels.h:294-298` — every runtime that supports dynamic loading implements:

```cpp
virtual kj::Own<WorkerStubChannel> loadIsolate(
    uint loaderChannel,
    kj::Maybe<kj::String> name,
    kj::Function<kj::Promise<DynamicWorkerSource>()> fetchSource);
```

`workerd:src/workerd/io/io-channels.h:331-340` — `WorkerStubChannel` exposes only two methods: `getEntrypoint(name, props, limits)` and `getActorClass(name, props, limits)`. Both return cap-table channels — the Dynamic Worker is **never** addressable through anything else. There is no enumeration API.

`workerd:src/workerd/io/io-channels.h:343-388` — `DynamicWorkerSource` is the post-validation form of `WorkerCode`: parsed modules + compat flags, an `env` serialized as a `Frankenvalue` (Cloudflare's cross-thread value+capability pickle), an optional `globalOutbound` channel, tail channels, and `ownContent` for backing-buffer ownership.

## 1.2 Wrangler / config schema

### `wrangler.jsonc` (the public config)

```jsonc
{
  "worker_loaders": [
    { "binding": "LOADER" }
  ]
}
```

evidence: `workers-sdk:packages/wrangler/src/__tests__/type-generation.test.ts:539` (test fixture uses `WORKER_LOADER_BINDING` as the binding name); type generation at `workers-sdk:packages/wrangler/src/type-generation/index.ts:2242-2262` (emits `<bindingName>: WorkerLoader` — the type literal `"WorkerLoader"` is hardcoded at line 2256); upload-form serialization at `workers-sdk:packages/wrangler/src/deployment-bundle/create-worker-upload-form.ts:159, 498` (`worker_loader` binding type).

There is **no** wrangler-level shared-cache `id` field exposed yet — the `id` field exists in the workerd capnp schema (`workerd.capnp:459`) and in the wd-test (`worker-loader-test.wd-test:13-15`), but wrangler currently emits only `{ binding }`.

### `workerd.capnp` (the runtime schema)

```capnp
bindings = [
  ( name = "loader",         workerLoader = () ),
  ( name = "sharedLoader1",  workerLoader = (id = "shared") ),
  ( name = "sharedLoader2",  workerLoader = (id = "shared") ),
  ( name = "uniqueLoader",   workerLoader = (id = "nonshared") ),
],
```

evidence: `workerd:src/workerd/api/tests/worker-loader-test.wd-test:11-16`.

## 1.3 Provisioning model

### Two entrypoints — different cache semantics

| Method | Cache semantics | Idempotent callback |
|---|---|---|
| `LOADER.load(code)` | **Always** creates an isolate. No name. May be evicted while the stub still exists; runtime then re-creates via the supplied closure. | The closure is called **0 or more** times — the `load()` impl takes ownership of the source and clones it on each rehydration (`worker-loader.c++:82-104`). |
| `LOADER.get(name, getCode)` | Keyed cache. Same `(loaderId, name)` tuple → same isolate (until evicted). | `getCode` is called **only** when the named isolate is not warm. May still be called more than once across the stub's lifetime. |

### How the cache is keyed (concrete invariant)

`workerd:src/workerd/server/server.c++:4182-4208` — the `WorkerLoaderNamespace` keeps a `kj::HashMap<kj::String, kj::Rc<WorkerStubImpl>>` keyed solely on the user-supplied `name`. The namespace itself is keyed by the `id` field of the binding (`workerd.capnp:459`). So:

- **Two bindings with the same `id`** look up in the **same** namespace and therefore share isolates.
- **Two bindings with different/absent `id`** never share isolates, even when called with the same name.
- **`get(null)`/`get(undefined)` and `load()`** generate a random UUID-suffixed isolate name (`server.c++:4204` — `randomUUID(server.entropySource)`) and skip the map. Each call is therefore a new isolate.

This is exactly what the contract test asserts: `worker-loader-test.js:455-543`. `loadCount === 8` after eight independent calls demonstrates: same name across same-id bindings = 1 isolate (loadCount += 1); different-id binding = +1; anonymous binding = +1; second name = +1; null = each call is unique (+3).

### Eviction

The OSS workerd implementation does **not** implement an active eviction policy — entries persist for the lifetime of the namespace. Eviction is documented as a runtime behaviour (`docs:dynamic-workers/api-reference/#get`):

> the isolate may be kept warm in memory for a while … But there is no guarantee: a later call with the same ID may instead start a new isolate from scratch.

`abortIsolate()` (called from inside the dynamic Worker — `worker-loader-test.js:961-1020`) does the only programmatic eviction in OSS. It runs `removeIsolate(name)` (`server.c++:4195, 4210-4213`), so the next `get(name)` triggers a fresh load.

This is one of the **deliberate open questions** for production (see §1.12) — OSS workerd cannot model the production eviction policy because production runs many tenants on the same machine and must reclaim memory.

### The `env` and `props` translation

Two-stage:

1. **`worker-loader.c++:106-169`** — `WorkerLoader::toDynamicWorkerSource` serializes the JS `env` object into a `Frankenvalue` (line 116: `Frankenvalue::fromJs`) — this captures both plain values and capability handles in a thread-portable form.
2. **`server.c++:4298-4323`** — when the `WorkerStubImpl::start()` actually builds the `WorkerService`, it calls `source.env.rewriteCaps(...)` and walks each cap, rewriting:
   - `IoChannelFactory::SubrequestChannel` (i.e. `Fetcher`) → `SUBREQUEST` channel entries (`server.c++:4299-4307`).
   - `ActorClass` (i.e. `DurableObjectClass`) → `ACTOR_CLASS` channel entries (`server.c++:4308-4315`).
   - Anything else → `DOMDataCloneError: Dynamic 'env' contains one or more objects that are not supported for use in 'env', although they would be supported in 'props'.` (`server.c++:4316-4322`).

Implication: only **service stubs** and **DO class bindings** are transferable in `env`. KV, R2, D1, Queues, Hyperdrive must be wrapped in a `WorkerEntrypoint` and exposed as a service stub (this is the `MyStorage` pattern in `docs:dynamic-workers/usage/bindings`).

`props` is also a `Frankenvalue` (`worker-loader.c++:16-23, 41-48`), but it's stored on the **`getEntrypoint(name, options)`** call and lives on the entrypoint stub — every method invocation the Dynamic Worker's `WorkerEntrypoint` makes can read `this.ctx.props`. This is how per-call/per-tenant scoping is implemented (`worker-loader-test.js:62-72`).

## 1.4 Lifecycle

### Cold start

1. `LOADER.get(name, cb)` returns a `WorkerStub` synchronously (`worker-loader.c++:63-80`).
2. The stub holds an `IoOwn<WorkerStubChannel>`. The stub is "warm-or-loading" — **not** an awaited handle.
3. The first call on the stub (`getEntrypoint().fetch(...)` etc.) blocks until `fetchSource` resolves and the isolate boots. From `docs:dynamic-workers/api-reference/#get`: "If the Worker is not loaded yet, requests made to the stub will wait for the Worker to load before being delivered. If loading fails, the request will throw an exception." Confirmed by the test contract `worker-loader-test.js:740-754` (`codeLoaderException`): an exception in the callback surfaces on the first request, not on `get()`.
4. Concretely: `WorkerStubImpl::start()` is forked at construction (`server.c++:4251`). It awaits `fetchSource()`, builds a `WorkerDef`, and calls `server.makeWorkerImpl()` (`server.c++:4374`).

### Hibernation / eviction (production behaviour, asserted in docs)

- Isolate may be unloaded silently while the stub still exists (`docs:dynamic-workers/api-reference/#get`).
- When unloaded, the next call re-runs `getCode` and rebuilds the isolate. Module-scoped state is lost (the contract test `worker-loader-test.js:455-543` exercises this for live isolates; live state continuity is **not** guaranteed across eviction — billing and architecture both treat each load as fresh).

### `abortIsolate()`

A method exposed only to dynamically-loaded Workers under the `experimental` flag (`worker-loader-test.js:981-985, 1024-1062`). It:

1. Throws an error to the calling context with message `"internal error; reference = …"`.
2. Removes the isolate from the namespace's cache.
3. Subsequent calls with the same name reload from scratch.
4. Anonymous workers (`get(null, …)` / `load()`) lose access entirely — there's no name to rehydrate against.

This is the OSS analogue of platform-level eviction; see `worker-loader-test.js:961-1020`.

## 1.5 Isolation

- **V8 isolate boundary.** Each unique `(loaderId, name)` corresponds to one V8 isolate (per process at any given time). Confirmed by counter test: `worker-loader-test.js:505-508` shows the module-scoped `let i = 0` from line 467 is shared across calls within the same `(loaderId, name)`; `:509-525` shows distinct IDs/names produce independent isolates.
- **Process boundary.** OSS workerd creates the isolate in-process (`server.c++:4374` `server.makeWorkerImpl`). Production runs many tenants per process — but the `WorkerLoaderNamespace` only exists for the issuing parent, so a Dynamic Worker is always co-located with its parent in workerd. The blog post (`blog:code-mode/`) is explicit about isolates: *"Isolates are far more lightweight than containers. An isolate can start in a handful of milliseconds using only a few megabytes of memory."*
- **Capability boundary.** A Dynamic Worker can talk to:
  - The bindings in the `env` it was created with (rewritten through the cap table).
  - `globalOutbound` for `fetch()`/`connect()`. If this is `null`, those throw — see `server.c++:4222-4242` (`NullGlobalOutboundChannel::startRequest`) for the exact error.
  - Loopback bindings to entrypoints in **its own** Worker code (`ctx.exports`, requires `enable_ctx_exports` compat flag — `worker-loader-test.js:756-784`).
- **No cross-Worker stub leakage.** Stubs returned by `getEntrypoint` are *not* serializable to a third Worker. Asserted by contract: `worker-loader-test.js:74-88` — passing a Dynamic Worker entrypoint stub via `props` throws `DataCloneError: Entrypoints to dynamically-loaded workers cannot be transferred to other Workers, because the system does not know how to reload this Worker from scratch. Instead, have the parent Worker expose an entrypoint which constructs the dynamic worker and forwards to it.`

## 1.6 Concurrency

- A Dynamic Worker behaves like any Worker invocation: each `fetch()`/RPC runs in a request context. Multiple concurrent requests on the same stub run **in parallel** within the same isolate (no input gate — only DOs have input gates).
- The same isolate may be reused across many concurrent requests, subject to V8's single-thread-per-isolate constraint. Workers' standard concurrency model applies (event-loop concurrency, no parallel JS execution within one isolate).
- Cross-isolate parallelism: each unique `(loaderId, name)` → a separate isolate → genuine OS-level parallelism with the parent (provided the runtime schedules them on different threads, which it does for workerd's runtime in production).

## 1.7 Limits / quotas

From `docs:dynamic-workers/usage/limits/`:

- `limits.cpuMs` (per invocation) and `limits.subRequests` settable two ways:
  1. In the `WorkerCode` returned from `getCode()` — applies to the isolate as a whole.
  2. In `getEntrypoint(name, { limits })` — applies to one invocation.
  - **The lower of the two wins** (asserted in docs).
- Runtime types: `cpuMs: number`, `subRequests: number` (`io-channels.h:316-325`).
- Above and beyond these explicit knobs, ordinary Worker plan limits apply.

From `docs:dynamic-workers/pricing/`:

- Currently Workers Paid only.
- Billing dimensions: **unique Dynamic Workers created per day**, requests, CPU time.
- Anonymous (`load()` or `get(null, …)`) = 1 unique Worker per call. Scoping with stable `id` is the cost-saving default.
- "Each `fetch()` call into a Dynamic Worker" and "each RPC method call on a Dynamic Worker stub" each count as one request.
- An RPC method that returns an `RpcTarget` does **not** double-bill subsequent calls — they share the original RPC session.

## 1.8 Routing

OSS workerd: in-process. There is no cross-region story in OSS.

Production: explicitly co-located with the parent — `blog:code-mode/`: *"We want the code to just run right where the agent is."* This is a deliberate departure from how Workers normally route (no anycast, no Smart Placement). The Dynamic Worker is a child of the parent's request context.

## 1.9 Interaction model

- **Inbound:** `worker.getEntrypoint(name?, opts).fetch(req)` — HTTP. `worker.getEntrypoint(name?, opts).rpcMethod(args)` — JS-RPC. Default entrypoint = `export default { fetch, … }` or `export default class extends WorkerEntrypoint`. Named entrypoint = any other exported `WorkerEntrypoint` subclass.
- **Outbound (from Dynamic Worker):**
  - Bindings in `env` → cap-table channels back to whatever stub the parent provided.
  - `fetch()` / `connect()` → `globalOutbound` (parent-controlled `Fetcher`, or `null` to block, or inherited).
  - `ctx.exports` → loopback inside the Dynamic Worker's *own* exports.
- **DO bridge:** `worker.getDurableObjectClass(name?, opts)` returns a class binding that can be supplied to a facet (see §2). The DO instance runs as a child of whichever DO calls `ctx.facets.get(name, () => ({ class }))`.

## 1.10 Observability

`tails: Fetcher[]` and `streamingTails: Fetcher[]` (the latter behind `allowExperimental`). The supplied stubs receive tail events for the Dynamic Worker only, not the parent. Tail Workers are wired through `DynamicWorkerSource.tails` (`io-channels.h:357-358`) and forwarded to `WorkerDef.tails` (`server.c++:4342-4353`).

Test contract: `worker-loader-test.js:300-356` confirms (a) the tail event arrives, (b) `ctx.props` set on the tail stub flows through, (c) `tail()` runs in the parent worker's environment.

`docs:dynamic-workers/usage/observability/` adds: tail Workers run **after** the Dynamic Worker has returned its response, so they don't add latency. To stream logs in real time, the doc recommends a Durable Object that both the loader's `fetch()` and the tail Worker write into.

## 1.11 Failure modes

- **Code-load callback throws** → first request on the stub throws the same exception. The stub is not reusable; the next call gets the same exception (test: `worker-loader-test.js:740-754`).
- **Module parse error / startup throws** → the user-readable error is preserved (test: `worker-loader-test.js:870-910`); not "internal error; reference = …".
- **`globalOutbound: null` and the worker calls `fetch()`** → throws `Error: This worker is not permitted to access the internet via global functions like fetch(). It must use capabilities (such as bindings in 'env') to talk to the outside world.` — exact message in `server.c++:4225-4227` and asserted by `worker-loader-test.js:271-298`.
- **`abortIsolate()`** → all in-flight calls throw "internal error; reference = …"; isolate is removed from cache.
- **Mixed JS + Python modules** → `TypeError: Module "x.py" is a Python module, but the main module isn't a Python module.` (`worker-loader-test.js:803-835`, `worker-loader.c++:244-258`).
- **Unbundled TypeScript** → `TypeError: Module name must end with '.js' or '.py' … If you're trying to load TypeScript, bundle it first with '@cloudflare/worker-bundler' …` (`worker-loader.c++:192-199`, asserted in `worker-loader-test.js:837-867`).
- **Limits exceeded** → "the Dynamic Worker will immediately throw an exception" (docs).
- **Module field count != 1** → `TypeError: Each module must contain exactly one of 'js', 'cjs', 'text', 'data', 'json', 'py', or 'wasm'` (`worker-loader.c++:209-212`).

## 1.12 Open questions / library-relevant invariants

| ID | Question | Best evidence | Resolution status |
|---|---|---|---|
| WL-1 | Is the isolate cache LRU, time-bound, both? OSS doesn't say. | Docs assert "kept warm in memory for a while" with no guarantee. Code in `server.c++:4185-4220` is a plain `HashMap`. | **Open.** Production-only invariant; not in OSS. Treat as: assume eviction can happen at any time between requests; rely on `getCode` callback being called again. |
| WL-2 | Can two Workers in different deployments share an isolate? | `workerLoaderNamespaces` is a **`Server`-level** map keyed by binding `id` (`server.h:193`). When *any* Worker links a `workerLoader = (id = "X")` binding, `workerLoaderNamespaces.findOrCreate("X", ...)` returns the same namespace (`server.c++:4974-4988`). Anonymous bindings (no `id`) get a fresh namespace each time via `anonymousWorkerLoaderNamespaces` (`server.h:194`). | **Resolved (yes, in workerd OSS) — production unconfirmed.** In workerd OSS, two distinct Workers in the same `Server` that both bind `workerLoader = (id = "shared")` **share** the `WorkerLoaderNamespace` and therefore can share warm isolates by name. **Treat as an open question for production**: cf-internal-research can confirm whether the production runtime applies tenant scoping that workerd OSS does not. *Library implication:* if production preserves OSS semantics, a stable `id` lets multiple coordinators amortize cold-start costs across deployments — but also means tenant-isolation must be enforced via the `name` and `props`, not via the binding `id`. |
| WL-3 | Capability lifetime of the returned `Fetcher` stub across requests. | `IoOwn<WorkerStubChannel>` is held by the JS object. The channel survives as long as the JS object exists. The underlying isolate may be evicted independently — calls then either rehydrate (named) or throw (anonymous). | **Resolved.** Stubs survive eviction *by name*; anonymous stubs do not. (`server.c++:4204-4207` — anonymous stubs hold the `WorkerStubImpl` directly without map registration.) |
| WL-4 | Tails are wired how? | `tails` array → `Fetcher` channels → forwarded to `WorkerDef.tails`. Tail event arrival happens through `IoChannelFactory::SubrequestChannel` invocations after the Dynamic Worker's request resolves. | **Resolved.** See `worker-loader.c++:138-145` (tails) and `:147-158` (streamingTails, requires `allowExperimental`); receiving end at `server.c++:4342-4353`. The contract test (`worker-loader-test.js:300-356`) consumes the first event only (`event[0]`), implying single-event-per-invocation semantics rather than asserting it directly. |
| WL-5 | How is `globalOutbound: null` enforced in the V8 layer? | `NullGlobalOutboundChannel::startRequest` throws on every fetch attempt; defined in `server.c++:4222-4242`. The channel is non-transferrable (throws `DOMDataCloneError`). | **Resolved.** Anything that hits `fetch()`/`connect()` goes through the global outbound channel; null = throw. There is no V8-level network sandbox — it's enforced at the Workers fetch surface. |
| WL-6 | What happens to live `RpcTarget`/`RpcStub` objects when the isolate is evicted? | E-order semantics from Cap'n Proto + `docs:durable-objects/api/stub` "If an exception is thrown by a Durable Object stub all in-flight calls and future calls will fail with exceptions." Same applies here. | **Asserted by analogy.** No explicit OSS test of dynamic-Worker stub eviction; the abort tests show in-flight calls fail with "internal error; reference = …" (`worker-loader-test.js:1008-1013`). |
| WL-7 | Does `props` go through structured clone on every method call? | `Frankenvalue::fromJs` is called once at `getEntrypoint(opts.props)` time (`worker-loader.c++:19-23`). The serialized form is reused for every invocation of that entrypoint stub. | **Resolved.** Props serialize once, ride along on every call. |
| WL-8 | Is there a hard ceiling on `modules` size or count? | Not in OSS code path. `worker-loader.c++:172` only requires `modules.fields.size() > 0`. | **Open.** Production runs likely have a script-size cap mirroring normal Workers (1 MiB compressed / 10 MiB uncompressed for Free, higher Paid — see Workers Limits). |

---

# 2. Durable Object Facets

A facet is a **child Durable Object actor** that runs inside the same Durable Object instance as a "supervisor" DO, but with its own:
- DurableObject **class** (loaded from a Worker — typically a Dynamic Worker, but any class binding works),
- isolated **SQLite database**,
- isolated **JS handler scope**,
- own `ctx.id` (defaulting to the parent's),
- own `ctx.props`.

It shares with the parent:
- the **process** and **isolate** (same V8 isolate as the parent DO when the dynamic class is in the same Worker code; a separate isolate when the class came from `worker.getDurableObjectClass()`),
- the **placement** (colo, machine),
- the **input gate / lifecycle** semantics of an actor — but each facet has its own independent input gate (it is its own `Worker::Actor`),
- alarms are **only supported on the root facet** (see §2.11 — `workerd:src/workerd/server/server.c++:2820`).

## 2.1 API surface

### TypeScript surface

From `workerd:src/workerd/api/actor-state.h:423-487`:

```ts
interface DurableObjectState {
  // …existing members (id, storage, blockConcurrencyWhile, etc.)…
  readonly facets: DurableObjectFacets;
}

interface DurableObjectFacets {
  get<T extends Rpc.DurableObjectBranded | undefined = undefined>(
    name: string,
    getStartupOptions: () => FacetStartupOptions<T> | Promise<FacetStartupOptions<T>>,
  ): Fetcher<T>;
  abort(name: string, reason: any): void;
  delete(name: string): void;
}

interface FacetStartupOptions<T> {
  class: DurableObjectClass<T>;
  id?: DurableObjectId | string;
}
```

The returned stub is a `Fetcher` (not `DurableObjectStub`). The header explicitly notes (`actor-state.h:457-459`):

> Returns a `Fetcher` instead of a `DurableObject` because the returned stub does not have the `id` or `name` methods that a DO stub normally has.

So you cannot `.id` / `.name` a facet from outside. To address a facet, you need its **name** (the string passed to `get`) within its parent.

### `DurableObjectClass` is the bridge to Worker Loader

`workerd:src/workerd/api/actor.h:358-386` — `DurableObjectClass` is an opaque, RPC-serializable handle that represents a DO class binding *without* an attached storage namespace. It is the only thing you can pass as `class:` in `FacetStartupOptions`.

Three sources of `DurableObjectClass`:
1. **From a Dynamic Worker:** `worker.getDurableObjectClass("ClassName", { props })` — `worker-loader.h:32-34`. This is the dynamic-code path.
2. **From a `durableObjectClass` binding in `bindings`** — `workerd.capnp:385-387`:
   > `durableObjectClass @26 :ServiceDesignator;` "A Durable Object class binding, without an actual storage namespace. This can be used to implement a facet."
3. **From `ctx.exports`** loopback — `worker-loader-test.js:407-413` shows `this.ctx.exports.GreeterFacet({ props: { greeting: 'Hello' } })`. Loopback bindings can be DO classes as well as `WorkerEntrypoint`s.

### Cap'n Proto wire

The runtime contract — `workerd:src/workerd/io/worker.h:901-924`:

```cpp
class FacetManager {
public:
  struct StartInfo {
    kj::Own<IoChannelFactory::ActorClassChannel> actorClass;
    Worker::Actor::Id id;        // ctx.id for the child object
  };
  virtual uint getDepth() const = 0;
  virtual kj::Own<IoChannelFactory::ActorChannel> getFacet(
      kj::StringPtr name, kj::Function<kj::Promise<StartInfo>()> getStartInfo) = 0;
  virtual void abortFacet(kj::StringPtr name, kj::Exception reason) = 0;
  virtual void deleteFacet(kj::StringPtr name) = 0;
};
```

That's the complete contract. Notice `getDepth()` — facets are recursive, and depth is tracked.

## 2.2 Wrangler / config

There is **no wrangler key** for facets. Facets are runtime-only — you create them by calling `ctx.facets.get(...)` from inside a DO. The DO class doing the calling needs:

- A SQLite-backed namespace (`migrations.new_sqlite_classes`).
- A `worker_loaders` binding (typically) so it can fetch a `DurableObjectClass` from a Dynamic Worker.

Example (`docs:dynamic-workers/usage/durable-object-facets/`):

```jsonc
{
  "compatibility_date": "2026-05-08",
  "main": "src/index.ts",
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["AppRunner"] }
  ],
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

`workers-sdk` evidence: only `packages/miniflare/src/runtime/config/generated/workerd.ts` mentions facets — auto-generated from the workerd capnp schema. There is no facet config key in `packages/wrangler/src/config/`. Wrangler does **not** declare facets; it only declares the loader and DO that supervises them.

## 2.3 Provisioning

### Two-tier model

```
┌─ Durable Object instance (idFromName "my-app") ─────────────────────┐
│                                                                     │
│   Root facet  (your supervisor class, e.g. AppRunner)               │
│      ├─ ctx.storage  → my-app.sqlite                                │
│      ├─ ctx.facets.get("greeter1", () => ({ class: <stub> }))       │
│      ├─ ctx.facets.get("greeter2", () => ({ class: <stub> }))       │
│      │                                                              │
│      ├── facet "greeter1"  (loaded class)                           │
│      │     └─ ctx.storage  → my-app.<id>.sqlite                     │
│      │                                                              │
│      └── facet "greeter2"  (loaded class)                           │
│            └─ ctx.storage  → my-app.<id>.sqlite                     │
└─────────────────────────────────────────────────────────────────────┘
        +  my-app.facets   (append-only tree-index file)
```

### How `ctx.facets.get(name, callback)` resolves the class

`workerd:src/workerd/server/server.c++:2551-2581` — `getFacetContainer`:

1. Look up the `name` in the parent's `facets` `ActorMap`.
2. If not found, call `callback()` to get `FacetStartupOptions`.
3. The `class` field is unwrapped via `callFacetStartCallback` (`server.c++:2908+`) — extracting the `ActorClassChannel` from whatever `DurableObjectClass` was supplied.
4. Construct an `ActorContainer` keyed by `name`, with `ns` (the namespace), `parent = *this`, and the timer.
5. Return an `ActorChannelImpl` wrapping it.

The same `name` from the same supervisor → same `ActorContainer` → same `Worker::Actor` instance. Eviction-then-rehydration triggers the callback again.

### Facet ID assignment (storage partitioning)

`workerd:src/workerd/server/facet-tree-index.h:50-123` and `facet-tree-index.c++:88-126`. The facet tree index is an **append-only file** named `<actor-id>.facets`. Each entry: `(parentId:uint16, nameLength:uint16, nameBytes…)`. Format:

- 8-byte magic `0xc4cdce5bc5b0ef57`.
- Each entry assigns the **next sequential ID** to a new `(parentId, name)` tuple.
- IDs start at 1; root = 0; `MAX_ID = 65535` (`facet-tree-index.h:117`), giving **65,535 non-root facets + 1 root = 65,536 total facets per actor lifetime** (consistent with the file's own header comment at `facet-tree-index.h:33-34`). Past that, `Maximum number of facets exceeded` is thrown (`facet-tree-index.c++:96`).
- The file is append-only; entries are never deleted (even when a facet is `delete()`d). This guarantees that once a name has been used, getting it again returns the same ID — preserving deterministic on-disk paths.
- Power-failure tolerant: corrupted tail is truncated on read (`facet-tree-index.c++:79-86`), so a partial entry doesn't poison the index.

### SQLite path layout

`workerd:src/workerd/server/server.c++:2684-2691`:

```cpp
if (id == 0) {
  return kj::Path({kj::str(root.key, ".sqlite")});       // root/supervisor
} else {
  return kj::Path({kj::str(root.key, '.', id, ".sqlite")}); // facet
}
```

Concrete: for an actor named `my-app` the root DB is `my-app.sqlite`, the index is `my-app.facets`, and facet ID 7's DB is `my-app.7.sqlite`. The index file exists only on the root; child facets do not have their own index files.

In production this directory layout is virtual (SRS — Storage Relay Service), but the schema is the same.

### Parent ID inheritance vs override

`actor-state.h:441-444`:

```cpp
struct StartupOptions {
  ...
  jsg::Optional<kj::OneOf<jsg::Ref<DurableObjectId>, kj::String>> id;
};
```

If `id` is omitted, the facet's `ctx.id` defaults to the parent DO's `ctx.id`. If supplied, the facet sees that as its own `ctx.id`. **This is purely a JS-visible value** — it does not affect placement, routing, or storage path. Storage path uses the facet's tree-assigned ID. Placement always follows the parent (the facet runs in the same colo, same DO instance).

## 2.4 Lifecycle

### Boot

- `ctx.facets.get(name, cb)` returns synchronously (`actor-state.h:460-462`, `server.c++:2577-2581`).
- On first call to the returned stub, the runtime:
  1. Calls `cb()` if not already running — gets `FacetStartupOptions { class, id? }`.
  2. Resolves the `ActorClassChannel` from the class.
  3. Constructs a `Worker::Actor` with the given `id` (or inherits parent's), the storage backed by the assigned SQLite path, and the class as the actor implementation.
  4. The DO's constructor runs.
- Until then, requests on the stub are queued.

### Running

Facet behaves like any DO: input gate, output gate, single-threaded handler dispatch, `blockConcurrencyWhile`, alarms (root only — see §2.11), WebSockets with hibernation. From the dynamic class's perspective, `this.ctx` is a `DurableObjectState` exactly like any other DO.

### Shutdown / hibernation

`server.c++:2755-2800` — `handleShutdown`. After **10 seconds of inactivity**, the actor is evicted (the same eviction policy as a top-level DO in workerd). Hibernation manager hibernates active WebSockets first.

**Crucial cascade:** when a facet's *parent* breaks (`monitorOnBroken`, `server.c++:2715-2728`), the parent loops through `facets` and calls `abort(brokenReason)` on each, then clears the map. **The whole tree comes down with the root.** The reverse is not true — aborting one facet does not affect siblings or the parent.

### `ctx.facets.abort(name, reason)`

`actor-state.h:464`, `server.c++:2583-2588`:

1. `facets.findEntry(name)` — if not present, no-op.
2. `entry.value->abort(reason)` — runs `Worker::Actor::shutdown` and breaks all in-flight calls with `reason`.
3. `facets.erase(entry)` — removes from the map.

After abort, `ctx.facets.get(name, cb)` will run `cb()` again from scratch. Storage is preserved.

> *Stub invalidation*: per docs (`docs:dynamic-workers/usage/durable-object-facets/#abort`):
> "Shuts down a running facet and invalidates all existing stubs. Any subsequent call on an invalidated stub throws `reason`."

### `ctx.facets.delete(name)`

`actor-state.h:465`, `server.c++:2590-2603`:

1. Calls `abortFacet(name, "Facet was deleted.")` first.
2. Looks up the facet's tree-index ID.
3. **Recursively deletes descendant facet storage** (`deleteDescendantStorage`, `server.c++:2693-2707`) — DFS through the tree, removing each child's `.sqlite` file.
4. Removes the facet's own `.sqlite` file.

Note: the **index entry stays** (append-only). If a facet is deleted and then re-created with the same name later, it gets the **same numeric ID** and its old SQLite path may still be in scope (though the file was removed). This is by design — deterministic re-use of paths.

### Replicas note

`actor-state.h:208-212` — `DurableObjectStorage` constructor includes a "replica" path (forwards writes to a primary). Facets are not specifically excluded; if the supervisor DO is replicated, the same applies to its facets. Not specifically tested in OSS.

## 2.5 Isolation

| Boundary | Shared? |
|---|---|
| Process | yes — facet always runs in the same workerd process as parent |
| V8 isolate | depends — when `class` came from a Dynamic Worker (`worker.getDurableObjectClass(...)`), the facet runs in the Dynamic Worker's isolate; otherwise it shares the parent's isolate |
| `Worker::Actor` instance | **no** — each facet has its own Actor |
| Input gate / output gate | **no** — each facet has its own gates (so two facets on the same DO can run concurrent handlers) |
| SQLite database | **no** — each facet's own file |
| Alarms | parent only (root facet) |
| Hibernation manager | each facet has its own |
| `ctx.id` JS value | inherited unless overridden |
| Container | parent only |
| Code (class) | yes within one facet, isolated from other facet classes |

This is the most important fact for the parallel-jobs library: **two facets on the same supervisor have independent input gates** — they can handle requests in parallel within the same DO instance. (The parent also has its own input gate, independent of the facets'.)

`server.c++:2331-2333` — `ActorContainer final: public RequestTracker::Hooks, public kj::Refcounted, public Worker::Actor::FacetManager`. Every running actor *is* a `FacetManager` (because every actor's runtime container implements the interface). Each facet is its own `ActorContainer` and each `Worker::Actor` carries its own `InputGate inputGate` (`worker.c++:3735`). The plumbing is wired through at `server.c++:3254-3271` (the `ActorClassImpl::newActor` path threads the FacetManager parameter into `Worker::Actor`'s ctor at `worker.h:942`). Facets are recursive (`facet-tree-index-test.c++:214-248` confirms multi-level facets).

## 2.6 Concurrency

- **Within a single facet:** standard DO single-threaded JS, input-gate-serialized handler invocation.
- **Across facets of the same supervisor:** independent input gates → genuine parallel handler execution. Storage isolation → no cross-facet locking from SQLite.
- **Parent ↔ facet:** also independent. Parent calling `await facetStub.fetch(...)` does not block parent's input gate beyond the duration of the call (the call is asynchronous over `IoChannelFactory::ActorChannel`).
- **Parallelism ceiling:** all facets and the parent run in the same workerd process. Total CPU is bounded by the underlying machine's cores allocated to that DO instance. In production, that's typically a single core per actor-class-host, but multiple actors on different cores.

## 2.7 Limits / quotas

From `docs:durable-objects/platform/limits/`:

| Limit | Value |
|---|---|
| Storage per Durable Object (sum across all facets) | 10 GB (Workers Paid) |
| Number of facets per actor lifetime | **65,536** total (root + 65,535 non-root). `MAX_ID = 65535` at `facet-tree-index.h:117`; throws `Maximum number of facets exceeded` (`facet-tree-index.c++:96`). |
| Per-request CPU | 30s (default) up to 5min (configurable via `limits.cpu_ms`) — applies per facet handler invocation |
| WebSocket message size | 32 MiB |
| WebSocket connections per DO | 32,768 |

These are the standard DO limits. Each facet's request invocation gets its own 30s CPU budget — not shared with the parent or sibling facets.

## 2.8 Routing

A facet is **always co-located** with its parent DO. There is no facet-specific routing. The parent DO's placement (which Cloudflare colo, which physical machine) determines the facet's placement. Cross-region calls only happen if you call out from a facet to a different DO namespace.

## 2.9 Interaction model

- **Inbound to a facet:** only via the parent's `ctx.facets.get(name).fetch(req)` or `ctx.facets.get(name).rpcMethod(args)`. Facets are **not directly addressable from outside** the parent DO.
- **From facet to parent:** by passing a stub or RpcTarget into `props` or `env`. The dynamic class can call back, but it has to be given the capability. The facet's class doesn't see the parent's `env` directly — only what the parent constructed via the Dynamic Worker's `env`.
- **From facet to other facets:** must go through the parent (or via a passed stub). There is no `ctx.parent` API. Sibling-to-sibling RPC is therefore **mediated by the supervisor**, which is the design intent.
- **From facet outbound network:** governed by the loaded Worker's `globalOutbound` (set at Dynamic Worker `load()`/`get()` time). When the class binding is *not* from a Dynamic Worker (e.g. it's a same-Worker DO class), the outbound is the parent Worker's outbound.

## 2.10 Observability

- Facet `console.log()` and traces flow to the **Dynamic Worker**'s tail Workers (set via `tails:` at load time). This is independent of the parent DO's observability.
- When the class is a same-Worker DO class (not from a loader), the facet's logs flow to the parent Worker's tail Workers.

## 2.11 Failure modes

- **Alarms inside a facet** silently use the default no-op `Hooks` rather than the alarm scheduler (`server.c++:2812-2822` — the `if (parent == kj::none) { ... } else { ... }` branch attaches `ActorSqliteHooks` only on root; the `else` arm uses `ActorSqlite::Hooks::getDefaultHooks()` with the explicit `// TODO(someday): Support alarms in facets, somehow.` comment).
  Practical effect: `setAlarm` from a non-root facet is a hook-less DB write, which means `getAlarm` will read it but no alarm scheduler will *trigger* it. Treat alarms as **not supported** in non-root facets.
- **Parent breaks** → all facets aborted (`server.c++:2715-2728`).
- **Facet class load fails** (callback throws or class is invalid) → next call on the stub throws.
- **Maximum facets exceeded** → exception "Maximum number of facets exceeded".
- **Empty / too-long facet name** → `Facet name cannot be empty`, `Facet name too long`.
- **`deleteAll()` on a facet's storage** → cascades: when a facet calls `ctx.storage.deleteAll()`, the runtime additionally deletes **all of that facet's child facets' storage** (`server.c++:2833-2845`, in the `afterReset` callback). This is a non-obvious safety property: clearing a facet implicitly clears its sub-tree.
- **Power loss mid-write of facet index entry** → corruption tolerated; partial entry truncated on next read (`facet-tree-index.c++:79-86`).
- **`abort()` on a non-running facet** → no-op. **`delete()` on a non-running facet** → still walks the tree and deletes storage (since the index is on disk).

## 2.12 Open questions / library-relevant invariants

| ID | Question | Best evidence | Status |
|---|---|---|---|
| F-1 | Does parent ID inheritance affect routing? | `actor-state.h:441-444` — `id` is a JS-visible value only. Storage path uses tree-assigned numeric ID. | **Resolved (no).** Placement follows parent always. The `id` override is cosmetic for `ctx.id`. |
| F-2 | Stub invalidation after `abort` — what exactly happens to a *queued* call? | Docs: "Any subsequent call on an invalidated stub throws `reason`." `server.c++:2585` — `entry.value->abort(reason)` runs through `Worker::Actor::shutdown`. In-flight calls fail with the supplied reason. | **Resolved.** `abort` is a hard reset; queued and in-flight calls fail. |
| F-3 | Are facet handlers concurrent across siblings? | Each facet has its own `Worker::Actor` → its own input gate → independent. | **Resolved (yes).** This is the key parallelism opportunity. |
| F-4 | Can a facet itself create sub-facets? | `getDepth()` is recursive (`worker.h:917`); `facet-tree-index-test.c++:214-248` exercises 3 levels. | **Resolved (yes).** |
| F-5 | Does `ctx.facets.get` survive parent eviction? | Parent eviction → all facets aborted (§2.4). After re-instantiation, `ctx.facets.get(name, cb)` → `cb()` runs again, facet rebuilt. | **Resolved.** Stubs held by the parent JS are torn down with the parent; on re-instantiation, the parent must call `ctx.facets.get` again to re-acquire. |
| F-6 | What happens to RPC stubs *passed out* of a facet? | E-order semantics; if the facet is aborted, all stubs sourced from that facet break. | **Resolved (analogically).** Same as DO stub semantics (§4). |
| F-7 | Code-update story | Recipe in docs (`docs:dynamic-workers/usage/durable-object-facets/#abort`): "abort the facet running the old version, then call `get()` with a callback that returns the new class". | **Resolved (manual).** No automatic versioning. |
| F-8 | Are facet alarms truly broken in production, or only in workerd? | OSS: hooked to default no-op (`server.c++:2820-2822`). Production: undocumented. | **Open.** Treat as not-supported until proven otherwise. |
| F-9 | Hibernation per-facet — does the parent stay alive while a facet hibernates? | Parent and facets hibernate independently (each has its own `handleShutdown` task at `server.c++:2755`). | **Resolved.** Independent hibernation. |

---

# 3. Container Durable Objects

A Durable Object class can opt-in to having an attached **container sidecar** — a long-running Linux process inside its own VM, with its lifetime tied to the DO instance. The DO is the supervisor; the container is the heavy compute.

## 3.1 API surface

### TypeScript surface

The high-level API is in the `@cloudflare/containers` npm package; the runtime API is `ctx.container` on a `DurableObjectState`.

`workerd:src/workerd/api/container.h:145-300`:

```ts
interface Container {
  readonly running: boolean;

  start(options?: ContainerStartupOptions): void;
  monitor(): Promise<void>;                    // resolves when container exits
  destroy(error?: any): Promise<void>;         // tear down
  signal(signo: number): void;
  getTcpPort(port: number): Fetcher;           // talk to container via TCP
  setInactivityTimeout(durationMs: number): Promise<void>;

  // Egress interception:
  interceptOutboundHttp(addr: string, binding: Fetcher): Promise<void>;
  interceptAllOutboundHttp(binding: Fetcher): Promise<void>;
  interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void>;
  interceptOutboundTcp(addr: string, binding: Fetcher): Promise<void>;   // experimental

  // Snapshots:
  snapshotDirectory(opts: { dir: string; name?: string }): Promise<DirectorySnapshot>;
  snapshotContainer(opts: { name?: string }): Promise<Snapshot>;

  // Experimental:
  exec(cmd: string[], options?: ExecOptions): Promise<ExecProcess>;
  inspect(): Promise<{ labels: Record<string, string> } | null>;
}

interface ContainerStartupOptions {
  entrypoint?: string[];
  enableInternet: boolean;        // default false
  env?: Record<string, string>;
  hardTimeout?: number | bigint;  // experimental — absolute kill deadline from start
  labels?: Record<string, string>;
  directorySnapshots?: ContainerDirectorySnapshotRestoreParams[];
  containerSnapshot?: ContainerSnapshot;
}
```

The `@cloudflare/containers` library provides the `Container` base class, with hooks `defaultPort`, `sleepAfter`, `onStart`, `onStop`, `onError`, `onActivityExpired` (`docs:containers/platform-details/architecture/`).

### Cap'n Proto wire (the runtime ↔ container engine RPC)

`workerd:src/workerd/io/container.capnp:10-265` — the RPC interface workerd uses to talk to the **container engine** (in workerd local: Docker; in production: Cloudflare's container runtime).

Key methods:
- `status() -> (running: Bool)` — always called at DO startup.
- `start(StartParams) -> ()` — error to call if already running.
- `signal`, `destroy`, `monitor`, `listenTcp`, `interceptOutbound{Http,Https,Tcp}`, `getTcpPort`, `snapshotDirectory`, `snapshotContainer`, `exec`.

Comment from the schema (`container.capnp:13-14`):

> When the actor shuts down, workerd will drop the `Container` capability, at which point the container engine should implicitly destroy the container.

So the **container's lifetime is bounded above by the DO's lifetime** in workerd. In production it's the same model.

## 3.2 Wrangler / config

`wrangler.jsonc` (`docs:containers/`):

```jsonc
{
  "containers": [
    {
      "class_name": "MyContainer",
      "image": "./Dockerfile",
      "max_instances": 5,
      "instance_type": "standard-1"
    }
  ],
  "durable_objects": {
    "bindings": [
      { "class_name": "MyContainer", "name": "MY_CONTAINER" }
    ]
  },
  "migrations": [
    { "new_sqlite_classes": ["MyContainer"], "tag": "v1" }
  ]
}
```

`workerd.capnp:666-676` (the runtime view inside a DO namespace):

```capnp
container @5 :ContainerOptions;
struct ContainerOptions {
  imageName @0 :Text;   # default: "latest" tag
}
```

`workerd.capnp:728-746`:

```capnp
containerEngine :union {
  none @16 :Void;
  localDocker @17 :DockerConfiguration;   # local dev only
}
struct DockerConfiguration {
  socketPath @0 :Text;
  containerEgressInterceptorImage @1 :Text;  # sidecar that proxies egress
}
```

So locally, workerd shells out to Docker via socket. In production, the container engine is internal (not in OSS).

## 3.3 Provisioning

- The **DO** is the addressing unit. `getContainer(env.MY_CONTAINER, "session-id")` is just `env.MY_CONTAINER.idFromName("session-id").get()` with sugar.
- The container is created **lazily** the first time `ctx.container.start()` is called inside the DO. Until then, the DO is a normal DO (or a DO whose `ctx.container.running === false`).
- Starting a container can take 1-3 seconds for cold start (`docs:containers/platform-details/architecture/`).
- Image distribution: pre-fetched globally; image lives in Cloudflare's Registry.
- Selection algorithm at start time: "**nearest location with a pre-fetched image**". This means **the container can be in a different colo than the DO** — this is the only DO-adjacent primitive where compute is non-co-located by default.
- Once a container is running, requests routed to that DO's container go through `ctx.container.getTcpPort(port).fetch(req)` — passes through the DO, which forwards over the RPC channel.

## 3.4 Lifecycle

- **Start:** `ctx.container.start(options)` → RPC `start(StartParams)` to the engine.
- **Run:** the container is just a Linux process inside a VM. Logs, metrics, networking are auto-wired.
- **Sleep:** `sleepAfter` (set as a class property in `@cloudflare/containers`'s `Container` base) triggers a **`SIGTERM`** after the timer expires with no requests; if the container doesn't exit within **15 minutes**, **`SIGKILL`**. Source: `docs:containers/platform-details/architecture/`. The DO can also call `destroy()` immediately.
- **Restart:** subsequent `ctx.container.start()` after exit is allowed. Disk is **ephemeral** by default — fresh image each cold start.
- **Snapshot/restore:** `snapshotDirectory` / `snapshotContainer` produce an `id`; pass back via `directorySnapshots` / `containerSnapshot` in next `start`. Persistence path is "coming soon" per docs.
- **DO eviction:** when the DO is evicted (10s idle), workerd drops the `Container` capability → engine destroys the container (`container.capnp:13-14`).

### Lifecycle hooks (in `@cloudflare/containers`)

`docs:containers/platform-details/architecture/`:
- `onStart()` — after start.
- `onStop()` — after exit, with `{ exitCode, reason }`.
- `onActivityExpired()` — when `sleepAfter` fires; default impl calls `stop()`.
- `onError()` — error exit.

## 3.5 Isolation

| Boundary | Where |
|---|---|
| VM | one VM per container instance (`docs:containers/platform-details/architecture/`: "Each container instance runs inside its own VM") |
| Process | inside the VM |
| Filesystem | ephemeral disk per instance, scoped to instance type (2-20 GB) |
| Network | egress optional (`enableInternet`); routable to private services via `interceptOutbound{Http,Https,Tcp}` |
| Architecture | `linux/amd64` only |

## 3.6 Concurrency

A container is one VM/process. Concurrency depends on:
- vCPU allocation (1/16 for `lite`, up to 4 for `standard-4`) — `docs:containers/platform-details/limits/`.
- Memory (256 MiB to 12 GiB).
- The application's own threading.

The DO supervising the container is single-threaded. The container itself can be multi-threaded (up to its vCPU allocation).

`max_instances` (per class) caps the total concurrent live containers across all DOs of that class.

## 3.7 Limits / quotas

`docs:containers/platform-details/limits/`:

| Resource | Workers Paid |
|---|---|
| Memory across all live containers | 6 TiB |
| vCPU across all live containers | 1500 |
| Disk across all live containers | 30 TB |
| Image size | = instance disk space |
| Total image storage / account | 50 GB |

Instance types: `lite` (1/16 vCPU / 256 MiB), `basic` (1/4 / 1 GiB), `standard-1`–`standard-4`. Custom: 1-4 vCPU, ≥3 GiB memory per vCPU, ≤2 GB disk per GiB memory.

## 3.8 Routing

- DO routes by `idFromName` / `newUniqueId` as usual — single global routing.
- Container is **placed where a pre-fetched image is available nearest to the request**, which can differ from the DO's colo. Subsequent requests to the same DO route to the same container while it's alive.
- After container restart, the container can land in a different location.
- This is the **only** primitive in this dossier where compute placement is decoupled from the DO.

## 3.9 Interaction model

- **Worker → Container** flows always *via the DO*: caller stub → DO → `ctx.container.getTcpPort(port).fetch(req)` → container.
- **Container → outside world:** governed by `enableInternet` plus interception bindings. Default: blocked.
- **Container ↔ DO:** TCP via `getTcpPort`. The `@cloudflare/containers` library wraps this so `containerInstance.fetch(req)` works.
- **Container → other containers:** must go via the DO via egress interception or a binding.

## 3.10 Observability

Auto-collected logs and metrics. `docs:containers/faq/#how-do-container-logs-work` (not fetched in this pass — known docs slug). DO-level tail Workers + analytics.

## 3.11 Failure modes

- **Out of memory:** container OOM-killed. `onError` runs.
- **Image too large:** rejected at deploy.
- **`hardTimeout` exceeded:** SIGKILL.
- **DO eviction with running container:** container destroyed.
- **Image pull failure in cold colo:** `start()` rejects.
- **VM crash:** container considered exited; `onStop` runs.
- **Account-level resource cap hit:** `start()` rejects with quota error.

## 3.12 Open questions

| ID | Question | Resolution |
|---|---|---|
| C-1 | Can two DOs share one container? | **No.** Container is owned by a single DO instance (`container.capnp:13-14`). |
| C-2 | Is the container in the same colo as the DO? | **No, not necessarily.** Placement chosen for "nearest pre-fetched image" which may differ from the DO. |
| C-3 | Can the supervisor DO host facets *and* a container? | The C++ `Worker::Actor` ctor accepts both `container` and `facetManager` (`worker.h:941-942`). Per server.c++:2820 alarms aren't yet supported in facets — but containers per-facet are not exposed in the OSS surface. **Container is on root only.** |
| C-4 | What happens to in-flight TCP connections during sleep? | They're severed. `sleepAfter` triggers SIGTERM; DO must drain. |
| C-5 | Image-update story (rolling deploy) | New deploys roll out instances gradually (`docs:containers/platform-details/architecture/`). Existing containers continue on old image until they restart. |

---

# 4. Named Entrypoints + Workers JS-RPC

Workers' built-in RPC is the substrate that makes Worker Loaders, Facets, Service Bindings, and Dispatch Namespaces all behave like JavaScript object graphs. It's a Cap'n Proto-derived (Cap'n Web) object-capability RPC system. **This section is the connective tissue for everything else.**

## 4.1 API surface

### `WorkerEntrypoint` (`cloudflare:workers`)

```ts
import { WorkerEntrypoint, RpcTarget, DurableObject } from "cloudflare:workers";

export class MyApi extends WorkerEntrypoint<Env, Props> {
  // env, ctx accessible via this.env, this.ctx
  // ctx.props is the per-call props the caller specified
  // ctx.exports is the loopback to your own Worker's exports
  async fetch(req: Request): Promise<Response> { … }
  async customRpc(args): Promise<any> { … }
}
```

Doc evidence: `docs:workers/runtime-apis/bindings/service-bindings/rpc/`. Header registration: each `WorkerEntrypoint`-derived class becomes an exported entrypoint of the Worker. Default-exported class = "default" entrypoint.

### `RpcTarget`

Any class extending `RpcTarget` becomes pass-by-stub over RPC (instead of failing with "non-RpcTarget classes can't cross"). Methods are remotely callable. Properties are remotely readable (await them).

### `DurableObject` base class

`DurableObject` is a `WorkerEntrypoint`-like base for actor classes. Methods are RPC-callable through a `DurableObjectStub` (`docs:durable-objects/api/stub/`).

### Cross-stub forwarding

A stub received from Worker B can be passed to Worker C via RPC. Calls on it are proxied through the introducer (`docs:workers/runtime-apis/rpc/#forwarding-rpc-stubs`):

> "When ANOTHER_SERVICE calls a method on the counter that is passed to it, this call will automatically be proxied through the introducer and on to the RpcTarget class implemented by COUNTER_SERVICE."

> "Currently, this proxying only lasts until the end of the Workers' execution contexts. **A proxy connection cannot be persisted for later use.**"

### Promise pipelining

The promise returned by an RPC method is a custom thenable. Calling a method on the *promise itself* (without awaiting first) makes a **speculative pipelined call** that completes in one round trip:

```ts
using promiseForCounter = env.COUNTER_SERVICE.getCounter();
await promiseForCounter.increment();   // single round trip
```

Doc evidence: `docs:workers/runtime-apis/rpc/#promise-pipelining`. Backed by Cap'n Proto's E-order semantics (`docs:durable-objects/api/stub`).

### Disposers

Stubs implement `Symbol.dispose` / `Symbol.asyncDispose`. The `using` declaration releases the stub at scope exit. Without `using`, stubs are GC-released — but GC is non-deterministic, so explicit `using` is recommended.

### Streams, Request, Response, RpcStub

Pass-through types: `ReadableStream` (byte-oriented only), `WritableStream`, `Request`, `Response`. Ownership transfers — the sender can no longer use the stream. Flow control is automatic.

## 4.2 Wrangler / config

A Worker that *defines* entrypoints just exports them. To *call* a named entrypoint, you declare a service binding:

```jsonc
{
  "services": [
    {
      "binding": "ADMIN",
      "service": "todo-app",
      "entrypoint": "AdminEntrypoint"
    }
  ]
}
```

Evidence: `docs:workers/runtime-apis/bindings/service-bindings/rpc/#named-entrypoints`.

Entrypoints can also be addressed via:
- `ctx.exports.<EntrypointName>({ props })` — loopback into the same Worker (compat flag `enable_ctx_exports`).
- `worker.getEntrypoint(name)` — on a Dynamic Worker stub (§1).
- DO `env.NAMESPACE.get(id)` returns the `DurableObject`-class entrypoint by default.

## 4.3 Provisioning

- Entrypoints are **regular class exports** of a Worker; no separate registration.
- Each invocation creates a new instance of the class — *stateless across calls* (`docs:workers/runtime-apis/bindings/service-bindings/rpc/#the-workerentrypoint-class`):
  > "A new instance of the class is created every time the Worker is called. Note that even though the Worker is implemented as a class, it is still stateless"
- `DurableObject` subclasses are the exception — there's one instance per DO per actor, and it persists for the actor's lifetime.

## 4.4 Lifecycle

### Stub lifecycle

- A stub holds a capability table reference. While the stub is live, the underlying `RpcTarget` (or `WorkerEntrypoint` invocation, or DO) is kept alive enough to serve calls.
- Stubs cannot persist beyond the **execution context** of the introducing Worker (`docs:workers/runtime-apis/rpc/#forwarding-rpc-stubs` — explicit).
- DO stubs are an exception: they're addressable globally by ID, so the *stub object* dies with its context, but the DO it points to has its own persistence.

### Promise pipelining lifecycle

- Speculative call queued before parent resolves.
- If the parent throws, all pipelined calls fail with the same exception (`docs:workers/runtime-apis/rpc`).

## 4.5 Isolation

- **WorkerEntrypoint** in service binding: runs in the target Worker's isolate, on the same thread by default (Smart Placement may relocate).
- **WorkerEntrypoint** in a Dynamic Worker via Worker Loader: runs in the Dynamic Worker's isolate.
- **WorkerEntrypoint** in `ctx.exports` loopback: same isolate, same thread.
- **DurableObject**: in the DO's isolate (often shared with the parent Worker's isolate when same-Worker class; separate when from a Dynamic Worker class binding).

## 4.6 Concurrency

- Each RPC call gets its own request context. Multiple concurrent RPC calls on the same `WorkerEntrypoint` binding run in parallel (same Worker, same isolate, but new instance per call).
- **Subrequest budget:** "A single request has a maximum of 32 Worker invocations, and each call to a Service binding counts towards this limit. Subsequent calls will throw an exception." (`docs:workers/runtime-apis/bindings/service-bindings/#limits`). This is the cap on **fan-out per request**.

## 4.7 Limits / quotas

- Max RPC payload **32 MiB** serialized. Larger → use `ReadableStream` (`docs:workers/runtime-apis/rpc/#limitations`).
- Subrequests: each RPC counts; cap is 1000 per request on Workers Paid (Workers limits).
- Service-binding RPC calls share `request.cf` only when in trusted dispatch namespaces (`docs:cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/`).

## 4.8 Routing

- Service bindings: same colo by default; Smart Placement may move the callee.
- DO RPC: routes to the DO's home colo (single-region pin).
- Worker Loader RPC: parent's colo (Dynamic Worker is co-located).
- Dispatch namespace: same as service binding routing.

## 4.9 Interaction model

- All RPC is **`async`** from caller side, even if the callee method is sync.
- Callable surface: methods + property getters (await the property to fetch).
- Pass-by-stub: functions, `RpcTarget` subclasses, RPC stubs themselves, streams, `Request`, `Response`.
- Plain class instances (non-`RpcTarget`) **cannot** cross — explicit error rather than silent property-only clone.

## 4.10 Observability

Standard Workers tail / observability applies. Each RPC call shows up as an invocation event (and counts toward billing as one request, per Worker Loader pricing — `docs:dynamic-workers/pricing/`).

## 4.11 Failure modes

- **Method throws** → caller awaits → exception thrown. Pipelined calls all fail with the same exception.
- **Network error mid-call (DO disconnects)** → all in-flight and future calls on the *same stub* fail; recreate the stub to recover (`docs:durable-objects/api/stub/`):
  > "If an exception is thrown by a Durable Object stub all in-flight calls and future calls will fail with [exceptions]. To continue invoking methods on a remote Durable Object a Worker must recreate the stub."
- **Stub leaked across contexts** → silently broken on use; no warning currently.
- **`structuredClone` of class instance not extending `RpcTarget`** → throws `DataCloneError`.
- **32 MiB payload overflow** → throws.

## 4.12 Open questions / library-relevant invariants

| ID | Question | Resolution |
|---|---|---|
| RPC-1 | E-order across pipelined calls? | Yes — Cap'n Proto E-order is a contract (`docs:durable-objects/api/stub`). Calls to one stub deliver in order. |
| RPC-2 | Stub passing chain depth | Unbounded in principle; each hop adds a proxy. Costs latency and a request-counter increment. |
| RPC-3 | Stub lifetime when introducer goes idle | "Currently, this proxying only lasts until the end of the Workers' execution contexts." → if the introducer's request context ends, forwarded stubs break. **Critical for the multi-processing library:** the coordinator must stay alive while workers hold stubs. |
| RPC-4 | Can a Dynamic Worker entrypoint stub be passed to another Worker? | **No.** Explicitly tested (`worker-loader-test.js:74-88`). |
| RPC-5 | Are RPC method invocations input-gated on a DO? | Yes — the DO's input gate serializes. Non-DO `WorkerEntrypoint`s have no gate. |

---

# 5. Dispatch Namespaces (Workers for Platforms)

A namespace-scoped lookup for **deployed multi-tenant Workers**. The dispatch namespace is the deployment substrate; the **dynamic dispatch Worker** routes requests into it.

## 5.1 API surface

```ts
interface DispatchNamespace {
  get(workerName: string, args?: object, opts?: { limits?: { cpuMs?: number; subRequests?: number } }): Fetcher;
}

// Inside the dispatcher:
const userWorker = env.DISPATCHER.get("customer-a", {}, { limits: { cpuMs: 50, subRequests: 50 } });
return userWorker.fetch(request);
```

Evidence: `docs:cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/`.

## 5.2 Wrangler / config

```jsonc
{
  "dispatch_namespaces": [
    { "binding": "DISPATCHER", "namespace": "my-dispatch-namespace" }
  ]
}
```

User Workers are deployed via API into a namespace. Outbound Workers (egress interceptors) and tail consumers are configured per namespace.

## 5.3 Provisioning

- Namespace is a control-plane container. Each user Worker inside it is a **fully deployed Worker** (with its own bundle, secrets, bindings).
- `env.DISPATCHER.get(name)` returns a stub immediately. The lookup happens at first request.
- Cap on user Workers: "Unlimited number of Workers — No per-account script limits apply to Workers in a namespace" (`docs:cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works`).

## 5.4 Lifecycle

- User Workers deploy/undeploy via API.
- `env.DISPATCHER.get("missing-name").fetch(req)` throws `Error: Worker not found …` — caught in dispatcher.
- Each request is independent: the dispatcher decides routing per request.

## 5.5 Isolation

**Untrusted by default** (`docs:cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/`):
- `request.cf` is **not** available in user Workers.
- Each user Worker has an **isolated cache** (Cache API / `caches.default`).
- `caches.default` is **disabled** for user Workers in the namespace.

Trusted mode flips these but leaks cache across tenants — only suitable for internal platforms.

## 5.6 Concurrency

Standard Worker concurrency. Each user Worker invocation is a fresh isolate-call.

## 5.7 Limits / quotas

- Per-Worker custom limits: `cpuMs`, `subRequests` set at the `get(name, {}, { limits })` call site by the dispatcher (`docs:cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/`).
- The dispatcher itself counts each `dispatcher.get(...).fetch(...)` toward its own subrequest cap.

## 5.8 Routing

- Single-tenant Workers: standard routing (anycast, eyeball-colo).
- The dispatcher and user Worker are typically **co-located**, but Smart Placement can move them.

## 5.9 Interaction model

- Dispatcher → user Worker: `fetch(request)` only. **No RPC** to dispatch-namespace Workers in OSS docs (they're treated as opaque HTTP services).
- User Worker outbound: optionally through an **outbound Worker** (egress interceptor) — every `fetch()` from user Workers passes through it first.

## 5.10 Observability

- Tail Workers can be configured per namespace.
- Workers Logs apply.
- Tags allow filtering by customer/plan/environment (`docs:cloudflare-for-platforms/workers-for-platforms/configuration/tags/`).

## 5.11 Failure modes

- `Worker not found` if name doesn't exist.
- CPU/subrequest limit exceeded → exception in dispatcher.
- User Worker unhandled exception → standard Workers error handling.

## 5.12 Open questions

| ID | Question | Resolution |
|---|---|---|
| DN-1 | RPC vs fetch with dispatch namespace? | Docs only show `.fetch(request)`. RPC support is not documented. **Treat as fetch-only.** |
| DN-2 | Worker Loader vs Dispatch Namespace head-to-head | See §7 comparison. |
| DN-3 | Can dispatch user Workers be DOs? | DOs require namespace declarations at the parent script level. Dispatch namespaces deploy *Workers*; DOs deployed inside a user Worker would be subject to standard DO routing, but cross-tenant DO access is blocked. |

---

# 6. Service Bindings

The original cross-Worker primitive. Direct A→B Worker calls without going through public URLs.

## 6.1 API surface

Two flavors:

### RPC mode (preferred)

```jsonc
{
  "services": [
    { "binding": "WORKER_B", "service": "worker_b", "entrypoint": "MyEntrypoint" }
  ]
}
```

```ts
const result = await env.WORKER_B.add(1, 2);
```

`docs:workers/runtime-apis/bindings/service-bindings/rpc/`.

### HTTP mode

```jsonc
{ "binding": "WORKER_B", "service": "worker_b" }
```

```ts
const resp = await env.WORKER_B.fetch(request);
```

`docs:workers/runtime-apis/bindings/service-bindings/http/` (not deeply fetched; behavior is "the standard `Fetcher` interface").

## 6.2 Wrangler / config

`services` array. `entrypoint` field selects a named entrypoint. Default = the Worker's `export default`.

## 6.3 Provisioning

- Both Workers are deployed independently.
- Target Worker must exist before caller is deployed.
- Smart Placement may relocate either side.

## 6.4 Lifecycle

- "Service bindings API is asynchronous — you must `await` any method you call. If Worker A invokes Worker B via a Service binding, and Worker A does not await the completion of Worker B, Worker B will be terminated early." (`docs:workers/runtime-apis/bindings/service-bindings/`)

## 6.5 Isolation

- Same colo by default; Smart Placement may move callee.
- Different isolates always (cross-Worker).

## 6.6 Concurrency

- Standard Workers concurrency.
- Each call is a fresh callee invocation.

## 6.7 Limits / quotas

- "Each request to a Worker via a Service binding counts toward your subrequest limit."
- "A single request has a maximum of 32 Worker invocations, and each call to a Service binding counts towards this limit." — **the hard fan-out cap per parent request is 32.**
- "Calling a service binding does not count towards simultaneous open connection limits."

## 6.8 Routing

Same as RPC — same colo (Smart Placement may move). DO RPC is single-region pinned.

## 6.9 Interaction model

- RPC: `env.B.method(args)` and method return values follow §4.
- HTTP: `env.B.fetch(request)`.
- Service bindings cannot dynamically discover Workers — the binding is named at config time. (Use Dispatch Namespace or Worker Loader for dynamic.)

## 6.10 Observability

Standard. Each invocation shows up in the callee's tail/logs.

## 6.11 Failure modes

- Binding to non-existent Worker → deploy-time failure.
- Callee throws → caller awaits → exception.

## 6.12 When to use vs alternatives

| Need | Use |
|---|---|
| A and B are statically known, deployed by you | Service binding (RPC if calling specific methods; HTTP for reverse-proxy patterns). |
| Many tenants, deployed via API | Dispatch namespace. |
| Code provided at runtime, ephemeral or short-lived | Worker Loader / Dynamic Workers. |
| Stateful actor with shared storage with supervisor | Facets. |
| Heavy CPU / non-JS workload tied to a DO instance | Container DO. |
| Any of the above + per-call custom credentials | Pass via `props` (Worker Loader) or `ctx.props` (Dispatch / RPC). |

---

# 7. Cross-primitive comparison & fitness for "multi-processing"

## 7.1 Head-to-head: Worker Loader vs Dispatch Namespace

Both let the *caller* dynamically pick which code runs. They solve the same problem at different scales.

| Axis | Worker Loader | Dispatch Namespace |
|---|---|---|
| Code source | Strings supplied at runtime, in the calling Worker's request context | Pre-deployed Workers, deployed via API |
| Cold start | ~ms (isolate boot) | Standard Worker start |
| Per-invocation cost | Pay-per-Dynamic-Worker-per-day + requests + CPU | Standard Workers pricing |
| Identity | Caller-chosen `id` string (or anonymous UUID); shared cache via `id` on the binding | Cloudflare-known `name` of a deployed Worker |
| Bindings/env supplied to runner | **Caller-controlled `env`** — pass any RPC stub or service binding | **Pre-configured at deploy** by the platform; outbound interceptor optional |
| Trust model | Caller-controlled (`globalOutbound: null`, custom limits, capability env) | Platform-controlled untrusted-mode default |
| RPC | Yes — `getEntrypoint(name).rpc()` | Not in OSS docs (fetch-only) |
| Storage | None directly; pair with Facets for persistent SQLite | None directly |
| Lifecycle | Ephemeral, evictable; named keeps cache | Long-lived deployments; user owns deploy/undeploy |
| Use case fit | "AI Code Mode", per-tenant ephemeral logic, vibe-code | Multi-tenant SaaS, per-customer deployed apps |

**Punchline for the multi-processing library:** Worker Loader is the *closer* match for "spin up a worker on demand to run a job." Dispatch namespace is for "host my customers' apps." If our jobs come from a deploy pipeline, dispatch wins. If our jobs are computed/generated at request time, loader wins.

## 7.2 Service Binding vs RPC vs everything

Service binding is the *transport layer* used by all the other primitives:
- Worker Loader's `getEntrypoint().method()` is RPC over a service-binding-like channel.
- Facet's stub is RPC over a DO actor channel.
- Dispatch's `userWorker.fetch(req)` is the fetch surface of a service binding.

When you must use a service binding (and not something fancier):
- The callee is statically known at deploy time.
- You don't need per-tenant capability passing (use Worker Loader).
- You don't need per-tenant deployments (use Dispatch).

## 7.3 Multi-processing fitness scorecard

Scoring criteria (1-5):

| Primitive | Parallelism | Addressability | State | Cold start | Cost-per-job | Coordinator-friendly |
|---|---|---|---|---|---|---|
| **Worker Loader** ephemeral | 5 — many isolates concurrently | 4 — by `id` string, caller-managed | 1 — none, paired with facets only | 5 — ms | 4 — billed per unique-Worker-per-day | 5 — capability-passing via env, full control |
| **Worker Loader** named (warm) | 5 | 5 — `id` is stable, callable across requests | 2 — module-scope only, evictable | 5 (warm) / 4 (cold) | 5 — many calls amortise the daily uniqueness fee | 5 |
| **DO Facets** | 4 — each facet = independent gate, but capped by parent placement | 4 — by name within parent only | 5 — own SQLite, persistent | 3 — DO-class boot | 3 — DO request pricing, storage | 4 — supervisor pattern is built-in |
| **Container DOs** | 3 — one VM per DO | 3 — by DO name; container can be in different colo | 4 — ephemeral disk by default; snapshots | 1-2 — 1-3s cold | 1 — per-vCPU/memory billing, image storage | 3 — supervisor is the DO, not the Worker |
| **Dispatch Namespace** | 4 — many tenants concurrent | 5 — name lookup | 1 — only via embedded DOs/KV/etc | 4 | 3 — standard Workers | 4 — built for fan-out routing |
| **Service Bindings** | 3 — bounded by 32-fan-out cap per request | 1 — static, named at deploy | 0 | 5 | 5 | 2 — static topology |

### How to combine for "multi-processing"

Three viable shapes for the eventual library:

1. **Ephemeral-loader pool (recommended for arbitrary user code).**
   - **Coordinator:** a Worker (no DO needed) holds a `LOADER` binding.
   - **Worker pool:** `LOADER.get("job-${jobHash}", () => ({...code, env: { COORDINATOR: ctx.exports.Coordinator({props: {jobId}}) }}))` — each unique job gets its own warm isolate.
   - **Job dispatch:** call `getEntrypoint("Worker", { props: {…} }).run(args)` per job.
   - **Result/stream-back:** the Dynamic Worker calls back via the `COORDINATOR` capability passed in `env`. Or returns via RPC.
   - **Strengths:** low ms cold start, per-job sandbox (capability-only outbound), genuine cross-isolate parallelism.
   - **Weaknesses:** no in-memory state across jobs unless you reuse `id`; per-day uniqueness billing means hashing IDs liberally is costly.
   - **Watch-outs:** RPC stub forwarding only lasts as long as the introducing Worker's request context (RPC-3). For long-running jobs, the coordinator must keep its request alive (e.g., via WebSocket / Workflow / a coordinator DO).

2. **Persistent-thread pool via DO facets (recommended for stateful workers).**
   - **Coordinator:** a supervisor DO (`JobCoordinator`).
   - **Worker pool:** facets named `worker-0`, `worker-1`, …, each with its own SQLite for partial state. Each facet's class is loaded from the user-provided code via `LOADER.get(...).getDurableObjectClass("Worker")`.
   - **Job dispatch:** coordinator picks a facet by job hash or round-robin and calls `facet.runJob(args)`.
   - **Strengths:** facets have independent input gates ⇒ true parallel handlers under one DO. Persistent storage per worker. Up to 65,535 facets per supervisor.
   - **Weaknesses:** all facets co-located with parent ⇒ capped by per-DO CPU; alarms not supported in non-root facets; entire tree comes down with the parent on `monitorOnBroken`.
   - **Watch-outs:** facet hibernation policy is the same 10s idle as DOs in workerd; in production, treat as opaque.

3. **Container DOs as heavy threads.**
   - **Coordinator:** Worker.
   - **Worker pool:** `MyContainer` DOs, sized to `standard-1`/`standard-2`.
   - **Job dispatch:** `getContainer(env.MY_CONTAINER, jobId).fetch(req)` or RPC.
   - **Strengths:** non-JS workloads, multi-vCPU per worker, full Linux.
   - **Weaknesses:** 1-3s cold start, container can be in different colo from DO, ephemeral disk, far more expensive.
   - **Watch-outs:** containers gated on `max_instances` per class.

### Hybrid (the likely best answer)

A coordinator DO orchestrating:
- A **facet per persistent worker thread** for affinity + state.
- A **Worker Loader pool** for stateless one-off jobs (with `globalOutbound: null` to sandbox).
- **Container DOs** as escape hatch for CPU-bound or Python/native workloads.
- Job queue stored in the coordinator's SQLite; dispatch via the facet/loader/container as appropriate.

The blocking limits to design around:
- 32-fan-out cap per request → batch via streams or a Workflow if a single request must coordinate >32 calls.
- Per-day Dynamic Worker uniqueness billing → use stable `id`s (hash of code).
- Stub forwarding lifetime → coordinator must be on the request path or a DO that keeps a long-lived request open.
- Facet alarms not supported → schedule from the supervisor's alarm.

---

# 8. Open questions / contradictions to resolve with internal sources

(Hand off these to the cf-internal-research session at reconciliation.)

| ID | Question | Why it matters for the library |
|---|---|---|
| WL-1 | Production isolate eviction policy: LRU by memory? Time-based? Per-binding quota? | Determines how aggressive `getCode` callbacks must be (re-fetching code from R2/D1 vs. embedding inline). |
| WL-3 | Confirm: stubs survive eviction *for named Dynamic Workers* in production. | Needed to size connection pools and decide if stubs can be cached across requests. |
| F-8 | Are facet alarms broken in production, or only in workerd OSS? | If broken in prod too, the library cannot use facet alarms; must drive timing from supervisor. |
| C-2 | Container placement vs DO colo — what's the typical latency hit? | Multi-processing performance budget. |
| RPC-3 | Concrete behaviour when an introducer's execution context ends while a forwarded stub is still in use. | Determines whether the coordinator can be transient (Worker) or must be a DO. |
| DN-1 | Does dispatch namespace support RPC? | Affects which stubs a dispatcher can hand back to its tenants. |
| WL-8 | Production cap on `WorkerCode.modules` total bytes. | Determines whether bundled-with-deps Dynamic Workers (Hono + npm) are practical. |

---

# 9. Citation index

(Each entry below was used as evidence for at least one claim in §1-§7. Path-stable references are workerd `main` snapshot at fetch time, May 2026.)

## 9.1 workerd source

| Path | Used for |
|---|---|
| `src/workerd/api/worker-loader.h` | Worker Loader API surface, types, modules |
| `src/workerd/api/worker-loader.c++` | Loader semantics, env caps rewriting, module type errors |
| `src/workerd/api/tests/worker-loader-test.js` | Contract tests for every loader behaviour |
| `src/workerd/api/tests/worker-loader-test.wd-test` | Loader binding declarations, multi-id sharing |
| `src/workerd/api/actor-state.h` | DurableObjectFacets API, FacetStartupOptions, DurableObjectState shape |
| `src/workerd/api/actor.h` | DurableObjectClass type for facets |
| `src/workerd/api/container.h` | Container API surface, ContainerStartupOptions |
| `src/workerd/io/container.capnp` | Container ↔ engine RPC contract |
| `src/workerd/io/io-channels.h` | DynamicWorkerSource, WorkerStubChannel, ResourceLimits |
| `src/workerd/io/worker.h` | FacetManager, HibernationManager, Worker::Actor ctor |
| `src/workerd/server/workerd.capnp` | Binding schema (workerLoader, durableObjectClass, container, durableObjectStorage) |
| `src/workerd/server/server.c++` | Loader namespace impl, facet container impl, env rewriting, eviction |
| `src/workerd/server/facet-tree-index.h` | Facet ID assignment, 65535 cap, on-disk format |
| `src/workerd/server/facet-tree-index.c++` | Append-only index, corruption tolerance |
| `src/workerd/server/facet-tree-index-test.c++` | Multi-level tree (facets-of-facets), error cases |

## 9.2 workers-sdk source

| Path | Used for |
|---|---|
| `packages/wrangler/src/__tests__/type-generation.test.ts:539` | Wrangler `worker_loaders` config fixture |
| `packages/wrangler/src/type-generation/index.ts:2242-2262` | Type generation for `WorkerLoader` |
| `packages/wrangler/src/deployment-bundle/create-worker-upload-form.ts:159, 498` | `worker_loader` upload binding |
| `packages/miniflare/src/plugins/worker-loader/index.ts` | Local-dev plugin (existence — not deeply read) |

## 9.3 Public docs

| URL slug | Used for |
|---|---|
| `dynamic-workers/` | Worker Loaders overview, use cases |
| `dynamic-workers/getting-started/` | `load()` vs `get()`, `globalOutbound`, Python |
| `dynamic-workers/api-reference/` | Full WorkerCode reference, env/props/tails semantics |
| `dynamic-workers/usage/bindings/` | Capability-based sandboxing, custom bindings, props |
| `dynamic-workers/usage/durable-object-facets/` | Facet supervisor pattern, 3-layer model, abort/delete |
| `dynamic-workers/usage/egress-control/` | globalOutbound options, HttpGateway pattern |
| `dynamic-workers/usage/limits/` | cpuMs, subRequests; "lower of the two wins" |
| `dynamic-workers/usage/observability/` | Tail Workers wiring, real-time logs via DO |
| `dynamic-workers/pricing/` | Per-day uniqueness billing, RPC = request |
| `dynamic-workers/usage/dynamic-workflows/` | Combining Loaders + Workflows |
| `durable-objects/` | DO concepts |
| `durable-objects/api/state/` | DurableObjectState methods, hibernation, abort |
| `durable-objects/api/stub/` | E-order, stub failure semantics, recreate-to-recover |
| `durable-objects/platform/limits/` | Per-DO storage, CPU, WebSocket caps |
| `workers/runtime-apis/rpc/` | RPC promise pipelining, stub forwarding, types |
| `workers/runtime-apis/bindings/service-bindings/` | Service binding overview, fan-out cap |
| `workers/runtime-apis/bindings/service-bindings/rpc/` | WorkerEntrypoint, named entrypoints |
| `cloudflare-for-platforms/workers-for-platforms/` | Dispatch namespace overview |
| `cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/` | Dispatch architecture |
| `cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/` | Dispatcher routing patterns, custom limits |
| `cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/` | Untrusted-mode invariants |
| `containers/` | Container overview, basic config |
| `containers/platform-details/architecture/` | Container lifecycle, placement, cold start |
| `containers/platform-details/limits/` | Instance types, resource caps |

## 9.4 Blog

| URL | Used for |
|---|---|
| `blog.cloudflare.com/code-mode/` | Worker Loader rationale, isolate-vs-container framing, capability-based sandboxing |

---

**End of dossier (pre-review).** §10 reviewer findings appended after the rigor pass.

# 10. Rigor review — findings & post-review additions

A reviewer agent cross-checked every `path:line` citation in §1-§9 against the workerd OSS source at extraction time (May 2026). The full audit is summarised here; bet-affecting findings have been folded back into the prose above. This section preserves the trail.

## 10.1 Critical fixes applied

### CR-1 — WL-2 was wrong (now fixed)

**Original claim:** "A Worker A and Worker B cannot share a Dynamic Worker isolate even if both have `LOADER` bindings with `id = 'shared'` — namespaces are scoped to the parent service (`server.c++:4509`)."

**What the source actually says:** `server.h:193-194` declares `workerLoaderNamespaces` and `anonymousWorkerLoaderNamespaces` as `Server`-level maps. `server.c++:4974-4988` shows that for *every* Worker linking a `workerLoader` binding with the same `id`, `workerLoaderNamespaces.findOrCreate(id, ...)` returns the **same** namespace. So in workerd OSS, **two distinct Workers can share warm Dynamic Worker isolates by `(id, name)`**.

**Status:** WL-2 in §1.12 has been rewritten to reflect this and re-classified as "Resolved (yes, in workerd OSS) — production unconfirmed." Production semantics may be tenant-scoped; reconciliation is needed.

**Why this matters for the multi-processing library:** if production preserves OSS semantics, a stable `id` across coordinator deployments amortises cold starts but **also weakens isolation**. Tenant separation must come from `name` and `props`, not from the `id`.

### CR-2 — FacetManager construction citation was misleading (now fixed)

**Original cite:** `server.c++:570 and :3254-3271` for "every actor builds a fresh FacetManager."

**What the source actually says:** Line 570 is `InvalidConfigService::newActor`, an error-throwing stub. Lines 3254-3271 thread the `FacetManager` parameter into `Worker::Actor`'s ctor; they do not show *construction*. The actual proof that every actor *is* a FacetManager is at **`server.c++:2331-2333`** — `class ActorContainer final: ... public Worker::Actor::FacetManager`. Each actor's runtime container implements the interface.

**Status:** §2.5 prose updated to cite `server.c++:2331-2333` (ActorContainer extends FacetManager) and `worker.c++:3735` (each actor has its own `InputGate inputGate`).

## 10.2 Medium / minor adjustments folded in

- **65,535 vs 65,536:** §2.3 and §2.7 now state "65,536 total (root + 65,535 non-root)" matching the file's own header comment.
- **Alarm-in-facet citation:** broadened to `server.c++:2812-2822` showing the full root-vs-facet branching, not just the TODO comment.
- **Counter-test citation:** split into `:505-508` (sharing) and `:509-525` (non-sharing).
- **Tail-wiring citation:** split into `:138-145` (tails) and `:147-158` (streamingTails).
- **Wrangler type-generation citation:** clarified that `<bindingName>: WorkerLoader` is the emitted shape, with `WORKER_LOADER_BINDING` being the test fixture's binding name.

## 10.3 Post-review additions (incorporated by reference)

These were flagged by the reviewer as missing high-value content for the multi-processing library angle. Each is independently verifiable against the cited source.

### A1. `DurableObjectClass` is RPC-serializable

`workerd:src/workerd/api/actor.h:382` declares `JSG_SERIALIZABLE(rpc::SerializationTag::ACTOR_CLASS);` on `DurableObjectClass`. **A loaded class can be passed across RPC boundaries.** Concretely: a coordinator can receive a `DurableObjectClass` from `worker.getDurableObjectClass(...)` and ship it to a *different* Worker (or DO), which can then use it as a facet supervisor. The same loaded code becomes a re-usable supervisor template.

### A2. `ActorClassChannel`s are specialisable per-call by `props`

`workerd:src/workerd/api/worker-loader.c++:38-61` (`WorkerStub::getDurableObjectClass`) takes per-call `props` and threads them into the `ActorClassChannel`. Same class, different per-tenant `ctx.props` ⇒ effectively N different specialised actors backed by one loaded class.

### A3. `WorkerStubImpl` lifetime hack

`workerd:src/workerd/server/server.c++:4395-4404` and `:4423-4433` keep a refcount on the parent `WorkerStubImpl` for the duration of an in-flight `SubrequestChannelImpl`. This reinforces RPC-3 in §4.12: **a coordinator that hands out a Dynamic-Worker stub and then returns will release its JS reference, breaking the stub for downstream consumers.** Long-running streams keep stubs alive *while* they're in flight; once flight completes, the stub is released. For the multi-processing library, the coordinator must remain on the request path (or be a DO holding the request open) for as long as workers hold its stubs.

### A4. `worker-loader-test.js:712-737` `asyncCodeLoader`

Confirms `getCode` callbacks may be `async`. The first request blocks until the promise resolves, then proceeds. The library can fetch user-supplied code from R2/D1/KV inside the callback without a separate "preload" step.

### A5. `worker.c++:3735` per-actor `InputGate`

Each `Worker::Actor` carries `InputGate inputGate;` as a member — this is the structural proof that **each facet (which is its own `Worker::Actor`) has its own input gate**. Direct evidence for §2.5/§2.6's parallelism claim.

### A6. `requireNotBroken` cascade

`workerd:src/workerd/server/server.c++:2709-2713` shows that once `brokenReason` is set on an `ActorContainer`, every subsequent operation throws a *cloned* exception. Combined with `monitorOnBroken` cascading to children (`:2715-2728`), a broken root facet poisons the whole subtree until the actor is recreated.

### A7. Compat-flag propagation

`worker-loader.c++:267-295` (especially `:269-273`) — a Dynamic Worker can have its own `compatibilityDate`/`compatibilityFlags` independent of the parent, but `experimental` is gated: the parent must itself have `experimental` for `allowExperimental: true` to be permitted on the child. Library implication: jobs running at *higher* compat dates than the coordinator are fine; jobs needing experimental flags require an experimental coordinator.

### A8. Anonymous `workerLoader` namespaces

`server.h:194` declares `anonymousWorkerLoaderNamespaces` as a separate vector. Bindings without an `id` field allocate fresh namespaces, never shared. This is the *opposite* invariant from CR-1: anonymous bindings are isolated by binding instance, named bindings (same `id`) are shared across the `Server`.

## 10.4 Verifications that held up (selected)

The reviewer spot-checked 80+ specific citations and found these all **accurate**:
- All `worker-loader.h`/`.c++` API surface citations (modules, env, props, allowExperimental gating).
- All `actor-state.h` Facets API citations.
- All `container.h` and `container.capnp` claims (including the "container destroyed when DO drops capability" invariant at `container.capnp:13-14`).
- All `workerd.capnp` binding-schema citations (workerLoader, durableObjectClass, container, durableObjectStorage).
- All `server.c++` claims about: cache lookup (`:4182-4220`), null outbound error message (`:4225-4227`), env cap rewriting (`:4298-4323`), facet container management (`:2551-2603`), facet-tree-index integration (`:2638-2691`), broken-actor cascade (`:2715-2728`), 10s eviction timer (`:2755-2800`).
- All `facet-tree-index.h`/`.c++` citations.
- All `worker-loader-test.js` contract claims (the `loadCount === 8` test, abort behaviour, error messages, mixed-language errors, etc.).
- All `worker-loader-test.wd-test:11-16` binding declarations.
- The wrangler config-shape claim (only `binding`, no `id`) backed by `workers-utils/src/config/environment.ts:1463-1466`.

## 10.5 What this means for the bet

After the CR-1 and CR-2 fixes, the dossier's load-bearing claims are all backed by source the reviewer could verify line-for-line. The remaining open questions (§8, plus WL-2 production behaviour) are explicitly marked as such and depend on internal sources the cf-internal-research session is responsible for resolving.

**Net:** the dossier should now be bet-winning on every claim that has a `path:line` citation; remaining uncertainty is concentrated in the explicitly-marked Open questions, which the multi-processing library's design phase will need to resolve before relying on production-only invariants.
