# PROD-RESET-RESEARCH — R4: Smart Placement & Multi-Region (W12)

Research scope: read-replica consistency model; Smart Placement
behaviour for the supervisor DO; whether deliberate cross-region
parallelism (instead of latency hiding) is achievable; and how the
SRS (Storage Relay Service) layer underpinning SQLite-in-DO works.

---

## R4.1 Durable Objects are SINGLE-LOCATION by design

✓ CONFIRMED ([What are DOs](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)):

> Each Durable Object has a globally-unique name, which allows you
> to send requests to a specific object from anywhere in the world.

[DO Storage Options](https://developers.cloudflare.com/workers/platform/storage-options/#durable-objects):

> Global Uniqueness guarantees that there will be a single instance
> of a Durable Object class with a given ID running at once, across
> the world. Requests for a Durable Object ID are routed by the
> Workers runtime to the Cloudflare data center that owns the
> Durable Object.

So a single `NimbusSession` DO instance lives in ONE data center.
All requests addressed to that DO are forwarded to that location. No
matter where the user is, all their session WS messages and HTTP
fetches converge on one machine.

[DO Best Practices — Rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/):

> **Use Durable Objects for stateful coordination, not stateless
> request handling**
>
> Workers are stateless functions: each request may run on a
> different instance, in a different location, with no shared memory
> between requests. Durable Objects are stateful compute: each
> instance has a unique identity, runs in a single location, and
> maintains state across requests.

**For Nimbus**: parallelism IS achievable, but NOT by spreading work
across replicas of the same DO. We must spread work across DIFFERENT
DOs (different IDs, possibly different classes). R4.4 covers W12
read replicas, which are a SECONDARY mechanism for distributing
READ traffic — not for parallelizing compute.

---

## R4.2 Location hints — best-effort, set on first `get()`

✓ CONFIRMED ([DO data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)):

> Durable Objects do not currently change locations after they are
> created. By default, a Durable Object is instantiated in a data
> center close to where the initial `get()` request is made. This
> may not be in the same data center that the `get()` request is
> made from, but in most cases, it will be in close proximity.
>
> Hints are a best effort and not a guarantee. Unlike with
> jurisdictions, Durable Objects will not necessarily be
> instantiated in the hinted location, but instead instantiated in
> a data center selected to minimize latency from the hinted
> location.

> Dynamic relocation of existing Durable Objects is planned for the
> future.

Supported hints: `wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`,
`oc`, `afr`, `me`. Plus jurisdiction-restricted: `eu`, `fedramp`.

**For Nimbus**: location hints are useful for "place this user's
session DO near them" but DON'T enable parallelism. They affect
WHERE the single instance lives, not how many instances exist.

---

## R4.3 Smart Placement — affects fetch handlers, NOT RPC

✓ CONFIRMED ([Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/)):

> Smart Placement automatically analyzes your Worker's traffic
> patterns and places it in an optimal location.

> ### Review limitations
>
> * Smart Placement only affects the execution of fetch event
>   handlers. **It does not affect RPC methods or named entrypoints.**

[Workers RPC limitations](https://developers.cloudflare.com/workers/runtime-apis/rpc/):

> Smart Placement is currently ignored when making RPC calls. If
> Smart Placement is enabled for Worker A, and Worker B declares a
> Service Binding to it, when Worker B calls Worker A via RPC,
> Worker A will run locally, on the same machine.

✓ CONFIRMED Nimbus uses this correctly:
- `wrangler.jsonc:34` sets `"placement": { "mode": "smart" }`.
- Nimbus's wrangler.jsonc comment at `wrangler.jsonc:18-31`:
  > "Smart Placement is 'ignored when making RPC calls'... so RPC
  > into the DO is unchanged — but the gateway's own fetch handler
  > gets pinned near the DO's region, which removes the cross-region
  > gateway⇄DO RTT for warm tenants."

So Smart Placement gives Nimbus a latency win for the GATEWAY
Worker (the entry-point fetch handler in `src/index.ts`), but
doesn't move the DO itself. The DO stays put.

**For plan §3 / §4**: Smart Placement is NOT a parallelism mechanism.
It's a latency-hiding mechanism. Plan §3 should not propose using
Smart Placement to achieve parallelism. ✓ Plan §3 doesn't claim
this; just confirming.

---

## R4.4 W12 read replicas — Nimbus's existing implementation

✓ CONFIRMED — referenced in `wrangler.jsonc:18-31` as the W12 hotfix
and in `src/replica-routing.ts` and `src/nimbus-session-replica.ts`.

The user's prompt asked about read-replica consistency. The DO docs
DO show a `replica_routing` config and read-replication for SQLite-
backed DOs is documented for D1 ([D1 Read Replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)) but NOT
explicitly documented as available for arbitrary DO classes in the
public docs. ⚠ UNVERIFIED whether DO read replication is GA for
custom DO classes or still beta / Nimbus-experimental.

Nimbus's `src/replica-routing.ts:98-99` graceful-degrades when the
flag is absent — so we know the codebase TREATS this as flaky /
not-always-available, which is consistent with "experimental".

[D1 read replication consistency model](https://developers.cloudflare.com/d1/best-practices/read-replication/):

> D1 asynchronously replicates changes from the primary database
> instance to all read replicas. This means that at any given time,
> a read replica may be arbitrarily out of date. The time it takes
> for the latest committed data in the primary database instance to
> be replicated to the read replica is known as the replica lag.

> All write queries are still forwarded to the primary database
> instance. Read replication only improves the response time for
> read query requests.

> When using D1 Sessions API, your queries obtain bookmarks which
> allows the read replica to only serve sequentially consistent
> data.

So even WITH read replication enabled:
- Writes always go to the primary (one location).
- Reads CAN go to a nearby replica IF the application accepts
  sequential consistency (not strong consistency).
- Sessions API + bookmarks bridge this gap.

**For Nimbus's W12**: read replicas serve SQL reads from regions
near the user. Useful for `/api/_diag/memory` polls (sequential
consistency is fine — the diag response doesn't need to be
strongly consistent with the most recent write). Not useful for
write-heavy workflows like npm install.

❗ ARCHITECTURE-IMPACTING — read replicas DO NOT give us parallel
WRITE capacity. The 128 MB memory pressure on the primary DO is
NOT mitigated by replicas. They just spread READ load.

---

## R4.5 SRS — the underpinning of SQLite-in-DO

⚠ UNVERIFIED whether the implementation details still match (the
blog is from 2024-09-26, which is older than our compat date of
2026-04-01) but architectural shape should be stable.

[Zero-latency SQLite storage in every Durable Object — blog post 2024-09-26](https://blog.cloudflare.com/sqlite-in-durable-objects/):

> **Storage Relay Service (SRS)** ... is based on a simple idea:
>
> Local disk is fast and randomly-accessible, but expensive and
> prone to disk failures. Object storage (like R2) is cheap and
> durable, but much slower than local disk and not designed for
> database-like access patterns.

Mechanism summary:
1. Every DO has a primary host machine running SQLite + the DO's
   in-memory state.
2. SQLite is configured in WAL mode. SRS hooks SQLite's VFS to
   intercept WAL writes.
3. Writes are batched (10 s OR 16 MiB whichever first) and uploaded
   to R2 as object-storage logs.
4. **Synchronous write confirmation**: SRS forwards every commit to
   5 follower machines across the network. Once 3+ followers
   acknowledge, the write is confirmed (via the **Output Gate**
   pattern — "When the DO responds to the client, the response is
   blocked by the Output Gate until all storage writes relevant to
   the response have been confirmed").
5. If the primary fails, followers can take over.

This explains why write commits in DOs are fast despite being
durable. Two implications for Nimbus:

### R4.5.1 Output Gate is invisible but real

Nimbus's WS message handler returns a response that goes through the
Output Gate. If we issue SQL writes immediately before responding,
those writes are confirmed by the gate before the response is sent.
This is the mechanism by which `ctx.storage.sql.exec(...)` is
synchronous AND durable. **Track B' designs that persist
shell-cwd / scrollback / etc. on every prompt cycle benefit from
this** — the per-prompt cycle's SQL write is durable by the time the
next user keystroke arrives.

### R4.5.2 16 MiB batch upload limit suggests bulk-write strategy

SRS batches writes up to 16 MiB OR 10 seconds. Our SqliteVFS at
`src/sqlite-vfs.ts` already does its own batching above SRS. Stacking
two batchers can be wasteful but isn't incorrect.

For Track B' we should NOT need to optimise SRS batching — it's
opaque platform behavior. We should write SQL state changes when
they happen and trust SRS.

---

## R4.6 Multi-region parallelism — what's actually achievable

❗ ARCHITECTURE-IMPACTING for plan §3.

Actual mechanisms for cross-region parallelism on Cloudflare:
1. **Distinct DOs (distinct IDs and/or classes)** in distinct regions
   via location hints. Each can run independently in its own data
   center. Each is its own 128 MB envelope. ❗ But cross-DO RPC
   between distinct-region DOs incurs cross-region RTT (Smart
   Placement is ignored for RPC per R4.3).
2. **Dynamic Workers within a single supervisor DO** — these run on
   the same machine as the supervisor (per the SRS principle of
   "code runs where data lives"). Same-region. The 128 MB caps are
   per-isolate, but the runtime process is shared.
3. **Service-bound stateless Workers** — these CAN spread across
   regions because they're stateless. But they have no persistent
   state to coordinate around.

For Nimbus, the relevant choice is between (1) and (2):

(1) Distinct DOs:
- Pro: each DO has its own 128 MB envelope (R1.1 caveat: same-class
  peer DOs MAY co-tenant; cross-class is more likely separated).
- Pro: each DO can be in a different region, parallelism is
  geographic.
- Con: cross-DO RPC between regions is slow (cross-region RTT).
  For a tightly-coupled npm-install workload this is bad — the
  supervisor would wait many ms per RPC call.
- Con: Output Gate is per-DO. Coordinating consistent state across
  multiple DOs requires application-level protocols (CRDTs, fan-in
  merge, etc.).

(2) Dynamic Workers in same DO:
- Pro: zero RPC latency (in-process Cap'n Proto).
- Pro: each isolate has own 128 MB.
- Con: all isolates share the host machine resources. No geographic
  parallelism (all in same data center).
- Con: empirical ~5-6 concurrent isolate ceiling per R2.3.

**Verdict for Nimbus**: (2) is the right answer for npm install /
pre-bundle / vite. They're tightly-coupled compute that benefits
from low-latency RPC, and per-isolate 128 MB is enough headroom.

(1) is the right answer for "this user has multiple SESSIONS"
(distinct user sessions). Each session is its own DO, naturally
isolated, and the user is in one location anyway.

---

## R4.7 RPC sessions and billing semantics

✓ CONFIRMED ([DO Pricing footnote 1](https://developers.cloudflare.com/durable-objects/platform/pricing/)):

> Each RPC session is billed as one request to your Durable Object.
> Every RPC method call on a Durable Objects stub is its own RPC
> session and therefore a single billed request.
>
> RPC method calls can return objects (stubs) extending RpcTarget
> and invoke calls on those stubs. Subsequent calls on the returned
> stub are part of the same RPC session and are not billed as
> separate requests.

So returning a stub from an RPC method gives "free" subsequent
calls on that stub (same session). This is relevant for Nimbus's
chained RPC patterns (e.g. SupervisorRPC.getEsbuildWasm() returning
something, or the inner-do-registry returning DO stubs).

For Track A'.2 (slice streaming via ReadableStream over RPC):
returning a `ReadableStream` from a method KEEPS the session open
while the stream is being consumed. Pulling 10 MB worth of bytes
through a stream costs ONE billed request, not N requests. ✓

For Track B' (state in SQL): each `ctx.storage.sql.exec(...)` is
not an RPC call — it's a synchronous in-process library call. Zero
RPC billing impact.

---

## R4.8 R4 summary — what changes for plan §3

| Claim from current plan §3 / current code | R4 verdict |
|---|---|
| "spread work across read replicas" | ❗ Read replicas serve READ traffic only. Not a write-parallelism mechanism. ✓ Useful for /api/_diag/* polls (Sessions API + bookmarks for sequential consistency). |
| "Smart Placement gives parallel compute" | ❗ FALSE — Smart Placement is single-location latency hiding for fetch handlers, not parallelism. RPC ignores it. |
| "use distinct DOs for parallel compute" | ✓ Valid for cross-class / cross-region but cross-DO RPC RTT is high. Best for stateful coordination across logically-separate entities. |
| "use dynamic Workers in same DO for parallel compute" | ✓ Valid; ~5-6 concurrent isolates ceiling; zero RPC latency. THE RIGHT ANSWER for npm install + pre-bundle. |
| "writes need cross-region replication" | ❌ Writes always serialize at the primary; SRS handles durability transparently. |
| "Output Gate auto-confirms writes" | ✓ CONFIRMED — Track B' SQL writes are durable by the time the next user message arrives. |

Plan §3 implications:
- Plan §3 already (correctly) targets Track A' at moving heavy work
  to dynamic Workers in the same DO. R4 confirms this is the right
  shape.
- Plan §3 should NOT propose multi-region parallelism for npm
  install. Cross-region RTT kills it.
- Plan §3's Track B' (SQL-backed state) gets the Output Gate for
  free. No need to design "write confirm" logic.
- The `/api/_diag/memory` poll endpoint COULD be served from a read
  replica using the W12 path. Latency win for diag polls. But this
  is a follow-up optimization, not a Bug C fix.

---

## R4.9 Open follow-ups (carry to R7 synthesis)

⚠ UNVERIFIED:
- Is DO read replication GA for custom DO classes or still
  beta / experimental? Nimbus treats it as flaky.
- Does the 30-second waitUntil cap apply to DO requests the same
  way as Worker fetch requests? (Public docs imply yes — the cap
  is at the request level — but DO requests are unlimited in wall
  time per R1.8 so the interaction is unclear.)

These shouldn't gate plan §3 commits but should be resolved
before any Track A' or B' design that depends on either.
