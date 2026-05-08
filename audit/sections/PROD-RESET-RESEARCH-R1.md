# PROD-RESET-RESEARCH — R1: Durable Objects memory model

Research scope: confirm the per-DO 128 MB cap, isolate-sharing semantics
between peer DOs, the eviction / hibernation lifecycle, SQLite memory
accounting, and what survives hibernation vs. cold restart.

Citation discipline: `✓ CONFIRMED`, `❗ ARCHITECTURE-IMPACTING`,
`⚠ UNVERIFIED`. Everything below cites a public Cloudflare docs URL
or a workerd / nimbus source-code line.

---

## R1.1 The 128 MB cap is **per-isolate, not per-DO**

❗ ARCHITECTURE-IMPACTING — this contradicts the working assumption in
`src/npm-installer.ts:795`: "own 128 MB budget on edge".

**Primary citation** ([Workers — Limits, Memory](https://developers.cloudflare.com/workers/platform/limits/#memory)):

> Each isolate can consume up to 128 MB of memory, including the
> JavaScript heap and WebAssembly allocations. **This limit is
> per-isolate, not per-invocation.** A single isolate can handle
> many concurrent requests.

**Reinforcing citation** ([Durable Objects — Pricing, footnote 5](https://developers.cloudflare.com/durable-objects/platform/pricing/)):

> If your account creates many instances of a single Durable Object
> class, **Durable Objects may run in the same isolate on the same
> physical machine and share the 128 MB of memory**. These Durable
> Objects are still billed as if they are allocated a full 128 MB
> of memory.

**Implication for Nimbus**: spawning N peer DOs of the same class
(e.g. N session DOs, or N `inner-do-registry`-style helper DOs) does
NOT give us N × 128 MB. They CAN co-tenant. The cohort that ends up
in one isolate compete for the same 128 MB. This is the SAME failure
mode as the supervisor-isolate problem.

**Reinforcing citation in our own code base** at
`src/npm-installer.ts:1402-1409` (already-known prior art):

> "The Mini-PRD 'DO shared isolate issues' documents resets at <128
> MiB on shared isolates: multiple DOs from the same script can land
> in the same V8 isolate, sharing its 128 MiB cap."

---

## R1.2 Isolate eviction triggers — three distinct paths

✓ CONFIRMED at `src/oom-classify.ts:14-99` already. The public docs
expand the trigger list:

### R1.2.1 Memory cap exceeded

[Workers — Limits, Memory](https://developers.cloudflare.com/workers/platform/limits/#memory):

> When an isolate exceeds 128 MB, the Workers runtime lets in-flight
> requests complete and creates a new isolate for subsequent
> requests. During extremely high load, the runtime may cancel
> some incoming requests to maintain stability.

[Error 1102 docs](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1102/):

> A Cloudflare Worker exceeds the 128 MB memory limit. This is a
> per-isolate limit, an isolate may be handling multiple requests
> concurrently.

### R1.2.2 CPU-between-requests eviction (NEW finding)

❗ ARCHITECTURE-IMPACTING — this is a third, distinct DO eviction
trigger NOT in our current oom-classify taxonomy.

[Durable Objects — Limits, footnote 4](https://developers.cloudflare.com/durable-objects/platform/limits/):

> Each incoming HTTP request or WebSocket message resets the
> remaining available CPU time to 30 seconds. ... If you consume
> more than 30 seconds of compute between incoming network
> requests, **there is a heightened chance that the individual
> Durable Object is evicted and reset.**

This means: a long-running CPU burst with no inbound network
activity (e.g. our supervisor running pre-bundle wholly inside a
single setTimeout / waitUntil chain with no new WS message arriving)
can trigger eviction WITHOUT hitting the memory cap. The user
reported "session became progressively laggy → DO reset" — a 30-s
CPU burst without WS keepalive matches.

**Action for Nimbus**: every long-running CPU burst on the supervisor
must be broken into chunks separated by an awaited inbound boundary
(WS message, fetch, alarm, timer pulse). Today's pre-bundle slot
loop at `src/npm-installer.ts:1517-1750` runs slot-after-slot
without an explicit "yield to inbound" signal between slots.

### R1.2.3 Hibernation (intentional + reversible)

✓ CONFIRMED ([DO Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)):

> After 10 seconds of no incoming request or event, and all the
> [hibernation conditions] satisfied, the Durable Object will
> transition into the **hibernated** state.
>
> When hibernated, the in-memory state is discarded, so ensure you
> persist all important information in the Durable Object's storage.
>
> In case of an incoming request or event while in the **hibernated**
> state, the **constructor() will run again**, and the Durable Object
> will transition to the active, in-memory state and execute the
> invoked function.

Hibernation conditions ALL must be true:

> * No setTimeout/setInterval scheduled callbacks are set
> * No in-progress awaited fetch() exists
> * No WebSocket standard API is used
> * No request/event is still being processed

So a DO with an active vite dev server and WebSocket terminal stays
in **idle, in-memory, non-hibernateable** state — does NOT hibernate
but ALSO incurs duration billing. Cite [DO Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/):

> If any of the above conditions is false, the Durable Object remains
> in-memory, in the **idle, in-memory, non-hibernateable** state.

### R1.2.4 70-140 s inactivity → full eviction

✓ CONFIRMED ([DO Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)):

> While in the **idle, in-memory, non-hibernateable** state, **after
> 70-140 seconds of inactivity** (no incoming requests or events),
> the Durable Object will be evicted entirely from memory and
> potentially from the Cloudflare host and transition to the
> **inactive** state.

For an active Nimbus session (vite dev server running), this state
should NOT trigger. But if vite is killed and the user idles,
70-140 s later the DO evicts → next WS message reconstructs from
scratch.

### R1.2.5 Uncaught exceptions

✓ CONFIRMED ([DO Best Practices — Rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)):

> If an uncaught exception occurs in your Durable Object, the runtime
> may terminate the instance. Any in-memory state will be lost, but
> SQLite storage remains intact.

Already documented in our code at `src/npm-installer.ts:1539-1544`.

---

## R1.3 What survives across each transition

| Transition | Constructor re-runs? | In-memory state | SQLite storage | WS clients (hibernation API) |
|---|---|---|---|---|
| Active → idle (in-memory) | NO | preserved | preserved | preserved |
| Active → hibernated | YES (on next event) | **DISCARDED** | preserved | **preserved** (still attached to edge) |
| Active → inactive (full evict) | YES (on next event) | **DISCARDED** | preserved | preserved IF using hibernation API |
| Active → terminated (uncaught throw) | YES (on next event) | **DISCARDED** | preserved | dropped |
| Active → memory-cap reset | YES (on next event) | **DISCARDED** | preserved | dropped |
| Active → CPU-between-requests reset | YES (on next event) | **DISCARDED** | preserved | dropped |

Citations:

- [DO Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) "When hibernated, the in-memory state is discarded"
- [Hibernation WebSocket API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) "When a Durable Object receives no events ... for a short period, it is evicted from memory. During hibernation: WebSocket clients remain connected to the Cloudflare network; In-memory state is reset; When an event arrives, the Durable Object is re-initialized and its constructor runs"
- Best-practices [Rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) "Always persist critical state to storage before performing operations that might fail"

❗ ARCHITECTURE-IMPACTING — Nimbus today persists the OOM ring,
process logs, and W12 replica bookmark to SQL, but **does NOT
persist**: shell cwd, kernel mount tree, env vars, terminal scrollback,
the live npmInstaller / facetManager / esbuildService / viteDevServer
configurations beyond the single `vite-config` blob lazily rehydrated
at `src/nimbus-session-routes.ts:547`. On hibernation/eviction these
are silently re-built from defaults — which is exactly the user-
visible Bug C symptom.

---

## R1.4 SQLite memory accounting against the 128 MB cap

⚠ UNVERIFIED but highly suggestive. The public docs do NOT explicitly
state whether SQLite's in-memory cache (page cache + WAL) counts
against the 128 MB DO heap cap or is accounted separately.

**Indirect citation** ([In-memory state](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/)):

> The Durable Object's storage has a built-in in-memory cache of its
> own. If you use get() to retrieve a value that was read or written
> recently, the result will be instantly returned from cache.

This says "in-memory cache" but does not place it in vs. out of the
128 MB envelope. **For Nimbus this matters** — our SqliteVFS holds a
33 MiB LRU on top of whatever SQLite itself caches
(`src/sqlite-vfs.ts:127-129` "drop the cap to ~8 MiB and free heap
headroom"). If SQLite's own page cache is INSIDE the 128 MB, the
LRU is double-pressure. If it's OUTSIDE, the LRU is the only
heap-pressure source.

To resolve this, R1.4 needs either:
1. workerd source code reference for SQLite VFS bridging — would
   show whether pages live in V8 heap or in C++-allocated memory
   outside the V8 isolate budget.
2. Empirical measurement post-Bug-B-fix.

Both are out of scope for this dispatch. Mark this as a research
followup; do NOT lock architectural decisions on the assumption it's
in or out of the 128 MB until resolved.

---

## R1.5 Cross-DO RPC and isolate boundaries

✓ CONFIRMED for the basic claim: each DO class can be RPC'd by other
DOs / Workers via stubs. Each DO has its own private storage. But
"each DO has its own 128 MB" is FALSE per R1.1.

**Source-code reference** in our own wrangler.jsonc lines 1-30 cites
the W12 hotfix for cross-DO RPC: `experimental` flag and
`replica_routing` are needed for chained service-stub returns from
WorkerEntrypoints. This is the Smart Placement / read-replica path
covered in R4.

**For Nimbus today**: if I spawn helper DOs of a NEW class (different
class name from `NimbusSession`), the docs imply a different cohort
→ likely different isolates. The pricing footnote scopes its
isolate-sharing claim to "many instances of **a single Durable
Object class**". So a *different-class* DO MAY get its own isolate,
but ⚠ UNVERIFIED whether the platform actively places different
classes in different isolates or just "may" (i.e. it's permitted but
not guaranteed). Architecturally, dispatching work to a different
DO class is the platform's intended escape hatch for "this work
needs its own 128 MB ceiling".

---

## R1.6 Hibernation API (WS) coverage

✓ CONFIRMED ([Hibernation WebSocket API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)):

> WebSocket clients remain connected to the Cloudflare network /
> In-memory state is reset / When an event arrives, the Durable
> Object is re-initialized and its constructor runs.
>
> To restore state after hibernation, use serializeAttachment and
> deserializeAttachment to persist data with each WebSocket
> connection.

[Best Practices — Use Durable Objects for WebSockets](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/):

> Use this.ctx.acceptWebSocket() instead of ws.accept() to enable
> hibernation. Use setWebSocketAutoResponse for ping/pong heartbeats
> that do not wake the object.

✓ Confirmed Nimbus implements this correctly:
- `ctx.acceptWebSocket(server)` at `src/nimbus-session-routes.ts:106`
- `setWebSocketAutoResponse` at `src/ws-hibernation-config.ts:77-88`
- `setHibernatableWebSocketEventTimeout(5000)` at `src/ws-hibernation-config.ts:94-97`
- attachment serialization at `src/nimbus-session-routes.ts:113`

The 5-s `setHibernatableWebSocketEventTimeout` (a hard workerd cap on
hibernatable WS-event handler runtime — ref retro §S-2 wallTime
cluster) is consistent with R1.2.2 — workerd is structurally biased
against long synchronous handlers.

---

## R1.7 Subrequest + connection limits

✓ CONFIRMED ([Workers — Limits, Subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests)):

> Workers Paid: 10,000 subrequests per invocation (configurable up
> to 10M via `limits.subrequests` in wrangler config).

Pre-Feb-2026 the limit was 1000; we are well above that. NOT a
trigger for Bug C unless ONE invocation makes 10K+ subrequests.

✓ CONFIRMED ([Workers — Limits, Simultaneous open connections](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections)):

> Each Worker invocation can have up to **six connections**
> simultaneously waiting for response headers.

❗ Possibly architecture-impacting for npm install — fanning out 15
concurrent tarball fetches from a single supervisor invocation hits
this limit; fetches stack 6-at-a-time. We MAY already implement
6-fan-out via the resolver-facet path; verify.

---

## R1.8 Wall time

✓ CONFIRMED ([Workers Limits — Wall time](https://developers.cloudflare.com/workers/platform/limits/#wall-time-limits-by-invocation-type)):

> Durable Objects (RPC / HTTP): Unlimited (No hard limit while the
> caller stays connected to the Durable Object.)
> Durable Object alarm handlers: 15 minutes

So a long-lived WS message handler is unlimited in WALL time but
strictly bounded in CPU (R1.2.2 — 30 s between requests) and
memory (R1.1 — 128 MB shared isolate envelope).

The 5-s `setHibernatableWebSocketEventTimeout` from
`src/ws-hibernation-config.ts:38` is therefore a **stricter Nimbus
invariant**, not a platform limit. Nimbus could relax it to (say)
20 s and still be inside the platform 30-s CPU cap — but the
wallTime histogram from `audit/probes/prod-reset-investigation/
wallTime-histogram.txt` shows our existing 5-s cap IS being hit, so
relaxing isn't safe; the right answer is "don't have any WS handler
that approaches 5 s".

---

## R1.9 Storage — capacity, schema, billing

✓ CONFIRMED ([DO — Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)):

| Property | Value |
|---|---|
| Storage per Durable Object | 10 GB |
| Maximum string/BLOB or table row size | 2 MB |
| Maximum SQL statement length | 100 KB |
| WebSocket message size (received) | 32 MiB |
| Maximum bound parameters per query | 100 |

The 2 MB row cap matters for B' designs that persist scrollback /
shell history — must chunk. The 32 MiB WebSocket message cap matters
for any future "stream a build artifact through the WS" idea.

For Nimbus today: 10 GB / DO ≫ user content. Storage capacity is
NOT the limiting factor — heap is.

---

## R1.10 R1 summary — what changes for plan §3

| Claim from current plan §3 / current code | R1 verdict |
|---|---|
| "supervisor isolate has its own 128 MB" | **❗ FALSE per R1.1** — the cap is per-isolate, the supervisor and its peer DOs MAY co-tenant |
| "OOM is the trigger for Bug C" | ✓ CONSISTENT but R1.2.2 adds a SECOND distinct trigger (CPU-between-requests > 30 s) we did not previously consider |
| "all critical state in SQL" | ❗ Current code persists OOM ring + W9 process logs + vite-config but NOT cwd / kernel / mounts / env / scrollback (R1.3) |
| "supervisor heap visible via process.memoryUsage()" | ✓ CONFIRMED FALSE in DO context — must use deterministic estimator (Bug B) |
| "32 MiB WS message cap" | ✓ CONFIRMED — relevant for any new bulk-message designs |
| "DO RPC gives independent 128 MB" | ❗ FALSE for same-class peer DOs (R1.1); UNVERIFIED for cross-class |
| "5 s hibernatable event timeout" | ✓ CONFIRMED self-imposed (not a platform limit) but appropriate given R1.2.2 |

R1 has substantially **strengthened** the case for plan §3's Track A'
(memory containment) and Track B' (state in SQL) — both directly
address findings here. The new finding R1.2.2 (CPU-between-requests)
adds a **fourth** Track A' sub-change: yield to the event loop with
an actual inbound boundary on long-running supervisor work, not just
microtasks.

R1 does NOT support plan §3's implicit assumption that "spawning a
peer DO automatically gets us a fresh 128 MB" — that's only true for
**cross-class** spawning, and even then is "may" not "guaranteed".
The architecturally robust path is:

1. Move heavy work to a **different class** of DO or to a Worker
   Loader-spawned dynamic Worker (R2) — to maximize the chance of
   isolate isolation.
2. Make the supervisor's resident set so small that even when it
   co-tenants in a shared isolate it doesn't tip the cohort.

Both are already in plan §3; R1 just confirms they're the right
shapes.
