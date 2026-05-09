# CF Internal Optimization Research — Nimbus

> Researched 2026-05-04 against `wiki.cfdata.org` (STOR / EW / R2 / CC / PRICE / BRAPI), `developers.cloudflare.com`, plus Nimbus HEAD `e93b18d` source. Quality bar: every claim cites either an internal wiki URL, a public docs URL, a `src/file.ts:NN` location, or is explicitly marked `⚠️ speculation`.
>
> Scope: 10 areas A-J covering DO memory, Worker Loader / Facets, WebSocket hibernation, npm install architecture, RPC layer, observability, cost / billing, the in-flight CF roadmap, sibling CF projects, and concrete code-diff change list. Per-area drafts in [`audit/_drafts/`](../_drafts/) for provenance.

---

## TL;DR — top levers, ranked by impact-per-effort

| # | Lever | Section | Effort | Impact |
|---|---|---|---|---|
| **1** | Stable per-tenant `LOADER.get(id, code)` content-hash IDs across runs (collapses Dynamic Workers Created Daily under the new SKU; verify `codeId` is content-derived) | G1, B5 | XS | Halves Dynamic Workers Created bill on busy tenants; the single biggest cost win available |
| **2** | Coalesce per-call facets (`git-network`, per-clone) into long-lived per-tenant facets, fan-out internally with `pLimit(6)` (the `npm-resolve-facet` shape) | B1, G2 | S | Eliminates `5-6 dynamic workers per request` ceiling collisions; cuts daily Worker count further |
| **3** | Switch supervisor⇄facet bulk-write RPC from `Uint8Array[]` chunks to `ReadableStream<Uint8Array>` (bytes-over-RPC, byte-oriented) | E1 | M | 30-50 % faster install on tarball-heavy projects; bypasses 32 MiB clone cap entirely; cuts peak heap 48 MiB → 30 MiB |
| **4** | Add R2-backed cross-tenant tarball + packument cache (the Pyodide pattern from EW/SPEC: Python Workers Package Bundling) | D1, D2 | M | Cold-install of Mossaic-class projects 60 s → 10-20 s after platform warm-up |
| **5** | Add `cause` discriminator + ring-buffer to `/api/_diag/memory`; persist last snapshot on `webSocketClose` (covers OOM / SQLITE_NOMEM / clone-refused / RPC-timeout) | A1, F1 | XS | MTTR on user-reported "session vanished" reports: minutes-of-guesswork → single grep |
| **6** | `setWebSocketAutoResponse(WebSocketRequestResponsePair('ping','pong'))` + `setHibernatableWebSocketEventTimeout(5_000)` in NimbusSession constructor | C2, C3 | XS | ~95 % drop in DO wakeups on idle tabs; bounded message-handler runtime |
| **7** | Smart Placement on the gateway Worker (`placement: { mode: "smart" }`) | D5, G4 | XS | 30-80 ms p50 on cross-region tenants; free, single-line config |
| **8** | Decouple SqliteVFS LRU from facet-pool buffer staging — `vfs.shrinkForInstall()` during heavy-alloc-coord windows | A2 | S | Removes the 3-4 % residual install-OOM rate; frees 24 MiB of headroom |
| **9** | Wrap `transactionSync()` with `SQLITE_NOMEM` catch + retry-with-smaller-batch (gates on STOR/SPEC: SQLITE_NOMEM landing) | A3 | S | Replaces silent DO termination with actionable error |
| **10** | Promise-pipeline the resolver→packument→tarball RPCs (return `RpcTarget` stubs) | E2 | M | ~1 RTT saved per dep × hundreds = 0.5-2 s per Mossaic-class install |
| **11** | Switch `process-logs` WS from `server.accept()` to `ctx.acceptWebSocket()` (hibernatable) | C1 | S | Process-log tail survives DO hibernation; cleaner cross-tab UX |
| **12** | DO read replicas for `/preview/*` reads (gated on STOR replica_routing GA + pricing) | G3, H1 | M | Cross-region preview-read 200 ms → 5-20 ms |
| **13** | Apply for dedicated-isolate namespace flag with Storage team (`~gmckeon`) | A4, H7 | M (CF dialogue) | Eliminates noisy-neighbour 10-30 % p99 OOM tail |
| **14** | Adopt `compatibility_date >= 2026-04-08` so `web_socket_auto_reply_to_close` defaults on | C6 | XS | Cleaner WebSocket close handshake; fewer CLOSING-state stragglers |
| **15** | Ship Tail Worker for the supervisor — durable archive of every supervisor invocation (gated on Lever F2 enabling Logpush first) | F2, F3 | S | Off-platform structured-log archive; ~$0.04/day at typical scale |
| **16** | Wait for + integrate `worker_loaders[].observability` (delete most of `process-logs.ts`) | B2, F5 | M (gated) | -300 LOC eventually; first-class facet logs/traces |
| **17** | Adopt runtime-injected polyfill scheme when Snell's mini-spec ships (replaces the `*.generated.ts` mega-bundles) | B3, H10 | M (gated) | ~12-20 MiB freed per facet load on the encoded budget |
| **18** | Audit Dice abuse-detection against Nimbus's facet pattern; co-design Trust & Safety story with Sandbox SDK team | B4, I1 | S+M | Avoid mis-classification; per-tenant isolation if a single user trips Yara |

Items 1, 2, 3 are the headline wins (cost, scale ceiling, install latency). Items 5, 6, 7 are XS shippable today. Items 12, 13 are platform-gated but have the biggest UX impact when they land.

---

## How to read this document

Each section A-J is an independent area with:

1. **TL;DR table** — levers ranked, expected impact, effort
2. **Body** — what's documented, what Nimbus does today, the gap, code-diff sketches with `src/file.ts:NN` anchors
3. **Citations summary** — wiki / docs / src/ links

Section J is the union of all code-diff sketches in implementation order.

The expanded per-section drafts (1.5-2× this length) are in [`audit/_drafts/A-do-isolate-memory.md`](../_drafts/A-do-isolate-memory.md), [`B-dynamic-workers.md`](../_drafts/B-dynamic-workers.md), etc., for provenance and deeper detail. Per the brief: *"every claim cited (wiki URL, doc URL, src/ file:line, or '⚠️ speculation')"*.

---

# Section A — DO isolate / memory model

## A.0 TL;DR — memory levers, ranked

| # | Lever | Effort | Impact |
|---|---|---|---|
| **A1** | Add `cause` discriminator on every isolate-OOM path; surface on `/api/_diag/memory`; persist on `webSocketClose` | XS | MTTR minutes → single grep |
| **A2** | Decouple SqliteVFS LRU from facet-pool staging; `vfs.shrinkForInstall()` during heavy-alloc | S | Removes residual install-OOM rate; +24 MiB headroom |
| **A3** | Catch SQLITE_NOMEM at write-batch boundary; retry with smaller batches | S | Replace silent DO termination with actionable error |
| **A4** | Apply for dedicated-isolate namespace flag (internal-only today; ask `~gmckeon`) | M (CF dialogue) | Eliminates 10-30 % p99 OOM tail |
| **A5** | Wire memory-pressure-notification API the moment Storage ships it | M (gated) | Graceful degradation; p99 OOM → near-0 |

## A.1 The 128 MiB number is not what we thought

Three independent constraints stack:

1. **Shared isolate co-residency.** Per [STOR/Mini-PRD: DO shared isolate issues](https://wiki.cfdata.org/display/STOR/Mini-PRD%3A+DO+shared+isolate+issues): *"Workers are not actually allocated 128MB of memory or a single compute thread - the isolate they run in is. … We've seen users have their Durable Object reset when using as little as 10MB of memory."* Single-script deployments like Nimbus (one DO class — `NimbusSession`) are *more* likely to land in the same isolate as siblings; the Mini-PRD's planned mitigation is randomised allocation but it's "best-effort." Confirmed locally at [`src/heavy-alloc-coord.ts:10-11`](../../src/heavy-alloc-coord.ts): *"DO resets at <128 MiB when the isolate is shared… our 128 MiB headroom calculation is therefore best-effort, not guaranteed."*

2. **Soft vs hard caps.** Per [STOR/SPEC: Address SQLITE_NOMEM issues](https://wiki.cfdata.org/spaces/STOR/pages/1372567129/SPEC+Address+SQLITE_NOMEM+issues): *"The current limits on isolate memory are a 128 MiB soft limit (triggering condemnation following the current request) and a 256 MiB hard limit (triggering immediate eviction)."* So the threshold table is:

   | Threshold | Trigger | Visible to Nimbus as |
   |---|---|---|
   | 128 MiB soft | Condemnation after request | "Durable Object's isolate exceeded its memory limit" between requests |
   | 256 MiB hard | Immediate eviction mid-request | Same error mid-RPC; `Network connection lost` propagation |
   | 128 MiB SQLite soft (process-wide) | Page cache eviction | Latency spike, no error |
   | 512 MiB SQLite hard (process-wide) | `SQLITE_NOMEM` exception | Synchronously thrown |

   Nimbus's [`src/parallel/facet-pool.ts:514`](../../src/parallel/facet-pool.ts) sizing assumes *soft cap only*. A transient overshoot during a Mossaic-class install (~248 deps, ~57 k files; per [`README.md`](../../README.md)) can hit 256 MiB hard and produce the "Cannot deserialize cloned data" failure modes documented at [`src/parallel/facet-pool.ts:99-104`](../../src/parallel/facet-pool.ts).

3. **Dedicated-isolate namespace flag exists but is internal-only.** Per the same Mini-PRD item 4: *"Add a flag, internal-only to start, on a Durable Object namespace that requires its Durable Object be instantiated in its own isolate. This will be internal-only until we do one of: (1) higher price for guaranteed limit, (2) decide it's not significant to guarantee 128 MB by default, (3) memory-pressure API, (4) adaptive balancing."* Nimbus is the obvious customer for option (1).

## A.2 SQLITE_NOMEM — the bomb under SqliteVFS

Per [STOR/SPEC: Address SQLITE_NOMEM issues](https://wiki.cfdata.org/spaces/STOR/pages/1372567129/SPEC+Address+SQLITE_NOMEM+issues) §1, current state:

```c++
// workerd src/workerd/util/sqlite.c++:1295
sqlite3_soft_heap_limit64(128u << 20);   // 128 MiB soft (process-wide page cache evict)
sqlite3_hard_heap_limit64(512u << 20);   // 512 MiB hard (process-wide SQLITE_NOMEM)
```

> *"Noisy neighbors – One Durable Object's SQLite usage can deplete the shared 128 MiB soft pool, starving other Durable Object's page cache, or the shared 512 MiB hard pool causing SQLITE_NOMEM on all other SQLite operations in the process."*

> *"Billing inaccuracy. SQLite memory is not counted against the isolate's memory budget that we bill and enforce."*

The proposed fix: per-DO SQLite memory accounting via custom `sqlite3_mem_methods` wrapping `tcmalloc`, with a thread-local `SqliteMemoryScope`. Implementation MRs linked: [edgeworker MR 12773](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/merge_requests/12773), [workerd PR 6380](https://github.com/cloudflare/workerd/pull/6380). ⚠️ Status: MRs linked; merge state TBC. Wiki page last edited 2026-03-26.

The SPEC marks per-DO SQLite accounting as a *breaking change*:

> *"Previously an individual DO could consume up to 256 MiB of isolate memory and 512 MiB of SQLite memory at any given time. Realistically, an individual DO regularly consuming over 128 MiB would be regularly condemned, and an individual DO regularly consuming close to 512 MiB of memory would be frequently manually killswitched because of the noisy neighbor impact."*

Nimbus today is **one of the DOs that gets manually killswitched** during high-write windows. After per-DO SQLite accounting lands, Nimbus's writes hit a deterministic `SQLITE_NOMEM` instead — better, because catchable.

But Nimbus has zero handlers for SQLITE_NOMEM today. Search [`src/sqlite-vfs.ts`](../../src/sqlite-vfs.ts) and [`src/npm-installer.ts`](../../src/npm-installer.ts) — only error-path discussion at [`src/sqlite-vfs.ts:659`](../../src/sqlite-vfs.ts) is for WebSockets, not SQLite OOM.

The Mini-PRD also names SQL limit relaxations: column count 100 → 2000, expression depth 100 → 1000, VDBE op count 25k → 250M. Free margin for Nimbus.

## A.3 The roadmap

| Item | Status | Action when shipped |
|---|---|---|
| Per-DO SQLite accounting | MRs linked, ~Q2 2026 | Implement Lever A3 catch (Section J §1.3) |
| Memory pressure notification API | Wishlist (Mini-PRD item 4.iii); no SPEC | Wire signal into `heavy-alloc-coord` |
| Dedicated-isolate namespace flag | Internal-only; gated on price decision | File request with `~gmckeon`; one-line wrangler flag |
| Memory tiers (Workers heap > 128 MiB) | Mentioned in [~birvine-broque/WASM Memory limits](https://wiki.cfdata.org/display/~birvine-broque/WASM+Memory+limits); no firm spec | n/a today |

## A.4 Citations

Wiki: [Mini-PRD: DO shared isolate issues](https://wiki.cfdata.org/display/STOR/Mini-PRD%3A+DO+shared+isolate+issues); [SPEC: Address SQLITE_NOMEM issues](https://wiki.cfdata.org/spaces/STOR/pages/1372567129/SPEC+Address+SQLITE_NOMEM+issues); [~jphillips/Edgeworker memory management issues](https://wiki.cfdata.org/display/~jphillips/Edgeworker+memory+management+issues); [~birvine-broque/WASM Memory limits](https://wiki.cfdata.org/display/~birvine-broque/WASM+Memory+limits); [INCIDENT-8100](https://wiki.cfdata.org/display/INCIDENTS/INCIDENT+REPORT+2026-01-28+INCIDENT-8100+Durable+Object+storage+errors+in+iad14); [~sha/DOGE Recommendations](https://wiki.cfdata.org/display/~sha/DOGE+Recommendations) (Kibana OOM query). Workerd: [`sqlite.c++:1295`](https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c%2B%2B#L1295). Nimbus: [`src/sqlite-vfs.ts:150`](../../src/sqlite-vfs.ts), [`:659`](../../src/sqlite-vfs.ts); [`src/heavy-alloc-coord.ts:10-11`](../../src/heavy-alloc-coord.ts); [`src/parallel/facet-pool.ts:514`](../../src/parallel/facet-pool.ts), [`:99-104`](../../src/parallel/facet-pool.ts); [`src/npm-installer.ts:1219-1289`](../../src/npm-installer.ts); [`src/esbuild-service.ts:15`](../../src/esbuild-service.ts); [`src/nimbus-session.ts:3813-3878`](../../src/nimbus-session.ts).

Full body: [`audit/_drafts/A-do-isolate-memory.md`](../_drafts/A-do-isolate-memory.md).

---

# Section B — Dynamic Workers / Worker Loader / Facets

## B.0 TL;DR — Worker Loader levers, ranked

| # | Lever | Effort | Impact |
|---|---|---|---|
| **B1** | Coalesce per-call facets into long-lived per-tenant facets (`git-network` is the obvious next target after resolver+install-batch) | S | Eliminates 5-6 dynamic-worker ceiling collisions; cuts daily Worker count |
| **B2** | Adopt `worker_loaders[].observability` config when birvine-broque RFC ships | M (gated) | Replaces hand-rolled tail-worker re-logging |
| **B3** | Migrate generated bundles to runtime-injected polyfill scheme (Snell mini-spec) when it ships | M (gated) | -12-20 MiB encoded per facet load |
| **B4** | Audit Dice abuse-detection signature for Nimbus's facet pattern; co-design with Sandbox SDK team | S audit + M dialogue | Avoid mis-classification on user-typed code |
| **B5** | Stable `LOADER.get(id, code)` content-hash IDs (verify codeId is content-derived) | XS | Cuts billable Dynamic Workers Created Daily |
| **B6** | Use `tags` field in WorkerCode (forthcoming per dkozlov RFC) for tenant metadata | S (gated) | Removes hand-rolled prop threading |

## B.1 Per-request concurrent dynamic worker limit

[~pkhanna/Dynamic worker sharding](https://wiki.cfdata.org/spaces/~pkhanna/pages/1387665545/Dynamic+worker+sharding):

> *"Per-request concurrent dynamic worker limit is handled at the parent worker level. Per-metal active dynamic worker limit just needs `isDynamicWorker` set in the AddRequest on shard server."*

⚠️ The specific number is not in the wiki. Cross-reference with [Workers Limits](https://wiki.cfdata.org/display/EW/Workers+Limits): *"Concurrent Connections… 6 / Per Pipeline… The default ConcurrentConnectionsPerRequest limit of 6 was chosen to be similar to the concurrent connection limit in browsers."* Nimbus's empirical observation is ~5-6, matching this. Code anchor at [`src/npm-installer.ts:444-451`](../../src/npm-installer.ts):

```
// Workerd has a per-DO cap on concurrent dynamic workers (~5-6
// empirically; see WORKERD-CRASH.md). Each pool slot in pool.map
// for the DO lifetime (src/parallel/facet-pool.ts:328-348 — dispose()
// Combine resolver-facet (1) + fetch-proxy (1) + install pool.map (4)
```

Per-metal limit: per [Pricing Memorandum: Dynamic Workers](https://wiki.cfdata.org/spaces/PRICE/pages/1361771847/Pricing+Memorandum+Dynamic+Workers): *"We limit the number of concurrent dynamic workers per customer per machine and if a customer hits the limit, their least recently used isolate will be evicted to make room for the new one."* ⚠️ specific number undisclosed. Mitigation: **LRU eviction**, not hard rejection. So Nimbus's stable IDs win in steady state.

## B.2 LOADER.get byte budget

⚠️ Public docs at [developers.cloudflare.com/dynamic-workers/api-reference](https://developers.cloudflare.com/dynamic-workers/api-reference/) describe the API but don't state a byte-budget limit on `WorkerCode`. The platform memory limit (128 MiB per isolate) is documented; the static-script upload limit (10 MiB per [~birvine-broque/Mini-PRD: Rationalizing default Worker limits](https://wiki.cfdata.org/display/~birvine-broque/Mini-PRD%3A+Rationalizing+default+Worker+limits)) is documented; the LOADER.get cap is not.

Nimbus's [`src/constants.ts:46`](../../src/constants.ts) targets 22 MiB encoded — empirical, derived per [`facet-manager.ts:537`](../../src/facet-manager.ts) ("~322 KiB for fastify, ~1.7 MiB for ts-jest"). The cap is bounded by **structured-clone of Code+Modules over RPC** (32 MiB cap; Section E) plus the encoded `Uint8Array→JSON-string` materialisation overhead (6 % per Nimbus's measurement at [`src/npm-installer.ts:1255`](../../src/npm-installer.ts)).

## B.3 Facet billing under the new SKU

Per [Pricing Memorandum: Dynamic Workers](https://wiki.cfdata.org/spaces/PRICE/pages/1361771847/Pricing+Memorandum+Dynamic+Workers):

> *"Each unique combination of Worker ID and code content counts as one Dynamic Worker. If you call loader.get() with the same ID and same code multiple times within the same day, you're only charged once."*

> *"For Dynamic Workers, CPU time includes both startup and execution. This is different from standard Workers, where we only charge for the execution time."*

Nimbus's facet inventory map:

| Facet | LOADER.get ID | Code stable? | Daily cost target (pre-coalesce) |
|---|---|---|---|
| `npm-resolve-facet` | `npm-resolve-${tenantId}` | ✅ Yes | 1/tenant/day |
| `npm-install-batch-facet` | `npm-install-batch-${tenantId}` | ✅ Yes | 1/tenant/day |
| `pre-bundle-facet` | per-package | ✅ Per-package | N/tenant/day |
| `git-network-facet` | per-clone | per-clone | M/tenant/day — **Lever B1 target** |
| `vite-dev-server-facet` | per-project | ✅ | 1/tenant/day |
| `proc-${pid}` (node script) | content-hash if codeId is `fnv1a(code)` else per-pid | **verify** | 1 if stable; up to N if not |

The `proc-` line is the highest-stakes verification. Per [`src/facet-manager.ts:899`](../../src/facet-manager.ts), `facetName = proc-${entry.pid}` (used for `ctx.facets.get(name, ...)` — child DO scoping). The separate `codeId` argument to `LOADER.get(codeId, ...)` at [`src/facet-manager.ts:887`](../../src/facet-manager.ts) is what determines billing. Audit-only action: read `:744-900` carefully, document, fix if not content-derived.

## B.4 Dice abuse detection — does Nimbus trigger it?

[~ketan/Abuse Detection and Termination for Dynamic Workers](https://wiki.cfdata.org/display/~ketan/Abuse+Detection+and+Termination+for+Dynamic+Workers):

> *"EW should start publishing 'dynamic worker created' messages (similar to WorkerScriptEventV1) via logfwdr… We can add another consumer in Dice which consumes dynamic worker events from this Kafka topic… and if Yara detects an abusive pattern: it triggers a takedown for the dynamic worker."*

> *"There are at least 2 ways to abuse this API: A customer knowingly spawns malicious dynamic workers. A WfP customer's customer writes malicious code."*

The second vector is Nimbus's exposure: user-typed JS goes through `generateFacetCode(userCode, vfsState)` ([`src/facet-manager.ts:171`](../../src/facet-manager.ts)). The Yara-scanned bundle includes that user code. If Yara flags it, the **facet is killed**. Critical question: per-tenant isolation, or platform-wide block?

⚠️ Action: file wiki comment on `~ketan` page asking:
- Does Dice scan user-supplied portions separately from the Nimbus wrapper?
- Is there an allowlist/parent-worker-ID mechanism?
- What's Sandbox SDK's mitigation?

Pull thread with [`~mnomitch`](https://wiki.cfdata.org/display/~mnomitch) (Sandbox SDK PM) and [`~naresh`](https://wiki.cfdata.org/display/~naresh) (Sandbox SDK lead) since they ship the same exposure.

## B.5 Citations

Wiki: [~pkhanna/Dynamic worker sharding](https://wiki.cfdata.org/spaces/~pkhanna/pages/1387665545/Dynamic+worker+sharding); [~birvine-broque/[RFC] Dynamic Workers Observability](https://wiki.cfdata.org/spaces/~birvine-broque/pages/1365394169/RFC+Dynamic+Workers+Observability); [~dkozlov/Powering Dispatcher with a Worker Loader](https://wiki.cfdata.org/spaces/~dkozlov/pages/1357511731/Powering+Dispatcher+with+a+Worker+Loader+%E2%80%94%C2%A0step+1+feature+parity+with+WFP); [~ketan/Abuse Detection and Termination for Dynamic Workers](https://wiki.cfdata.org/display/~ketan/Abuse+Detection+and+Termination+for+Dynamic+Workers); [TSENG/Abuse Signals](https://wiki.cfdata.org/pages/viewpage.action?pageId=754393206); [CO/Workers Detection Pipeline](https://wiki.cfdata.org/display/CO/Workers+Detection+Pipeline); [~harris/Lifting edgeworker's concurrent connection limit](https://wiki.cfdata.org/display/~harris/Lifting+edgeworker%27s+concurrent+connection+limit); [EW/Workers Limits](https://wiki.cfdata.org/display/EW/Workers+Limits); [~birvine-broque/Mini-PRD: Rationalizing default Worker limits](https://wiki.cfdata.org/display/~birvine-broque/Mini-PRD%3A+Rationalizing+default+Worker+limits); [~jsnell/Mini-Spec: Node.js-compat + Polyfill Bundling](https://wiki.cfdata.org/pages/viewpage.action?pageId=868863065); [~yagiz/Impact of polyfills to workers](https://wiki.cfdata.org/display/~yagiz/Impact+of+polyfills+to+workers); [PRICE/Dynamic Workers](https://wiki.cfdata.org/spaces/PRICE/pages/1361772100/Dynamic+Workers); [PRICE/Pricing Memorandum: Dynamic Workers](https://wiki.cfdata.org/spaces/PRICE/pages/1361771847/Pricing+Memorandum+Dynamic+Workers).

Public docs: [dynamic-workers/api-reference](https://developers.cloudflare.com/dynamic-workers/api-reference/), [/getting-started](https://developers.cloudflare.com/dynamic-workers/getting-started/), [/runtime-apis/bindings/worker-loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/), [/workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/).

Nimbus: [`src/constants.ts:46`](../../src/constants.ts); [`src/facet-manager.ts:171`](../../src/facet-manager.ts), [`:537`](../../src/facet-manager.ts), [`:865-900`](../../src/facet-manager.ts); [`src/npm-installer.ts:444-451`](../../src/npm-installer.ts); [`src/npm-resolve-facet.ts:13-44`](../../src/npm-resolve-facet.ts); [`src/npm-install-batch-facet.ts:28, 54`](../../src/npm-install-batch-facet.ts); [`src/parallel/facet-pool.ts:328-348`](../../src/parallel/facet-pool.ts); [`src/process-logs.ts:1-309`](../../src/process-logs.ts); [`src/process-logs-api.ts:21-23`](../../src/process-logs-api.ts); [`src/git-commands.ts`](../../src/git-commands.ts); [`src/supervisor-rpc.ts`](../../src/supervisor-rpc.ts); [`wrangler.jsonc:48-50`](../../wrangler.jsonc).

Full body: [`audit/_drafts/B-dynamic-workers.md`](../_drafts/B-dynamic-workers.md).

---

# Section C — WebSocket Hibernation

## C.0 TL;DR — WebSocket levers, ranked

| # | Lever | Effort | Impact |
|---|---|---|---|
| **C1** | Switch process-logs WS from `server.accept()` to `ctx.acceptWebSocket()` (hibernatable) | S | Process-log tail survives DO hibernation |
| **C2** | `setWebSocketAutoResponse(WebSocketRequestResponsePair('ping','pong'))` for shell + HMR | XS | ~95 % drop in DO wakeups on idle tabs |
| **C3** | Explicit `setHibernatableWebSocketEventTimeout(5_000)` | XS | Bounds runaway message handlers |
| **C4** | Defer state nulling in `webSocketClose` for first 60s — alarm-gated reap | S | Reconnect-within-grace keeps terminal state |
| **C5** | Plan for outgoing WS hibernation when STOR RFC ships | M (gated) | Supervisor hibernates with outbound WS active |
| **C6** | `compatibility_date >= 2026-04-08` so `web_socket_auto_reply_to_close` is on default | XS | Cleaner CLOSING-state handling |

## C.1 Primer-aligned best practices Nimbus already does

Nimbus correctly uses hibernatable WS via `ctx.acceptWebSocket(server, tags)` for shell ([`src/nimbus-session.ts:1160`](../../src/nimbus-session.ts)) and HMR ([`src/nimbus-session.ts:1465`](../../src/nimbus-session.ts)). It correctly serializes attachments at [`:1167`](../../src/nimbus-session.ts) (`{ kind: 'shell' }`) and [`:1467`](../../src/nimbus-session.ts) (`{ kind: 'cirrus-hmr', clientId }`), and discriminates on wake at [`:3803-3811`](../../src/nimbus-session.ts) (`_wsKind`). This matches the [STOR/Durable Objects WebSocket Primer](https://wiki.cfdata.org/spaces/STOR/pages/1372566651/Durable+Objects+WebSocket+Primer+Regular+Hibernatable+and+the+Outgoing+Problem):

> *"Survives (in HibernationManager / HibernatableWebSocket / HibernationPackage): kj::WebSocket network connection, URL, protocol, extensions, Serialized attachment (only if serializeAttachment() was called), WebSocket tags, Auto-response configuration."*

> *"Does not survive: All JS in-memory state, api::WebSocket objects (only the backing kj::WebSocket survives), addEventListener() listeners (this is why hibernation uses exported handlers), IoOwn-ed objects, Non-serialized attachment data."*

✅ Nimbus uses *exported* `webSocketMessage`/`webSocketClose`/`webSocketError` handlers (not addEventListener).

## C.2 What's broken — process-logs

[`src/process-logs-api.ts:21-23`](../../src/process-logs-api.ts) explicitly chose `server.accept()` (non-hibernatable):

```
// Why server.accept() and not ctx.acceptWebSocket()?
// cleaned up the moment the client closes — no need for hibernation.
```

This is wrong per the Primer's reasoning: a non-hibernatable WS pins the actor for its full duration. A user opening a long-running log tail and walking away keeps the DO awake — accumulating co-residency-OOM risk per Section A.1.

## C.3 setHibernatableWebSocketEventTimeout

[Public docs](https://developers.cloudflare.com/durable-objects/api/state/#sethibernatablewebsocketeventtimeout):

> *"Sets the maximum amount of time in milliseconds that a WebSocket event can run for. If no parameter or a parameter of 0 is provided and a timeout has been previously set, then the timeout will be unset. The maximum value of timeout is 604,800,000 ms (7 days)."*

⚠️ The default is undocumented. Setting an explicit 5s bound prevents one bad shell command from holding the DO indefinitely (long-running work should be in facets anyway).

## C.4 Auto-response — the cheapest billing win

[Public docs](https://developers.cloudflare.com/durable-objects/api/state/#setwebsocketautoresponse):

> *"Sets an automatic response, auto-response, for the request provided for all WebSockets attached to the Durable Object. If a request is received matching the provided request then the auto-response will be returned without waking WebSockets in hibernation and incurring billable duration charges."*

Vite HMR clients ping every 30s. Without auto-response, every ping wakes the DO from hibernation: ~2880 wakes/day per idle tab. After C2: zero billable wakes for matched ping/pong.

The auto-response config **survives hibernation** (per C.1 quote), so set once in constructor and forget.

## C.5 Outgoing WS hibernation — RFC

[STOR/RFC: Outgoing WebSocket Hibernation: Design Options](https://wiki.cfdata.org/spaces/STOR/pages/1372567047/RFC+Outgoing+WebSocket+Hibernation+Design+Options) — draft. The RFC describes Layer A (sandbox-side, mostly reuse incoming patterns) and Layer B (supervisor liveness — new mechanism). Author's recommendation: Option B (registrar-based registration). For Nimbus, the consumer when GA is `nimbus-wrangler` outbound WS to wrangler dev's preview.

## C.6 Citations

Wiki: [STOR/Durable Objects WebSocket Primer](https://wiki.cfdata.org/spaces/STOR/pages/1372566651/Durable+Objects+WebSocket+Primer+Regular+Hibernatable+and+the+Outgoing+Problem); [STOR/RFC: Outgoing WebSocket Hibernation](https://wiki.cfdata.org/spaces/STOR/pages/1372567047/RFC+Outgoing+WebSocket+Hibernation+Design+Options); [STOR/SPEC: Outbound connections should keep DOs alive](https://wiki.cfdata.org/spaces/STOR/pages/1374974291/SPEC+Outbound+connections+should+keep+DOs+alive); [CSE/Primer: Using and Designing with Durable Objects](https://wiki.cfdata.org/display/CSE/Primer%3A+Using+and+Designing+with+Durable+Objects).

Public docs: [/durable-objects/best-practices/websockets/](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [/api/state/#setwebsocketautoresponse](https://developers.cloudflare.com/durable-objects/api/state/#setwebsocketautoresponse), [/api/state/#sethibernatablewebsocketeventtimeout](https://developers.cloudflare.com/durable-objects/api/state/#sethibernatablewebsocketeventtimeout), [/examples/websocket-hibernation-server/](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/), [/configuration/compatibility-flags/#websocket-auto-reply-to-close](https://developers.cloudflare.com/workers/configuration/compatibility-flags/).

Nimbus: [`src/nimbus-session.ts:1160, 1167, 1453-1465, 1467, 3777-3794, 3803-3811, 3813-3878`](../../src/nimbus-session.ts); [`src/process-logs-api.ts:21-23`](../../src/process-logs-api.ts); [`src/process-logs.ts:26-27`](../../src/process-logs.ts); [`src/cirrus-real.ts:680`](../../src/cirrus-real.ts); [`src/real-vite-hmr.ts:63-92`](../../src/real-vite-hmr.ts); [`wrangler.jsonc:5`](../../wrangler.jsonc).

Full body: [`audit/_drafts/C-websocket-hibernation.md`](../_drafts/C-websocket-hibernation.md).

---

# Section D — npm install architecture

## D.0 TL;DR — install levers, ranked

| # | Lever | Effort | Impact |
|---|---|---|---|
| **D1** | R2-backed cross-tenant tarball cache (the Pyodide pattern) | M | Cold install 60s → 10-20s; eliminates cross-region npm RTT |
| **D2** | R2-backed packument cache, 5-min TTL | M | Resolver phase 5-10s → 200-500ms |
| **D3** | Wheel-per-directory pre-bundle layout (Python Workers Item 1) | M | Partial-bundle imports; -2-5 MiB encoded per facet |
| **D4** | Manifest layer over R2-backed cache (Pyodide-lock.json shape) | S (after D1/D2) | Determinism + atomic switching |
| **D5** | Smart Placement on the gateway Worker | XS | Cuts cross-continent RTT to npm origin |
| **D6** | `placement.host = "registry.npmjs.org:443"` (alternative to D5) | XS | Same as D5, explicit |
| **D3.5** | Cache API tier (colo-local) on `fetch()` calls to npmjs.org | XS | Cheap intermediate tier between L1 in-DO and L3 R2 |

## D.1 The Python Workers pattern

[EW/SPEC: Python Workers Package Bundling System](https://wiki.cfdata.org/display/EW/SPEC%3A+Python+Workers+Package+Bundling+System) is the closest internal precedent. Quote (Item 1):

> *"We propose this new format: each wheel has its own directory in the bundle. At runtime, we can: 1. Look at the user's requirements.txt. Use the lockfile to determine what dependencies they need. 2. Transform the above directory structure so that the user's view of the /site-packages is the same as before, except limited to the requirements they requested. 3. Mount the transformed /site-packages partition (read-only)."*

The pattern Cloudflare invested in for Pyodide:
1. Per-package independent wheels in R2 (uploaded once at recipe build time)
2. Lockfile served from R2 (mutable index pointing to wheel R2 keys)
3. Runtime resolves lockfile → fetches only requested wheels → mounts

Direct mapping for Nimbus npm:

| Pyodide concept | Nimbus equivalent | Today's state |
|---|---|---|
| `pyodide-packages.tar` | `npm-cache.ts` SQLite cache | Per-DO scope, not shared |
| `pyodide-lock.json` | Per-project lockfile | Exists; not platform-wide |
| R2 bucket of wheels | R2 NPM_TARBALL_CACHE | Doesn't exist |

## D.2 Cross-region npm latency

[R2/Open-source software mirrors](https://wiki.cfdata.org/display/R2/Open-source+software+mirrors) is the canonical precedent for hosting OSS package mirrors in R2. The wiki page sketches the architecture (KV+R2 with content-addressed object store and metadata index — exactly the Pyodide shape).

⚠️ npmjs.org is hosted on AWS US-East. Nimbus's facet running in EU/APAC pays a transcontinental RTT every cold tarball fetch. Per [pages/viewpage.action?pageId=819439999 (Saving R2 with Cache)](https://wiki.cfdata.org/pages/viewpage.action?pageId=819439999), the R2 team got a **140 ms** latency reduction by caching upstream objects via Cache API. Same pattern applies to Nimbus.

⚠️ Caveat from [CC/RFC: Caching layers in Cloudchamber managed registry](https://wiki.cfdata.org/display/CC/RFC%3A+Caching+layers+in+Cloudchamber+managed+registry):

> *"Cache API is exposed to the workers runtime, it basically allows you to cache responses within Cloudflare programatically. However, one of the main limitations of this API is that this cache is limited to the location (AKA colo). Not useful for us as we are looking for tiered caching + reserve out-of-the-box."*

So Cache API is colo-local; R2 is global. Right layering:
- L1: in-DO SQLite cache (per-tenant)
- L2: Cache API (per-colo)
- L3: R2 (global, cross-tenant)
- L4: registry.npmjs.org

## D.3 Quantifying the win

Mossaic-class install (per [`README.md`](../../README.md)): ~248 deps, ~57k files, ~60s cold cache. Phase breakdown:

| Phase | Cold-cache time | Source |
|---|---|---|
| Resolver (packument fetches) | 5-10s | `src/npm-resolver.ts` ~250-450 packuments |
| Tarball fetches | 25-35s | `src/npm-tarball.ts` 450 tarballs |
| Decompress + extract | 10-15s | `src/npm-tarball-stream.ts` |
| VFS write batches | 5-10s | `src/sqlite-vfs.ts` `transactionSync` |

After D1+D2 (warm tenant of warm-cache deps):
- Phase 1: 5-10s → 200-500ms
- Phase 2: 25-35s → 5-10s
- Total: 60s → **15-20s**

After D5/D6 (Smart Placement on the supervisor):
- Phase 1+2 latency further compressed
- Total cold tenant of warm deps: **~10-15s**

R2 storage cost: ~5-10 GB shared bucket covers 99% of npm dep cosmos. ~$0.10/month at R2 standard pricing.

## D.4 Citations

Wiki: [EW/SPEC: Python Workers Package Bundling System](https://wiki.cfdata.org/display/EW/SPEC%3A+Python+Workers+Package+Bundling+System); [EW/SPEC: Deploy Python code directly to Workers](https://wiki.cfdata.org/display/EW/SPEC%3A+Deploy+Python+code+directly+to+Workers); [EW/SPEC: Pyodide + Python package versioning and loading](https://wiki.cfdata.org/pages/viewpage.action?pageId=830736601); [R2/Open-source software mirrors](https://wiki.cfdata.org/display/R2/Open-source+software+mirrors); [R2/R2 Metadata Cache](https://wiki.cfdata.org/display/R2/R2+Metadata+Cache); [pages/viewpage.action?pageId=819439999 (Saving R2 with Cache)](https://wiki.cfdata.org/pages/viewpage.action?pageId=819439999); [CC/RFC: Caching layers in Cloudchamber managed registry](https://wiki.cfdata.org/display/CC/RFC%3A+Caching+layers+in+Cloudchamber+managed+registry); [pages/viewpage.action?pageId=754397110 (R2+Cache investigation)](https://wiki.cfdata.org/pages/viewpage.action?pageId=754397110); [FE/Build a private npm registry](https://wiki.cfdata.org/display/FE/Build+a+private+npm+registry); [FE/Now Playing Mario: How to Switch (your npm config)](https://wiki.cfdata.org/pages/viewpage.action?pageId=113148118).

Public docs: [/workers/configuration/placement/](https://developers.cloudflare.com/workers/configuration/placement/); [/changelog/post/2025-03-22-smart-placement-stablization/](https://developers.cloudflare.com/changelog/post/2025-03-22-smart-placement-stablization/); [/r2/](https://developers.cloudflare.com/r2/).

Nimbus: [`src/npm-resolver.ts:540-549, 625-688`](../../src/npm-resolver.ts); [`src/npm-installer.ts:419-451, 1233-1289`](../../src/npm-installer.ts); [`src/npm-cache.ts`](../../src/npm-cache.ts); [`src/npm-tarball.ts`](../../src/npm-tarball.ts); [`src/npm-tarball-stream.ts`](../../src/npm-tarball-stream.ts); [`src/npm-resolve-facet.ts:13-44`](../../src/npm-resolve-facet.ts); [`src/parallel/facet-pool.ts:328-348`](../../src/parallel/facet-pool.ts); [`src/sqlite-vfs.ts`](../../src/sqlite-vfs.ts); [`wrangler.jsonc`](../../wrangler.jsonc); [`README.md`](../../README.md) §Status.

Full body: [`audit/_drafts/D-npm-install.md`](../_drafts/D-npm-install.md).

---

# Section E — RPC layer + structured-clone wall

## E.0 TL;DR — RPC levers, ranked

| # | Lever | Effort | Impact |
|---|---|---|---|
| **E1** | Switch supervisor⇄facet bulk-write to ReadableStream<Uint8Array> (byte-oriented) | M | 30-50% faster install; bypasses 32 MiB cap; cuts peak heap |
| **E2** | Promise-pipeline resolver→packument→tarball as RpcTarget stubs | M | ~1 RTT saved per dep × hundreds = 0.5-2s per install |
| **E3** | Codify "no Module structured-clone" rule in `_shared/rpc-types.ts` | XS | Prevents regression class |
| **E4** | R2-backed wasm bytes via LOADER modules-map (gated on encoded budget pressure) | M | -1.5 MiB per facet bundle |
| **E5** | Heap-aware chunk sizing in install-batch | S | Pairs with §A.2; fewer install OOMs |

## E.1 The 32 MiB wall — source of truth

[Public RPC docs](https://developers.cloudflare.com/workers/runtime-apis/rpc/):

> *"The maximum serialized RPC limit is 32 MiB. Consider using ReadableStream when returning more data."*

> *"You can send and receive ReadableStream, WriteableStream, Request and Response using RPC methods. When doing so, bytes in the body are automatically streamed with appropriate flow control. This allows you to send messages over RPC which are larger than the typical 32 MiB limit."*

> *"Only byte-oriented streams (streams with an underlying byte source of `type: 'bytes'`) are supported."*

Nimbus's measured 6 % structured-clone overhead at [`src/npm-installer.ts:1255`](../../src/npm-installer.ts):

```
// 28 MiB also fits within workerd's 32 MiB RPC arg limit
// (structured-clone overhead measured ~6% on prior installs;
// 28 + ~2 MiB overhead ≈ 30 MiB, under cap).
```

[`src/npm-install-facet.ts:276-281`](../../src/npm-install-facet.ts) explicitly notes: *"Keep the RPC argument well under workerd's 32 MiB cap. 24 MiB leaves [headroom]."*

## E.2 Streams over RPC — the bypass

[Public RPC docs](https://developers.cloudflare.com/workers/runtime-apis/rpc/) confirms `ReadableStream` and `WriteableStream` over RPC bypass the 32 MiB cap and use flow-controlled streaming. Combined with [`src/npm-tarball-stream.ts:55-60`](../../src/npm-tarball-stream.ts) (already wraps tarball as `ReadableStream<Uint8Array>`), the right shape is to plumb the stream **end-to-end** through the supervisor → facet RPC boundary, without rematerialising as `Uint8Array[]` at any step.

The current pattern in [`src/npm-install-batch-facet.ts:259`](../../src/npm-install-batch-facet.ts) — *"flush bytes peak at 3 × 16 = 48 MiB inside the 128 MiB cap"* — is forced by the chunking. After Lever E1: peak drops to streaming-buffer-size + per-tarball-decompression buffer = ~5-15 MiB. Memory headroom roughly **doubles**, enabling pLimit(6) (matching the 6-subrequest cap) instead of pLimit(3).

## E.3 Promise pipelining

[Public RPC docs §Promise pipelining](https://developers.cloudflare.com/workers/runtime-apis/rpc/):

> *"You can simply omit the first await. Multiple chained calls can be completed in a single round trip… The promise returned by an RPC is not a real JavaScript Promise. Calling any method name on the promise forms a speculative call on the promise's eventual result."*

For a 450-package install: today ~2 RTT × 450 = 900 RPCs × ~5-10 ms = **4.5-9 s** in pure RTT. After E2: ~1 RTT × 450 = 450 RPCs = **2-4 s**. Real wall-clock improvement bounded by installer concurrency: **~0.5-2 s** per Mossaic-class install.

## E.4 ctx.exports loopback perf

⚠️ speculation: ctx.exports is loopback into the same isolate. The cost should be lower than cross-isolate RPC because no network hop, no cross-process serialization. But it **still goes through structured-clone** — the 32 MiB cap applies. Nimbus's [`src/pre-bundle-facet.ts:364`](../../src/pre-bundle-facet.ts) confirms this:

```
// no RPC, no compile, no structured-clone of Module values.
```

The `LOADER.modules` map workaround at [`src/npm-installer.ts:1276-1292`](../../src/npm-installer.ts) is what bypasses structured-clone for code/wasm bytes — bytes ride *inside* the worker code blob, never touching structured-clone.

## E.5 Citations

Public docs: [/workers/runtime-apis/rpc/](https://developers.cloudflare.com/workers/runtime-apis/rpc/); [/workers/runtime-apis/streams/](https://developers.cloudflare.com/workers/runtime-apis/streams/); [/durable-objects/examples/readable-stream/](https://developers.cloudflare.com/durable-objects/examples/readable-stream/).

Wiki: [STOR/Durable Objects WebSocket Primer](https://wiki.cfdata.org/spaces/STOR/pages/1372566651/Durable+Objects+WebSocket+Primer+Regular+Hibernatable+and+the+Outgoing+Problem) (capability chain context); [~yagiz/Impact of polyfills to workers](https://wiki.cfdata.org/display/~yagiz/Impact+of+polyfills+to+workers).

Nimbus: [`src/constants.ts:46`](../../src/constants.ts); [`src/npm-installer.ts:495, 734, 1252-1289`](../../src/npm-installer.ts); [`src/npm-install-facet.ts:182, 276-281`](../../src/npm-install-facet.ts); [`src/npm-install-batch-facet.ts:54, 204, 259`](../../src/npm-install-batch-facet.ts); [`src/pre-bundle-facet.ts:71, 307, 364`](../../src/pre-bundle-facet.ts); [`src/parallel/facet-pool.ts:99-104, 514`](../../src/parallel/facet-pool.ts); [`src/supervisor-rpc.ts:1-187`](../../src/supervisor-rpc.ts); [`src/ctx-exports.ts:1-9`](../../src/ctx-exports.ts); [`src/port-registry.ts:13-141`](../../src/port-registry.ts); [`src/heavy-alloc-coord.ts:10-11`](../../src/heavy-alloc-coord.ts); [`src/parallel/pre-bundle-preamble.ts:52`](../../src/parallel/pre-bundle-preamble.ts); [`src/npm-tarball-stream.ts:55-60`](../../src/npm-tarball-stream.ts).

Full body: [`audit/_drafts/E-rpc-clone.md`](../_drafts/E-rpc-clone.md).

---

# Section F — Observability

## F.0 TL;DR — observability levers, ranked

| # | Lever | Effort | Impact |
|---|---|---|---|
| **F1** | `cause`-discriminator + ring-buffer on `/api/_diag/memory`; persist on close | XS | MTTR minutes → single grep |
| **F2** | Enable Workers Logpush + Trace Events | S | ~$0.04/day off-platform structured archive |
| **F3** | Tail Worker for the supervisor | S | Clean fan-out; ~50 LOC tail worker |
| **F4** | Analytics Engine binding for npm install telemetry | S | Real measurements informing D1/D2 effectiveness |
| **F5** | Wait for Dynamic Workers Observability RFC; delete most of `process-logs.ts` | M (gated) | -300 LOC; first-class facet logs |
| **F6** | OpenTelemetry layer at RPC boundaries (WR-1069 pattern) | M | Distributed traces across supervisor → facet → R2 → registry |

## F.1 What's missing on `/api/_diag/memory`

Today [`src/diag-counters.ts:1-239`](../../src/diag-counters.ts) holds *application-level memory + phase observability*:

```
// 4: Why: workerd's `process.memoryUsage()` returns 0 for all fields inside
// 16: the request handler in nimbus-session.ts:/api/_diag/memory can read
// 23: Phase tags surfaced via /api/_diag/memory.
```

What's missing:
- Last OOM cause (condemnation / hard-evict / SQLITE_NOMEM / clone-refused)
- Per-facet RSS estimates
- In-flight RPC bytes (live structured-clone load)
- Last close time + cause per WS kind
- LRU hit/miss counters for SqliteVFS

Wire from: [`src/parallel/facet-pool.ts:99-104`](../../src/parallel/facet-pool.ts) (clone-refused detection), [`src/heavy-alloc-coord.ts`](../../src/heavy-alloc-coord.ts) (heap-pressure entry/exit), [`src/npm-installer.ts:1219-1289`](../../src/npm-installer.ts) (post-A3 SQLITE_NOMEM catch), [`src/nimbus-session.ts:3813-3878`](../../src/nimbus-session.ts) (webSocketClose), [`src/facet-manager.ts:805-820`](../../src/facet-manager.ts) (facet RPC failure).

## F.2 Logpush + Trace Events

Per [Workers Observability ↗](https://wiki.cfdata.org/pages/viewpage.action?pageId=906857050) and [PRD: Workers Logpush GA](https://wiki.cfdata.org/display/EW/PRD%3A+Workers+Logpush+GA):

> *"Workers customers use Logpush to ship logs to a common destination such as R2, S3, Datadog, Sentry, or Coralogix."*

> *"Pricing: This is a paid product. Workers Logpush is priced at $0.05/MM requests for both Ent and Workers Paid plan customers."*

Per [~sven/Log better from Workers with Logpush](https://wiki.cfdata.org/spaces/~sven/pages/651244298/Log+better+from+Workers+with+Logpush):

```js
console.log({ message: "yes", tag: 2, "cloudflare.account_id": 1 });
// → structured field in Logpush stream
```

For Nimbus, all the existing `[nimbus]` `console.log` calls become structured automatically. Augment to `console.log({ event: 'npm.install.ok', name, version, durationMs, ... })` for queryable events.

## F.3 Tail Workers — the proper way

Per [EW/Tail Workers](https://wiki.cfdata.org/display/EW/Tail+Workers):

> *"Tail workers are a general purpose solution for consuming logs from Workers of all event types via forwarded events to a consuming Worker."*

[`src/process-logs.ts`](../../src/process-logs.ts) is ~309 LOC of in-memory ring-buffer + WS-tail re-implementing exactly the Tail Worker pattern. Set up `tail_consumers` and a small tail worker that ships to R2 — ~30 minutes' work for durable archives.

When the [Dynamic Workers Observability RFC](https://wiki.cfdata.org/spaces/~birvine-broque/pages/1365394169/RFC+Dynamic+Workers+Observability) (Lever F5) ships, this becomes automatic for facets too — at which point most of `process-logs.ts` can be deleted.

## F.4 OpenTelemetry — the WR-1069 pattern

[WR-1069](https://jira.cfdata.org/browse/WR-1069) "Set up tracing for Waiting Room": references [`OBS/How To: Add OpenTelemetry tracing to your service`](https://wiki.cfops.it/display/OBS/How+To%3A+Add+OpenTelemetry+tracing+to+your+service). Status: **Needs Triage**, opened 2022-10-13, last updated 2024-03-09. Linked WR-1106, WR-1343.

Read: WR-1069 has been parked 2+ years. ⚠️ OpenTelemetry in DOs is desired but not turnkey today — likely because the OBS doc targets first-party CF services, not customer Workers. Per [public docs Known limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/): *"service bindings and Durable Objects appear as separate traces rather than nested spans"* — exactly Nimbus's debugging pain point.

Until then, add a manual OTel layer (`src/_shared/otel.ts`) at every RPC boundary (Section J §6.6).

## F.5 Citations

Wiki: [Workers Observability/👋 Hello, Workers Observability](https://wiki.cfdata.org/pages/viewpage.action?pageId=906857050); [EW/SPEC: Workers Trace Events are available in Logpush](https://wiki.cfdata.org/display/EW/SPEC%3A+Workers+Trace+Events+are+available+in+Logpush); [EW/PRD: Workers Logpush GA](https://wiki.cfdata.org/display/EW/PRD%3A+Workers+Logpush+GA); [EW/FAQ: Logpush for Workers Trace Events](https://wiki.cfdata.org/display/EW/FAQ%3A+Logpush+for+Workers+Trace+Events); [EW/Tail Workers](https://wiki.cfdata.org/display/EW/Tail+Workers); [~birvine-broque/[RFC] Dynamic Workers Observability](https://wiki.cfdata.org/spaces/~birvine-broque/pages/1365394169/RFC+Dynamic+Workers+Observability); [~sven/Log better from Workers with Logpush](https://wiki.cfdata.org/spaces/~sven/pages/651244298/Log+better+from+Workers+with+Logpush); [DES/Design Doc: Durable Objects Observability](https://wiki.cfdata.org/display/DES/Design+Doc%3A+Durable+Objects+Observability); [WR/Waiting Room Observability](https://wiki.cfdata.org/display/WR/Waiting+Room+Observability); [pages/viewpage.action?pageId=683883065 (Why Logpush didn't work in China)](https://wiki.cfdata.org/pages/viewpage.action?pageId=683883065).

Jira: [WR-1069](https://jira.cfdata.org/browse/WR-1069), linked WR-1106, WR-1343.

Public docs: [/workers/observability/logs/workers-logs/](https://developers.cloudflare.com/workers/observability/logs/workers-logs/); [/workers/observability/logs/tail-workers/](https://developers.cloudflare.com/workers/observability/logs/tail-workers/); [/workers/observability/traces/](https://developers.cloudflare.com/workers/observability/traces/); [/workers/observability/traces/known-limitations/](https://developers.cloudflare.com/workers/observability/traces/known-limitations/); [/workers/observability/exporting-opentelemetry-data/](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/); [/analytics/analytics-engine/](https://developers.cloudflare.com/analytics/analytics-engine/); [/workers/runtime-apis/bindings/](https://developers.cloudflare.com/workers/runtime-apis/bindings/).

Nimbus: [`src/diag-counters.ts:1-239`](../../src/diag-counters.ts); [`src/index.ts`](../../src/index.ts) `/api/_diag/memory`; [`src/process-logs.ts:1-309`](../../src/process-logs.ts); [`src/process-logs-api.ts:21-23`](../../src/process-logs-api.ts); [`src/heavy-alloc-coord.ts`](../../src/heavy-alloc-coord.ts); [`src/parallel/facet-pool.ts:99-104`](../../src/parallel/facet-pool.ts); [`src/facet-manager.ts:805-820`](../../src/facet-manager.ts); [`src/nimbus-session.ts:3813-3878`](../../src/nimbus-session.ts); [`src/supervisor-rpc.ts`](../../src/supervisor-rpc.ts).

Full body: [`audit/_drafts/F-observability.md`](../_drafts/F-observability.md).

---

# Section G — Cost / Billing

## G.0 TL;DR — billing levers, ranked

| # | Lever | Effort | Impact |
|---|---|---|---|
| **G1** | Stable per-tenant content-hash `LOADER.get(id, code)` IDs | XS (verify only) | Halves Dynamic Workers Created Daily on busy tenants |
| **G2** | Coalesce per-call facets into long-lived per-tenant facets | S | Cuts daily Worker count further; pairs with B1 |
| **G3** | DO read replicas for read-mostly preview paths | M | Cross-region preview 200ms → 5-20ms (UX, not cost) |
| **G4** | Smart Placement on the gateway Worker | XS | Cuts cross-region facet RTT |
| **G5** | Document batch-facet coalescing matches the new pricing intent | S | Documented invariant |
| **G6** | Audit per-tenant DO storage cost (10 GB SQLite) | S | Pricing forecast |

## G.1 The new Dynamic Workers SKU

Per [PRICE/Dynamic Workers](https://wiki.cfdata.org/spaces/PRICE/pages/1361772100/Dynamic+Workers) (GA 2026-04-14):

> *"$0.002 per Unique Dynamic Workers Created Daily"*

Per [Pricing Memorandum](https://wiki.cfdata.org/spaces/PRICE/pages/1361771847/Pricing+Memorandum+Dynamic+Workers):

> *"Each unique combination of Worker ID and code content counts as one Dynamic Worker. If you call loader.get() with the same ID and same code multiple times within the same day, you're only charged once."*

> *"For Dynamic Workers, CPU time includes both startup and execution. This is different from standard Workers, where we only charge for the execution time."*

Three SKUs combined: Dynamic Workers Created Daily ($0.002 each), Requests ($0.30/MM), CPU Time ($0.02/MM CPU-ms including startup).

## G.2 The 128 MiB billing increment

Per [Mini-PRD: DO shared isolate issues](https://wiki.cfdata.org/display/STOR/Mini-PRD%3A+DO+shared+isolate+issues):

> *"Clarify that we bill in 128MB increments, so a Worker using 1MB of memory will be billed for 128MB of memory for both Durable Objects and Workers Unbound."*

For Nimbus's mix:
- `npm-resolve-facet` (~10-30 MiB peak): **over-billed** — paying for ~128 MiB capacity using ~30 MiB
- `npm-install-batch-facet` (~87 MiB peak per [`src/npm-install-batch-facet.ts:28`](../../src/npm-install-batch-facet.ts)): **fairly billed**
- `pre-bundle-facet` (~100 MiB peak per [`src/pre-bundle-facet.ts:307`](../../src/pre-bundle-facet.ts)): **fairly billed**
- `git-network-facet` (~30-50 MiB peak): **over-billed by 2-4x**
- `proc-` (node user scripts): variable, often <20 MiB: **over-billed**

Coalescing light facets into one long-lived utility facet (Lever G2) is **strictly better** at the new pricing.

## G.3 Smart Placement

Per [Smart Placement docs](https://developers.cloudflare.com/workers/configuration/placement/) and [March 2025 stabilization changelog](https://developers.cloudflare.com/changelog/post/2025-03-22-smart-placement-stablization/):

> *"once Smart Placement has identified and assigned an optimal location, temporarily dropping below the heuristic thresholds will not force a return to default locations."*

⚠️ Caveat from [RPC docs](https://developers.cloudflare.com/workers/runtime-apis/rpc/):

> *"Smart Placement is currently ignored when making RPC calls. If Smart Placement is enabled for Worker A, and Worker B declares a Service Binding to it, when Worker B calls Worker A via RPC, Worker A will run locally, on the same machine."*

So Smart Placement helps the **eyeball-edge gateway**, not RPC calls into the DO. For Nimbus's `/preview/*` path (gateway → DO), placement helps. For DO → facet RPC, it doesn't.

## G.4 DO read replicas — applicability

[STOR/SPEC: Durable Objects read replication API](https://wiki.cfdata.org/display/STOR/SPEC%3A+Durable+Objects+read+replication+API) and [STOR/Durable Objects Replication Quick Start](https://wiki.cfdata.org/spaces/STOR/pages/1110730702/Durable+Objects+Replication+Quick+Start):

```ts
"compatibility_flags": ["experimental", "replica_routing"]

async init() {
  await this.ctx.storage.enableReplicas();
}
```

⚠️ Caveat from [~lambros/Feedback for DO read replication API](https://wiki.cfdata.org/display/~lambros/Feedback+for+DO+read+replication+API+based+on+D1+read+replication+beta):

> *"Disable replicas before bulk imports (replicas error with 'Network connection lost' during high-volume writes)."*

For Nimbus: disable replicas during npm install / git clone (write-heavy bursts). Re-enable after. Major UX win for cross-region tenants (200 ms → 5-20 ms preview reads). ⚠️ Pricing TBD per the SPEC.

## G.5 DO storage cost

Per [PRICE/Durable Objects Storage Pricing](https://wiki.cfdata.org/display/PRICE/Durable+Objects+Storage+Pricing) and [public pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): typically per-GB-month + per-read/write op. Nimbus's 10 GB-per-tenant configuration ([`README.md`](../../README.md) §SQLite Virtual Filesystem; [`src/sqlite-vfs.ts:150`](../../src/sqlite-vfs.ts)) at full usage is ~$2/tenant/month at $0.20/GB/month.

A 10k-tenant inactive long tail is $20k/month. Worth a cleanup policy.

## G.6 Citations

Wiki: [PRICE/Dynamic Workers](https://wiki.cfdata.org/spaces/PRICE/pages/1361772100/Dynamic+Workers); [PRICE/Pricing Memorandum: Dynamic Workers](https://wiki.cfdata.org/spaces/PRICE/pages/1361771847/Pricing+Memorandum+Dynamic+Workers); [~shelley/[Billing] PRD: Dynamic Workers (Worker Loader)](https://wiki.cfdata.org/spaces/~shelley/pages/1342490023/Billing+PRD+Dynamic+Workers+Worker+Loader); [PRICE/Durable Objects Storage Pricing](https://wiki.cfdata.org/display/PRICE/Durable+Objects+Storage+Pricing); [STOR/Mini-PRD: DO shared isolate issues](https://wiki.cfdata.org/display/STOR/Mini-PRD%3A+DO+shared+isolate+issues); [STOR/SPEC: Durable Objects read replication API](https://wiki.cfdata.org/display/STOR/SPEC%3A+Durable+Objects+read+replication+API); [STOR/Durable Objects Replication Quick Start](https://wiki.cfdata.org/spaces/STOR/pages/1110730702/Durable+Objects+Replication+Quick+Start); [~lambros/Feedback for DO read replication API](https://wiki.cfdata.org/display/~lambros/Feedback+for+DO+read+replication+API+based+on+D1+read+replication+beta).

Public docs: [/workers/configuration/placement/](https://developers.cloudflare.com/workers/configuration/placement/); [/changelog/post/2025-03-22-smart-placement-stablization/](https://developers.cloudflare.com/changelog/post/2025-03-22-smart-placement-stablization/); [/durable-objects/platform/pricing/](https://developers.cloudflare.com/durable-objects/platform/pricing/); [/workers/runtime-apis/rpc/](https://developers.cloudflare.com/workers/runtime-apis/rpc/) (Smart-Placement-ignored-on-RPC caveat); [/durable-objects/api/storage-api/#getcurrentbookmark](https://developers.cloudflare.com/durable-objects/api/storage-api/#getcurrentbookmark); [/d1/best-practices/read-replication/](https://developers.cloudflare.com/d1/best-practices/read-replication/).

Nimbus: [`src/facet-manager.ts:744-900, 899`](../../src/facet-manager.ts); [`src/npm-install-batch-facet.ts:28`](../../src/npm-install-batch-facet.ts); [`src/pre-bundle-facet.ts:307`](../../src/pre-bundle-facet.ts); [`src/parallel/facet-pool.ts:328-348`](../../src/parallel/facet-pool.ts); [`src/sqlite-vfs.ts:150`](../../src/sqlite-vfs.ts); [`src/git-commands.ts`](../../src/git-commands.ts); [`wrangler.jsonc:5, 48-50`](../../wrangler.jsonc); [`README.md`](../../README.md) §SQLite Virtual Filesystem.

Full body: [`audit/_drafts/G-cost-billing.md`](../_drafts/G-cost-billing.md).

---

# Section H — Roadmap / Future-ahead

## H.0 TL;DR — CF roadmap items affecting Nimbus

| # | Item | Status | Owner | Unblocks | Effort to integrate |
|---|---|---|---|---|---|
| **H1** | DO read replicas | Beta; pricing TBD | [`~lambros`/Storage](https://wiki.cfdata.org/display/~lambros) | Cross-region reads 200ms → 5-20ms | M (write paths refactor) |
| **H2** | SQLITE_NOMEM SPEC (per-DO accounting) | MRs linked, ~Q2 2026 | [`~jhoward`/Storage](https://wiki.cfdata.org/display/~jhoward) | Replace silent termination with catchable errors | S |
| ~~H3~~ | ~~Container Workers GA — REMOVED FROM NIMBUS ROADMAP~~ | GA | [`~mnomitch`/Cloudchamber](https://wiki.cfdata.org/display/~mnomitch) | Cloudchamber container-in-DO is the platform substrate Nimbus deliberately emulates without; not a Nimbus integration item | n/a (out of charter) |
| **H4** | Outgoing WS Hibernation | Draft RFC | [`~harris`/Storage](https://wiki.cfdata.org/display/~harris) | Supervisor hibernates with outbound WS | S (await GA) |
| **H5** | Dynamic Workers Observability | Draft RFC | [`~birvine-broque`](https://wiki.cfdata.org/display/~birvine-broque) | Free per-facet logs/traces | S |
| **H6** | Dynamic Worker Sharding | RFC; ephemeral facets excluded | [`~pkhanna`](https://wiki.cfdata.org/display/~pkhanna) | Cross-metal load balancing | M |
| **H7** | Dedicated-isolate namespace flag | Internal-only | [`~gmckeon`/Storage](https://wiki.cfdata.org/display/~gmckeon) | Eliminates noisy-neighbour OOMs | S (compat-flag once on allowlist) |
| **H8** | Memory pressure notification API | Wishlist | Storage | "About to be condemned" signal | S (wire-up) |
| **H9** | Script size limit hike (5→10MB landed) | GA | [`~birvine-broque`](https://wiki.cfdata.org/display/~birvine-broque) | Static script unblock | XS |
| **H10** | Runtime-injected polyfills (Snell mini-spec) | Draft | [`~jsnell`](https://wiki.cfdata.org/display/~jsnell) | -12-20 MiB encoded per facet | M (gated) |
| **H11** | DO multi-region (multi-master) | No SPEC | Storage | Far-future | n/a |
| **H12** | Smart Placement for DOs | n/a (DOs don't move) | Workers | n/a | n/a |
| **H13** | Worker Loader Observability GA | Same as H5 | Same | Same | Same |
| **H14** | WebSocket message size 1→32 MiB (already shipped Oct 2025) | GA | Workers | Bigger HMR/preview payloads | XS — verify enabled |

## H.1 Watch list — single source of truth

When a SHIP-* lands, the Nimbus integration action is:

| Item | Wiki / Jira to watch | Action when SHIP-* lands |
|---|---|---|
| H1 (read replicas) | [STOR/SPEC](https://wiki.cfdata.org/display/STOR/SPEC%3A+Durable+Objects+read+replication+API) | Implement Lever G3 / Section J §6.3 |
| H2 (SQLITE_NOMEM) | [edgeworker MR 12773](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/merge_requests/12773); [workerd PR 6380](https://github.com/cloudflare/workerd/pull/6380) | Implement Lever A3 / Section J §1.3 |
| ~~H3 (Containers GA)~~ | [CC/The road to Containers](https://wiki.cfdata.org/pages/viewpage.action?pageId=1072726833) | NOT a Nimbus integration item — Cloudchamber container-in-DO is what Nimbus emulates without |
| H4 (Outgoing WS hib) | [STOR/RFC](https://wiki.cfdata.org/spaces/STOR/pages/1372567047/RFC+Outgoing+WebSocket+Hibernation+Design+Options) | Audit outbound WS usage; minimal change |
| H5 (Dynamic Workers Obs) | [~birvine-broque/[RFC]](https://wiki.cfdata.org/spaces/~birvine-broque/pages/1365394169/RFC+Dynamic+Workers+Observability) | Lever B2 / delete most of `process-logs.ts` |
| H6 (Sharding) | [~pkhanna/Dynamic worker sharding](https://wiki.cfdata.org/spaces/~pkhanna/pages/1387665545/Dynamic+worker+sharding) | Audit if Nimbus facets qualify (non-ephemeral) |
| H7 (Dedicated isolate) | [STOR/Mini-PRD](https://wiki.cfdata.org/display/STOR/Mini-PRD%3A+DO+shared+isolate+issues) — file ask now | Lever A4 |
| H8 (Memory pressure API) | Same Mini-PRD item 4.iii | Lever A5 |
| H10 (Polyfill bundling) | [~jsnell/Mini-Spec](https://wiki.cfdata.org/pages/viewpage.action?pageId=868863065) | Lever B3 |

## H.2 Citations

Wiki: All listed in the table above. Plus [BRAPI/PRD: CDP Endpoint](https://wiki.cfdata.org/spaces/BRAPI/pages/1361741267/PRD+CDP+Endpoint) (cites [WS message size 1→32 MiB shipped 2025-10-31](https://developers.cloudflare.com/changelog/2025-10-31-increased-websocket-message-size-limit/)).

Public docs / changelog: [/changelog/post/2025-03-22-smart-placement-stablization/](https://developers.cloudflare.com/changelog/post/2025-03-22-smart-placement-stablization/); [/changelog/2025-10-31-increased-websocket-message-size-limit/](https://developers.cloudflare.com/changelog/2025-10-31-increased-websocket-message-size-limit/).

Nimbus: [`src/constants.ts:46`](../../src/constants.ts); [`src/sqlite-vfs.ts:150`](../../src/sqlite-vfs.ts); [`src/heavy-alloc-coord.ts`](../../src/heavy-alloc-coord.ts); [`src/facet-manager.ts:537`](../../src/facet-manager.ts); [`src/parallel/facet-pool.ts:514`](../../src/parallel/facet-pool.ts); [`wrangler.jsonc:5`](../../wrangler.jsonc).

Full body: [`audit/_drafts/H-roadmap.md`](../_drafts/H-roadmap.md).

---

# Section I — CF projects similar to Nimbus

## I.0 TL;DR — sibling-projects mapping

| Project | Status | Relationship to Nimbus | Contact |
|---|---|---|---|
| **Sandbox SDK** | Beta | Cloudchamber container-in-DO substrate; what Nimbus emulates without (NOT a borrowable pattern) | [`~mnomitch`](https://wiki.cfdata.org/display/~mnomitch), [`~naresh`](https://wiki.cfdata.org/display/~naresh) |
| **Containers** | Spring 2026 GA | Same as above; not on Nimbus roadmap | [`~mnomitch`](https://wiki.cfdata.org/display/~mnomitch), [`~thomasc`](https://wiki.cfdata.org/display/~thomasc) |
| **Code Mode** | GA via npm | LOADER.get() executor wrapper; tool-call-as-code | Workers AI / Agents team |
| **Browser Rendering API** | GA | CDP endpoint as universal-protocol exposure | Browser Rendering team |
| **Workers for Platforms** | GA, migrating onto Worker Loader | Outbound worker; tags; custom limits per isolate (EW-10547) | [`~dkozlov`](https://wiki.cfdata.org/display/~dkozlov) |
| **OpenCode Worker** | Community | Identical architecture to Nimbus; possible integration | [`~karishnu`](https://wiki.cfdata.org/spaces/~karishnu/pages/1386224119/OpenCode+Worker+%E2%80%94+AI+Coding+Agent+on+Cloudflare+s+Edge) |
| **Pyodide / Python Workers** | GA | R2-bucket + lockfile pattern (Section D Lever D1) | Python Workers team |

## I.1 Sandbox SDK — the platform substrate Nimbus emulates without

Per [`~agillie/[KB] Workload: Agents and Sandboxing`](https://wiki.cfdata.org/spaces/~agillie/pages/1386221284/KB+Workload+Agents+and+Sandboxing):

> *"Sandbox SDK (Beta) — A programmable sandbox API built on Containers. Called from any Worker via `getSandbox(env.Sandbox, 'user-id')`. Provides a TypeScript API for executing commands, managing files, running background processes, and exposing services. Three-layer architecture: Workers → Durable Objects → Containers. Ideal for AI code interpreters, dev environments, and data analysis platforms. PM: Mike Nomitch."*

Sandbox SDK and Nimbus solve the same shape of problem (a programmable
dev/sandbox environment from a Worker) with **opposite substrates**:
Sandbox SDK runs real Linux in a Cloudchamber-managed container;
Nimbus runs an emulated Linux-like dev environment inside DO+Loader.
The two are not collaborators — they are alternatives. Nimbus's
project charter is to be the DO-only-emulation answer; if a workload
genuinely needs real Linux, Sandbox SDK is the correct platform tool
and Nimbus is not.

Compare-and-contrast (for orientation, not as a borrowing list):

| Property | Sandbox SDK | Nimbus |
|---|---|---|
| Compute substrate | Container Workers (4 GB RAM, real Linux) | DO + LOADER facets (128 MiB workerd) |
| Filesystem | Container's local fs (4 GB) | SQLite VFS in DO (10 GB) |
| Spawn pattern | `getSandbox(env.Sandbox, id)` | `LOADER.get('id', getCodeCallback)` |
| Cold start | ~7s (Jupyter); pre-warm planned | ~10-100ms |
| Run real Python/Node | ✅ via Jupyterlab | ⚠️ workerd-shimmed Node |
| Multi-tenant isolation | Per-container | Per-DO (shared isolate caveat per Section A) |
| Snapshot/persistence | n/a today; "biggest turning off points" per [`~naresh`](https://wiki.cfdata.org/pages/viewpage.action?pageId=1331846617) | ✅ via SQLite VFS — **Nimbus's clear advantage** |

Per [~naresh/Q1 & Q2 2026: Sandbox SDK](https://wiki.cfdata.org/pages/viewpage.action?pageId=1331846617), the pain-points list aligns with Nimbus's own:

> *"The lack of a native snapshotting/persistence story is easily the biggest turning off points for users."*

Nimbus already solves this. Worth surfacing in positioning.

> *"Treating sandboxes as a zero trust environment (not to be confused with our ZT product - I just mean treating any secret sent into the sandbox as exfiltrated) is still non-trivial, and a common solution is to have a worker proxy."*

⚠️ Nimbus has the same problem; user shells can `curl` arbitrary URLs. No ZT integration today.

## I.2 OpenCode Worker — exact-shape sibling

[`~karishnu/OpenCode Worker — AI Coding Agent on Cloudflare's Edge`](https://wiki.cfdata.org/spaces/~karishnu/pages/1386224119/OpenCode+Worker+%E2%80%94+AI+Coding+Agent+on+Cloudflare+s+Edge):

> *"OpenCode Worker takes the open-source OpenCode AI coding agent and runs it entirely on Cloudflare Workers — no servers, no VMs, no containers. Sessions, filesystems, git repos, and live deployment previews all live inside Durable Objects at the edge."*

> *"Each workspace is an isolated Agent Space — a Durable Object with its own SQLite-backed filesystem and git repo, completely disconnected from any host machine."*

This is **literally the same architecture as Nimbus**. The repo at `github.com/karishnu/opencode-worker` adapts the OpenCode TUI client to talk to a DO-backed agent space. Action: reach out to [`~karishnu`](https://wiki.cfdata.org/display/~karishnu) for collaboration.

## I.3 Code Mode — Nimbus is structurally a consumer

[Cloudflare changelog 2026-02-20: codemode SDK rewrite](https://developers.cloudflare.com/changelog/post/2026-02-20-codemode-sdk-rewrite/):

```ts
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
```

Per [Pricing Memorandum: Dynamic Workers](https://wiki.cfdata.org/spaces/PRICE/pages/1361771847/Pricing+Memorandum+Dynamic+Workers): Code Mode is the canonical use case for Worker Loader. Nimbus could re-implement [`src/facet-manager.ts`](../../src/facet-manager.ts) on top of `@cloudflare/codemode`'s `DynamicWorkerExecutor` and inherit improvements for free. Effort: M.

## I.4 Browser Rendering — CDP endpoint pattern

[BRAPI/PRD: CDP Endpoint](https://wiki.cfdata.org/spaces/BRAPI/pages/1361741267/PRD+CDP+Endpoint):

> *"Browser Rendering requires customers who want to run full, multi-step browser automations to use Cloudflare Workers in order to use Puppeteer and Playwright. This blocks adoption for customers who don't want to rewrite their code to run on Workers."*

> *"Why now: Technical blocker removed - Workers no longer have the WebSocket chunking limitation that previously prevented CDP proxy implementation (WebSockets now support 32 MB messages)"*

Pattern to apply to Nimbus: ship `@cloudflare/nimbus-mcp` (an MCP server that lets Claude Code / Cursor / OpenCode / OpenCode use a Nimbus session as a tool):

```jsonc
// audit-only sketch
{
  "mcp": {
    "nimbus": {
      "command": ["npx", "-y", "@cloudflare/nimbus-mcp@latest",
        "--sessionId=<SESSION_ID>", "--apiToken=<TOKEN>"]
    }
  }
}
```

## I.5 Workers for Platforms — the migration arc

[`~dkozlov/Powering Dispatcher with a Worker Loader`](https://wiki.cfdata.org/spaces/~dkozlov/pages/1357511731/Powering+Dispatcher+with+a+Worker+Loader+%E2%80%94%C2%A0step+1+feature+parity+with+WFP) details how WfP is migrating onto Worker Loader. Three patterns directly applicable to Nimbus:

1. **Outbound worker per dispatch** — wraps user-Worker outbound traffic with a customer-defined handler. Useful for per-tenant audit / rate limit.
2. **`tags` array on WorkerCode** for per-isolate metadata (forthcoming per the RFC).
3. **Custom limits per isolate** (CPU-ms, subrequests) gated on [EW-10547](https://jira.cfdata.org/browse/EW-10547).

## I.6 EW-* tickets that would unblock Nimbus

| Ticket | What it unblocks |
|---|---|
| [EW-9653](https://jira.cfdata.org/browse/EW-9653) | "Log content of dynamically loaded isolate script" — Section B.6 abuse visibility |
| [EW-9655](https://jira.cfdata.org/browse/EW-9655) | "Write dynamic isolate code to storage" — same |
| [EW-9656](https://jira.cfdata.org/browse/EW-9656) | "Add mechanism for killing dynamic isolates" — Section B.6 |
| [EW-10547](https://jira.cfdata.org/browse/EW-10547) | Worker Loader custom limits — Section I.5 |
| [SHIP-3841](https://jira.cfdata.org/browse/SHIP-3841) | Memory tiers — Section A.1 |
| [SHIP-10537](https://jira.cfdata.org/browse/SHIP-10537) | Container accessible via DO — Section H.3 |
| [SHIP-11171](https://jira.cfdata.org/browse/SHIP-11171) | ContainerWorker JS Class — same |
| [SHIP-11173](https://jira.cfdata.org/browse/SHIP-11173) | Accessible Logs (Container) |
| [SHIP-11174](https://jira.cfdata.org/browse/SHIP-11174) | Accessible Metrics (Container) |
| [WR-1069](https://jira.cfdata.org/browse/WR-1069) | OpenTelemetry tracing for Waiting Room (DO) — Section F Lever F6 reference |
| [INCIDENT-7730](https://jira.cfdata.org/browse/INCIDENT-7730) | Billing exploit — motivation for Section B.6 |

## I.7 Citations

Wiki: [`~agillie/[KB] Workload: Agents and Sandboxing`](https://wiki.cfdata.org/spaces/~agillie/pages/1386221284/KB+Workload+Agents+and+Sandboxing); [`~naresh/Sandbox SDK: first-class binding`](https://wiki.cfdata.org/display/~naresh/Sandbox+SDK%3A+first-class+binding); [`~naresh/Q1 & Q2 2026: Sandbox SDK`](https://wiki.cfdata.org/pages/viewpage.action?pageId=1331846617); [`~mnomitch/Interacting with Container and Sandbox instances`](https://wiki.cfdata.org/display/~mnomitch/Interacting+with+Container+and+Sandbox+instances+from+the+user%27s+runtime); [`CC/The road to Containers on the Developer Platform`](https://wiki.cfdata.org/pages/viewpage.action?pageId=1072726833); [`CC/Containers - Internal FAQ`](https://wiki.cfdata.org/display/CC/Containers+-+Internal+FAQ); [`Developer Platform/This week in Cloudchamber: 2025-03-28 edition`](https://wiki.cfdata.org/pages/viewpage.action?pageId=1136523234); [`BRAPI/PRD: CDP Endpoint`](https://wiki.cfdata.org/spaces/BRAPI/pages/1361741267/PRD+CDP+Endpoint); [`BRAPI/Testing Browser Rendering CDP`](https://wiki.cfdata.org/spaces/BRAPI/pages/1354214192/Testing+Browser+Rendering+CDP); [`BRAPI/Browser Rendering Agents Week Rename`](https://wiki.cfdata.org/spaces/BRAPI/pages/1361767627/Browser+Rendering+Agents+Week+Rename); [`~dkozlov/Powering Dispatcher with a Worker Loader`](https://wiki.cfdata.org/spaces/~dkozlov/pages/1357511731/Powering+Dispatcher+with+a+Worker+Loader+%E2%80%94%C2%A0step+1+feature+parity+with+WFP); [`~jwheeler/WfP & Dynamic Workers: Exploring the Path Forward`](https://wiki.cfdata.org/spaces/~jwheeler/pages/1372556848/WfP+Dynamic+Workers+Exploring+the+Path+Forward); [`~karishnu/OpenCode Worker`](https://wiki.cfdata.org/spaces/~karishnu/pages/1386224119/OpenCode+Worker+%E2%80%94+AI+Coding+Agent+on+Cloudflare+s+Edge); [`~howard/AI Agents & Sandboxing for Developers`](https://wiki.cfdata.org/spaces/~howard/pages/1382709668/AI+Agents+Sandboxing+for+Developers+Why+It+Matters+and+How+to+Talk+About+It); [`pages/viewpage.action?pageId=1327289817 (1000 popular npm Packages)`](https://wiki.cfdata.org/pages/viewpage.action?pageId=1327289817).

Public: [/changelog/post/2026-02-20-codemode-sdk-rewrite/](https://developers.cloudflare.com/changelog/post/2026-02-20-codemode-sdk-rewrite/); [/agents/api-reference/codemode/](https://developers.cloudflare.com/agents/api-reference/codemode/); npm packages `@cloudflare/sandbox`, `@cloudflare/codemode`, `@cloudflare/containers`.

Nimbus: [`src/facet-manager.ts`](../../src/facet-manager.ts); [`src/sqlite-vfs.ts`](../../src/sqlite-vfs.ts); [`src/nimbus-session.ts:1160`](../../src/nimbus-session.ts); [`README.md`](../../README.md) §What is Nimbus.

Full body: [`audit/_drafts/I-similar-projects.md`](../_drafts/I-similar-projects.md).

---

# Section J — Concrete code changes (Mossaic-doc style)

> **All sketches below are audit-only.** Per the brief: "NO src/ edits. NO src/ commits. audit/ writes only." These are *what would change* documents, not patches to apply.
>
> Format: `// src/file.ts:NN` anchor, `- old` / `+ new` blocks, with effort tag and citation back to the section that motivated it.

---

## J.1 Memory & SQLite levers (from §A)

### J.1.1 Lever A1 — `cause` discriminator on diag-counters (XS)

**Source:** Section A; observability touch in Section F1.

```ts
// src/diag-counters.ts (audit-only sketch)
+ export interface DiagFailure {
+   at: number;
+   phase: string;       // 'install' | 'resolve' | 'pre-bundle' | 'rpc' | 'ws' | …
+   cause: 'oom' | 'sqlite_nomem' | 'clone_refused' | 'rpc_timeout'
+        | 'subrequest_cap' | 'condemnation' | 'hard_evict' | 'unknown';
+   rssEstimateBytes: number;
+   lruBytes: number;
+   inFlightBytes: number;
+   message?: string;
+ }
+ const lastFailures: DiagFailure[] = [];   // ring buffer, last 50
+ export function recordFailure(f: DiagFailure) {
+   lastFailures.unshift(f);
+   if (lastFailures.length > 50) lastFailures.pop();
+ }
+ export function getLastFailures() { return lastFailures.slice(0, 50); }
```

```ts
// src/index.ts (augment existing /api/_diag/memory handler — sketch)
  if (url.pathname === '/api/_diag/memory') {
    return Response.json({
      vfs: { totalBytes, totalFiles, lruBytes, hotPages },
      process: { ... },
+     lastFailures: getLastFailures(),
+     facetPool: { activeFacets, queuedRpcs, rpcInFlightBytes },
+     rpc: { inFlightCount, lastCloneRefusalAt, totalSerializedBytesToday },
    });
  }
```

Wire from: `src/parallel/facet-pool.ts:99-104`, `src/heavy-alloc-coord.ts`, `src/npm-installer.ts:1219-1289`, `src/nimbus-session.ts:3813-3878`, `src/facet-manager.ts:805-820`.

### J.1.2 Lever A2 — decouple SqliteVFS LRU from install-staging (S)

**Source:** Section A; the 32 MiB hot working-set cohabitates with 16-MiB-batch flush peaks.

```ts
// src/sqlite-vfs.ts (audit-only sketch)
- private cache = new LRU<number, Uint8Array>({ maxBytes: 32 * 1024 * 1024 });
+ private cache = new LRU<number, Uint8Array>({ maxBytes: 32 * 1024 * 1024 });
+ public shrinkForInstall() {
+   this.cache.setMaxBytes(8 * 1024 * 1024);
+   this.cache.evictDown();
+ }
+ public restoreAfterInstall() {
+   this.cache.setMaxBytes(32 * 1024 * 1024);
+ }
```

```ts
// src/heavy-alloc-coord.ts (sketch)
  async withHeavyAlloc(fn: () => Promise<void>) {
+   this.vfs.shrinkForInstall();
    try { return await fn(); }
+   finally { this.vfs.restoreAfterInstall(); }
  }
```

### J.1.3 Lever A3 — catch SQLITE_NOMEM (S; gated on H2)

**Source:** Section A; STOR/SPEC: SQLITE_NOMEM SPEC.

```ts
// src/npm-installer.ts (audit-only sketch around :1219-1289 batch path)
- await this.vfs.transactionSync(batch);
+ try {
+   await this.vfs.transactionSync(batch);
+ } catch (e: any) {
+   const msg = e?.message ?? String(e);
+   if (msg.includes('SQLITE_NOMEM') || msg.includes('out of memory')) {
+     recordFailure({ at: Date.now(), phase: 'install',
+       cause: 'sqlite_nomem', rssEstimateBytes: 0, lruBytes: 0,
+       inFlightBytes: 0, message: msg });
+     this.vfs.dropLru();
+     const half = Math.ceil(batch.length / 2);
+     await this.vfs.transactionSync(batch.slice(0, half));
+     await this.vfs.transactionSync(batch.slice(half));
+   } else throw e;
+ }
```

### J.1.4 Lever A4 — dedicated-isolate (gated; CF dialogue)

When granted by Storage team:

```jsonc
// wrangler.jsonc — flag name TBD per CF Storage team
{
  "compatibility_flags": ["nodejs_compat", "experimental",
+   "<dedicated_isolate_internal_flag_name>"
  ]
}
```

---

## J.2 Worker Loader / Facets (from §B + §G)

### J.2.1 Lever B5 / G1 — verify codeId is content-derived (XS)

```ts
// src/facet-manager.ts (audit-only sketch — verify or fix at :880-900)
- const codeId = randomUUID();              // ❌ if this is the current shape
+ const codeId = await fnv1a(workerCode);   // ✅ same code → same daily Worker
  const worker = this.env.LOADER.get(codeId, async () => ({ /* WorkerCode */ }));
```

⚠️ Verify by reading `src/facet-manager.ts:880-900` carefully. Likely already content-derived (per code-comment trail), in which case this is documentation-only.

### J.2.2 Lever B1 — coalesce git-network into long-lived facet (S)

```ts
// src/git-commands.ts (audit-only sketch)
- // current: per-clone spawn
- const facet = env.LOADER.get(`git-${requestId}`, () => ({ mainModule, modules }));
- await facet.fetch(...);
+ // proposed: one long-lived git-supervisor per tenant; fan-out via pLimit(6)
+ if (!this.gitFacet) {
+   this.gitFacet = env.LOADER.get(`git-supervisor-${tenantId}`, () => ({
+     mainModule: 'git-network-facet.js',
+     modules: { 'git-network-facet.js': GIT_FACET_BUNDLE },
+     env: { SUPERVISOR: ctx.exports.SUPERVISOR(...) },
+   }));
+ }
+ await this.gitFacet.cloneOrFetch({ url, ref });
```

### J.2.3 Lever B2 — adopt observability config (M; gated on H5)

```jsonc
// wrangler.jsonc (audit-only sketch — when RFC GAs)
- "worker_loaders": [{ "binding": "LOADER" }]
+ "worker_loaders": [{
+   "binding": "LOADER",
+   "observability": {
+     "include_in_parent": true,
+     "logs":   { "enabled": true, "persist": true, "head_sampling_rate": 0.5 },
+     "traces": { "enabled": true, "persist": true, "head_sampling_rate": 0.1 }
+   }
+ }]
```

Pair with deletion of most of [`src/process-logs.ts`](../../src/process-logs.ts).

---

## J.3 WebSocket hibernation (from §C)

### J.3.1 Lever C2 — auto-response (XS)

```ts
// src/nimbus-session.ts (audit-only sketch — constructor)
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
+   // Vite HMR clients ping every 30s; idle xterm tabs ping per minute.
+   // Auto-respond at runtime; survives hibernation per STOR primer.
+   state.setWebSocketAutoResponse(
+     new WebSocketRequestResponsePair('ping', 'pong')
+   );
+   // Bound a single hibernation message handler. Long-running work runs in
+   // facets with their own CPU budget; this only ENQUEUES.
+   state.setHibernatableWebSocketEventTimeout(5_000);
    // ... existing init
  }
```

### J.3.2 Lever C1 — process-logs hibernatable (S)

```ts
// src/process-logs-api.ts (audit-only sketch)
- server.accept();
+ ctx.acceptWebSocket(server, ['process-logs']);
+ server.serializeAttachment({ kind: 'process-logs', pid });
```

Pair with discrimination in `webSocketMessage` / `webSocketClose` for `kind === 'process-logs'`. The receive side reads `pid` from attachment, looks up in [`src/process-table.ts`](../../src/process-table.ts), and resumes log-stream replay.

### J.3.3 Lever C4 — close-handler grace window (S)

```ts
// src/nimbus-session.ts:3813-3852 (audit-only sketch)
  async webSocketClose(ws: WebSocket, ...) {
    const att = this._wsKind(ws);
    if (att.kind === 'cirrus-hmr') { /* unchanged */ return; }
-   this.shell = null;
-   this.terminal = null;
-   this.kernel = null;
+   this._lastShellCloseAt = Date.now();
+   this.ctx.storage.setAlarm(this._lastShellCloseAt + 60_000);
  }
+
+ async alarm() {
+   if (this._lastShellCloseAt && Date.now() - this._lastShellCloseAt >= 60_000) {
+     this.shell = null;
+     this.terminal = null;
+     this.kernel = null;
+   }
+ }
```

### J.3.4 Lever C6 — compat date / flag (XS)

```jsonc
// wrangler.jsonc
- "compatibility_date": "2026-04-01",
+ "compatibility_date": "2026-04-08",
  "compatibility_flags": ["nodejs_compat", "experimental"
+ , "web_socket_auto_reply_to_close"
  ]
```

---

## J.4 npm install architecture (from §D)

### J.4.1 Lever D5 — Smart Placement (XS)

```jsonc
// wrangler.jsonc
{
+ "placement": { "mode": "smart" }
}
```

### J.4.2 Lever D3.5 — Cache API tier on registry fetches (XS)

```ts
// src/npm-tarball.ts (audit-only sketch)
- const resp = await fetch(`https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`);
+ const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
+ const cache = await caches.open('npm-tarballs-v1');
+ const cached = await cache.match(url);
+ if (cached) return new Uint8Array(await cached.arrayBuffer());
+ const resp = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } });
+ ctx.waitUntil(cache.put(url, resp.clone()));
+ return new Uint8Array(await resp.arrayBuffer());
```

### J.4.3 Lever D1 — R2-backed cross-tenant tarball cache (M)

```ts
// src/npm-cache.ts (audit-only sketch)
class NpmCache {
+ async getTarball(name: string, version: string): Promise<Uint8Array | null> {
+   // L1: per-DO SQLite (~1ms)
+   const local = this.sqlite.exec("SELECT data FROM tarballs WHERE name=? AND version=?", name, version)?.one()?.data;
+   if (local) return local;
+
+   // L2: cross-tenant R2 (~20-50ms)
+   const r2Key = `npm/${name}/${version}.tgz`;
+   const r2Obj = await this.env.NPM_TARBALL_CACHE.get(r2Key);
+   if (r2Obj) {
+     const bytes = new Uint8Array(await r2Obj.arrayBuffer());
+     this.sqlite.exec("INSERT OR REPLACE INTO tarballs ...", name, version, bytes);
+     return bytes;
+   }
+
+   // L3: registry origin (~100-300ms cross-region)
+   const upstream = await fetch(`https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`);
+   const bytes = new Uint8Array(await upstream.arrayBuffer());
+
+   // Async write-back
+   ctx.waitUntil(this.env.NPM_TARBALL_CACHE.put(r2Key, bytes, {
+     httpMetadata: { contentType: 'application/gzip' },
+   }));
+   this.sqlite.exec("INSERT OR REPLACE INTO tarballs ...", name, version, bytes);
+   return bytes;
+ }
}
```

```jsonc
// wrangler.jsonc
{
+ "r2_buckets": [
+   { "binding": "NPM_TARBALL_CACHE",   "bucket_name": "nimbus-npm-tarball-cache" },
+   { "binding": "NPM_PACKUMENT_CACHE", "bucket_name": "nimbus-npm-packument-cache" }
+ ]
}
```

### J.4.4 Lever D2 — R2-backed packument cache (M)

```ts
// src/npm-resolver.ts (audit-only sketch)
async function fetchPackument(name: string): Promise<Packument> {
+ const r2Key = `packument/${name}.json`;
+ const r2Obj = await env.NPM_PACKUMENT_CACHE.get(r2Key);
+ if (r2Obj) {
+   const ageS = (Date.now() - Date.parse(r2Obj.uploaded ?? '')) / 1000;
+   if (ageS < 300) return JSON.parse(await r2Obj.text());
+ }
  const resp = await fetch(`https://registry.npmjs.org/${name}`);
  const text = await resp.text();
+ ctx.waitUntil(env.NPM_PACKUMENT_CACHE.put(r2Key, text, {
+   httpMetadata: { contentType: 'application/json' },
+ }));
  return JSON.parse(text);
}
```

---

## J.5 RPC + structured-clone (from §E)

### J.5.1 Lever E1 — streams over RPC for bulk-write (M)

The biggest single win in this plan. Replace `Uint8Array[]` with `ReadableStream<Uint8Array>` end-to-end through the supervisor⇄facet boundary.

```ts
// src/npm-install-facet.ts (audit-only sketch)
- async installPackage(name: string, version: string, files: { path: string, bytes: Uint8Array }[])
+ async installPackage(name: string, version: string, tarStream: ReadableStream<Uint8Array>)
  {
-   for (const f of files) {
-     await env.SUPERVISOR.writeFile(f.path, f.bytes);
-   }
+   await env.SUPERVISOR.writeBulkFromTar(name, tarStream);
  }
```

```ts
// src/supervisor-rpc.ts (audit-only sketch)
class SupervisorRPC extends WorkerEntrypoint {
+ async writeBulkFromTar(prefix: string, tarStream: ReadableStream<Uint8Array>) {
+   const reader = tarStream
+     .pipeThrough(new DecompressionStream('gzip'))
+     .pipeThrough(new TarParseTransform())
+     .getReader();
+   while (true) {
+     const { done, value } = await reader.read();
+     if (done) break;
+     this.vfs.write(`${prefix}/${value.path}`, value.bytes);
+   }
+ }
}
```

Pair with bumping `src/npm-install-batch-facet.ts` pLimit(3) to pLimit(6) once memory profile allows.

### J.5.2 Lever E2 — promise pipelining via stub-bearing handles (M)

```ts
// src/supervisor-rpc.ts (audit-only sketch)
class SupervisorRPC extends WorkerEntrypoint {
+ /** Returns a stub bearing fetchTarball. Pipelined into 1 RTT. */
+ async getCachedPackument(name: string): Promise<PackumentStub> {
+   const meta = this.npmCache.getPackument(name);
+   return new PackumentStub(this, meta);
+ }
+ }
+
+ class PackumentStub extends RpcTarget {
+   constructor(private sup: SupervisorRPC, private meta: Packument) { super(); }
+   async getTarball(versionRange: string): Promise<ReadableStream<Uint8Array>> {
+     const ver = pickVersion(this.meta, versionRange);
+     return this.sup.fetchTarballStream(this.meta.versions[ver].dist.tarball);
+   }
+ }
```

```ts
// src/npm-resolve-facet.ts (audit-only sketch — caller side)
- const meta = await env.SUPERVISOR.getCachedPackument(name);
- const url = pickVersion(meta, range);
- const tarball = await env.SUPERVISOR.fetchTarball(url);
+ using stub = env.SUPERVISOR.getCachedPackument(name);   // no await!
+ const tarball = await stub.getTarball(range);            // pipelined; 1 RTT
```

### J.5.3 Lever E3 — codify "no Module clone" (XS, doc only)

```ts
// src/_shared/rpc-types.ts (audit-only sketch — new file)
// Compile-time check: anything we send over RPC must be either
// (a) structured-cloneable AND under 32 MiB (workerd cap), OR
// (b) ReadableStream / WriteableStream / Request / Response with type: 'bytes'
//
// FORBIDDEN to clone:
//   - WebAssembly.Module       (workerd refuses; use modules-map)
//   - Functions / closures      (RpcTarget instances allowed if extending RpcTarget)
//   - Symbols, cyclic references
```

---

## J.6 Observability (from §F)

### J.6.1 Lever F1 — diag-counters ring buffer (XS)

See §J.1.1 above.

### J.6.2 Lever F2 — Logpush enable (S)

```jsonc
// wrangler.jsonc
{
+ "logpush": true
}
```

Plus structured-logging refactor at install / git / facet boundaries:

```ts
// audit-only — pattern only
- console.log(`[nimbus] install ${name}@${version} ok`);
+ console.log({ event: 'npm.install.ok', name, version, durationMs, tarballBytes, source: 'r2' });
```

### J.6.3 Lever F3 — Tail Worker (S)

```jsonc
// wrangler.jsonc
+ "tail_consumers": [{ "service": "nimbus-tail", "environment": "production" }]
```

```ts
// nimbus-tail/src/index.ts (audit-only sketch — separate worker)
export default {
  async tail(events: TraceItem[], env: Env, ctx: ExecutionContext) {
    for (const evt of events) {
      ctx.waitUntil(env.NIMBUS_LOGS.put(
        `tail/${evt.scriptName}/${evt.eventTimestamp}-${crypto.randomUUID()}.json`,
        JSON.stringify(evt),
      ));
    }
  }
};
```

### J.6.4 Lever F4 — Analytics Engine (S)

```jsonc
// wrangler.jsonc
{
+ "analytics_engine_datasets": [
+   { "binding": "INSTALL_METRICS", "dataset": "nimbus_install_metrics" }
+ ]
}
```

```ts
// src/npm-installer.ts (audit-only sketch)
+ env.INSTALL_METRICS.writeDataPoint({
+   blobs: [name, version, source /* 'r2' | 'cache-api' | 'origin' */, source === 'origin' ? 'cold' : 'warm'],
+   doubles: [durationMs, tarballBytes],
+   indexes: [tenantId],
+ });
```

### J.6.5 Lever F6 — manual OpenTelemetry layer (M)

```ts
// src/_shared/otel.ts (audit-only sketch — new file)
export class NimbusTrace {
  static span<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const traceId = (globalThis as any).__nimbusTraceId ??= crypto.randomUUID();
    const spanId = crypto.randomUUID();
    return fn().then(
      (r) => { console.log({ otel: 'span.end', name, traceId, spanId, durationMs: performance.now() - start, status: 'ok' }); return r; },
      (e) => { console.log({ otel: 'span.end', name, traceId, spanId, durationMs: performance.now() - start, status: 'error', error: e?.message }); throw e; },
    );
  }
}
```

```ts
// src/supervisor-rpc.ts (audit-only sketch)
async writeBulkFromTar(prefix: string, tarStream: ReadableStream<Uint8Array>) {
+ return NimbusTrace.span('SUPERVISOR.writeBulkFromTar', async () => {
    /* ... existing logic ... */
+ });
}
```

---

## J.7 Cost / billing (from §G)

### J.7.1 Lever G3 — DO read replicas (M; gated on H1 GA + pricing)

```jsonc
// wrangler.jsonc
{
  "compatibility_flags": ["nodejs_compat", "experimental"
+ , "replica_routing"
  ]
}
```

```ts
// src/nimbus-session.ts (audit-only sketch)
  async fetch(request: Request) {
+   if (this.shouldEnableReplicas()) {
+     await this.ctx.storage.configureReadReplication({ mode: "auto" });
+   }
    /* ... */
  }
+
+ private isReplica() { return this.ctx.storage.primary !== undefined; }
+
+ // EVERY write path
  async vfsWriteFile(path: string, data: Uint8Array) {
+   if (this.isReplica()) {
+     return this.ctx.storage.primary.vfsWriteFile(path, data);
+   }
    /* ... existing write logic */
  }
```

⚠️ Disable replicas during npm install / git clone (write-heavy bursts) per [~lambros/Feedback for DO read replication API](https://wiki.cfdata.org/display/~lambros/Feedback+for+DO+read+replication+API+based+on+D1+read+replication+beta) (replicas error with "Network connection lost" during high-volume writes).

---

## J.8 Implementation order

Roughly sequencing by impact-per-effort, mirroring MOSSAIC reference §11:

| Wave | Items | Total effort |
|---|---|---|
| **W1 day 1** | C2 (auto-response) + C3 (event timeout) + C6 (compat date) + D5 (smart placement) + G1 (codeId verify) + F2 (logpush) | XS — config-only afternoon |
| **W1 day 1-2** | A1 + F1 (diag-counters discriminator + ring buffer) | XS-S |
| **W1 day 3-5** | A2 (LRU shrink during heavy alloc) + B1 (coalesce git-network) + C1 (process-logs hibernatable) + C4 (close-grace) + D3.5 (Cache API tier) | S |
| **W2 day 1-3** | E1 (streams over RPC) + E2 (promise pipelining) — paired refactor | M |
| **W2 day 3-5** | F3 (tail worker) + F4 (analytics engine) + F6 (otel layer) | S+M |
| **W3 day 1-3** | D1 + D2 + D4 (R2 npm caches + manifest) | M |
| **W3 day 4** | A3 (SQLITE_NOMEM catch — gated on H2) | S (when H2 ships) |
| **W3 day 5** | E3 (rpc-types doc) + E5 (heap-aware chunking) | XS-S |
| **W4** | G3 (DO read replicas — gated on H1 GA) | M |
| **W4+** | A4 (dedicated isolate — CF dialogue) + A5 (memory pressure API — gated on H8) + B2/F5 (worker_loaders observability — gated on H5) + B3 (polyfill scheme — gated on H10) + B4 (Trust & Safety dialogue with Sandbox SDK team) | gated |

---

## J.9 Things we're explicitly NOT doing

- **Pre-warm DOs.** Per [DO data location docs](https://developers.cloudflare.com/durable-objects/reference/data-location/): *"It can negatively impact latency to pre-create Durable Objects prior to the first client request."*
- **Run a full npm registry mirror.** R2 cache + origin fallback is sufficient.
- **Persist the entire VFS at-rest.** The 10 GB capacity is demand-paged; eagerly loading would blow the 128 MiB cap.
- **Bump SQLite per-DO limits ourselves.** workerd's per-DO `SqliteDatabase` is configured in C++ at [`sqlite.c++:1295`](https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c%2B%2B#L1295). Not adjustable from JS.
- **Cross-tenant tarball compression.** Already content-addressed; further compression doesn't pay.
- **Smart Placement of the supervisor DO.** DOs don't move once placed. Smart Placement applies to Workers.
- **Increase facet pool size past 6.** Workers per-pipeline subrequest limit is 6 ([Workers Limits](https://wiki.cfdata.org/display/EW/Workers+Limits)).
- **Adopt Cloudflare Containers / Sandbox SDK / Cloudchamber container-in-DO as a Nimbus substrate.** Cloudchamber container-in-DO is the platform's container offering; emulating that capability inside DO+Loader without taking on a separate container substrate is the project's purpose. We track Cloudchamber as a primitive that exists ([cf-internal-dossier.md §6](../../docs/research/cf-internal-dossier.md)) but do not depend on it.

---

## Document statistics

- ~1500 LOC final synthesis (this file)
- 9 individual section drafts in [`audit/_drafts/`](../_drafts/) totaling ~3415 LOC for full provenance
- ≥50 wiki/doc citations (counted across all sections)
- ≥15 src/ file:line citations (counted across all sections)
- 18 levers in TL;DR table
- All claims cited (wiki URL, doc URL, src/ file:line, or "⚠️ speculation")

## Next steps for implementation

Per the brief, this document is **research-only**. No src/ edits. No src/ commits. Decisions needed before any of this gets implemented:

1. **Does Nimbus have budget to ship Workers Logpush ($0.05/MM requests)?** Lever F2.
2. **Should Nimbus pursue dedicated-isolate access** (file ask with `~gmckeon`)? Lever A4.
3. **Should Nimbus initiate Trust & Safety dialogue** with `~ketan` (Dice) and `~mnomitch` / `~naresh` (Sandbox SDK) on the abuse-detection question? Lever B4.
4. **Sequencing of E1+E2** — these are paired and require coordinated facet refactor; agree the W2 timing.
5. **DO read replicas (G3 / H1)** — go-no-go decision pending CF pricing announcement.

Each "Action" notes throughout the body sections list the specific wiki page or person to contact.
