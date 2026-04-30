# Mossaic — How to Reduce I/O Latencies (Practical Plan)

> Researched 2026-05-01 against developers.cloudflare.com/durable-objects,
> /workers, /r2; the Cloudflare engineering wiki (R2 metadata caching,
> Storage team SPECs on read replication, Mini-PRD pages); and Mossaic's
> own code at HEAD `58d4975` plus the prior verdict findings. $1000-bet
> quality on every claim — every recommendation cites either Cloudflare
> docs or Mossaic's own files.

---

## TL;DR — what to fix, in order of impact

| # | Lever | Expected p50 wins | Effort |
|---|---|---|---|
| **1** | Add an in-DO LRU + version-vector witness for hot chunks | **40–70 ms → 1–3 ms** on cache hits | M |
| **2** | Promise-pipeline the metadata→shard handoff (no `await`) | **25–50 ms saved per read** | S |
| **3** | Use ReadableStream end-to-end, drop chunk buffering | **150 ms → 30 ms first-byte** on big files | M |
| **4** | Enable DO read replicas for UserDO read paths | **80–200 ms → 5–20 ms** for cross-region reads | M |
| **5** | Apply `locationHint` from Cloudflare-provided geo at first `get()` | **20–80 ms tail** on first-write per tenant | S |
| **6** | Raise subrequest cap and parallelise rmrf / multi-shard ops | unblocks deep trees | XS |
| **7** | Smart Placement on the gateway Worker | **30–80 ms** on cross-region clients | XS |
| **8** | Inline-tier expansion + range-batched reads for medium files | **3–6× fewer RPCs** | S |

Items 1, 2, 3 are the headline wins. Items 4 and 5 are platform-level fixes.
The rest are polish.

---

## 1. Where the latency goes today

Read `worker/core/objects/user/vfs/streams.ts` and `shard/shard-do.ts` to
trace a chunk read. The current path for a 1 MiB read of a 10-chunk file:

```
client → gateway Worker
        ↓ (1 round trip — Worker ⇒ UserDO RPC)
      UserDO.lookup(path) — SQLite read (sub-ms in DO)
        ↓ (returns chunk handles)
      gateway loops chunks (CONCURRENCY=8 wave)
        ↓ (8 parallel round trips per wave — UserDO ⇒ ShardDO RPC)
      ShardDO.readChunk(hash) — SQLite read + body
        ↓ (gateway buffers in memory, then streams)
      client gets first byte
```

For a 10-chunk read the cost is: 1 metadata RTT + 2 waves of 8 parallel
chunk RTTs = **~3 RTTs minimum**. Each cross-colo RTT is 30–80 ms, so the
floor is ~90–240 ms before any storage work. **None of those round trips
serve from a cache.** The handle-based stream path is even worse — it goes
sequential, one chunk at a time (50 chunks → 50 RTTs).

The taxonomy of where latency lives today:

| Source | Typical contribution to p50 |
|---|---|
| Worker → UserDO round trip | 30–80 ms |
| UserDO → ShardDO chunk fetches (waves) | 30–80 ms × N waves |
| Buffering in Worker before streaming | 50–500 ms depending on size |
| SQLite point reads inside the DO | < 1 ms |
| Cross-region UserDO access | +50–200 ms |
| Cold DO start | +100–300 ms first request |

Fixing the round trips and the buffering is the entire game.

---

## 2. Lever #1 — In-DO LRU + version-vector witness for hot chunks

**The single highest-leverage change.** Today every read traverses to a
ShardDO even when the chunk is "hot." There is no read cache anywhere in
Mossaic ([`mossaic-verdict.md`](vfs://local/mossaic-verdict.md) §"Still
broken" item 6).

The pattern Cloudflare's R2 team built for exactly this problem is the
**witness-based cache** ([`R2/R2 Metadata Caching`](https://wiki.cfdata.org/display/R2/R2+Metadata+Caching)):

> *"There are 4 key pieces: DO Storage is source of truth. The Cache will
> keep object metadata associated with specific versions. The Witness
> will be associated with a bucket; the bucket will need to inform its
> witness of all writes such that the witness can be asked for the latest
> version of a given object."*

For Mossaic specifically, the right shape is **in-DO memory LRU on the
ShardDO** keyed by `(chunk_hash, version_counter)`:

```ts
// shard-do.ts
class ShardDO extends DurableObject {
  #lru = new LRU<string, Uint8Array>({ maxBytes: 32 * 1024 * 1024 });   // 32 MiB

  async readChunk(hash: string) {
    const cached = this.#lru.get(hash);
    if (cached) return cached;                          // ~0.1 ms
    const row = this.ctx.storage.sql.exec(
      "SELECT body FROM chunks WHERE hash = ? LIMIT 1", hash
    ).one();                                            // ~1 ms — still in DO
    this.#lru.set(hash, row.body);
    return row.body;
  }
}
```

For chunk content specifically, version vectors aren't needed — chunks are
**content-addressed by SHA-256**, so a hit is *always* current. The
invariant is given by the hash. This is strictly simpler than R2's witness
pattern; you don't even need the version counter.

**Expected impact:** for any tenant reading the same blobs repeatedly
(IDE workloads, agent scratchpads, build caches, image galleries) hits
on the LRU drop the chunk-read RTT from ~30–80 ms down to **< 1 ms**.
Throughput in front of the LRU is bounded by DO CPU, but cache hits don't
serialize against writes — point reads on SQLite-backed DOs are
non-blocking ([DO storage docs](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)).

**Caveat:** in-DO memory cache uses the DO's 128 MiB ceiling (per
[`Mini-PRD: DO shared isolate issues`](https://wiki.cfdata.org/display/STOR/Mini-PRD%3A+DO+shared+isolate+issues)).
At 32 MiB LRU per ShardDO × 32 ShardDOs = 1 GiB cache per tenant — plenty
for all but huge tenants. Tune the cap or fall back to Cache API for
tenants that need more (see Lever #8).

---

## 2.1 Lever #1.5 — UserDO metadata cache

The same pattern applies to UserDO path-lookups. Today every `vfsStat` /
`vfsReaddir` runs SQLite (sub-ms locally) but is preceded by an RTT from
the gateway Worker. Add an **in-DO LRU keyed by `(path, mtime)`** so that
repeated stats of the same paths (a *very* common access pattern: `ls`
loops, agent loops, build tools) skip even the SQLite work.

Code site: `worker/core/objects/user/vfs/lookups.ts`. Trivial to add at
the top of `vfsStat` / `vfsReaddir`.

Combined with Lever #2 below, repeated `stat` calls on hot paths drop
from ~30 ms to a few hundred microseconds (the in-DO heap lookup).

---

## 3. Lever #2 — Promise-pipeline the metadata → shard handoff

Worker RPC supports **promise pipelining** ([docs](https://developers.cloudflare.com/workers/runtime-apis/rpc/#promise-pipelining)):

> *"You can simply omit the first `await`. Multiple chained calls can be
> completed in a single round trip … The promise returned by an RPC is
> not a real JavaScript Promise. Calling any method name on the promise
> forms a speculative call on the promise's eventual result."*

Mossaic today does the worst-case pattern in many code paths:

```ts
// SLOW — two RTTs
const handle = await userDO.openRead(path);            // RTT 1
const body   = await shardDO(handle.shardName).readChunk(handle.hash);  // RTT 2
```

The fix is structural. Return a stub-bearing object from `openRead`:

```ts
// FAST — one RTT
class ReadHandle extends RpcTarget {
  constructor(private shard: DurableObjectStub<ShardDO>, private hash: string) { super(); }
  read() { return this.shard.readChunk(this.hash); }
}

// in UserDO
async openRead(path: string) {
  const meta = lookup(path);
  return new ReadHandle(env.SHARD.getByName(meta.shardName), meta.hash);
}

// in gateway Worker
using handle = userDO.openRead(path);    // no await!
const body = await handle.read();        // pipelined — single RTT
```

This is exactly the [Cap'n Web pattern](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)
and it's free if you restructure the RPC surface. **Saves one full RTT
(30–80 ms) on every read** that crosses the metadata→shard boundary.

Mossaic-specific application:
- `vfsStreamRead` / `vfsStreamReadByHandle` in `worker/core/objects/user/vfs/streams.ts`
  — return a stream-bearing stub instead of a (handle, then fetch) two-step.
- `vfsRead` for small files — same pattern.
- `vfsAppendWriteStream` for writes — pipeline the shard reservation with
  the first chunk write.

---

## 4. Lever #3 — ReadableStream end-to-end, drop chunk buffering

Workers RPC supports `ReadableStream` natively over RPC ([RPC streaming docs](https://developers.cloudflare.com/workers/runtime-apis/rpc/#readablestream-writeablestream-request-and-response)):

> *"You can send and receive ReadableStream, WriteableStream, Request and
> Response using RPC methods. When doing so, bytes in the body are
> automatically streamed with appropriate flow control. This allows you
> to send messages over RPC which are larger than the typical 32 MiB
> limit."*

And there's an explicit DO example ([readable-stream](https://developers.cloudflare.com/durable-objects/examples/readable-stream/))
showing a DO returning a stream that the Worker forwards verbatim.

Mossaic today buffers multi-chunk reads in worker memory before streaming
to the client (per the prior verdict). This is wasted memory and wasted
time-to-first-byte. The fix:

1. Build a `ReadableStream` *inside* the UserDO/ShardDO that pulls chunks
   in order (parallel with a small read-ahead).
2. Return that stream over RPC.
3. The Worker just `return new Response(stream)` — no buffering.

```ts
// inside ShardDO
streamChunks(hashes: string[]) {
  let i = 0;
  return new ReadableStream({
    pull: async (controller) => {
      if (i >= hashes.length) return controller.close();
      const body = await this.readChunk(hashes[i++]);   // hits LRU from Lever #1
      controller.enqueue(body);
    }
  }, { type: "bytes" });   // byte-oriented stream — required for RPC
}
```

**Expected impact:** time-to-first-byte for a 100 MiB file drops from
"buffer-the-whole-thing" (~500 ms) to "first chunk arrives" (~30–50 ms).
Worker memory use drops from O(file size) to O(chunk size).

The cancellation propagation works correctly per the docs: if the client
cancels, the stream cancellation propagates back to the DO, so you don't
keep fetching chunks the user no longer wants.

---

## 5. Lever #4 — DO read replicas for UserDO read paths

This is the big architectural unlock. As of the recent SPEC ([`Storage/SPEC: Durable Objects read replication API`](https://wiki.cfdata.org/display/STOR/SPEC%3A+Durable+Objects+read+replication+API)),
DOs now support **read replicas** via `ctx.storage.enableReplicas()`. The
quick start ([`Durable Objects Replication Quick Start`](https://wiki.cfdata.org/spaces/STOR/pages/1110730702/Durable+Objects+Replication+Quick+Start)):

```ts
// In wrangler.toml
compatibility_flags = ["experimental", "replica_routing"]

// In UserDO constructor
async init() {
  await this.ctx.storage.enableReplicas();   // currently 7 static replicas / region
}

// At the top of every method
isReplica() { return this.ctx.storage.primary !== undefined; }

async vfsStat(path: string) {
  // reads work on replicas
  return this.lookup(path);
}

async vfsWriteFile(path: string, body: Uint8Array) {
  if (this.isReplica()) {
    return this.ctx.storage.primary.vfsWriteFile(path, body);   // forward to primary
  }
  // ... actual write
}
```

Per [Krysten Gillett's D1 latency notes](https://wiki.cfdata.org/spaces/~krysten/pages/1374960488/D1+Performance+%26+Latency):
> *"1 static replica per CF region (7 globally, 2 in APAC) … considered stable
> for production use, with beta caveats … dynamic replica scaling is the main
> remaining item for GA."*

For Mossaic, this means a UserDO created by an ENAM tenant whose user
travels to APAC will currently see ~200–300 ms cross-region RTT for every
`stat`/`readdir`. With replicas enabled, the same operation hits a local
APAC replica at ~5–20 ms.

**Caveat — read-your-writes**: replicas can lag. Mossaic must use the
[bookmarks API](https://developers.cloudflare.com/durable-objects/api/storage-api/#getcurrentbookmark)
for any read-after-write that needs immediate consistency:

```ts
// after a write in primary
const bookmark = await this.ctx.storage.getCurrentBookmark();
return { result, bookmark };

// on a subsequent read (possibly on a replica)
await this.ctx.storage.waitForBookmark(bookmark);
return this.vfsStat(path);
```

This is exactly how D1 sessions work today.

**Expected impact:** for globally distributed users, p50 reads drop
80–200 ms → 5–20 ms. For tenants whose primary is in their region, no
change (replicas don't hurt).

**Caveats from real D1 experience:**
- Disable replicas before bulk imports (replicas error with
  "Network connection lost" during high-volume writes).
- Writes route to nearest replica then forward to primary — may add a
  few ms vs going direct to primary.

---

## 6. Lever #5 — `locationHint` on first `get()`

[Location hints docs](https://developers.cloudflare.com/durable-objects/reference/data-location/#provide-a-location-hint):

> *"Hints are a best effort and not a guarantee. Only the first call to
> `get()` for a particular Object will respect the hint."*

Mossaic currently doesn't pass a hint, so every UserDO is created
wherever the first `get()` happened to come from. For an organization
with most users in one region, that's fine. For a SaaS tenant whose user
signed up while traveling, that's a permanent latency tax.

Add this pattern to the gateway Worker:

```ts
// gateway.ts — when minting / first-touching a UserDO
const cf = (request as RequestWithCf).cf;
const continent = cf?.continent ?? "NA";
const hint = continentToHint(continent);   // NA→enam, EU→weur, AS→apac, etc.
const id = env.USER.idFromName(`user:${tenantId}`);
const stub = env.USER.get(id, { locationHint: hint });
```

This needs persistence: store the chosen hint on signup so subsequent
operations can pass the *same* hint (only the first `get()` respects it,
but for operational hygiene set it on every `get` anyway).

**Expected impact:** mostly tail latency. p99 first-write from far-away
clients drops by 50–150 ms. Won't change p50 for established tenants.

---

## 7. Lever #6 — Configure subrequest limit, fix recursive remove

The prior verdict flagged `vfsRemoveRecursive`'s 6400-internal-subrequest
blast radius (200 files × 32 shards) as exceeding the 1000-cap. **That's
no longer a fundamental limit:** since [Feb 2026](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)
paid plans default to **10,000 subrequests** per invocation and can be
raised to **10 million** via wrangler:

```jsonc
// wrangler.jsonc
{
  "limits": {
    "subrequests": 100000
  }
}
```

Add this to Mossaic's `deployments/service/wrangler.jsonc` and the
existing `vfsRemoveRecursive` becomes a non-issue for any tree under
~3,000 files.

Beyond that, the actual fix is to **batch deletes per-shard**:

```ts
// today: 200 files × 32 shards = 6400 calls
// better: group chunks by shard, send one call per shard with a list
const byShare = groupBy(chunks, c => c.shardName);
await Promise.all(Object.entries(byShard).map(([name, hashes]) =>
  env.SHARD.getByName(name).bulkUnlink(hashes)
));
// 32 calls regardless of file count
```

**Expected impact:** unblocks deep-tree deletes, latency goes from
"timeout at ~1000 files" to "completes in O(shards)" instead of
O(files × shards).

---

## 8. Lever #7 — Smart Placement on the gateway Worker

[Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/)
runs your Worker close to the services it talks to — useful when the
gateway is far from the UserDO. Today the gateway runs at the eyeball's
edge colo, the UserDO is wherever it landed; if these are far apart,
every `stat` is a transcontinental RTT.

```jsonc
// wrangler.jsonc
{
  "placement": { "mode": "smart" }
}
```

Cloudflare profiles your Worker over time and decides whether to keep
running it at the eyeball or hop closer to the DO. **Free, zero-code
change**, helps cross-region tenants without read replicas.

**Expected impact:** 30–80 ms for tenants whose UserDO is far from
typical eyeball location. Doesn't help tenants already in-region.

When combined with Lever #4 (read replicas), Smart Placement becomes less
important for reads but still useful for writes.

---

## 9. Lever #8 — Inline-tier expansion + range-batched reads

Today Mossaic inlines files **< 16 KiB** in the UserDO. That covers tiny
files but misses the most common "small but not tiny" sweet spot
(JS bundles, small images, JSON blobs — typically 50–500 KiB).

Two related changes:

**A. Raise the inline cap to 64 KiB or 128 KiB** for read-heavy tenants.
Storage cost in UserDO goes up linearly, but you skip the entire
ShardDO RTT and chunk-assembly cost for the most common medium-file
size. The per-row size limit on DO storage is documented as 2 MiB
(SQLite blob), so 128 KiB is well within budget.

**B. Range-batched chunk reads.** For a 10-chunk file, today Mossaic
makes 10 calls (or 8/2 in waves). With **chunk-range RPCs**, the gateway
asks the ShardDO "give me chunks indices [4..9]" and the ShardDO returns
a stream of all six. One RPC, one round trip. **Saves ~5 RTTs per
medium-file read.**

```ts
// shard-do.ts
streamRange(hashes: string[]) {
  return new ReadableStream({...}, { type: "bytes" });
}
```

This pairs naturally with Lever #3 (ReadableStream) — same primitive,
different use site.

---

## 10. What probably won't help (don't get distracted)

- **Cache API for chunks.** Cache API is HTTP-shaped, scoped to
  custom-domain serving. Doesn't help internal DO↔DO traffic. The R2
  metadata team also documented its scaling limits ([`R2 Metadata Caching`](https://wiki.cfdata.org/display/R2/R2+Metadata+Caching)
  → "Cache API doesn't scale well, [PINGORA-110]").
- **Switching from RPC to fetch().** RPC is strictly faster — Cap'n Proto
  over the actor pipeline, no HTTP framing, supports pipelining. If any
  Mossaic code still uses `fetch()` between DOs, replace with RPC.
- **Bigger DOs (memory tier).** Per [`Mini-PRD: DO shared isolate issues`](https://wiki.cfdata.org/display/STOR/Mini-PRD%3A+DO+shared+isolate+issues),
  there's no per-DO memory tier yet. The 128 MiB cap is a shared isolate
  ceiling. LRU sizing matters.
- **Increasing CONCURRENCY past 8.** [Workers limit](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections)
  is **6 concurrent subrequests per Worker request**. Anything above 6
  serializes. CONCURRENCY=8 already over-promises; setting CONCURRENCY=6
  and queueing past that is the correct shape.
- **Pre-warming DOs.** Per the [DO data location docs](https://developers.cloudflare.com/durable-objects/reference/data-location/#provide-a-location-hint):
  *"It can negatively impact latency to pre-create Durable Objects prior
  to the first client request."* The first request determines location;
  pre-warming bakes in the wrong colo.

---

## 11. Recommended implementation order

Roughly two weeks of focused work, sequencing by impact-per-effort:

| Week | Item | Notes |
|---|---|---|
| **W1 day 1** | Lever #6 — `limits.subrequests: 100000` in wrangler | One config line. Unblocks recursive ops today. |
| **W1 day 1** | Lever #7 — `placement: { mode: "smart" }` | One config line. No-cost win for cross-region. |
| **W1 day 1–2** | Lever #5 — `locationHint` on first UserDO `get()` | Small worker-side change, big tail-latency wins. |
| **W1 day 3–5** | Lever #1 — In-ShardDO LRU keyed by chunk hash | Highest single-feature win. ~32 MiB cap, evict on cold. |
| **W1 day 5** | Lever #1.5 — In-UserDO LRU for stat/readdir | Same pattern, smaller scope. |
| **W2 day 1–3** | Lever #2 — Promise pipelining via stub-bearing handles | Restructure RPC surface. |
| **W2 day 1–3** | Lever #3 — ReadableStream end-to-end | Pairs with #2. Drop the buffering. |
| **W2 day 4–5** | Lever #4 — DO read replicas (gated experiment) | Compat flag + bookmarks API. Test write paths. |
| **W2 day 5** | Lever #8 — Inline-tier raise + range RPCs | Polish. |
| **W3+** | Measure and re-prioritise | Per-tenant metrics will reveal the real bottlenecks. |

Add observability first (per-operation duration histograms with
`p50/p99`, broken down by metadata-RTT vs chunk-RTT vs body-bytes-time)
so you can validate each lever against real workloads, not synthetic
benchmarks.

---

## 12. The honest "what we still can't fix today"

- **Per-tenant metadata-write throughput.** UserDO is single-master.
  With replicas, *reads* scale; *writes* still serialize at the primary.
  ~1000 writes/sec ceiling per UserDO. If a single tenant blows past
  that, the right fix is the metadata-sharding plan I sketched at the
  end of last week's verdict (UserDO delegates to N MetadataShardDOs the
  way it already delegates bytes to ShardDOs). Not in scope for latency
  fixes.
- **Cold start on tenants that haven't been touched in a while.**
  ~100–300 ms once. No knob fixes this.
- **Replica freshness.** Bookmarks API guarantees read-your-writes for
  the same client; cross-client sync still has the natural replication
  lag (typically seconds; bounded by SRS replication speed).
- **WebSocket frames bypassing rate limit** (NEW-12 from the verdict)
  isn't a latency issue per se, but it does mean a noisy WS subscriber
  can starve other tenants on the same UserDO. Worth fixing in the same
  pass as the latency work.

---

## Sources

**Public docs**
- [DO data location & locationHint](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [DO storage best practices (SQLite)](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Workers RPC promise pipelining](https://developers.cloudflare.com/workers/runtime-apis/rpc/#promise-pipelining)
- [Workers RPC streams](https://developers.cloudflare.com/workers/runtime-apis/rpc/#readablestream-writeablestream-request-and-response)
- [DO ReadableStream example](https://developers.cloudflare.com/durable-objects/examples/readable-stream/)
- [Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/)
- [Subrequests limit raised (Feb 2026)](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)
- [Workers concurrent subrequest limit (6)](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
- [Bookmarks API for read-your-writes](https://developers.cloudflare.com/durable-objects/api/storage-api/#getcurrentbookmark)

**Internal wiki**
- [`STOR/SPEC: Durable Objects read replication API`](https://wiki.cfdata.org/display/STOR/SPEC%3A+Durable+Objects+read+replication+API)
- [`STOR/Durable Objects Replication Quick Start`](https://wiki.cfdata.org/spaces/STOR/pages/1110730702/Durable+Objects+Replication+Quick+Start)
- [`R2/R2 Metadata Caching`](https://wiki.cfdata.org/display/R2/R2+Metadata+Caching) — witness-based caching pattern
- [`R2/R2 Metadata Cache`](https://wiki.cfdata.org/display/R2/R2+Metadata+Cache) — production implementation details
- [`STOR/Mini-PRD: DO shared isolate issues`](https://wiki.cfdata.org/display/STOR/Mini-PRD%3A+DO+shared+isolate+issues)
- [`~krysten/D1 Performance & Latency`](https://wiki.cfdata.org/spaces/~krysten/pages/1374960488/D1+Performance+%26+Latency) — replica scale numbers

**Prior workspace research**
- [`local/mossaic-verdict.md`](vfs://local/mossaic-verdict.md)
- [`local/r2-under-the-hood.md`](vfs://local/r2-under-the-hood.md)
- [`local/do-fanout-state-sync.md`](vfs://local/do-fanout-state-sync.md)
