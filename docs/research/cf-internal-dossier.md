# Cloudflare Internal Dossier — Dynamic Workers, DO Facets & Adjacent Primitives

**Owner of this document:** internal-only research session.
**Companion document:** `/workspace/docs/research/cloudflare-dynamic-primitives.md` (codebase session — public docs + workerd / workers-sdk OSS source of truth).
**End-goal context:** inform design of a "multi-processing" library on top of Cloudflare primitives where multiple DOs / loaded Workers act as parallel "threads" with a coordinator.

This dossier is the canonical *internal source-of-truth* layer: Confluence design docs/RFCs, GitLab control-plane and edgeworker, Jira epics, team landing pages, and any ops/security/billing notes surfaced via wiki. It deliberately does not re-derive what the codebase session has already extracted from workerd/workers-sdk; cross-references are used instead.

> Status: **DRAFT — REVIEWED**. Sections were written incrementally as each research stage completed. A self-review pass with spot-checks is captured in §13.

---

## 0. Method recap

- **Surfaces mined:** wiki.cfdata.org (Confluence), gitlab.cfdata.org (internal GitLab), Jira (cfdata).
- **Depth budget:** deep on Facets + Worker Loaders; light on Container DOs, Dispatch Namespaces, Named/RPC Entrypoints.
- **Source-reading:** capnp schemas + key entry points only. No full source walks; defer to the codebase session for runtime traces.
- **Output:** descriptive, not prescriptive. Design phase is separate.

Public-doc baseline is captured in `/workspace/research/0[1-9]-*.json` and `10-do-rpc.json`, produced by the codebase session.

---


## 1. Executive summary (one paragraph per primitive)

**Durable Object Facets.** Facets are sub-actors that live *inside* a parent Durable Object's address. The facet tree is rooted at `RootCart.mainFacet` and child facets are stored in a `kj::HashMap<kj::String, kj::Rc<ActorHolderImpl>>` ([`src/edgeworker/scheduling/worker-set.c++:1270`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L1270)). Each facet runs as its own actor with its own `Worker::Actor::FacetManager`, has its own SQLite storage stage (`storage.deleteChild`), and shares the parent's *colo placement / global uniqueness* but not its V8 isolate. When process sandboxing is in play, facets in the sandbox communicate with the parent's `FacetManager` via Cap'n Proto RPC (`RpcProcessSandboxImpl::FacetManagerImpl`, [`process-sandbox.c++:2031`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/process-sandbox.c%2B%2B#L2031)). The supervisor and child facet have separate SQLite databases so the parent does not have to trust the child's code. `abortFacet` permanently invalidates all stubs for that facet, then `getFacet` can restart it (potentially with different code). Used internally as the substrate for **Dynamic Workers running inside actors** — `ActorWithLoader` test ([`dynamic-worker.ew-test:943`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/dynamic-worker.ew-test#L943)) shows the integration pattern.

**Worker Loaders / Dynamic Workers.** A `WorkerLoaderBinding` ([`pipeline.capnp:1575`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.capnp#L1575)) is a pipeline-level capability that lets a Worker spawn ephemeral or named isolates from code provided at request time via a callback. The runtime keys the dynamic isolate by `loaderId` (a string the user passes to `env.LOADER.get(id, callback)`); existing isolates are reused if not yet evicted. The control plane is `DynamicWorker` ([`src/edgeworker/scheduling/dynamic-worker.h`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/dynamic-worker.h)) which holds an `EdgeworkerEnvBuilder` that pairs the source code with the runtime-injected `env` so a misbehaving loader callback cannot mix-and-match bindings from different invocations. The product is currently **Open Beta** ([RM-24867](https://jira.cfdata.org/browse/RM-24867), Closed) and **GA in progress** ([RM-27238](https://jira.cfdata.org/browse/RM-27238) → SHIP-13903 / SHIP-13904). A high-risk product-security review is also in progress: [REVIEW-14667 Dynamic Isolates Alpha](https://jira.cfdata.org/browse/REVIEW-14667). Dynamic workers bypass the standard EWC deploy flow entirely and are therefore a *new abuse vector* — Dice (the abuse-detection pipeline) cannot reach them today, hence [EW-9653 / EW-9655 / EW-9656](https://jira.cfdata.org/browse/EW-9655) ship persistence + kill-switch hooks ([Ketan's "Abuse Detection and Termination for Dynamic Workers"](https://wiki.cfdata.org/spaces/~ketan/pages/1304119456)).

**Container Durable Objects.** A Container DO is a regular DO whose constructor obtains a Cloudchamber container capability via `getContainerDurableObject(ownerId, namespaceId, actorId, secret, jurisdiction)` ([Cloudchamber Architecture page](https://wiki.cfdata.org/display/CC/Architecture)). Edgeworker calls cloudchamberd locally; cloudchamberd selects a prewarmed container and returns the capability. The DO and container ideally land on the same metal for low-latency RPC, but in practice cloudchamberd picks "the closest prewarmed container to the Durable Object", which can be far. There's an in-flight project (PRD: [Spawning DOs next to containers](https://wiki.cfdata.org/display/CC/PRD%3A+Spawning+DOs+next+to+containers)) to flip this so DO placement *follows* container placement, with a future direct-proxy bypass of the DO isolate ([RM-24991](https://jira.cfdata.org/browse/RM-24991)).

**Dynamic Dispatch Namespaces (Workers for Platforms dispatcher).** Implementation centers on a `DispatchNamespaceConfig` ([Jon Phillips, Worker config: a pipelines replacement](https://wiki.cfdata.org/spaces/~jphillips/pages/1314783936)) where each namespace has an immutable `namespaceId` (UUID), a renamable `namespaceName`, and a 32-byte `namespaceKey` used to derive the user worker's pipeline ID via **`HMAC-SHA256(namespaceKey, scriptName)`**. This avoids any lookup table — the runtime computes the pipeline ID on every dispatch call. The pipeline-level binding type is `DynamicDispatchBinding` ([`pipeline.capnp:1426`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.capnp#L1426)) and the runtime adapter is `DynamicDispatchInterpreter` ([`internal-api/dynamic-dispatch.h`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/internal-api/dynamic-dispatch.h)). A `trusted_workers` namespace flag flips `untrustedByOwner` in the user worker's pipeline def ([`pipeline.capnp` Worker.untrustedByOwner](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.capnp)) which controls `request.cf` hiding, default-cache disabling, and named-cache isolation. The entire control plane lives in [`cloudflare/ew/edgeworker-config-service`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker-config-service) with ~40 REST routes under `/accounts/{id}/workers/dispatch/namespaces/...`.

**Named entrypoints / RPC entrypoints (JSRPC).** A `WorkerEntrypoint` is a class export that becomes its own RPC endpoint, addressable independently from the Worker's default `fetch` handler. Internally these map to `entrypoint.name` on a pipeline `Worker.Stage` ([`pipeline.capnp` Worker.entrypoint](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.capnp)). Named entrypoints are *the* enabling primitive for everything in this dossier — Worker Loaders return a `Fetcher` only via `worker.getEntrypoint(name)`, Tail Workers are wired via `tails: [ctx.exports.Foo({props:{...}})]`, outbound interception via `globalOutbound: ctx.exports.OutboundHandler({props:{...}})`, and loopback bindings on `ctx.exports` use `loopbackActorClassStagePlusOne` ([`pipeline.capnp` actorNamespace](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.capnp)). Lambros Petrou has been pushing for [Expanded RPC support in workerd](https://wiki.cfdata.org/display/~smacleod/Expanded+RPC+support+in+workerd) (Sam Macleod) — a new binding type that exposes *all* entrypoints across a workerd process over a single `tcp://` URL — but that is not yet on the production runtime.

---

## 2. Source map: where the canonical artefacts live

### 2.1 GitLab repos (most→least relevant)

| Path | What's there | Why we care |
|---|---|---|
| [`cloudflare/ew/edgeworker`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker) (id 4318, branch `master`) | The runtime — supervisor, sandbox, scheduling, routing-supervisor, internal-api. Forked from but kept ahead of OSS workerd. | Canonical source of truth for facets, dynamic workers, dispatch interpreter, routing. Shared with `cloudflare/workers-runtime` (dev, group access 30) and `cloudflare/stor` (Storage team, group access 30). |
| [`cloudflare/ew/edgeworker-config-service`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker-config-service) (id 1349, branch `staging`) | EWC — entire control plane: ~40 REST routes, PostgreSQL schema, pipeline binary generator, QS publisher. | Source of truth for: dispatch namespace creation, deterministic pipeline IDs, kill-switch (`isKilled=true`), tag CRUD, billing data, entitlements. The reviewer set on its MRs (`@tlee @drivas @matthewrodgers @alisman @williamtaylor @mattprice @cloudflare/workers-deploy-config`) is effectively the WfP/dispatch ownership group. |
| [`cloudflare/ew/workerd`](https://gitlab.cfdata.org/cloudflare/ew/workerd) (id 1416, branch `scratch`) | Internal staging area for the OSS runtime. | Cross-check against codebase session's OSS findings only when public docs contradict runtime. |
| [`cloudflare/cc/cloudchamber`](https://gitlab.cfdata.org/cloudflare/cc/cloudchamber) | Cloudchamber coordinator + capnp schemas. | `getContainerDurableObject` RPC, container ↔ DO placement constraints. |
| [`cloudflare/cc/go-capnp`](https://gitlab.cfdata.org/cloudflare/cc/go-capnp) | Cloudchamber's Go capnp fork. | Schema generation for the Go side of cloudchamberd. |
| [`cloudflare/mb/schema`](https://gitlab.cfdata.org/cloudflare/mb/schema) | `WorkerScriptEventV1` Kafka events, `DynamicWorkerEventV1` proposed in [Ketan's abuse-detection page](https://wiki.cfdata.org/spaces/~ketan/pages/1304119456). | Where abuse pipeline taps in. |

Notable forks and POCs (read-only references):
- [`cloudflare/sec/app-prodsec/edgeworker`](https://gitlab.cfdata.org/cloudflare/sec/app-prodsec/edgeworker) — App ProdSec's mirror, used during PSR.
- [`jolio/workerd`](https://gitlab.cfdata.org/jolio/workerd) — JT Olio's internal workerd branch (DO team).
- [`jwheeler/wfp-loader-sketch`](https://gitlab.cfdata.org/jwheeler/wfp-loader-sketch) — Josh Wheeler's WfP-on-Loader POC referenced in [WfP & Dynamic Workers: Exploring the Path Forward](https://wiki.cfdata.org/spaces/~jwheeler/pages/1372556848).

### 2.2 Key Confluence pages (tier 1)

Loaders / Dynamic Workers:
- [Dina Kozlov — Powering Dispatcher with a Worker Loader — step 1](https://wiki.cfdata.org/spaces/~dkozlov/pages/1357511731) — **the** internal feature-parity matrix for migrating WfP onto Loader; covers bindings injection, assets, tags, outbound, custom limits, trusted flag, tail workers, billing.
- [Dina Kozlov — It's time to rebuild Workers for Platforms](https://wiki.cfdata.org/spaces/~dkozlov/pages/1357505452) — vision doc.
- [Brendan Irvine-Broque — RFC: Dynamic Workers Observability](https://wiki.cfdata.org/spaces/~birvine-broque/pages/1365394169) — first-class observability model: per-loader-binding `observability` config, separate Dynamic Workers dashboard surface, `include_in_parent` flag, loader ID = canonical identity, separate access control.
- [Josh Wheeler — WfP & Dynamic Workers: Exploring the Path Forward](https://wiki.cfdata.org/spaces/~jwheeler/pages/1372556848) — feature gap analysis (binding passthrough, dynamic resource bindings) + 3-column comparison (Current WFP / pure DW / hybrid).
- [Ketan Gupta — Abuse Detection and Termination for Dynamic Workers](https://wiki.cfdata.org/spaces/~ketan/pages/1304119456) — abuse pipeline integration plan; `WorkerLoaderBinding` extension for `blockedWorkers` / `blockedUserIds`; alternative QS-key blocklist.
- [Brendan Irvine-Broque — CDP + MCP + Code Mode = Agents can truly debug browsers](https://wiki.cfdata.org/pages/viewpage.action?pageId=1348872755) — Code Mode using Worker Loader for ephemeral V8 sandboxing of agent-generated code.

Dispatcher / WFP:
- [Aaron Lisman — Workers For Platforms - Technical Overview](https://wiki.cfdata.org/display/~alisman/Workers+For+Platforms+-+Technical+Overview) — deterministic ID derivation, namespace ID role, double-dispatch patterns, trusted_workers flag.
- [Jon Phillips — Worker config: a pipelines replacement](https://wiki.cfdata.org/spaces/~jphillips/pages/1314783936) — `DispatchNamespaceConfig` schema with `namespaceKey`, `trustedWorkers`, HMAC-SHA256 derivation explicitly documented.
- [Brendan Irvine-Broque — Market and monetize Workers for Platforms as its own thing](https://wiki.cfdata.org/pages/viewpage.action?pageId=1069393828) and [its 2026 follow-up](https://wiki.cfdata.org/pages/viewpage.action?pageId=1121693308) — the strategic plan that drives the migration.
- [Aaron Lisman / Workers — Spec: Pages x WFP](https://wiki.cfdata.org/display/EW/Spec%3A+Pages+x+WFP) — internal use of dispatch with shared static namespace, "1-4 ms of compute" overhead claim.
- [Dina Kozlov — Namespaces](https://wiki.cfdata.org/display/~dkozlov/Namespaces) — UX surface, untrusted-by-default semantics.
- [Customer Support — Cloudflare Workers Advanced Support Guide / WFP](https://wiki.cfdata.org/spaces/CSUP/pages/519709285/Cloudflare+Workers+Advanced+Support+Guide) — three-part model (Dispatch / User / Outbound).

Containers / Cloudchamber:
- [Cloudchamber — Architecture](https://wiki.cfdata.org/display/CC/Architecture)
- [Cloudchamber — Containers - Internal FAQ](https://wiki.cfdata.org/display/CC/Containers+-+Internal+FAQ)
- [Cloudchamber — RFC: APIs for a durable object binding](https://wiki.cfdata.org/display/CC/RFC%3A+APIs+for+a+durable+object+binding)
- [Cloudchamber — RFC: Cloudchamber runtime and API interactions for Durable Object bindings](https://wiki.cfdata.org/display/CC/RFC%3A+Cloudchamber+runtime+and+API+interactions+for+Durable+Object+bindings)
- [Cloudchamber — PRD: Spawning DOs next to containers](https://wiki.cfdata.org/display/CC/PRD%3A+Spawning+DOs+next+to+containers)
- [Cloudchamber — Containers + Durable Objects are coming soon](https://wiki.cfdata.org/pages/viewpage.action?pageId=1117129971)
- [Cloudchamber — SOP: Debugging durable objects within Coordinator](https://wiki.cfdata.org/display/CC/SOP%3A+Debugging+durable+objects+within+Coordinator)
- [Naresh Ramesh — Understanding containers](https://wiki.cfdata.org/display/~naresh/Understanding+containers) — fresh manual-trace, recent.

DO platform background:
- [Storage — (Retroactive) SPEC: Durable Objects](https://wiki.cfdata.org/display/STOR/%28Retroactive%29+SPEC%3A+Durable+Objects) — the Sandbox / Supervisor / StorageProxy split.
- [Workers — Runtime internals](https://wiki.cfdata.org/display/EW/Runtime+internals) — definitions of Isolate, V8 Context, Replica, Thread; `MIN_REPLICA_LOAD` / `MAX_REPLICA_LOAD` in `worker-set.c++`.
- [Workers — Workers Runtime](https://wiki.cfdata.org/display/EW/Workers+Runtime) — Workers Runtime team landing page (`workers-runtime@cloudflare.com`, [Gchat](https://chat.google.com/preview/room/AAAAGX7FDAU)).
- [Workers — Workers Runtime Linktree](https://wiki.cfdata.org/display/EW/Workers+Runtime+Linktree) — linkdump (Runtime RMs board: [JIRA 3366](https://jira.cfdata.org/secure/RapidBoard.jspa?rapidView=3366)).
- [Josh Howard — "How we work" on the Durable Objects team](https://wiki.cfdata.org/spaces/~jhoward/pages/1387687993) — DO team org (US squad / London squad).
- [Workers — Asynchronous Isolate Recreation (AIR)](https://wiki.cfdata.org/pages/viewpage.action?pageId=309285428) — eviction / GC heuristics relevant to the loader cache.
- [Mike Nomitch — PRD: Public Volatile Cache](https://wiki.cfdata.org/display/~mnomitch/PRD%3A+Public+Volatile+Cache) and [SPEC: In-memory cache API](https://wiki.cfdata.org/display/EW/SPEC%3A+In-memory+cache+API) — the volatile-cache binding referenced from `pipeline.capnp` and relevant to "thread-local" caches in our multi-processing design.

RPC / entrypoints:
- [Korinne Alpers — Mini-PRD: Self-referential bindings](https://wiki.cfdata.org/display/~korinne/%5BMini-PRD%5D+Self-referential+bindings)
- [Sam Macleod — Expanded RPC support in workerd](https://wiki.cfdata.org/display/~smacleod/Expanded+RPC+support+in+workerd)
- [Workers eXperience — Mini-SPEC: JSRPC support for Workers + Assets in `wrangler dev`](https://wiki.cfdata.org/pages/viewpage.action?pageId=1092892940) — exhaustive matrix of fetch/RPC/handler behaviour across default/named/DO entrypoints.
- [Emerging Technology and Incubation — Global Compute: JS RPC and the Future of Smart Placement](https://wiki.cfdata.org/pages/viewpage.action?pageId=868849810) — strategic doc, names entrypoints "the key that unlocks everything".

### 2.3 Jira projects and key issues

- **RM** (Runtime Management) — `RM-24867 Dynamic Worker Loader Open Beta` (Closed), `RM-27238 Dynamic Worker Loader GA` (In Progress), Team: *Workers Runtime Platform*. RM Rapid board: [#3366](https://jira.cfdata.org/secure/RapidBoard.jspa?rapidView=3366).
- **EW** (Edgeworker) — feature tickets that hang off RM epics. `EW-9653`, `EW-9655`, `EW-9656` (abuse-pipeline plumbing, Closed), `EW-10547` (Allow custom limits for dynamic workers, Closed 2026-04-17 — both EWC and edgeworker MRs merged).
- **REVIEW** (Product Security Review) — `REVIEW-14667 Dynamic Isolates Alpha` (In Progress, label `risk-high-risk`, Sprint 135), `REVIEW-17120 Dynamic Worker Loader GA` (Needs Triage). Team: *Workers Runtime Platform*.
- **SHIP** — `SHIP-13903 Dynamic Worker: Open Beta` (Backlog), `SHIP-13904 Dynamic Worker: GA` (Backlog).
- **STOR** (Storage / DO) — DO-side observability work, SQLite-backed DO migration (SRS), DO read-replication API spec.
- **WPC** (Workers/Pages Convergence) — Workers Core ↔ Pages convergence project; Igor Minar / Rita Kozlov / Brendan Irvine-Broque sponsorship listed in [Workers eXperience landing](https://wiki.cfdata.org/pages/viewpage.action?pageId=628965204).
- **TMD-1000** — "Build dynamic workers pipeline (analysis, remediation)" (Closed) — followed by EW-9653 / EW-9655.
- **INCIDENT-7730** — billing exploit referenced as motivation for paranoia in Ketan's doc.

### 2.4 Relevant capnp schemas (read these, not the C++)

Located in `cloudflare/ew/edgeworker`, branch `master`:
- [`src/edgeworker/scheduling/pipeline.capnp`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.capnp) — `PipelineDef` (typeId `0xb08a70de6aaa7f1c`), `Stage`, `Worker`, `WorkerLoaderBinding` (line 1575), `DynamicDispatchBinding` (line 1426), `GlobalActorNamespaceBinding` (line 1312), `dynamicDispatch :group { stage; info :DynamicDispatchBinding; }` (line 425+), `actorNamespace.loopbackActorClassStagePlusOne`.
- `src/edgeworker/server/worker-limits.capnp` — `WorkerLimitsDef`. Used by both `WorkerLoaderBinding.limits` and `WorkerLoaderBinding.maxLimits`.
- `src/edgeworker/routing-supervisor/routing-supervisor.capnp` — Supervisor IPC interface to the sandbox: `exchangeToken()` → `GlobalActorNamespace`, `getActor()`. Three RPC scopes: `RoutingSupervisor` (sandbox), `PeerEdgeworker` (intra-colo peer), `ClusterGateway` (inter-colo).
- `src/edgeworker/routing-supervisor/peer-edgeworker.capnp` — `getGlobalActor()`, `getColoLocalActor()`, `releaseActor()`, `getColdStorage()`.
- `src/edgeworker/routing-supervisor/cluster-gateway.capnp` — inter-colo `getActor()`.
- `cloudflare/cc/cloudchamber/go/capnp/pkg/cloudchamber/cloudchamber.capnp` — `getContainerDurableObject(ownerId, namespaceId, actorId, secret, jurisdiction) -> ContainerDurableObject`.
- `cloudflare/cc/cloudchamber/go/capnp/pkg/cloudchamber/container.capnp` — `Container.status() -> (running :Bool)`, etc.

---

## 3. Internal team map (people, channels, ownership)

| Team | Charter | Wiki landing | Comms | Notes |
|---|---|---|---|---|
| **Workers Runtime** | edgeworker / workerd / isolate lifecycle / **Worker Loaders, facets** | [EW/Workers+Runtime](https://wiki.cfdata.org/display/EW/Workers+Runtime), [Linktree](https://wiki.cfdata.org/display/EW/Workers+Runtime+Linktree), [Contributors meeting](https://wiki.cfdata.org/display/EW/Workers+Runtime+Contributors+Meeting) | `workers-runtime@cloudflare.com`, [Gchat](https://chat.google.com/preview/room/AAAAGX7FDAU) | EM Kevin Flansburg; PM Brendan Irvine-Broque. Eng manager hiring page lists "C++ and Rust codebase that embeds the JavaScript engine, manages isolate lifecycles, enforces resource limits". Owns `cloudflare/ew/edgeworker`. |
| **Durable Objects** | DO storage/placement, **Facets**, SRS, alarms, hibernation, replication | [Josh Howard — How we work](https://wiki.cfdata.org/spaces/~jhoward/pages/1387687993), [DEVGTM/Durable+Objects](https://wiki.cfdata.org/display/DEVGTM/Durable+Objects) | EM Josh Howard; PM Vy Ton; Eng Director Ben Yule; Product Director Matt Silverlock. US squad (SRS / storage) and London squad (routing / alarms). Tech lead Lambros Petrou. Kenton Varda is principal engineer. |
| **Workers for Platforms / Deploy & Config** | EWC (entire control plane), dispatch namespaces, gradual deployment, **the migration onto Worker Loader** | [Aaron Lisman's WFP overview](https://wiki.cfdata.org/display/~alisman/Workers+For+Platforms+-+Technical+Overview), [Dina Kozlov's WfP-on-Loader sequence](https://wiki.cfdata.org/spaces/~dkozlov/pages/1357511731) | Default reviewer set on EWC MRs: `@tlee @drivas @matthewrodgers @alisman @williamtaylor @mattprice @cloudflare/workers-deploy-config`. PM Dina Kozlov drives the rebuild plan. |
| **Cloudchamber / Containers** | Container scheduler, prewarm pool, DO ↔ container placement | [CC/Architecture](https://wiki.cfdata.org/display/CC/Architecture), [Containers — Internal FAQ](https://wiki.cfdata.org/display/CC/Containers+-+Internal+FAQ) | Owns `cloudflare/cc/*`. Cloudchamber Coordinator account `199790c4a1b00611d67658fbcee14309` ([dash link in SOP](https://dash.cloudflare.com/199790c4a1b00611d67658fbcee14309/workers/durable-objects)). |
| **Edge / Routing Supervisor** (within Runtime) | The DO routing nervous system: `RoutingSupervisor`, `PeerEdgeworker`, `ClusterGateway`, ownership state machine | `src/edgeworker/routing-supervisor/AGENTS.md` (in repo) | Session-based ownership heartbeated to CockroachDB every 500ms via `ActorSessionManager`; consistent hashing within colo; Consul peer state. |
| **Workers Observability (WOBS)** | Workers Logs, Traces, Tail Workers, Query Builder, OTLP export | [WOBS space](https://wiki.cfdata.org/spaces/WOBS/) | RFC owner Brendan Irvine-Broque. [Trace Context Propagation and Support in v1](https://wiki.cfdata.org/spaces/WOBS/pages/1230612694). |
| **Application & Product Security (App ProdSec)** | PSR sign-off | `cloudflare/sec/app-prodsec/edgeworker` mirror exists | Owns REVIEW project. `risk-high-risk` label tracks Dynamic Isolates Alpha. |
| **Distributed Data / Storage** | DO storage backends (CockroachDB → SRS), R2 metadata path | [STOR space](https://wiki.cfdata.org/display/STOR/), [DO + CockroachDB](https://wiki.cfdata.org/pages/viewpage.action?pageId=135143405) | Erin Thames, Vy Ton, Josh Howard. |

People worth pinging on each primitive (extracted from authorship metadata):
- **Worker Loader / Code Mode / Dynamic Workers**: Kenton Varda, Brendan Irvine-Broque, Dina Kozlov, Ketan Gupta, Armen Boursalian.
- **Facets**: Kenton Varda (principal engineer creating "the runtime architecture"), the implementation lives in `worker-set.c++` so the Workers Runtime team owns it; explicit DO-team involvement is signposted by `getFacetPath()` use in [`dynamic-worker.c++:1296`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/dynamic-worker.c%2B%2B#L1296) (`actor.storageFactory.getFacet(...)`).
- **Cloudchamber / Container DO**: contact via `cloudflare/cc/*` repo MR reviewers; PRD authors include Naresh Ramesh, Tomas Lefebvre.
- **Dispatch / WFP / EWC**: Aaron Lisman (technical SME), Dina Kozlov (PM), the EWC reviewer set, Jon Phillips (config rewrite).


---

## 4. Deep dive: Durable Object Facets

> Cross-reference: codebase session's runtime/public-API doc covers the `this.ctx.facets.{get,abort,delete}` JS surface. This section covers what's *behind* that surface — the C++ implementation, capnp shape, lifecycle invariants, and known gotchas only visible internally.

### 4.1 Implementation summary

The facet implementation lives entirely in `cloudflare/ew/edgeworker`:
- Core: [`src/edgeworker/scheduling/worker-set.c++`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B) (`ActorHolderImpl`, `FacetActorChannel`, `RootCart`).
- Process-sandbox bridge: [`src/edgeworker/scheduling/process-sandbox.c++`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/process-sandbox.c%2B%2B) (`RpcProcessSandboxImpl::FacetManagerImpl`, `GetStartInfoCallbackImpl`).
- Storage glue: `actor.storageFactory.getFacet(actorHolder->getFacetPath(), cart->onActorCodeUpdated())` ([`dynamic-worker.c++:1296`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/dynamic-worker.c%2B%2B#L1296), [`pipeline.c++:1788`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.c%2B%2B#L1788)).
- Public-runtime shape: this is layered on top of `Worker::Actor::FacetManager` from workerd (the OSS interface) — the codebase session's doc has the workerd-side view.

The runtime exposes a `kj::HashMap<kj::String, kj::Rc<ActorHolderImpl>> facets` per parent ([`worker-set.c++:1270`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L1270)). Each `ActorHolderImpl`:
- Implements both `ActorHolder` and `Worker::Actor::FacetManager` (one type, three roles: a node in the facet tree, the manager interface for its children, and a back-reference to the parent's storage).
- Holds either a `Root` marker, a `Child {parent, name, depth}` triple, a `ProcessSandboxed { rpcFacetManager }` indirection (when the actor is inside a process sandbox), or a `kj::Exception` (the abort reason — terminal state) ([`worker-set.c++:1228-1247`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L1228)).
- Tracks a `currentChannel` pointer back to the most-recent `FacetActorChannel` so destroying the channel doesn't dangle ([`worker-set.c++:1272`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L1272), [`worker-set.c++:1581`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L1581)).
- Optionally owns an `ActorStorageFactory::Stage` — used to implement `deleteFacet()` (the SQLite database is deleted via `storage.deleteChild(name, actor->getOutputGate())` ([`worker-set.c++:2012`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L2012))).

The root facet is the parent DO itself — `RootCart.mainFacet`. Comment at [`worker-set.c++:1230`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L1230): "This is the root facet, i.e. `RootCart.mainFacet`."

### 4.2 Lifecycle, invariants, footguns

**`getFacet(name, getStartInfo)`** ([`worker-set.c++:1314`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L1314)):
1. Forwards to `rpcFacetManager` if running inside a process sandbox.
2. Refuses to start a new facet if the *current* actor is already shutting down (throws the saved abort exception).
3. Calls `facets.findOrCreate(name, ...)` — same name returns the same holder; new name allocates a new `ActorHolderImpl` with `depth = parent.depth + 1`.
4. Returns a refcounted `FacetActorChannel`; the supervisor invokes `getStartInfo()` lazily, only when the holder hasn't been started before *or* it has hibernated.

**`abortFacet(name, reason)`** ([`worker-set.c++:1476-1490`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L1476)):
1. Walks down to the named child.
2. Calls `child.value->abort(reason)` — recursively aborts *grand*children too ([`worker-set.c++:1374-1378`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L1374)) — because the holder is permanently broken once aborted.
3. Erases the entry from `facets` so a subsequent `getFacet` allocates a fresh holder. **All previously-issued stubs throw `reason`** even if the facet later restarts.

**`deleteFacet(name)`** ([`worker-set.c++:1492`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L1492)):
1. First calls `abortFacet(name, "Facet was deleted.")`.
2. Then calls `deleteChildFacet(storage, name)` to drop the facet's SQLite storage stage.
3. Comment: a known TODO is that `deleteAll()` (called on the parent) does not currently abort running facets first ([`facets.storage-ew-test`, `deleteSelf`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/tests/actors-storage/facets.storage-ew-test#L213): "TODO(facets): Currently deleteAll() tries to delete facet storage without actually killing running facets first. This bug exists in workerd as well, and is probably best fixed there by having the deleteAll() API call some sort of `abortAllFacets()` method on the FacetManager.")

**Output-gate fragmentation**: each facet has its own output gate. Comment in [`worker-set.c++:2142`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L2142): `// TODO(facets): Unify OutputGates and pass a valid OutputGate here.` This is a known correctness footgun for cross-facet I/O ordering.

**Path encoding**: the test's `testLaneNameEncoding` ([`facets.storage-ew-test:140-153`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/tests/actors-storage/facets.storage-ew-test#L140)) asserts that a facet named `"baz/qux"` *does not collide* with a child named `"qux"` of a facet named `"baz"`. So the runtime escapes `/` in storage keys. Don't trust this on the public surface unless the codebase session confirms it.

**Open-request on abort**: there's a regression test (`testAbortFacetWithOpenRequest`) that confirms aborting a facet while a callback is held by a peer correctly disposes the callback (`Symbol.dispose` runs) and unblocks creation of a new facet with the same name ([`facets.storage-ew-test:226`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/tests/actors-storage/facets.storage-ew-test#L226)).

**Facets and dynamic workers compose** ([`facets.storage-ew-test:160-190` `runDynamicFacet`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/tests/actors-storage/facets.storage-ew-test#L160)):
```
let worker = this.env.WORKER_LOADER.get('worker', () => ({...}));
let corge = this.ctx.facets.get("corge", () => ({
  class: worker.getDurableObjectClass("GetSet"),
}));
```
This is the canonical pattern for "a facet whose code comes from a Worker Loader." The same facet name can be re-loaded as a different class later (e.g. `MyFacet`) and the underlying SQLite storage is preserved — explicitly tested.

**Capability-in-props is not yet supported** ([`pipeline.c++:1838`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.c%2B%2B#L1838)): `JSG_FAIL_REQUIRE(Error, "Facet classes do not yet support ctx.props containing capabilities. If you are seeing this, please email kenton@cloudflare.com about it...")`. So you cannot pass JSRPC stubs through to a child facet via `props` at the time of writing.

### 4.3 Process sandboxing model

Process sandboxing is on for some scripts. When sandboxed:
- The facet tree rooted at the current actor is split: `Root`/`Child` linkage exists in the *parent* process; the child runs `ProcessSandboxed { rpcFacetManager }` and forwards every `FacetManager` call upstream over Cap'n Proto RPC ([`process-sandbox.c++:2031-2069`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/process-sandbox.c%2B%2B#L2031)).
- `getFacetDepth` is communicated via the `rpc::FacetManager` capability ([`process-sandbox.c++:2202`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/process-sandbox.c%2B%2B#L2202)).
- `GetStartInfoCallbackImpl` ([`process-sandbox.c++:2072`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/process-sandbox.c%2B%2B#L2072)) is the bridge for the child to ask the parent "what code/options should I start with?".
- Implication: facets in a process-sandboxed actor incur an extra IPC round-trip on `getFacet` / `abortFacet` / `deleteFacet` and (per `getDepth`) on every depth query.

### 4.4 Capnp / pipeline-level exposure

Facets are *not* a separate pipeline binding type. They appear in test pipelines as:
- A `globalActorNamespace` for the root (`MyActor`) — with `loopbackActorClassStagePlusOne = 3` so the same name acts as both a namespace binding and an actor-class binding.
- An `actorClass` binding for the facet class (`MyFacet`) referencing the same stage:
```capnp
ctxExports = [
  (name = "MyActor", value = (globalActorNamespace = (
    id = "facets-test-MyActor-namespace",
    info = (
      obfuscationKey0 = 0x0123456789abcdef,
      obfuscationKey1 = 0x0123456789abcdef,
      zoneId = "123456",
      useStorageRelay = true,
      loopbackActorClassStagePlusOne = 3,
    )
  ))),
  (name = "MyFacet", value = (actorClass = (id = 3))),
],
```
[`facets.storage-ew-test:23-34`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/tests/actors-storage/facets.storage-ew-test#L23). Note `useStorageRelay = true` — facets ride on the **SRS (Storage Relay Service)** SQLite path, not legacy CockroachDB, in the test config.

### 4.5 Facets — invariants relevant to multi-processing

| Invariant | Source | Implication |
|---|---|---|
| Facets share the parent DO's **colo placement and global uniqueness**. They are addressed *through* the parent, not independently. | Implicit: facets live in the parent's `kj::HashMap`; routing-supervisor never sees them as their own actor IDs. | A multi-processing library that uses facets as "threads" gets free locality with the coordinator DO but **cannot scale CPU beyond one machine** — all facets of a DO share one host. |
| Each facet runs on its own **`Worker::Actor`** with its own input/output gates and (today) its own SQLite database stage. | `worker-set.c++:1260` `storage`; `facets.storage-ew-test` separate counters. | Storage isolation between supervisor and facet is real; cross-facet writes still need coordination. |
| Output-gate unification across facets is a TODO. | `worker-set.c++:2142` | Cross-facet ordering guarantees are weaker than within-facet today. |
| Facet code can come from a Worker Loader (`worker.getDurableObjectClass(name)`). | `runDynamicFacet` test. | This is the substrate for "ephemeral thread classes" — pair Loader + Facet to dynamically reify worker code as an actor class. |
| `abortFacet` permanently invalidates *all* prior stubs; restart with new code is supported via `getFacet` callback. | `worker-set.c++:1245-1247`, `1476-1490`. | Useful for "thread restart with new code" semantics. |
| `ctx.props` capabilities don't cross facet boundaries yet. | `pipeline.c++:1838`. | A coordinator cannot hand a stub-as-prop to a worker facet today; it must pass the stub through bindings/env or via the loader callback. |
| In a process sandbox, facet operations cost an extra IPC. | `process-sandbox.c++:2031-2202`. | Don't put tight `getFacet`/`abortFacet` loops in the hot path for sandboxed actors. |
| Facets compose with the existing **hibernation**, **alarms**, and **WebSocket hibernation** model. | Facets are `Worker::Actor` instances; they inherit those. Public docs (codebase session) cover the JS surface. | "Hibernation"-based long-lived threads work — but only one actor at a time (the active facet) is awake to handle a request lane. |

### 4.6 Facets — Jira and known work

- **No dedicated Jira epic surfaced** for "Facets GA" — the implementation appears to land via `worker-set.c++` MRs without a top-level shipping epic in our search results. Worth a follow-up to confirm via a manager ping; the more robust signal is the `TODO(facets):` markers in the runtime source.
- The relevant test files are the ground-truth specification:
  - [`src/edgeworker/tests/actors/facets.ew-test`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/tree/master/src/edgeworker/tests/actors) — execution semantics (no consul/cockroach/srs).
  - [`src/edgeworker/tests/actors-storage/facets.storage-ew-test`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/tests/actors-storage/facets.storage-ew-test) — storage semantics with full backend.
- BUILD entry: `cloudflare/ew/edgeworker/src/edgeworker/tests/actors-storage/BUILD` includes `facets.storage-ew-test` ([line 574](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/tests/actors-storage/BUILD#L574)).

### 4.7 Public-vs-internal delta (Facets)

| Public claim (developers.cloudflare.com `dynamic-workers/usage/durable-object-facets/`, captured in `01-public-docs-facets-lifecycle.json`) | Internal source-of-truth | Delta |
|---|---|---|
| "A single Durable Object can have any number of facets with different names, each with its own independent SQLite database." | `kj::HashMap<kj::String, kj::Rc<ActorHolderImpl>> facets` is unbounded in code; storage-relay-backed; `useStorageRelay = true` in the test pipeline. | **Match** for storage independence. **Public is silent** about a numeric upper bound — none is hardcoded in the repo. Practically bounded by the parent DO's memory, output gates, and storage quota. |
| `facets.get(name, callback)` re-uses the existing facet if running. | `findOrCreate` + lazy `getStartInfo()` invocation. | **Match.** |
| `facets.abort(name, reason)` "shuts down a running facet and invalidates all existing stubs." | Confirmed in `abort` and `~FacetActorChannel` paths; previously-issued stubs throw the abort reason permanently. | **Match.** |
| Public says facet's storage is "preserved" on `abort`. | Storage stage is *not* deleted on abort; only on `delete`. | **Match.** |
| Public docs imply facets can run different classes after abort. | Test confirms (`runDynamicFacet` reloads `corge` as `MyFacet` after abort, with same storage). | **Match.** |
| Public surface does not document **hibernation** semantics for child facets specifically. | Hibernation logic is shared with `Worker::Actor` (codebase session has the workerd-side view). The parent's `RootCart` holds the hibernation manager (`maybeHibernationManager`, [`worker-set.c++:1867`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L1867)). | **Internal-only:** the hibernation manager is per-RootCart, not per-facet, so the *parent* governs the hibernation boundary even if a child facet is what holds the WebSocket. |
| Public surface implies independent placement per facet. | False — facets share the parent's placement. | **Internal-only & important for design**: facets are not a horizontal-scale primitive across machines. |
| Public surface does not expose a depth limit. | `getFacetPath` allocates `child.depth + 1` stringptrs; no hardcoded max depth observed. | **Likely unbounded in practice**, but trust the public docs only after the codebase session confirms workerd has no max. Treat as "deep recursion will eventually OOM the parent" rather than "fail-fast bound." |


---

## 5. Deep dive: Worker Loaders / Dynamic Workers

> Cross-reference: codebase session covers the workerd-side `WorkerLoader` JS API (`env.LOADER.get(id, callback)`, `getEntrypoint`, `getDurableObjectClass`), `WorkerCode` shape (`mainModule`, `modules`, `compatibilityDate`, `globalOutbound`, `tails`, `env`), and TypeScript signatures. This section covers what's *behind* that surface.

### 5.1 Capnp shape — the binding contract

[`pipeline.capnp:1575`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.capnp#L1575):

```capnp
struct WorkerLoaderBinding {
  limits @0 :WorkerLimitsDef;
  # Default limits to apply to all workers loaded using this binding.
  #
  # PROTIP: Set `limits.alwaysProcessSandbox` to `true` to require process sandboxing.

  maxLimits @1 :WorkerLimitsDef;
  # Max limits that can be applied to workers loaded using this binding.
}
```

That's the entire pipeline-level contract. Two `WorkerLimitsDef` — a default and a max. Notably, **there is no per-binding "max active loaded workers" field at the pipeline level today**: per-binding caps are not in the schema yet. Per-owner caps come from runtime config (see below).

The binding appears in a Worker's `globals` as `Global.value.workerLoader = WorkerLoaderBinding` ([`pipeline.capnp:646` field `@71`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.capnp#L646)). At pipeline-load time the runtime calls `getWorkerLoader({.limits, .maxLimits})` to register a channel, fingerprint the limits, and wire up `Global::WorkerLoader{ .channel = channel }` ([`worker-set.c++:870-878`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L870)).

[`worker-set.h:712`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.h#L712):
```cpp
struct WorkerLoaderChannelInfo {
  kj::Own<WorkerLimitsDef::Reader> limits;
  kj::Own<WorkerLimitsDef::Reader> maxLimits;
};
```

Per [Ketan's abuse-detection page](https://wiki.cfdata.org/spaces/~ketan/pages/1304119456), an *expansion* is being designed:
```capnp
struct WorkerLoaderBinding {
  limits @0 :WorkerLimits;
  blockedWorkers @1 :List(BlobId);     # killed by Dice / EWC
  blockedUserIds @2 :List(Text);       # WfP customer's customer block list
}
```
Not yet in the master schema as of this read.

### 5.2 The DynamicWorker request-time object

[`src/edgeworker/scheduling/dynamic-worker.h`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/dynamic-worker.h):

```cpp
class DynamicWorker: public WorkerStubChannel, public kj::Refcounted {
  // DynamicWorker represents a worker that was loaded using a dynamic worker loader, i.e.
  // from code specified at runtime. This backs the object returned when you call
  // `workerLoader.get()`.
  //
  // Keep in mind that DynamicWorker is an I/O object, meaning it is limited to be used only
  // within a single request context. The underlying isolate, though, may be reused across
  // many requests, hence many `DynamicWorker` instances may end up pointing at the same
  // underlying `Worker` and isolate over time. We rely on `WorkerSet` itself to give us the
  // same isolate if it hasn't been evicted.
```

Concrete consequences:
- The `DynamicWorker` object has a per-request lifetime.
- The underlying isolate is stored *in the same `WorkerSet`* that holds normal Worker isolates, keyed by a `scriptId`. A `loaderId` (the string the user passes to `env.LOADER.get(id, ...)`) maps deterministically to a `scriptId` for non-ephemeral workers; for ephemeral (null-named) workers, `scriptId` is randomly generated.
- `bool isEphemeral;` on `DynamicWorker` ([`dynamic-worker.h:62`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/dynamic-worker.h)).
- `bool alwaysProcessSandbox;` ([`dynamic-worker.h:61`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/dynamic-worker.h)) — the loader can force process sandboxing per binding via `limits.alwaysProcessSandbox`.
- `getEntrypoint(name, props, limits)` and `getActorClass(name, props, limits)` are the two public methods, both returning `WorkerStubChannel`/`SubrequestChannel`/`ActorClassChannel`.

### 5.3 EdgeworkerEnvBuilder — the source/bindings binding

The most subtle internal mechanism, well-commented in [`dynamic-worker.h:88-170`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/dynamic-worker.h):

> **The fundamental design problem we're working around here is that, traditionally, in edgeworker, bindings come from the pipeline, while source code comes from the WorkerBundle. … With dynamic worker loading, on the other hand, source code and bindings are constructed at the same time, by the loader callback provided by the app. Although the callback _should_ return the same content each time it is called, we have no ability to guarantee that apps behave correctly. Therefore, we MUST NOT pair source code obtained from one callback invocation with bindings obtained from another. To prevent that, we really want the bindings to be delivered with the WorkerSource. So, this "attachment" accomplishes that.**

So `EdgeworkerEnvBuilder` (and its sandbox cousin `ProcessSandboxEnvBuilder`) is attached to the `Worker::Script` itself — when an isolate is reused, the same env builder is reused, guaranteeing source ↔ env consistency even though the surrounding pipeline is allowed to point at different bindings.

It exposes:
- `getEnv() -> EnvInfo { Frankenvalue env; uint subrequestChannelCount; uint actorClassChannelCount; }` — synchronous; the env is computed eagerly when the loader callback runs.
- `hasTails() -> bool` — used to decide whether to expect a `tracer` capability on the IPC at request time.
- `reportExports(entrypoints, actorClasses)` — called once after the worker is constructed; in the sandbox case this RPCs back to the parent so the parent's `IoChannelFactory` can correctly assign channel numbers for `ctx.exports`.

Process sandboxing complication: in the sandbox, a "stub" `ProcessSandboxEnvBuilder` is independent of any RPC connection (each request may use a different RPC). It stores an "env builder ID" that maps in the parent process to the real `EdgeworkerEnvBuilder`. This is why the [Mini-PRD wiki page](https://wiki.cfdata.org/display/EW/Workers+Runtime) describes the runtime as carrying around a "map of IDs to `EdgeworkerEnvBuilder` instances in the parent."

### 5.4 The isolate cache: shape and TTL

[`src/edgeworker/scheduling/dynamic-worker-map.h`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/dynamic-worker-map.h):

```cpp
// Reverse map from dynamic worker content hash to the script IDs that have replicas
// currently loaded in memory. Entries are added in addImpl() when a replica is created,
// and removed in ScriptReplica's destructor when the replica is evicted. This invariant
// is relied upon by:
//
// - BanSubscriber: unbans don't require explicit action because evicting the condemned
//   replica removes it from this map, and the next cold-start re-checks via checkBan().
// - revalidate(): only re-checks content hashes with live replicas, avoiding stale
//   lookups.
//
// Analogous to NotificationsMap (which maps encrypted blob IDs to pipeline IDs).
class DynamicWorkerMap {
 public:
  void insert(kj::StringPtr contentHash, kj::StringPtr scriptId) const;
  void remove(kj::StringPtr contentHash, kj::StringPtr scriptId) const;
  kj::Array<kj::String> getScriptIds(kj::StringPtr contentHash) const;
  kj::Array<kj::String> getContentHashes() const;

 private:
  struct State {
    kj::HashMap<kj::String, kj::HashSet<kj::String>> hashToScriptIds;
  };
  mutable kj::MutexGuarded<State> guarded;
};
```

The cache is **not a cache of code**; it's a *reverse index* from `contentHash` → `{scriptId}` of currently-loaded replicas. The actual isolate cache is the same `WorkerSet` LRU used by all Workers — dynamic workers compete with regular Workers for memory.

Crucially: for unnamed/ephemeral dynamic workers, the [edgeworker pipeline test](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/dynamic-worker.c%2B%2B#L524) generates the `scriptId` either as a random hash or by hashing the user-supplied name. Per Ketan's abuse-detection plan: this is moving to a **content-based hash** so identical code in two different ephemeral invocations dedupes to the same `scriptId` (and so abuse pipelines can identify identical malicious code).

#### Per-owner LRU limit

[`src/edgeworker/server/config.capnp:692`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/server/config.capnp#L692):
```capnp
dynamicWorkersPerOwnerLimit @215 :UInt32 = 50;
# Maximum number of concurrent dynamic worker isolates per owner per process.
```

**Default cap: 50 dynamic worker isolates per owner per edgeworker process.** Implemented by `WorkerSet::DynamicWorkerTracker` ([`worker-set.c++:4000-4100`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L4000)):
- `DynamicWorkerTracker(uint limit) : shards(kShardCount), limit(limit) {}` — sharded by owner ID.
- `using OwnerMap = kj::HashMap<uint32_t, kj::HashSet<const Shard::WorkerInfo*>>;`
- `registerWorker(info)` → if breaching the limit, returns a `CondemnedEntry` so the caller can `evictDynamicWorkerInline()` the LRU victim.
- LRU is computed using `lastUsed` timestamps (CLOCK_REALTIME_COARSE granularity, per the test).

#### Eviction reasons (metric labels)

[`metrics.c++:1778-1790`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/metrics.c%2B%2B#L1778):
```cpp
enum EvictionReason { LRU, CONDEMNED, INACTIVE, DYNAMIC_WORKER };
struct EvictionReasonLabel {
  static constexpr kj::StringPtr LRU = "lru";
  static constexpr kj::StringPtr CONDEMNED = "condemned";
  static constexpr kj::StringPtr INACTIVE = "inactive";
  static constexpr kj::StringPtr DYNAMIC_WORKER = "dynamic_worker";
};
```
And in [`metrics.h:300`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/metrics.h#L300): `INACTIVE_WEBSOCKETS, DYNAMIC_WORKER_EVICTED, DYNAMIC_WORKER_BANNED, ABORT_ISOLATE_CALLED, …`. So eviction can be: per-owner cap (`DYNAMIC_WORKER` → `DYNAMIC_WORKER_EVICTED`), abuse-pipeline ban (`DYNAMIC_WORKER_BANNED`), regular memory-pressure LRU (`LRU`), explicit condemnation (`CONDEMNED`), or inactivity-driven (`INACTIVE`).

There is a metric `edgeworker_script_dynamicWorkerReplicaCount` ([`metrics.c++:902`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/metrics.c%2B%2B#L902)), and a `DynamicWorkerContext { kj::StringPtr parentScriptId; bool isEphemeral; }` in metrics ([`metrics.h:873`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/metrics.h#L873)).

### 5.5 Billing & metrics attribution

From [`dynamic-worker.c++:1050`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/dynamic-worker.c%2B%2B#L1050) (comment block in `DynamicWorker` constructor):

> // setting the caller's deployment ID. This will cause invocations of dynamic workers to be aggregated with the caller's analytics and billing. This is not really right, but I think there isn't a better option without some deeper changes to the data pipeline.

So **today, dynamic worker CPU/requests roll up to the caller's `DeploymentId`** — they are not billed as their own separate scripts. This is consistent with [Dina Kozlov's WfP-on-Loader doc](https://wiki.cfdata.org/spaces/~dkozlov/pages/1357511731) "Billing attribution" section, which expects to thread `dispatcherID` / `hasDispatcher` through manually so that WfP customers' pipelines retain their existing billing semantics:
- `Requests` charged only on the dispatcher.
- `CPU time` charged on dispatcher AND user worker (`hasDispatcher = 1 OR isNotNull(dispatcherID)`).
- `Scripts` come from the EWC scripts table.

The internal bookkeeping field `freeServiceBindingInvocation` ([`pipeline.h:172`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.h#L172)) marks invocations that should not count as billable — note in [`pipeline.c++:4754`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.c%2B%2B#L4754): "WfP dispatch invokes completely different billing code (for both the dispatcher and the dispatchee) which ignores the `freeServiceBindingInvocation` flag." The runtime carries `dispatcherId` / `dispatcherDeploymentId` separately for dynamic-dispatch invocations.

**Bottom-line for multi-processing design**: today, an account that uses a Worker Loader to spawn many "thread" workers will see all the CPU time and request count attributed to the *parent* worker's deployment, not split per loaded worker. RFC: Dynamic Workers Observability proposes to fix the *observability* side (loader ID as canonical identity, separate dashboard surface) but billing attribution is explicitly held in scope for the WfP migration only.

### 5.6 Custom limits per-loaded-worker

[`EW-10547`](https://jira.cfdata.org/browse/EW-10547) (Closed 2026-04-17) added per-call custom limits: the loader callback can return `limits: { cpuMs, subrequests }`, validated against `WorkerLoaderBinding.maxLimits`. The corresponding MRs:
- [edgeworker MR 12791](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/merge_requests/12791)
- [edgeworker-config-service MR 8662](https://gitlab.cfdata.org/cloudflare/ew/edgeworker-config-service/-/merge_requests/8662)

So as of April 2026: yes, you can give each loaded worker different CPU/subrequest limits, but they're capped by `maxLimits` on the binding.

### 5.7 Trusted/untrusted, request.cf, cache isolation

The same `untrustedByOwner` flag that powers WfP namespaces ([`pipeline.capnp` Worker.untrustedByOwner](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.capnp)) is the mechanism designed for Worker Loader's "trusted" flag in [Dina's parity doc](https://wiki.cfdata.org/spaces/~dkozlov/pages/1357511731). Effects when set:

- `cf` blob removed from incoming requests.
- `cf` blob in subrequests is ignored.
- `caches.default` disabled.
- `caches.open(name)` opens *named* caches private to this script.

The flag is enforced in the **parent** process so that a process-sandboxed dynamic isolate cannot bypass it. Open question (per Dina's doc and our reading): in `caches.open(name)`, what is the cache namespace identifier for a dynamic worker that has no `scriptId` registered with EWC? The current proposal is to use the `loaderId` argument to `env.LOADER.get(id, ...)`. Until that ships, named cache isolation for dynamic workers is undefined.

### 5.8 Safety gating & abuse-pipeline integration

The most consequential internal artifact: [Ketan Gupta — Abuse Detection and Termination for Dynamic Workers](https://wiki.cfdata.org/spaces/~ketan/pages/1304119456) and the three [EW-9653](https://jira.cfdata.org/browse/EW-9653) / [EW-9655](https://jira.cfdata.org/browse/EW-9655) / [EW-9656](https://jira.cfdata.org/browse/EW-9656) tickets (all Closed under epic [RM-24867 Dynamic Worker Loader Open Beta](https://jira.cfdata.org/browse/RM-24867)).

What ships:
- **Persistence of dynamic worker code**: edgeworker hashes the content, pushes the bundle to object storage keyed by hash if not already present, logs the content ID, and reports crashes (EW-9655). This makes Dice able to scan dynamic worker code retroactively.
- **`DynamicWorkerEventV1`** Kafka event proposed for `cloudflare/mb/schema/repository/workers/workers.proto` (analogous to `WorkerScriptEventV1`).
- **Kill switch**: `WorkerLoaderBinding.blockedWorkers` (list of `BlobId`) is being added so EWC can remotely disable specific dynamic-worker content hashes from running under a given loader binding (EW-9656).
- **Per-user block list**: `WorkerLoaderBinding.blockedUserIds` so a WfP-style customer of a loader can block its own end-users.
- **Long-term scalability fallback**: instead of embedding lists in the pipeline def, use individual QuickSilver keys for hashes/user IDs and subscribe.

Open security review: [REVIEW-14667 Dynamic Isolates Alpha](https://jira.cfdata.org/browse/REVIEW-14667) — *In Progress*, label `risk-high-risk`, owned by *Workers Runtime Platform*. [REVIEW-17120 Dynamic Worker Loader GA](https://jira.cfdata.org/browse/REVIEW-17120) — *Needs Triage* — gating GA.

[Ketan's doc](https://wiki.cfdata.org/spaces/~ketan/pages/1304119456) is explicitly labelled paranoid — referencing [INCIDENT-7730 (billing exploit)](https://jira.cfdata.org/browse/INCIDENT-7730) — and the authors envision two threat models:
1. Customer knowingly spawns malicious dynamic workers.
2. WfP customer's customer writes malicious code (the more likely path).

Practical implication for design: **Worker Loader is gated for production use behind paid plans + behavioural review**, and the public docs are still treating it as Beta. Any "spawn-many-workers" library should plan around a per-owner cap of ~50 active isolates and assume the platform may invalidate hashes asynchronously.

### 5.9 Observability (RFC, not yet GA)

Per [Brendan Irvine-Broque's RFC](https://wiki.cfdata.org/spaces/~birvine-broque/pages/1365394169):
- Configuration moves to the Wrangler `worker_loaders` array with an `observability` block per binding (logs/traces, sampling, destinations, persist).
- **Loader ID is the canonical dynamic worker identity** — every event is keyed by it.
- Dynamic worker telemetry persists to a separate "Dynamic Workers" dashboard surface by default; `include_in_parent: true` (default) also surfaces it in the caller's worker view.
- Tail Workers are no longer the recommended path — they're explicitly described as a workaround.
- New per-account access policy proposed for the Dynamic Workers surface.

Status: RFC, not implemented. Today, observability of a dynamic worker = attach a tail and re-log, per [`dynamic-logging` repo example](https://github.com/irvinebroque/dynamic-logging).

### 5.10 Worker Loader — invariants relevant to multi-processing

| Invariant | Source | Implication |
|---|---|---|
| Per-owner per-process cap on active loaded isolates: **default 50** (`dynamicWorkersPerOwnerLimit`). | `config.capnp:692`, `worker-set.c++:4145`. | A multi-processing library targeting one account on one edgeworker process cannot exceed ~50 concurrent isolates. Above that, LRU eviction kicks in transparently — old "threads" lose their in-memory state. |
| Eviction policy: **per-owner LRU** by `lastUsed` timestamp (`CLOCK_REALTIME_COARSE`). | `dynamic-worker-owner-limit.ew-test`, `DynamicWorkerTracker` in `worker-set.c++:4000-4100`. | If your coordinator round-robins across N>50 workers, each worker re-cold-starts on its turn. Sticky locality of work to a worker is mandatory. |
| Eviction is also driven by memory pressure (regular `LRU` reason) and bans (`CONDEMNED`/`DYNAMIC_WORKER_BANNED`). | `metrics.c++:1778-1790`. | "Threads" are not durable — even below the per-owner cap, host memory pressure can evict them. Treat all in-isolate state as ephemeral. |
| Isolate is keyed by the `loaderId` (named) or content-hash-derived `scriptId` (ephemeral). Loaded isolates *compete in the same `WorkerSet`* as deployed Worker isolates — there is no separate dynamic-worker arena. | `dynamic-worker.h:62`, `dynamic-worker-map.h`. | Memory quota is shared. Don't expect a dedicated cache for loaded workers. |
| **Same source code → same isolate** (when the loader callback is consistent). The `EdgeworkerEnvBuilder` ties bindings to the source so misbehaving callbacks cannot leak bindings across isolates. | `dynamic-worker.h:88-170`. | The platform protects you against "callback returned different bindings for same name" by *re-running the callback when needed* and rejecting mismatches. |
| `globalOutbound` can intercept all `fetch`/`connect` from the loaded worker (`null` blocks all egress; a service binding redirects). | Capnp + Dina's parity doc. | Coordinator can build a "policy"-style worker that wraps every loaded worker. |
| Per-call custom limits supported (`limits: {cpuMs, subrequests}`), capped by `maxLimits`. | EW-10547 closed; both MRs merged. | Different "threads" can have different CPU budgets within a single binding. |
| Dynamic workers run **in the same colo** as the parent loader — there's no cross-colo loader by design (the binding is local-process-scoped). | Implicit: `Global::WorkerLoader{.channel}` indexes a per-process channel table. | Multi-region multi-processing requires N coordinator workers, one per region. The runtime has no built-in cross-region "spawn elsewhere." |
| Process sandboxing supported and can be required via `limits.alwaysProcessSandbox = true`. | `pipeline.capnp:1579` (PROTIP comment), `dynamic-worker.h:61` `alwaysProcessSandbox`. | Recommended for any code received from less-trusted callers. Adds extra IPC but enforces stronger isolation. |
| Tail Workers can be passed **per loaded worker** via `tails:` in the callback (today the docs path; observability RFC obsoletes it). | Capnp + Dina's doc. | Different "threads" can have different observability handlers. |
| Billing today: dynamic worker invocations roll up to the **caller's** deployment ID. | `dynamic-worker.c++:1050`. | An account using Worker Loader for a multi-processing library will see all CPU/requests under one deployment, not split per "thread". |
| `caches.open(name)` namespace isolation for dynamic workers is unresolved — open question is whether to use `loaderId`. | Open question in Dina's parity doc. | Don't trust named caches for cross-thread shared state until this is resolved. |
| Host-side fundraising/abuse: codebase hashes worker source and persists to object storage; `blockedWorkers` / `blockedUserIds` arrays may invalidate replicas mid-flight (`DYNAMIC_WORKER_BANNED`). | Ketan's wiki + EW-9655/9656 (Closed). | Long-running "threads" can be killed by Dice asynchronously — assume retry-on-abort semantics. |

### 5.11 Public-vs-internal delta (Worker Loaders)

| Public claim (`02-public-docs-worker-loader-api.json`, `07-loader-security.json`, `08-loader-env-tails.json`) | Internal source-of-truth | Delta |
|---|---|---|
| `env.LOADER.get(id, callback)` returns a stable handle. | Confirmed: same `id` deterministically maps to a `scriptId` and reuses the existing isolate if not evicted. | **Match.** |
| Worker Loader is for "advanced platforms" / "AI agents". Public docs do not specify a limit on concurrent loaded workers. | **Default 50 per owner per process** (`dynamicWorkersPerOwnerLimit`). | **Internal-only & critical for design.** |
| Public docs describe `globalOutbound`, `tails`, `env`, `compatibilityDate`, `mainModule`, `modules`. | All present in `WorkerCode` shape — confirmed in test pipelines. | **Match.** |
| Public docs describe LRU/cold-start as "the runtime decides" — no concrete policy. | Per-owner LRU explicitly tested; eviction reasons enumerated; `lastUsed` tracked at `CLOCK_REALTIME_COARSE`; bans and condemnation are separate. | **Internal exposes a five-way taxonomy** (LRU, CONDEMNED, INACTIVE, DYNAMIC_WORKER, BANNED). |
| Public docs treat each `loaderId` as if it were an independent worker. | Internally, two different `loaderId`s pointing at *identical content* end up with the same content hash in `DynamicWorkerMap` and the abuse pipeline treats them together. The eventual scriptId scheme is content-addressed. | **Internal-only:** content equality is observable to the platform and used for ban propagation. |
| Public docs do not expose billing semantics for the loaded worker. | Loaded workers' usage rolls up to the caller. WfP migration uses different code paths (`hasDispatcher`, `dispatcherID`). | **Internal-only:** for multi-processing economics, treat the entire loader-spawned tree as a single billable script today. |
| Public docs are silent on whether/when the platform may invalidate a loaded worker. | Bans and condemnation can invalidate replicas mid-flight; `DYNAMIC_WORKER_BANNED` metric label proves this. | **Internal-only.** |
| Public docs are silent on what happens under sustained high concurrency. | Per-owner LRU + memory-pressure LRU; both apply concurrently. | **Internal-only.** |
| Public docs do not describe security gating. | High-risk PSR `REVIEW-14667` open; GA blocked on `REVIEW-17120`. | **Internal-only:** treat Loader as Open Beta with high security scrutiny. |


---

## 6. Light pass: Container DOs

### 6.1 Wire shape

Cloudchamber-side Cap'n Proto interface ([wiki Architecture excerpt](https://wiki.cfdata.org/display/CC/Architecture), `cloudflare/cc/cloudchamber/go/capnp/pkg/cloudchamber/cloudchamber.capnp`):

```capnp
getContainerDurableObject @0 (
  ownerId :UInt64,
  namespaceId :Text,
  actorId :Data,
  secret :Data,
  jurisdiction :Jurisdiction
) -> (container :ContainerDurableObject);
```

And `Container.status() -> (running :Bool)` for liveness.

### 6.2 Lifecycle

Per the [PRD: Spawning DOs next to containers](https://wiki.cfdata.org/display/CC/PRD%3A+Spawning+DOs+next+to+containers) and [Naresh Ramesh — Understanding containers](https://wiki.cfdata.org/display/~naresh/Understanding+containers):

1. Customer creates a Cloudchamber `Application` (image ref + scheduling policies + DO namespace ID).
2. Coordinator's scheduler periodically creates `Deployment`s for the application, prewarming containers in different regions ("at least a few in NAM + EU"). Prewarming pre-pulls images and pre-schedules space.
3. When a customer calls `getContainer(env.CONTAINER, "someId").fetch(request)`, the runtime first routes to a DurableObject (creating it if new).
4. The DO's constructor calls cloudchamberd via `getContainerDurableObject(...)`. cloudchamberd selects "the closest prewarmed container to the Durable Object" and binds it to that actor ID.
5. The DO proxies requests to the container.

[Cloudchamber RFC](https://wiki.cfdata.org/display/CC/RFC%3A+Cloudchamber+runtime+and+API+interactions+for+Durable+Object+bindings) describes what happens if the launcher can't be reached: the DO is dropped an `UnconfiguredContainer` capability, restarting it.

### 6.3 Placement & latency invariants

- **Placement is decided by Cloudchamber, not the DO scheduler.** The DO is steered toward the container's metal once the container is selected. The PRD explicitly proposes flipping this: have edgeworker's DO scheduler defer to cloudchamberd up-front, then put the DO and container on the *same metal* — eliminating the cross-metal hop.
- **DO ↔ container hop is the latency dominator.** [Containers — Internal FAQ](https://wiki.cfdata.org/display/CC/Containers+-+Internal+FAQ): "The DurableObject routes to the container (this hop thru the DO is slow! - We are working on it now. [Track this RM-24991](https://jira.cfdata.org/browse/RM-24991))."
- **Cross-region placement happens.** "In a case where the nearest prewarmed container is far away — we use that, which ideally never happens, but does happen sometimes."
- **Statelessness is the explicit limitation today** — but [Containers + DOs are coming soon](https://wiki.cfdata.org/pages/viewpage.action?pageId=1117129971) describes using the DO as the persistence layer that survives container resets.

### 6.4 Internal vs public delta (Containers)

Public docs (codebase session's `03-public-docs-containers.json`) describe the JS API and high-level model. Internal-only: prewarm-pool semantics, the specific cross-metal hop overhead, and the in-flight bypass project (`RM-24991`). These should not significantly affect a multi-processing library design — Container DOs are *not* a good substrate for "thread" parallelism because cold-start is dominated by image-pull+container-boot, not isolate creation.

### 6.5 Relevance to multi-processing

Briefly: **Container DOs trade massive cold-start (seconds) for first-class workloads that don't fit Workers (full languages, long-lived state, heavy CPU).** They're appropriate as a "heavyweight worker" tier in a multi-processing library — e.g. ML inference, batch — but not as the parallel "thread" primitive. Use Worker Loaders for fast spin-up, Facets for actor-local concurrency, and reach for Container DOs only when other primitives fail.

---

## 7. Light pass: Dynamic Dispatch Namespaces (Workers for Platforms)

### 7.1 Pipeline-level shape

[`pipeline.capnp:1426`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.capnp#L1426) defines `DynamicDispatchBinding`. The binding appears as `Global.value.dynamicDispatch :group { stage @33 :UInt32; info @34 :DynamicDispatchBinding; }`. `stage` indexes a `SubPipeline` stage in the same pipeline; `info` carries the dispatch metadata.

The runtime adapter is [`src/edgeworker/internal-api/dynamic-dispatch.h`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/internal-api/dynamic-dispatch.h) — `DynamicDispatchInterpreter` translates `dispatcher.get(scriptName, args, options)` calls into pipeline arguments. The schema enumerates dispatch modes ([`dynamic-dispatch.c++:95-110`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/internal-api/dynamic-dispatch.c%2B%2B#L95)):
- `NAMESPACE` — full WfP namespace.
- `FIRST_PARTY` — first-party-script dispatch.
- `REQUIRE_SUFFIX` — restrict to scripts with a name suffix.

Param schema (validated at dispatch time):
- `BOOLEAN`, `JSON`, `ENTRYPOINT`, `WORKER`, `FRANKENVALUE` ([`dynamic-dispatch.c++:174-213`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/internal-api/dynamic-dispatch.c%2B%2B#L174)).

### 7.2 Pipeline-ID derivation

Per [Aaron Lisman's Workers For Platforms - Technical Overview](https://wiki.cfdata.org/display/~alisman/Workers+For+Platforms+-+Technical+Overview) and [Jon Phillips — Worker config schema](https://wiki.cfdata.org/spaces/~jphillips/pages/1314783936):
- Each namespace has a 32-byte cryptographic `namespaceKey`.
- User worker pipeline ID = **`HMAC-SHA256(namespaceKey, scriptName)`** — deterministic, no lookup table.
- The runtime computes this on every dispatch call.
- The dispatcher worker's pipeline carries the `namespaceKey` so the runtime can resolve names without calling EWC.

### 7.3 Trusted/untrusted

A `trusted_workers` flag at namespace creation time (per [Dina's Namespaces page](https://wiki.cfdata.org/display/~dkozlov/Namespaces)) flips `untrustedByOwner` in the user worker's `pipeline.capnp` `Worker` stage. Effects identical to those listed in §5.7.

When `untrustedByOwner = true` for a User Worker dispatched through the namespace:
- `request.cf` is hidden.
- `caches.default` is disabled.
- Named caches are isolated by script.
- The default zone cache is disabled (prevents poisoning).

### 7.4 Outbound Workers

`Outbound` is a separate `Stage` type ([`pipeline.capnp` Stage union](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.capnp)). Every `fetch()` from a User Worker is intercepted and routed to the configured Outbound Worker. Outbound parameters are passed via `connectionProps` (shared mechanism with `dynamicDispatch.connectionProps`).

The outbound binding can be either:
- **Mutable** — auto-updating, references the latest version of the outbound script.
- **Pinned** — version-locked.

EWC stores `namespace_binding_outbound` and rebuilds wrapper pipelines when this changes ([Josh Wheeler's WfP-DW exploration](https://wiki.cfdata.org/spaces/~jwheeler/pages/1372556848) "EWC's Role" section).

### 7.5 Internal-only invariants for dispatch namespaces

- **Constant-time dispatch resolution** in the runtime — no QS lookup needed for the namespace → pipeline mapping.
- The Dispatcher Worker is shared across many zones — [Spec: Pages x WFP](https://wiki.cfdata.org/display/EW/Spec%3A+Pages+x+WFP) says it adds "1-4 ms of compute for every request" and the isolate is "warm in practically every colo."
- Pipelines per WfP customer can be huge: WfP customers can accumulate "many abusive end-users over time" — Ketan's doc raises concerns about embedding huge `blockedUserIds` lists in pipeline defs.
- **EWC is the choke point** for everything namespace-related: ~40 REST routes, PostgreSQL source-of-truth, and binary pipeline-def generator. It generates `WorkerBundle` Cap'n Proto `ResourceLimits` baked into QS.

### 7.6 Public-vs-internal delta (Dispatch Namespaces)

| Public claim (`04-public-docs-dispatch.json`) | Internal | Delta |
|---|---|---|
| `dispatcher.get(name)` returns a stub. | HMAC-SHA256 derivation; pipeline ID computed inline. | **Match.** |
| `trusted` is a namespace property. | Stored in EWC as `trusted_workers`, propagated as `untrustedByOwner` on each user worker pipeline. | **Match.** |
| Public exposes `outbound` (with parameters). | Internally implemented as wrapper pipelines (mutable or pinned), with `connectionProps` carrying parameters. Pinned mode appears not to be public. | **Internal exposes pinning that public doesn't.** |
| Public says namespace can hold "several million" entries. | [Spec: Pages x WFP](https://wiki.cfdata.org/display/EW/Spec%3A+Pages+x+WFP): "built for several millions of entries." | **Match.** |
| Public docs imply WfP overhead is "negligible". | Internal: "1-4 ms of compute for every request" from the dispatcher worker. | **Internal puts a number on it.** |
| Public makes no commitment about dispatcher-isolate warmth. | Internal: "warm in practically every colo" because the dispatcher namespace is shared and static. | **Internal commits to warmth.** |

---

## 8. Light pass: Named entrypoints and JSRPC

### 8.1 Pipeline-level shape

In [`pipeline.capnp` `Stage.Worker`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.capnp), the entrypoint union is:
```capnp
entrypoint :union {
  name @10 :Text;       # named entrypoint export
  param @11 :Text;      # parameter binding — entrypoint is a pipeline param
}
```

So every pipeline `Worker` stage is parameterized by either a literal entrypoint name or a pipeline-parameter name. This is the substrate that lets one Worker script back many entrypoints (`MyActor`, `MyFacet`, `LogTailer`, …).

`Stage.Worker.ctxExports @19 :List(Global)` is parallel to `globals @1 :List(Global)` and populates `ctx.exports` with each named export ([`pipeline.capnp:217`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.capnp#L217)). For an `actorNamespace` value in `ctx.exports`, the comment says: "When an actor namespace appears in ctx.exports, we also want the same symbol to be usable as an actor class binding. In that case, `loopbackActorClassStagePlusOne` is the index of the loopback stage, plus one." This is the mechanism behind `ctx.exports.MyActor.getByName("…")` and the facets test wires it up explicitly.

### 8.2 Stub semantics & lifetime

The codebase session has the workerd-side `JsRpcStub` reality. Internal additions:
- **JSRPC Cap'n Proto plumbing** is concentrated in workerd's `worker-rpc.{h,c++}` ([WOBS Binding Instrumentation Notes](https://wiki.cfdata.org/display/WOBS/Binding+Instrumentation+Notes)).
- **`ctx.exports`** is the canonical way to obtain a stub to your own named entrypoints, including loopback to your own class as an actor binding.
- **Call props pattern**: `ctx.exports.Foo({props: {...}})` (used everywhere from facets to outbound interception) returns a stub to `Foo` *with* `props` baked into the connection. The provider sets props at connection-time and the receiver cannot override; this is how authority/identity is conveyed safely without round-trip auth.
- **Cross-Account Bindings (XAB)**: pipeline.capnp comments describe "cross-account 'connection'" semantics — the provider specifies metadata when the connection is created and the caller cannot see, much less modify, the props.

### 8.3 Internal-only RPC discoverability work

[Sam Macleod — Expanded RPC support in workerd](https://wiki.cfdata.org/display/~smacleod/Expanded+RPC+support+in+workerd) proposes a runtime endpoint exposing *all* entrypoints across workerd processes:

```js
env.RPC("tcp://localhost:1234").MyEntrypoint
```

Status: design proposal, not in production. Important for our use case because it would make a coordinator Worker able to enumerate / introspect available entrypoints dynamically — which would help "spawn a thread of class X" patterns.

[Korinne Alpers — Mini-PRD: Self-referential bindings](https://wiki.cfdata.org/display/~korinne/%5BMini-PRD%5D+Self-referential+bindings) is the related self-RPC story.

[Workers eXperience — Mini-SPEC: JSRPC support for Workers + Assets in `wrangler dev`](https://wiki.cfdata.org/pages/viewpage.action?pageId=1092892940) contains the canonical *expected* behaviour matrix across (default entrypoint / named entrypoint / Durable Object) × (fetch HTTP / fetch RPC / non-fetch RPC / non-fetch handlers) for both production and local dev. Use that as the ground-truth oracle when implementing tests.

### 8.4 Public-vs-internal delta (Named Entrypoints / RPC)

Almost no delta — the codebase session's public-doc capture (`05-public-docs-rpc-entrypoints.json`, `10-do-rpc.json`) and the internal pipeline.capnp agree on:
- Named entrypoints are first-class, addressable independently from the default `fetch`.
- Stubs can be passed across RPC boundaries (with caveats — complex bindings like R2 with `ReadableStream` don't pass through today, per [Josh Wheeler's WfP-DW doc](https://wiki.cfdata.org/spaces/~jwheeler/pages/1372556848)).
- `ctx.props` carries connection-scoped metadata.

Two internal-only items:
- **Binding-passthrough RPC limitation** — Kenton has been asked about adding native runtime support for passing complex bindings across RPC ([WfP & DW exploration](https://wiki.cfdata.org/spaces/~jwheeler/pages/1372556848)). This would unblock dynamic resource bindings.
- **Self-referential bindings** are not yet a public feature.


---

## 9. Cross-cutting invariant table (for multi-processing design)

This table consolidates the asks called out by the operator: **max facets per DO, max active loaded Workers per binding, isolate cache shape and TTL, hibernation triggers, eviction policy under memory pressure, single-region vs cross-region routing for facets vs loaders, billing units (request/duration/storage) for each primitive, and any safety-gating that limits Worker Loaders / facets in production.**

The table is the canonical reference. Each row cites the source: `code:file#Lline` (GitLab path), `wiki:Title` (Confluence), `jira:KEY`. Where a number is *not* present in source, the cell says "**unbounded in code**" or "**not in source-of-truth**".

### 9.1 Capacity and limits

| Question | Answer | Source |
|---|---|---|
| **Max facets per DO** | **No hard cap in source.** Bounded by parent DO's available memory, output gates, and storage stage count. The runtime stores `kj::HashMap<kj::String, kj::Rc<ActorHolderImpl>> facets;` per parent with no upper bound check. | `code:src/edgeworker/scheduling/worker-set.c++#L1270` |
| **Max facet depth** | **No hard cap in source.** Each child stores `depth = parent.depth + 1`; `getFacetPath` allocates `child.depth + 1` strings on every call. | `code:worker-set.c++#L1234, #L1429` |
| **Max active loaded Workers per binding** | **No per-binding cap.** | `code:pipeline.capnp#L1575` (no limit field on `WorkerLoaderBinding`) |
| **Max active loaded Workers per owner per process** | **Default 50 (`dynamicWorkersPerOwnerLimit @215 :UInt32 = 50`).** Configurable. Excess triggers LRU eviction. | `code:src/edgeworker/server/config.capnp#L692`, `code:worker-set.c++#L4145`, `code:dynamic-worker-owner-limit.ew-test` |
| **Max DO instances per namespace / per account** | Documented publicly as "billions" — confirmed informally in [Customer Solutions Engineering primer](https://wiki.cfdata.org/display/CSE/Primer%3A+Using+and+Designing+with+Durable+Objects). No explicit numeric cap in the runtime — it's a control-plane concern in EWC. | `wiki:CSE Primer` |
| **Max custom limits per loaded worker** | `cpuMs` and `subrequests` per call, capped by `WorkerLoaderBinding.maxLimits`. | `code:pipeline.capnp#L1581`, `jira:EW-10547` (Closed 2026-04-17) |

### 9.2 Isolate cache, eviction, hibernation

| Question | Answer | Source |
|---|---|---|
| **Loaded-worker isolate cache shape** | A reverse map `contentHash → {scriptId}` of currently-loaded replicas (`DynamicWorkerMap`) on top of the regular `WorkerSet` LRU. There is no separate cache — loaded workers compete with deployed Workers for memory. | `code:src/edgeworker/scheduling/dynamic-worker-map.h` |
| **Loaded-worker LRU policy** | Per-owner LRU by `lastUsed` timestamp (`CLOCK_REALTIME_COARSE` granularity). When the per-owner limit is breached, the LRU isolate for that owner is evicted inline. | `code:worker-set.c++#L4000-4100`, `code:dynamic-worker-owner-limit.ew-test` |
| **Loaded-worker eviction reasons** | Five labelled metrics: `lru` (memory pressure), `condemned` (kill), `inactive` (idle), `dynamic_worker` (per-owner cap), and `dynamic_worker_banned` (Dice). | `code:metrics.c++#L1778-1790`, `code:metrics.h#L300` |
| **Loaded-worker TTL** | **Not set explicitly.** Lifetime ends only on eviction (one of the five reasons above). There is no fixed time-to-live. | Implicit from the absence of TTL in `DynamicWorkerTracker` |
| **DO hibernation trigger** | After ~10s of inactivity *and* no pending alarms / timers / WebSockets. Hibernation manager is per-`RootCart` (the parent actor), not per-facet. | `wiki:CSE Primer` (10s figure), `code:worker-set.c++#L1867 maybeHibernationManager` |
| **DO hibernation w/ WebSockets** | `webSocketAcceptHibernation` keeps a WebSocket alive across hibernation; the actor reload reattaches. (Public-doc surface; internal mechanism in [`worker-set.c++:1907`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/worker-set.c%2B%2B#L1907) — `// We expect that the call to hibernate() will delete this. It could also resolve a reference cycle where the Worker::Actor holds references back to the RootCart…`). | `code:worker-set.c++#L1867-1907` |
| **Memory pressure eviction** | Standard regular-worker LRU applies to *all* isolates including dynamic. Worker isolate count per metal limited by 128MB working memory + LRU. AIR (Asynchronous Isolate Recreation) periodically rebuilds growing isolates. | `wiki:Asynchronous Isolate Recreation (AIR)` |
| **Process sandboxing** | Optional per script (heuristic-driven once a worker exhibits suspicious metrics) or required (`limits.alwaysProcessSandbox = true` on a `WorkerLoaderBinding` or per-Worker). Adds extra IPC. Once on, "should always be loaded sandboxed from now on." | `code:pipeline.capnp#L1579`, `code:worker-set.c++#L3965` |

### 9.3 Routing & regionality

| Question | Answer | Source |
|---|---|---|
| **DO routing model** | Three Cap'n Proto interfaces: `RoutingSupervisor` (sandbox→supervisor), `PeerEdgeworker` (intra-colo peer), `ClusterGateway` (inter-colo). Actors are assigned to specific metals via Ketama-style consistent hash (Consul-driven). Sessions heartbeat every 500ms to CockroachDB; capabilities are revoked via Cap'n Proto membranes when a session dies. | `code:src/edgeworker/routing-supervisor/AGENTS.md` |
| **DO single-region vs cross-region** | An actor lives on one shard. The shard's owning colo is determined by consistent hashing. **Cross-region routing happens transparently** — if the shard belongs to a remote colo, the request is forwarded via `InterColoRpcSystem` to the remote colo's `ClusterGateway`. Location hints exist (public). | `wiki:routing-supervisor AGENTS.md`, [Brendan — DO location hints](https://wiki.cfdata.org/pages/viewpage.action?pageId=711743043) |
| **Facets — regionality** | Facets are *not* independently placed. They share the parent DO's location entirely. | Implicit: facets = `Worker::Actor` instances inside the parent's `RootCart`. |
| **Worker Loader — regionality** | Loaded workers are local to the calling process (per-process channel, per-owner counter). **No cross-region "spawn elsewhere"** built in. | `code:edgeworker-api.h:427` (per-process WorkerLoader channel), `code:worker-set.c++#L4145` (process-scoped tracker) |
| **Container DO — regionality** | Cloudchamber prewarms in multiple regions. Placement chooses "closest prewarmed container to the DO" but can be far. PRD [Spawning DOs next to containers](https://wiki.cfdata.org/display/CC/PRD%3A+Spawning+DOs+next+to+containers) wants to flip this. | `wiki:CC FAQ` |

### 9.4 Billing model per primitive

| Primitive | Request unit | Compute (CPU-ms / duration) | Storage | Source |
|---|---|---|---|---|
| **Durable Object (parent)** | Per request to the DO | DO duration (compute) billed | Storage GB-month + read/write/list/delete ops | `wiki:DEVGTM/Durable Objects`, public pricing |
| **DO Facet** | **Today rolled up under the parent DO** (no separate billing unit observed in source). Each facet runs as a `Worker::Actor` but the runtime records its activity under the parent's `dispatcherId`/`deploymentId` or own deploymentId — the runtime's billing-attribution code has *no* facet-aware split. | Same as above. | Each facet has its own SQLite database stage; storage GB counts per parent DO storage account but stages are independently sized. | Implicit from `worker-set.c++` + `dynamic-worker.c++#L1050` comment |
| **Worker Loader (loaded worker)** | **Today rolled up under caller's deployment** (`dispatcherDeploymentId` carries the caller's). `freeServiceBindingInvocation` is *not* applied to dispatch (per [`pipeline.c++:4754`](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/blob/master/src/edgeworker/scheduling/pipeline.c%2B%2B#L4754)). | CPU-ms sums to the caller. | Loaded workers do not have storage of their own (unless they back a DO class via `getDurableObjectClass`, in which case standard DO storage applies). | `code:dynamic-worker.c++#L1050`, `wiki:Dina — WfP on Loader (Billing attribution)` |
| **Dispatch Namespace (User Worker)** | Dispatcher worker billed for requests. User worker counted via `hasDispatcher` / `dispatcherID`. | CPU-ms billed across dispatcher and user worker. | User worker may upload static assets to a per-namespace KV (managed by EWC). | `wiki:Dina — billing section`, `wiki:WFP support guide` |
| **Container DO** | Per request to the DO + container CPU/RAM time. | Cloudchamber-priced (containers) + DO-priced. | DO storage + container ephemeral storage (no platform-managed durability for container files). | `wiki:CC architecture`, public pricing |
| **Named entrypoints / RPC** | No separate billing — counts under the host worker. | CPU on the host worker. | N/A | Capnp `Worker.Stage` carries entrypoint name only |

### 9.5 Safety gating

| Primitive | Production gate | Status | Source |
|---|---|---|---|
| **DO Facets** | None observed beyond DO entitlements. The implementation appears to ride on existing DO infrastructure with no separate alpha/beta gate at the runtime level. | Treat as available where DOs are available. | Confirmed by absence of feature flag in `worker-set.c++` facet code. |
| **Worker Loader / Dynamic Workers** | **Open Beta with high-risk security review.** Bundle persistence to object storage + Dice integration + kill-switch hooks must be in place before GA. `cpu-isolate` blockedWorkers/blockedUserIds enforced at runtime. | Open Beta. GA blocked on PSR. | `jira:RM-24867 (Closed)`, `jira:RM-27238 (In Progress)`, `jira:REVIEW-14667 (In Progress, risk-high-risk)`, `jira:REVIEW-17120 (Needs Triage)`, `jira:EW-9655/9656 (Closed)`, `wiki:Ketan — Abuse Detection` |
| **Dispatch Namespaces** | GA today. `untrustedByOwner` enforced in parent process. `trusted_workers` flag opt-in for first-party dispatch. | GA. | `wiki:Aaron — WFP Technical Overview` |
| **Container DOs** | Open Beta / private beta. Allow-listed access. RM-24991 is the active ingress-bypass project. | Beta. | `wiki:CC — Containers + Durable Objects are coming soon` |
| **Named entrypoints / RPC** | GA. Documented publicly for Worker → Worker and Worker → DO. | GA. | Capnp + public `developers.cloudflare.com` |

### 9.6 RPC stub lifetime (relevant for coordinator → workers fanout)

- A `Fetcher`/RPC stub from `worker.getEntrypoint(name)` is an **I/O object** (per `dynamic-worker.h` comment: "DynamicWorker is an I/O object, meaning it is limited to be used only within a single request context."). The underlying isolate may live across requests, but the stub does not.
- Between requests, the coordinator must re-acquire its loader stub from `env.LOADER.get(loaderId, callback)` on every invocation.
- For long-lived flows (WebSockets, alarms), state must be in DO storage, not held by the coordinator's stubs.

### 9.7 Concurrency primitives summary

| Primitive | Concurrency model | Per-instance CPU parallelism |
|---|---|---|
| **Worker (regular)** | Single-threaded JS, replicas (`MIN_REPLICA_LOAD`/`MAX_REPLICA_LOAD`) created when blocked → up to 8 replicas per metal observed in production for some scripts. | Replicas give CPU parallelism *for the same script* once blocking demand exceeds threshold. |
| **Durable Object** | Single-threaded actor; explicitly "single-threaded on a single isolate." Concurrency from input/output gates and async I/O. | None. CPU work serializes through the actor lock. |
| **DO Facet** | One actor per facet — independent input/output gates from the parent. | **Same metal as parent**, so two facets contend for the same machine. CPU parallelism gained = the parallelism that comes from running on different actor lock. |
| **Worker Loader** | Each loaded isolate has its own V8 context and lock. Replicas may exist for hot loaded workers (the same replica logic applies). | Yes — multiple loaded isolates can run concurrently on the same metal subject to replica creation rules and the per-owner cap. |
| **Container DO** | Container is full OS process, multi-threaded by design. DO is the front door. | Yes — full process-level parallelism inside the container. |


---

## 10. Open questions / unknowns to follow up with humans

These are items where the source-of-truth is incomplete, ambiguous, or in-flight, and a quick ping to the right human is the cheapest next step. Pings ordered roughly by impact-on-design.

1. **What's the actual default for `dynamicWorkersPerOwnerLimit` in *production*?** The schema default is 50, but production may override via deployment config. **Ask:** [Workers Runtime team Gchat](https://chat.google.com/preview/room/AAAAGX7FDAU) or `workers-runtime@cloudflare.com`.
2. **Is the per-owner counter shared across the binding or per-binding?** The class is `DynamicWorkerTracker` shared across a `WorkerSet`. If a single account has two parent workers with two loader bindings, do their loaded-worker counts pool? Reading the code suggests yes — single counter per `(ownerId, process)`. **Ask:** Kenton Varda or Armen Boursalian.
3. **Cold-start latency for a Worker Loader spawn:** numerical ballpark (cold path: callback invocation + isolate creation + module compilation; warm path: just isolate-cache lookup). The `workerd` source has the timings; ask the codebase session to extract them or ping the Runtime team.
4. **Does eviction *invalidate* outstanding RPC stubs immediately, or do they fail on next call?** Affects fault-handling design in the coordinator.
5. **`caches.open(name)` namespace identifier for dynamic workers** — open question in [Dina's parity doc](https://wiki.cfdata.org/spaces/~dkozlov/pages/1357511731). Until resolved, named caches are unreliable as cross-thread shared state.
6. **Facet hibernation semantics** — does hibernating the parent unconditionally hibernate all child facets? The single `maybeHibernationManager` per-`RootCart` suggests yes, but the test files do not exercise multi-facet hibernation. **Ask:** Lambros Petrou or Josh Howard (DO team).
7. **Output gate unification across facets** (`TODO(facets):` in `worker-set.c++:2142`) — when will it land, and what ordering guarantees can a coordinator rely on today? **Ask:** Kenton Varda.
8. **Maximum facet depth in practice** — no hardcoded cap, but what's the supported-in-practice ceiling? Real production deployments likely keep depth ≤ 2.
9. **Cross-region behavior for Worker Loaders** — confirmed local-process-only. Is there a planned "spawn in remote colo" primitive (e.g. for placement-aware multi-processing)? **Ask:** Brendan Irvine-Broque (PM, Workers Runtime).
10. **Billing attribution roadmap** — Dina's doc covers WfP migration. Is per-loaded-worker billing on the post-GA roadmap? The `dynamic-worker.c++:1050` "this is not really right" comment suggests yes.
11. **`DynamicWorkerEventV1` Kafka schema** — is it merged into `cloudflare/mb/schema` or still at proposal stage? Affects how the multi-processing library can self-observe.
12. **Custom `WorkerLoaderBinding.blockedWorkers` / `blockedUserIds` arrays** — landed yet? Search results suggest the schema extension is not yet in master. **Ask:** Ketan Gupta directly.
13. **Per-loader-binding observability config** — RFC stage. Implementation will require pipeline.capnp extension and EWC support; timeline unclear.
14. **Self-referential bindings / `env.RPC("tcp://…")` discoverability** — proposal stage; would simplify thread-class enumeration but cannot be relied on yet.
15. **Container DO RM-24991** — when does the DO-bypass-when-on-same-metal optimization land? Significant for hybrid heavyweight-thread designs.
16. **Replica rules for loaded workers** — do `MIN_REPLICA_LOAD` / `MAX_REPLICA_LOAD` apply to dynamic workers identically to deployed Workers? Cited in [`Workers Runtime internals`](https://wiki.cfdata.org/display/EW/Runtime+internals). Ask: Workers Runtime.

---

## 11. Annotated source index

### 11.1 Capnp schemas (read these first for any contract question)

- `code:src/edgeworker/scheduling/pipeline.capnp` — the master pipeline schema. Read sections: `PipelineDef` (typeId `0xb08a70de6aaa7f1c`), `Stage.Worker` (incl. `untrustedByOwner @12`, `entrypoint :union`, `globals @1`, `ctxExports @19`), `WorkerLoaderBinding` (line 1575), `DynamicDispatchBinding` (line 1426), `GlobalActorNamespaceBinding` (line 1312), and the `Global.value` union (the binding type catalogue).
- `code:src/edgeworker/server/worker-limits.capnp` — `WorkerLimitsDef` (the type both `limits` and `maxLimits` use).
- `code:src/edgeworker/server/config.capnp` — global edgeworker config, including `dynamicWorkersPerOwnerLimit @215 :UInt32 = 50`.
- `code:src/edgeworker/routing-supervisor/routing-supervisor.capnp`, `peer-edgeworker.capnp`, `cluster-gateway.capnp` — DO routing.
- `code:src/edgeworker/scheduling/dynamic-dispatch.capnp` — dispatch namespace details.
- Cloudchamber: `cloudflare/cc/cloudchamber/go/capnp/pkg/cloudchamber/cloudchamber.capnp` and `container.capnp`.

### 11.2 Source files (key entry points only)

- `code:src/edgeworker/scheduling/worker-set.c++` — facets implementation, dynamic worker tracker, isolate lifecycle. Most important file in this entire dossier.
- `code:src/edgeworker/scheduling/worker-set.h` — `WorkerLoaderChannelInfo`, `DynamicWorkerTracker` declaration.
- `code:src/edgeworker/scheduling/dynamic-worker.h` — `DynamicWorker` request-time class and `EdgeworkerEnvBuilder` design comment (the source/binding pairing problem).
- `code:src/edgeworker/scheduling/dynamic-worker.c++` — implementation; line 1050 is the billing-attribution comment.
- `code:src/edgeworker/scheduling/dynamic-worker-map.h` — content-hash → script-id reverse map.
- `code:src/edgeworker/scheduling/process-sandbox.c++` — facet RPC bridge; `FacetManagerImpl`, `GetStartInfoCallbackImpl`, `FetchSourceCallbackImpl`.
- `code:src/edgeworker/scheduling/pipeline.c++` — pipeline channel wiring (look around `toWorkerLoader` and `WorkerStage`).
- `code:src/edgeworker/scheduling/edgeworker-api.h` — `WorkerLoader` channel structure on the API side.
- `code:src/edgeworker/scheduling/metrics.h`, `metrics.c++` — `EvictionReason` enum, `DynamicWorkerContext`, `dynamicScriptContentHash` field.
- `code:src/edgeworker/internal-api/dynamic-dispatch.{h,c++}` — `DynamicDispatchInterpreter`, the `dispatcher.get(...)` adapter.
- `code:src/edgeworker/routing-supervisor/AGENTS.md` — best one-page on the DO routing model.
- `code:src/edgeworker/supervisor/binding-keeper.h` — how supervisor exchanges tokens for actor namespace caps.

### 11.3 Tests-as-spec

- `code:src/edgeworker/tests/actors-storage/facets.storage-ew-test` — facet semantics including dynamic-class-loaded facets. Authoritative.
- `code:src/edgeworker/tests/actors/facets.ew-test` — facet semantics without storage backend. Authoritative for execution.
- `code:src/edgeworker/scheduling/dynamic-worker.ew-test` — Worker Loader basic execution, including `ActorWithLoader` (loader inside a DO).
- `code:src/edgeworker/scheduling/dynamic-worker-owner-limit.ew-test` — proves LRU eviction at `dynamicWorkersPerOwnerLimit = 2`.
- `code:src/edgeworker/scheduling/dynamic-worker-map-test.c++` — content-hash map invariants.
- `code:src/edgeworker/tests/dynamic-worker-limits.ew-test` — limit enforcement.
- `code:src/edgeworker/tests/dynamic-worker-metrics.ew-test` — metric emission (eviction reason labels visible here).
- `code:src/edgeworker/tests/dynamic-worker-load-test.ew-test-bin.c++` — load test under default `dynamicWorkersPerOwnerLimit = 50`.

### 11.4 Confluence pages — first-read list (de-duplicated)

Highest value, in roughly the order to read:
1. [Dina Kozlov — Powering Dispatcher with a Worker Loader — step 1](https://wiki.cfdata.org/spaces/~dkozlov/pages/1357511731)
2. [Brendan Irvine-Broque — RFC: Dynamic Workers Observability](https://wiki.cfdata.org/spaces/~birvine-broque/pages/1365394169)
3. [Ketan Gupta — Abuse Detection and Termination for Dynamic Workers](https://wiki.cfdata.org/spaces/~ketan/pages/1304119456)
4. [Josh Wheeler — WfP & Dynamic Workers: Exploring the Path Forward](https://wiki.cfdata.org/spaces/~jwheeler/pages/1372556848)
5. [Aaron Lisman — Workers For Platforms - Technical Overview](https://wiki.cfdata.org/display/~alisman/Workers+For+Platforms+-+Technical+Overview)
6. [Jon Phillips — Worker config: a pipelines replacement](https://wiki.cfdata.org/spaces/~jphillips/pages/1314783936)
7. [Storage — (Retroactive) SPEC: Durable Objects](https://wiki.cfdata.org/display/STOR/%28Retroactive%29+SPEC%3A+Durable+Objects)
8. [Workers — Runtime internals](https://wiki.cfdata.org/display/EW/Runtime+internals)
9. [Cloudchamber — Architecture](https://wiki.cfdata.org/display/CC/Architecture)
10. [Cloudchamber — Containers - Internal FAQ](https://wiki.cfdata.org/display/CC/Containers+-+Internal+FAQ)
11. [Brendan Irvine-Broque — CDP + MCP + Code Mode = Agents can truly debug browsers](https://wiki.cfdata.org/pages/viewpage.action?pageId=1348872755)
12. [Workers eXperience — Mini-SPEC: JSRPC support for Workers + Assets in `wrangler dev`](https://wiki.cfdata.org/pages/viewpage.action?pageId=1092892940)
13. [Sam Macleod — Expanded RPC support in workerd](https://wiki.cfdata.org/display/~smacleod/Expanded+RPC+support+in+workerd)
14. [Korinne Alpers — Mini-PRD: Self-referential bindings](https://wiki.cfdata.org/display/~korinne/%5BMini-PRD%5D+Self-referential+bindings)
15. [Workers — Asynchronous Isolate Recreation (AIR)](https://wiki.cfdata.org/pages/viewpage.action?pageId=309285428)

### 11.5 Jira tickets — at-a-glance

- Worker Loader Open Beta — [RM-24867](https://jira.cfdata.org/browse/RM-24867) (Closed). Workers Runtime Platform.
- Worker Loader GA — [RM-27238](https://jira.cfdata.org/browse/RM-27238) (In Progress). Workers Runtime Platform.
- Open Beta SHIP — [SHIP-13903](https://jira.cfdata.org/browse/SHIP-13903) (Backlog). GA SHIP — [SHIP-13904](https://jira.cfdata.org/browse/SHIP-13904) (Backlog).
- Dynamic Isolates Alpha PSR — [REVIEW-14667](https://jira.cfdata.org/browse/REVIEW-14667) (In Progress, `risk-high-risk`).
- Dynamic Worker Loader GA PSR — [REVIEW-17120](https://jira.cfdata.org/browse/REVIEW-17120) (Needs Triage).
- Dice integration — [EW-9653](https://jira.cfdata.org/browse/EW-9653), [EW-9655](https://jira.cfdata.org/browse/EW-9655), [EW-9656](https://jira.cfdata.org/browse/EW-9656) all Closed under RM-24867.
- Per-call custom limits — [EW-10547](https://jira.cfdata.org/browse/EW-10547) Closed 2026-04-17.
- DICE pipeline build — [TMD-1000](https://jira.cfdata.org/browse/TMD-1000) (Closed).
- Container ingress optimization — [RM-24991](https://jira.cfdata.org/browse/RM-24991) (in flight).
- Capitalisation tracking (FYI) — `ACCTG-1329`, `ACCTG-1507` for RM-24867 capitalizable time.

### 11.6 Useful Grafana / Sentry pointers

- DO SLO dashboard: [`grafana.cfdata.org/d/b5f16a5a…`](https://grafana.cfdata.org/d/b5f16a5a-6713-425f-9cf5-c692f5830861/durable-objects-sli-slo).
- DO Customer Metrics: [`grafana.cfdata.org/d/r12Awpcnk`](https://grafana.cfdata.org/d/r12Awpcnk/durable-objects-customer-metrics).
- DO namespace ID lookup: [`grafana.cfdata.org/d/debe3z3ddczk0d`](https://grafana.cfdata.org/d/debe3z3ddczk0d/durable-objects-namespace-id-lookup).
- Sentry DO project: [`sentry10.cfdata.org/.../?project=246`](https://sentry10.cfdata.org/organizations/cloudflare/issues/?project=246).
- Runtime RM rapid board: [`jira.cfdata.org/secure/RapidBoard.jspa?rapidView=3366`](https://jira.cfdata.org/secure/RapidBoard.jspa?rapidView=3366).

---

## 12. Status

- All sections written incrementally. This dossier captures the state of the cfdata.org sources as of **2026-05-08**.
- Companion document (codebase session) at `/workspace/docs/research/cloudflare-dynamic-primitives.md` covers the workerd / public-API angle. Where the two diverge, internal sources here take precedence for *gating*, *limits*, *placement*, and *billing*; codebase session takes precedence for *runtime APIs* and *type signatures*.
- The end-goal "multi-processing library" design phase is *out of scope* for this dossier and should be opened separately, using §9 (invariant table) as the authoritative input.

---

## 13. Self-review log (rigour audit)

A sub-agent review was attempted but the agent provider was unavailable, so the author did the review pass directly. Spot-checks below; remaining limitations called out at the bottom.

### 13.1 Verified citations (re-fetched live)

| Claim | Source | Verified |
|---|---|---|
| `dynamicWorkersPerOwnerLimit @215 :UInt32 = 50` is the default per-owner-per-process loaded-worker cap. | `cloudflare/ew/edgeworker:src/edgeworker/server/config.capnp` line 692. | ✅ Re-fetched the file, confirmed field number `@215`, default `50`, and comment "Maximum number of concurrent dynamic worker isolates per owner per process." |
| `WorkerLoaderBinding { limits @0 :WorkerLimitsDef; maxLimits @1 :WorkerLimitsDef; }` — only two fields, no per-binding active-worker cap. | `pipeline.capnp:1575-1582`. | ✅ Confirmed via direct content fetch; "PROTIP: Set `limits.alwaysProcessSandbox` to `true` to require process sandboxing." comment confirmed at line 1579. |
| `RM-24867 Dynamic Worker Loader Open Beta` is Closed; `RM-27238 Dynamic Worker Loader GA` is In Progress; both team `Workers Runtime Platform`. | Jira. | ✅ Direct ticket fetch confirmed both. |
| `REVIEW-14667 Dynamic Isolates Alpha` In Progress, label `risk-high-risk`, Sprint 135; `REVIEW-17120 Dynamic Worker Loader GA` Needs Triage. | Jira. | ✅ Confirmed. |
| `EW-9655 Write dynamic isolate code to storage` Closed under epic RM-24867. | Jira. | ✅ Confirmed (epic link). |
| `EW-10547 Allow custom limits for dynamic workers` Closed; epic is RM-27238 (GA). | Jira. | ✅ Confirmed (epic link). Dossier doesn't claim the epic, so no edit needed. |
| `TMD-1000 Build dynamic workers pipeline (analysis, remediation)` Closed. | Jira. | ✅ Confirmed. |
| `FacetActorChannel` and `kj::HashMap<kj::String, kj::Rc<ActorHolderImpl>> facets` in `worker-set.c++:1270` and surrounding code. | GitLab repo blob search. | ✅ Multiple search hits in `worker-set.c++`. |
| `dynamic-worker.c++:1050` billing-attribution comment "This will cause invocations of dynamic workers to be aggregated with the caller's analytics and billing. This is not really right…" | GitLab repo blob search. | ✅ Search hit at exact line. |
| `EvictionReason { LRU, CONDEMNED, INACTIVE, DYNAMIC_WORKER }` enum in metrics.c++ line 1778. | GitLab repo blob search. | ✅ Confirmed. Also `DYNAMIC_WORKER_EVICTED, DYNAMIC_WORKER_BANNED` in metrics.h:300. |
| `dynamic-worker-owner-limit.ew-test` proves LRU eviction at `dynamicWorkersPerOwnerLimit = 2`. | GitLab repo file fetch. | ✅ Read full file; eviction semantics, MRU/LRU ordering, and "fresh isolate counter resets to 0" all confirmed. |
| `facets.storage-ew-test` — facet semantics with storage. | GitLab repo file fetch. | ✅ Read full file; `runFacets`, `testLaneNameEncoding`, `runDynamicFacet`, `testAbortFacetWithOpenRequest`, `useStorageRelay = true`, and the `TODO(facets):` comment about deleteAll all confirmed. |
| `routing-supervisor/AGENTS.md` describes 3-RPC interface model, 500ms session heartbeats to CockroachDB, Ketama consistent hashing. | GitLab repo file fetch. | ✅ Read full AGENTS.md; all claims accurate. |
| Dina Kozlov's "Powering Dispatcher with a Worker Loader" page id 1357511731. | Wiki fetch. | ✅ Fetched page; all quoted material matches verbatim. |
| Brendan's RFC: Dynamic Workers Observability page id 1365394169. | Wiki fetch. | ✅ Fetched page; the four core proposals, default `include_in_parent: true`, and per-binding `observability` block all confirmed. |
| Ketan's Abuse Detection page id 1304119456. | Wiki fetch. | ✅ Fetched page; the proposed `WorkerLoaderBinding { limits, blockedWorkers, blockedUserIds }` extension and the QS-key-fallback alternative both confirmed. |

### 13.2 Internal contradictions checked — none material

- §1 says facets "share the parent's *colo placement / global uniqueness* but not its V8 isolate"; §4 confirms via `Worker::Actor` per facet; §9.7 says "facets share the parent's location entirely" with no implication of CPU parallelism across machines. Consistent.
- §1 + §5 + §9.1 all agree on `dynamicWorkersPerOwnerLimit = 50`. Consistent.
- §5 says billing rolls up to caller; §9.4 same; §10.10 calls out the roadmap question. Consistent.
- §5.7 / §7.3 both point to `untrustedByOwner` as the same flag — consistent.

### 13.3 Coverage of the operator's eight asks

| Ask | Where addressed |
|---|---|
| Max facets per DO | §9.1 — "No hard cap in source." |
| Max active loaded Workers per binding | §9.1 — "No per-binding cap." |
| Max active loaded Workers per owner per process | §9.1 — Default 50 with source. |
| Isolate cache shape and TTL | §5.4, §9.2 — content-hash → scriptId reverse map; TTL = LRU eviction (no fixed TTL). |
| Hibernation triggers | §9.2 — ~10s inactivity + no pending alarms/timers/WebSockets; per-RootCart manager. |
| Eviction policy under memory pressure | §5.4, §9.2 — five eviction reasons enumerated. |
| Single-region vs cross-region routing for facets vs loaders | §9.3 — facets share parent placement; loaders are local-process; DO routing is transparently cross-region. |
| Billing units per primitive | §9.4 — full table. |
| Safety gating | §5.8, §9.5 — full table; abuse-pipeline integration, PSR status. |

All eight covered with sourced citations.

### 13.4 Known limitations / weak points

1. **Container DO §6 is intentionally light.** The cloudchamber capnp schemas were referenced but not fully fetched. Adequate for the multi-processing brief (Container DOs are not the primary substrate) but anyone designing on top of Container DOs should pull the actual `cloudchamber.capnp` and `container.capnp` files.
2. **No verified production override of `dynamicWorkersPerOwnerLimit`.** The schema default is 50; the saltstack-generated config file may set a different value in production. Open question listed in §10 #1. **Treat `50` as a planning lower bound; the real value may be higher in production.**
3. **Replica behaviour for loaded workers** is not separately verified. The dossier mentions `MIN_REPLICA_LOAD`/`MAX_REPLICA_LOAD` from `worker-set.c++` (per [Workers Runtime internals](https://wiki.cfdata.org/display/EW/Runtime+internals)) but does not confirm whether dynamic-worker isolates participate identically. Open question §10 #16.
4. **Cross-account binding (XAB) details are sketched.** §8.2 mentions the pattern from pipeline.capnp comments but does not pull a full XAB walkthrough; for the multi-processing design we likely don't need it (single-account assumption).
5. **EWC schema not pulled.** §7 references EWC's PostgreSQL store and ~40 REST routes (per Josh Wheeler's wiki) but doesn't enumerate them all. The wiki page contains the full list.
6. **Workers Runtime / Pages convergence (WPC) team activity not deeply mined.** Their epics may indicate runtime-level changes to facet/loader semantics; this would be the first follow-up if this dossier needs deepening.
7. **No live spot-check** against the codebase session's companion document — the codebase session was writing to `/workspace/docs/research/cloudflare-dynamic-primitives.md` but that path did not exist at the time this dossier was written, only the per-topic JSON files in `/workspace/research/0[1-9]-*.json` and `10-do-rpc.json`. Consistency assumed; if the codebase session diverges materially, a reconciliation pass will be needed.
8. **No facet-specific Jira epic was found.** This is anomalous — Facets is a major feature and would normally have an RM epic. Likely either named differently (maybe under DO/STOR), or implementation is incremental enough that there's no umbrella ticket. Worth a follow-up ping.

### 13.5 Edits applied during review

- Fixed unbalanced markdown formatting at the start of §9.6 (`**\`I/O object**` → `**I/O object**`).
- Flipped status banner from "WORK IN PROGRESS" to "DRAFT — REVIEWED" with pointer to this section.
