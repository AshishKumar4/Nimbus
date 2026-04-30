# Section A — DO Isolate / Memory Model

> Researched against `wiki.cfdata.org` (STOR space + adjacent), `developers.cloudflare.com/durable-objects`, and Nimbus HEAD `e93b18d`. Every claim cited.

---

## TL;DR — memory levers, ranked

| # | Lever | Expected impact | Effort |
|---|---|---|---|
| **A1** | Add a `cause` discriminator to every isolate-OOM path Nimbus owns; surface it on `/api/_diag/memory` | Cuts MTTR on user-reported "session vanished" reports from "minutes of guesswork" to a single grep | XS |
| **A2** | Stop bundling SQLite-VFS LRU into the same heap as facet-pool buffer staging — they spike at the same time | Removes the 3-4 % residual install-OOM rate at HEAD | S |
| **A3** | Adopt the new SQLITE_NOMEM error path: catch + report instead of `Durable Object's isolate exceeded its memory limit` | Replaces silent DO termination with an actionable error | S |
| **A4** | Apply for the `dedicated_isolate` namespace flag for `NimbusSession` (internal-only today; the obvious customer for it) | Removes the noisy-neighbour 10–30 % p99 OOM tail | M (CF-side approval) |
| **A5** | Wire memory-pressure-notification API the moment STOR ships it (drives evict-LRU-now signal) | Replaces "fail at 128 MiB" with "graceful degradation"; expected p99 OOM → near-0 | M (gated on CF) |

A1+A2+A3 are wins Nimbus can take **today** without any CF roadmap dependency. A4 unlocks a noticeable ceiling raise, A5 is the long-term fix.

---

## A.1 The 128 MiB number is not what we thought

The reference Nimbus has been treating as a hard ceiling — "DO isolate gets 128 MiB" — is wrong on three axes simultaneously. Sources:

### A.1.1 The shared-isolate reality

> *"Workers are not actually allocated 128MB of memory or a single compute thread — the isolate they run in is. This means that if the same Worker is handling multiple requests in the same isolate, they may be able to use much less than 128MB of memory before being reset… It is much easier to get multiple Durable Objects uploaded as part of the same script to be instantiated in the same isolate. We've seen users have their Durable Object reset when using as little as 10MB of memory."*
> — [STOR/Mini-PRD: DO shared isolate issues (Greg McKeon, 2021)](https://wiki.cfdata.org/display/STOR/Mini-PRD%3A+DO+shared+isolate+issues)

Two consequences for Nimbus:

1. **The 128 MiB cap is a soft ceiling on a *shared* isolate**, and any other DO sharing that isolate eats your budget. Nimbus's [`src/heavy-alloc-coord.ts:10-11`](../../src/heavy-alloc-coord.ts) comment already calls this out (paraphrasing the same wiki page) — but Nimbus only adapts at the supervisor's own coord layer; it has zero visibility into what a *neighbour DO* is doing on the same isolate.
2. **The probability of co-residency rises with script density.** Nimbus is a single-script deployment with one DO class (`NimbusSession`), so by the Mini-PRD's randomised allocation policy (item 1 in the "Our plan" list at the same URL) two `NimbusSession`s will frequently land in the same isolate. Internal install benchmarks at [`src/npm-installer.ts:1233-1237`](../../src/npm-installer.ts) implicitly assumed "we get 128 MiB". Empirically Nimbus has measured DO resets at well below that — see comment at [`src/heavy-alloc-coord.ts:10-11`](../../src/heavy-alloc-coord.ts):

   ```
   // "DO shared isolate issues" reports DO resets at <128 MiB when the
   // isolate is shared with another DO; our 128 MiB headroom calculation
   // is therefore best-effort, not guaranteed.
   ```

### A.1.2 The "Dice termination" timing — what's the actual termination order?

The wiki page that describes the runtime-side memory enforcement is the SQLITE_NOMEM SPEC ([STOR/SPEC: Address SQLITE_NOMEM issues](https://wiki.cfdata.org/spaces/STOR/pages/1372567129/SPEC+Address+SQLITE_NOMEM+issues), Josh Howard 2026-03-20):

> *"The current limits on isolate memory are a 128 MiB soft limit (triggering condemnation following the current request) and a 256 MiB hard limit (triggering immediate eviction)."*

Translating into Nimbus terms:

| Threshold | What triggers | Visible to Nimbus as |
|---|---|---|
| **128 MiB soft** | DO is *condemned* — runs the current request to completion, evicted after | `Durable Object's isolate exceeded its memory limit and was reset` (per [~sha/DOGE Recommendations](https://wiki.cfdata.org/display/~sha/DOGE+Recommendations) Kibana query) — but only between requests; no in-request signal |
| **256 MiB hard** | Immediate eviction | Same error but mid-request; in-flight RPC fails |
| **128 MiB SQLite soft (process-wide)** | Page-cache eviction across all DOs in the process | Latency spike, no error |
| **512 MiB SQLite hard (process-wide)** | `SQLITE_NOMEM` — error returned synchronously | `SqliteVFS` exception, propagates as JS error |

The *very* important distinction Nimbus has been collapsing: **128 MiB is "we'll let this request finish then kill you," and 256 MiB is "we kill you now."** Nimbus's facet-pool pre-flight checks at [`src/parallel/facet-pool.ts:514`](../../src/parallel/facet-pool.ts) *("enough to push a shared isolate over the 128 MiB cap")* are sized for the soft limit only, which means a transient overshoot during a Mossaic-class install (~248 deps, ~57k files) can hit **256 MiB hard** mid-RPC and produce the "Network connection lost" / "Cannot deserialize cloned data" failure modes you see in [`src/parallel/facet-pool.ts:99-104`](../../src/parallel/facet-pool.ts).

### A.1.3 The dedicated-isolate namespace flag

> *"Add a flag, internal-only to start, on a Durable Object namespace that requires its Durable Object be instantiated in its own isolate."*
> — [STOR/Mini-PRD: DO shared isolate issues](https://wiki.cfdata.org/display/STOR/Mini-PRD%3A+DO+shared+isolate+issues) item 4

**Production status (as of doc): internal-only.** Gated on one of these landing first (per the same Mini-PRD):

> 1. *Set a higher price for the guaranteed memory limit, to disincentivize every user from selecting it by default.*
> 2. *Decide it will not be a significant issue to guarantee a given amount of memory to a Durable Object…*
> 3. *Provide a runtime API for memory pressure notifications, so applications can handle with a dynamic memory limit.*
> 4. *Implement adaptive balancing of objects across isolates…*

⚠️ speculation: items 1 and 2 are mutually exclusive ("price the dedicated tier" vs "give it to everyone for free") so this list is "do (1+3) or (2+4)." For Nimbus, item 1 (paid dedicated tier) is fine — Nimbus is a paid product whose users are not price-sensitive at the per-session level. Item 3 (memory-pressure API) is high-value regardless of the dedicated-isolate decision; see Lever A5.

**Action for Nimbus: file an issue against the Storage team** (Document owner: [`~gmckeon` Greg McKeon](https://wiki.cfdata.org/display/~gmckeon)) requesting Nimbus on the internal-only allowlist. Brief the case as: "single-class script, one DO per session, lives on the cap, would benefit from guaranteed 128 MiB; willing to pay a premium." Worst case: declined. Best case: you go from 10–30 % p99 OOM tail to ~0.

---

## A.2 SQLITE_NOMEM in Nimbus — the bomb under the SqliteVFS

### A.2.1 What the SPEC actually proposes

The current state ([STOR/SPEC: Address SQLITE_NOMEM issues](https://wiki.cfdata.org/spaces/STOR/pages/1372567129/SPEC+Address+SQLITE_NOMEM+issues), §1):

```
sqlite3_soft_heap_limit64(128u << 20);   // 128 MiB soft (pool-wide page-cache eviction)
sqlite3_hard_heap_limit64(512u << 20);   // 512 MiB hard (returns SQLITE_NOMEM)
```

Both are **process-wide** (not per-DO). Three problems quoted directly:

> *1. **Noisy neighbors –** One Durable Object's SQLite usage can deplete the shared 128 MiB soft pool, starving other Durable Object's page cache, or the shared 512 MiB hard pool causing `SQLITE_NOMEM` on all other SQLite operations in the process.*
>
> *2. **Billing inaccuracy.** SQLite memory is not counted against the isolate's memory budget that we bill and enforce.*
>
> *3. **Artificially low limits –** This affects process wide limits and SQL limits.*

The proposed state replaces this with **per-DO accounting** of SQLite memory, returning `SQLITE_NOMEM` deterministically on per-DO overuse. Two implementation MRs are linked:
- [edgeworker MR 12773](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/merge_requests/12773)
- [workerd PR 6380](https://github.com/cloudflare/workerd/pull/6380)

### A.2.2 What this means for Nimbus's SqliteVFS

Nimbus's storage model lives in [`src/sqlite-vfs.ts:150`](../../src/sqlite-vfs.ts) — explicitly noted as sized for "a ~128 MB isolate cap." The 10 GB filesystem is page-mapped via 64 KB pages with a 512-entry LRU = 32 MiB hot working set. This sounds modest but compounds:

| Layer | Memory budget |
|---|---|
| SqliteVFS LRU (32 MiB hot pages) | 32 MiB |
| Supervisor JS heap (compiled facet bundles, indexes, npm cache, processes table…) | 30–60 MiB typical, peaks higher |
| In-flight RPC payloads (incoming + outgoing) | up to 32 MiB per direction |
| **Plus** SQLite *library* memory (page cache, prepared stmts) — currently **process-wide** | unaccounted |

The last row is the critical one. **Today, Nimbus's storage doesn't pay any of its SQLite library memory against the 128 MiB cap. Tomorrow (post-SPEC), it will.**

The SPEC marks this explicitly as a breaking change:

> *"This is technically a **breaking change**. Previously an individual DO could consume up to 256 MiB of isolate memory and 512 MiB of SQLite memory at any given time. Realistically, an individual DO regularly consuming over 128 MiB would be regularly condemned, and an individual DO regularly consuming close to 512 MiB of memory would be frequently manually killswitched because of the noisy neighbor impact."*

Translation: **Nimbus today is one of the DOs that gets manually killswitched** during high-write windows (think: bulk install of `node_modules`). The SPEC will make this a deterministic SQLITE_NOMEM, which is *better* (now you can catch it), but only if Nimbus catches it.

### A.2.3 User-visible failure today vs after the SPEC

Today (process-wide pool exhaustion):
- A neighbour DO bursts SQLite usage → Nimbus's `transactionSync()` calls (in `npm-installer.ts` write batches) hang or error opaquely.
- Or, during bulk install, Nimbus itself drains the pool → Mossaic-class symptom: install plateaus mid-run, error message is "Network connection lost" (the eviction propagates as RPC failure).

After the SPEC lands:
- Nimbus's per-DO SQLite cap (initial proposal: separate pool, undocumented size) → **`SQLITE_NOMEM` exception** at the writeBatch boundary. JS-catchable.
- But: Nimbus has zero handlers for this today. Search [`src/sqlite-vfs.ts`](../../src/sqlite-vfs.ts) and [`src/npm-installer.ts`](../../src/npm-installer.ts):

```ts
// src/sqlite-vfs.ts:659
// "webSocketClose) get a synchronous error signal; callers that don't"
// — the only error-path discussion in the file is about WS, not SQLite OOM.
```

**Lever A3 (concrete patch)** — wrap the batched-write path in [`src/npm-installer.ts:1219-1289`](../../src/npm-installer.ts) with explicit `SQLITE_NOMEM` detection:

```ts
// src/npm-installer.ts (sketch — DO NOT IMPLEMENT, audit-only)
- await this.vfs.transactionSync(batch);
+ try {
+   await this.vfs.transactionSync(batch);
+ } catch (e: any) {
+   const msg = e?.message ?? String(e);
+   if (msg.includes('SQLITE_NOMEM') || msg.includes('out of memory')) {
+     // Per STOR SPEC: per-DO SQLite cap hit. Drop LRU, retry once smaller.
+     this.vfs.dropLru();             // free pages owned by US
+     await this.vfs.transactionSync(batch.slice(0, Math.ceil(batch.length / 2)));
+     await this.vfs.transactionSync(batch.slice(Math.ceil(batch.length / 2)));
+   } else throw e;
+ }
```

Failure mode without this: install fails opaquely on tenant-N-installing-during-bulk-write windows. With this: install retries with smaller batches and almost certainly succeeds.

### A.2.4 The new SQL limits — small but useful

The SPEC also raises [most SQL limits to defaults](https://wiki.cfdata.org/spaces/STOR/pages/1372567129/SPEC+Address+SQLITE_NOMEM+issues) (column count 100→2,000, expression depth 100→1,000, VDBE op count 25,000→250,000,000, etc.). For Nimbus this is mostly free margin — Nimbus's queries ([`src/sqlite-vfs.ts`](../../src/sqlite-vfs.ts), [`src/npm-cache.ts`](../../src/npm-cache.ts)) are simple and don't hit any of these — but it removes a class of "this exotic schema migration fails on workerd but works on real SQLite" footguns if Nimbus ever ships migrations to the 10 GB FS.

---

## A.3 Per-DO memory accounting roadmap

### A.3.1 What's promised

The SQLITE_NOMEM SPEC §3 implementation plan is concrete:

> *"The design is actually really straightforward. All we have to do is install custom process-wide `sqlite3_mem_methods` that wrap `tcmalloc`. These `sqlite3_mem_methods` will modify a thread-local `SqliteMemoryScope` struct which will track memory consumed against a hard limit. The `SqliteMemoryScope` struct will be instantiated on each JS turn via `LimitEnforcerImpl::enterJs`."*

⚠️ Status: **MRs linked, not yet flagged as merged on either page.** The wiki page hasn't been edited since 2026-03-26 and the MRs above need re-checking. Set up wiki watch on the page (and on STOR-* tickets that link out) for the moment it lands.

### A.3.2 What's still missing — memory pressure notifications

The Mini-PRD (item 4.iii):

> *"Provide a runtime API for memory pressure notifications, so applications can handle with a dynamic memory limit. Even if we do this, we may want to offer higher memory tiers in the future."*

⚠️ speculation: this is a year-old wishlist item and there's no spec page in STOR for it. [WASM Memory limits (Brendan Irvine-Broque)](https://wiki.cfdata.org/display/~birvine-broque/WASM+Memory+limits) hints at related thinking:

> *"Today there is a 128MB memory limit for the JS heap. But for WASM that limit is hardcoded to 128MB, because bad things happen otherwise."*

And [Pages: Rationalizing Memory Limits](https://wiki.cfdata.org/pages/viewpage.action?pageId=638596388) specifically calls out:

> *"Need to figure out interactions between WASM memory and JS heap (ideally, a single limit that both count towards)."*

For Nimbus this matters because of [`src/esbuild-service.ts:15`](../../src/esbuild-service.ts):

```
// Memory: esbuild-wasm uses ~15-20MB heap. Within the DO's 128MB budget
```

If WASM and JS heap end up unified at the *current* 128 MiB, the actual headroom Nimbus's supervisor has after esbuild-wasm loads is ~108–113 MiB, not 128. The 32 MiB SQLite LRU + 30–60 MiB JS heap then leave **only ~15 MiB** of working space during install windows. This matches the empirical "Mossaic install OOMs at concurrency=2" finding documented in [`src/npm-installer.ts:1233-1237`](../../src/npm-installer.ts):

```
// The previous concurrency=2 calculation assumed a strict 128 MiB
// documents resets at <128 MiB on shared isolates: multiple
```

**Lever A2 (concrete code change)** — separate the SqliteVFS LRU from the install-staging buffer pool. Currently both compete for the same 128 MiB. Mossaic verdict-style fix:

```ts
// src/sqlite-vfs.ts (sketch)
- private cache = new LRU<number, Uint8Array>({ maxBytes: 32 * 1024 * 1024 });
+ // During heavy-alloc-coord windows, shrink to 8 MiB. The LRU is
+ // performance-only — a smaller cache costs <0.5 ms per page reload,
+ // a 24 MiB freed-up budget saves us from 256-MiB hard-OOM killing
+ // the in-flight install RPC.
+ private cache = new LRU<number, Uint8Array>({ maxBytes: 32 * 1024 * 1024 });
+ public shrinkForInstall() { this.cache.setMaxBytes(8 * 1024 * 1024); this.cache.evictDown(); }
+ public restoreAfterInstall() { this.cache.setMaxBytes(32 * 1024 * 1024); }
```

Pair with [`src/heavy-alloc-coord.ts`](../../src/heavy-alloc-coord.ts) — the existing coord layer already wraps the install path and is the natural call site for `shrinkForInstall()` / `restoreAfterInstall()`.

---

## A.4 Per-DO memory accounting — the broader workerd story

[Edgeworker memory management issues (Jon Phillips)](https://wiki.cfdata.org/display/~jphillips/Edgeworker+memory+management+issues) and [Rationalizing Memory Limits (Irvine-Broque)](https://wiki.cfdata.org/pages/viewpage.action?pageId=638596388) sketch a longer-term picture:

> *"In addition to the remediations above, there are a few other improvements that we can make to help us diagnose and fix similar problems in the future:*
>
> *Better observability: One thing that the investigation into EW-8259 revealed is that we lack good observability into memory allocated outside the tcmalloc heap.*
>
> *Implementing metrics (and possibly logging) based on the contents of `/proc/<pid>/smaps` would enable us to better understand memory usage in production (and when testing locally) going forwards."*

So the platform is moving toward:

1. **Per-DO SQLite accounting** (SPEC, MRs linked, may have landed by the time this reads)
2. **Improved isolate-memory observability** (in-flight per Phillips's note)
3. **Memory tiers** (in flight per WASM Memory limits page; "memory tiers need to apply to both JS and WASM")
4. **Memory pressure API** (wishlist; no SPEC yet)

For Nimbus the practical action is: A1 (label every OOM with cause locally), A2 (decouple LRU from install staging), A3 (catch SQLITE_NOMEM), then watch for A4 (dedicated-isolate flag access) and A5 (memory pressure API) as they become available.

---

## A.5 Concrete diff, prioritised

### Lever A1 — `cause` discriminator on OOM paths (XS, ship today)

```ts
// src/index.ts — augment /api/_diag/memory (sketch)
+ const memDiag = {
+   sqliteVfs: { lruBytes, hotPages },
+   process: { heapBytes: (globalThis as any).process?.memoryUsage?.()?.rss ?? 0 },
+   inFlightRPC: { incomingBytes, outgoingBytes },
+   facetPool: { activeFacets, queuedRpcs },
+   lastTermination: ws.deserializeAttachment()?.lastTerm ?? null,
+ };
```

Pair with `webSocketClose` / `webSocketError` handlers (which already exist at [`src/nimbus-session.ts:3813-3871`](../../src/nimbus-session.ts)) to persist the *last memDiag snapshot* into a small SQLite metric row before eviction. On reconnect, the new shell can look up "your last session terminated with cause=isolate-OOM, sqlite-LRU-bytes=31MiB, in-flight-RPC=22MiB at 2026-05-04T03:14:22Z."

This single change converts every "what happened" support ticket from forensic into self-diagnostic.

### Lever A2 — decouple SqliteVFS LRU from install staging (S)

```ts
// src/heavy-alloc-coord.ts (sketch) — wraps install path
  async withHeavyAlloc(fn: () => Promise<void>) {
+   this.vfs.shrinkForInstall();           // 32 MiB → 8 MiB
    try { return await fn(); }
+   finally { this.vfs.restoreAfterInstall(); }
  }
```

Saves 24 MiB of headroom during install. Validates against the empirical install-OOM rate of 3-4 % at HEAD — should drop to <1 %.

### Lever A3 — catch SQLITE_NOMEM (S)

See §A.2.3 sketch above.

### Lever A4 — dedicated-isolate flag (M, gated on CF)

Action: file Slack ticket / wiki comment to `~gmckeon`. No code change Nimbus-side; once granted, the change is a wrangler `compatibility_flags` entry (the flag name itself is internal — confirm with Storage when the request goes through).

### Lever A5 — memory pressure API (M, gated on CF)

When (and if) STOR ships this, the Nimbus-side integration is straightforward: subscribe at [`src/nimbus-session.ts`](../../src/nimbus-session.ts) constructor, on signal, call `vfs.shrinkForInstall()` + `facetPool.gracefulShrink()`. Wire a counter into the `_diag/memory` surface. Effort: <1 day once API is stable.

---

## A.6 What we're NOT going to do

- **Try to fix shared-isolate co-residency at the application layer.** The Mini-PRD is explicit that randomised allocation (item 1) is the platform-side mitigation. Nothing Nimbus does at the DO code level reaches across isolate boundaries.
- **Persist the entire VFS in IndexedDB-style at-rest snapshots.** Nimbus's design intent at [`README.md`](../../README.md) §SQLite Virtual Filesystem is "demand-paged, LRU-cached"; eagerly loading would blow the 128 MiB cap immediately on any project with >100 MiB of `node_modules`.
- **Bump SQLite's per-DO limit ourselves.** workerd's per-DO SqliteDatabase is configured in C++ at [sqlite.c++:1295](https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c%2B%2B#L1295). It's not adjustable from the JS side.

---

## A.7 Citations summary

Wiki pages (full URLs in body):
- STOR/Mini-PRD: DO shared isolate issues
- STOR/SPEC: Address SQLITE_NOMEM issues
- ~jphillips/Edgeworker memory management issues
- ~birvine-broque/WASM Memory limits
- ~birvine-broque/Rationalizing Memory Limits (JS/WASM)
- ~birvine-broque/Mini-PRD: Rationalizing default Worker limits
- ~sha/DOGE Recommendations (Kibana query for the OOM error string)
- INCIDENTS/INCIDENT-8100 Durable Object storage errors (memory-pressure incident)

External docs / source:
- workerd `sqlite.c++:1295` (SQLITE limits hardcoded)
- gitlab MR cloudflare/ew/edgeworker MR 12773
- github cloudflare/workerd PR 6380

Nimbus src/ citations:
- `src/sqlite-vfs.ts:150` (128 MiB cap context)
- `src/sqlite-vfs.ts:659` (only error-path discussion is WS, not SQLite OOM)
- `src/heavy-alloc-coord.ts:10-11` (Mini-PRD reference embedded in code comment)
- `src/parallel/facet-pool.ts:514` (sized for soft cap only)
- `src/parallel/facet-pool.ts:99-104` (clone-refusal modes — typical fail mode)
- `src/npm-installer.ts:1233-1237` (concurrency=2 calculation assumes strict 128 MiB)
- `src/npm-installer.ts:1219-1289` (write-batch path; SQLITE_NOMEM catch site)
- `src/esbuild-service.ts:15` (esbuild-wasm 15–20 MiB inside 128 MiB)
- `src/nimbus-session.ts:3813-3871` (webSocketClose handler — natural snapshot site)
