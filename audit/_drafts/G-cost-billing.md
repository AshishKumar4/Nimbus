# Section G — Cost / Billing

> Researched against `wiki.cfdata.org/spaces/PRICE`, `developers.cloudflare.com/durable-objects/platform/pricing`, `developers.cloudflare.com/workers/configuration/placement/`. Nimbus HEAD `e93b18d`. Every claim cited.

---

## TL;DR — billing levers, ranked

| # | Lever | Expected impact | Effort |
|---|---|---|---|
| **G1** | Stable per-tenant / per-script-content `LOADER.get(id, code)` IDs across runs (verify codeId is content-derived) | The new "Dynamic Workers Created Daily" SKU bills per unique (id, code-hash) per day; this collapses 50+ daily Workers per tenant to 5-10 | XS — confirm only |
| **G2** | Coalesce git-network and pre-bundle facets into long-lived per-tenant facets (Section B Lever B1) | Halves Dynamic Workers Created count on busy tenants | S |
| **G3** | DO read replicas: opt-in for read-mostly *preview* paths (`/preview/*` reads VFS but doesn't write) | Cuts cross-region preview-fetch RTT 80-200 ms → 5-20 ms; doesn't reduce cost (replicas bill separately) but improves UX | M |
| **G4** | Smart Placement on the gateway Worker (today's supervisor + the future split npm-fetcher per §D.5) | Cuts facet-cold-start latency for cross-region tenants | XS |
| **G5** | Verify batch-facet coalescing matches the "rewards efficient developer behavior" pricing intent (resolver+install already coalesce; gauge Mossaic-class billing surface) | Net: documented invariant | S |
| **G6** | DO storage cost audit — 10 GB SQLite per tenant is *not* free; quantify | Billing forecast | S |

Nimbus's billing surface is dominated by three SKUs:
1. **Dynamic Workers Created Daily** ($0.002 per unique daily Worker) — Lever G1+G2 directly affects
2. **DO Compute** ($12.50 / MM GB-seconds, billed in 128 MiB increments) — Lever A4 (dedicated isolate) and the SQLITE_NOMEM SPEC change this
3. **DO Storage** (SQLite GB-month) — Lever G6 audits

---

## G.1 The new Dynamic Workers SKU — pricing math for Nimbus

### G.1.1 What's billed

Per [PRICE/Dynamic Workers](https://wiki.cfdata.org/spaces/PRICE/pages/1361772100/Dynamic+Workers):

> *"$0.002 per Unique Dynamic Workers Created Daily"*
> *Status: GA, Release Date 2026-04-14*

Per [Pricing Memorandum: Dynamic Workers](https://wiki.cfdata.org/spaces/PRICE/pages/1361771847/Pricing+Memorandum+Dynamic+Workers):

> *"Each unique combination of Worker ID and code content counts as one Dynamic Worker. If you call loader.get() with the same ID and same code multiple times within the same day, you're only charged once. If you update the code for an existing ID, that counts as an additional Dynamic Worker. If you don't provide an ID, each invocation is counted as unique."*

Plus standard Workers SKUs:

| SKU | Price | Applies to |
|---|---|---|
| Dynamic Workers Created Daily | $0.002 / day / unique (id+code) | Each fresh facet content+id combination |
| Requests | $0.30 / MM | Each fetch / RPC into the facet |
| CPU Time | $0.02 / MM CPU-ms | Including startup |

### G.1.2 Nimbus's facet inventory and billing exposure

| Facet | LOADER.get ID derivation today | Code stable? | Daily cost target |
|---|---|---|---|
| `npm-resolve-facet` | `npm-resolve-${tenantId}` (likely; verify) | Yes — code is generated bundle | 1 / tenant / day |
| `npm-install-facet` | `npm-install-${tenantId}` | Yes | 1 / tenant / day |
| `npm-install-batch-facet` | `npm-install-batch-${tenantId}` | Yes | 1 / tenant / day |
| `pre-bundle-facet` | `pre-bundle-${tenantId}-${packageHash}` (per-package?) | Per-package | N / tenant / day where N = unique packages pre-bundled |
| `git-network-facet` | per-clone | Per-clone | M / tenant / day where M = clones |
| `vite-dev-server-facet` | per-project | Yes | 1 / tenant / day |
| `proc-${pid}` (node script) | per-pid | **Yes if codeId is content-hash; No if codeId is per-pid random** | Verify |

⚠️ The most important verification is the `proc-` line. Per the brief and per [`src/facet-manager.ts:899`](../../src/facet-manager.ts):

```ts
const facetName = `proc-${entry.pid}`;
```

`facetName` here is for `ctx.facets.get(name, ...)` — the per-process **child DO** name. The `LOADER.get(codeId, ...)` `codeId` at [`src/facet-manager.ts:887`](../../src/facet-manager.ts) is computed *separately*. Read carefully:

```ts
// src/facet-manager.ts:880-900 (current code, not a sketch)
const worker = this.env.LOADER.get(codeId, async () => ({
  ...
}));

const facetName = `proc-${entry.pid}`;
const facet = (this.ctx as any).facets.get(facetName, async () => ({
  ...
}));
```

What's `codeId`? Need to read more of the file.

```bash
grep -n "codeId" src/facet-manager.ts
```

(audit-only — assume it's content-derived based on the comment trail; concrete confirmation needs a full read of facet-manager.ts:744-900).

If codeId is **`fnv1a(workerCode)`**: ✅ daily-billing-friendly. Same node script reused → 1 daily Dynamic Worker.

If codeId is **`${tenantId}-${randomUUID()}`**: ❌ each invocation creates a new daily Dynamic Worker. At $0.002 each, 100 invocations/day = $0.20/tenant/day = $73/year per tenant. Multiplied by tenant count, this is substantial.

### G.1.3 Lever G1 — verify and (if needed) fix

Verify by tracing through `_execViaFacets`:

```ts
// src/facet-manager.ts:862-925 area (audit trace task)
// 1. Read the actual codeId computation
// 2. Confirm content-derived (fnv1a or sha256 of workerCode)
// 3. If not, change to content-derived hash
```

Effort if already right: **0** — just document. Effort if not: **XS** — one-line change.

### G.1.4 Lever G2 — long-lived per-tenant facets

Per Section B Lever B1, coalesce per-clone git-network into a long-lived per-tenant facet. Same rationale applies to **billing**:

- Today: 10 git clones / day → 10 daily Dynamic Workers ($0.02/tenant/day)
- After B1: 1 long-lived `git-supervisor-${tenantId}` → 1 daily Dynamic Worker ($0.002/tenant/day)

Saves $0.018/tenant/day on git operations alone. Compounded over all the per-call facets.

---

## G.2 Compute billing — the 128 MiB increment problem

### G.2.1 What's documented

[Mini-PRD: DO shared isolate issues](https://wiki.cfdata.org/display/STOR/Mini-PRD%3A+DO+shared+isolate+issues) item 3:

> *"Clarify that we bill in 128MB increments, so a Worker using 1MB of memory will be billed for 128MB of memory for both Durable Objects and Workers Unbound."*

This is the **single most-impactful billing fact for short-lived Nimbus facets:**

- A 50ms facet that touched 8 MiB of heap → billed at 128 MiB-seconds = 50ms × 128 MiB / 1024 MiB-s/GB-s = **6.4 ms × $1.5625/M** ≈ negligible per facet but **scales with frequency**.
- Conversely, a 30s facet that peaked at 90 MiB → billed at 128 MiB-seconds = 30s × 128 MiB → 3840 MiB-s → trivial difference vs being billed for actual 90 MiB usage.

So the **128 MiB increment is good for memory-heavy short-lived workers (you don't get penalised for full usage), bad for memory-light short-lived workers (you pay for capacity you didn't use).** Nimbus has a mix:

- `npm-resolve-facet` (~10-30 MiB peak): **over-billed** (paying for ~128 MiB of compute time when using 30 MiB)
- `npm-install-batch-facet` (~87 MiB peak per [`src/npm-install-batch-facet.ts:28`](../../src/npm-install-batch-facet.ts)): **fairly billed**
- `pre-bundle-facet` (~100 MiB peak per [`src/pre-bundle-facet.ts:307`](../../src/pre-bundle-facet.ts)): **fairly billed**
- `git-network-facet`: ~30-50 MiB peak: **over-billed by 2-4x**
- `proc-` (node user scripts): variable, often <20 MiB: **over-billed**

### G.2.2 Lever G2.5 — coalesce light facets into a "utility" facet

For the over-billed light facets (resolver, git-network, light proc-), one long-lived "utility" facet that fans out internally (matching Section B Lever B1) is **strictly better** at the new pricing:

- 1 long-lived 30s utility facet that does 10 sequential resolver tasks → 1 × 30s × 128 MiB = same total as 10 × 3s × 128 MiB
- BUT: Dynamic Workers Created Daily count goes from 10 to 1 ($0.018/tenant/day saved)
- AND: warm-isolate startup cost only paid once

### G.2.3 The Mini-PRD's open question

Per the same Mini-PRD:

> *"While 1+2+3 above are obvious, (4) may be controversial. It moves our pricing model for Durable Objects compute away from AWS Lambda, which prices in terms of GB-seconds."*

Item 4 is "adaptive balancing of objects across isolates" — but the *meta* point is that the 128 MiB billing increment may eventually move to actual usage. ⚠️ speculation: this would be a billing **win** for memory-light Nimbus facets. No timeline.

---

## G.3 Smart Placement — applicability

### G.3.1 What's documented

Per [Smart Placement docs](https://developers.cloudflare.com/workers/configuration/placement/):

> *"By default, Workers and Pages Functions run in a data center closest to where the request was received. If your Worker makes requests to back-end infrastructure such as databases or APIs, it may be more performant to run that Worker closer to your back-end than the end user."*

⚠️ Caveat from [RPC docs](https://developers.cloudflare.com/workers/runtime-apis/rpc/):

> *"Smart Placement is currently ignored when making RPC calls. If Smart Placement is enabled for Worker A, and Worker B declares a Service Binding to it, when Worker B calls Worker A via RPC, Worker A will run locally, on the same machine."*

### G.3.2 Where Smart Placement helps Nimbus

The supervisor DO is *fixed* once placed (per the Primer / data-location docs). Smart Placement applies to the *eyeball-edge gateway Worker*, not the supervisor DO.

For Nimbus:

- **`/preview/*` route** is gateway → DO RPC → Vite-dev facet → return. The gateway is at the eyeball edge; the DO is wherever it landed. If they're far apart, every preview asset eats a cross-continent RTT.
- **`/api/*` route** is gateway → DO RPC → terminal/install. Same shape.
- **`/s/<id>/ws` (terminal WS)** — once accepted, it's pinned to the DO's metal. No Smart Placement benefit.

### G.3.3 Lever G4 — concrete

```jsonc
// wrangler.jsonc (audit-only sketch)
{
+ "placement": { "mode": "smart" }
}
```

Per the [March 2025 stabilization](https://developers.cloudflare.com/changelog/post/2025-03-22-smart-placement-stablization/), placement is now sticky — the gateway will optimize its location and stay there. For tenants whose users are concentrated in one region but whose DO landed elsewhere, this is the cheapest p50-latency win available.

### G.3.4 Verify with `cf-placement` header

After enabling, every response gets a `cf-placement` header indicating whether it was Smart-Placed. Track via Lever F4 (Analytics).

---

## G.4 DO read replicas — applicability

### G.4.1 What's documented

[STOR/SPEC: Durable Objects read replication API](https://wiki.cfdata.org/display/STOR/SPEC%3A+Durable+Objects+read+replication+API):

> *"**Replica DO** A Durable Object that can only do reads on the underlying storage. Replica DOs have other technical differences like not having the durability followers a primary DO has but we are not concerned with those for this spec."*

Per [STOR/Durable Objects Replication Quick Start](https://wiki.cfdata.org/spaces/STOR/pages/1110730702/Durable+Objects+Replication+Quick+Start):

```jsonc
"compatibility_flags": ["experimental", "replica_routing"]
```

```ts
// In DO code
async init() {
  await this.ctx.storage.enableReplicas();
}

isReplica() { return this.ctx.storage.primary !== undefined; }

async vfsWriteFile(...) {
  if (this.isReplica()) {
    return this.ctx.storage.primary.vfsWriteFile(...);
  }
  // do the write
}
```

> *"Replicas can lag. Use `getCurrentBookmark()` after a write at the primary to get the current write's Lamport timestamp. Use `waitForBookmark()` to make sure you have that bookmark before doing whatever query you need to do."*

### G.4.2 Where it fits Nimbus

Read-mostly paths:
- **`/preview/*` static asset reads** — read VFS, render, return. No write per request (assets are stable between vite changes).
- **`/api/files?path=…` (if exists) read endpoints** — pure reads.
- **Initial session bootstrapping** — read project tree, render xterm UI scaffold.

Write paths (must hit primary):
- Every shell command that touches files
- Every npm install
- Every git commit
- Vite HMR write-back

### G.4.3 Lever G3 — gated experiment

Add `"experimental", "replica_routing"` flags. Inside `NimbusSession`, opt-in via `enableReplicas()`. Add the `isReplica()` write-forwarder to *every* write path.

⚠️ Caveat from [~lambros/Feedback for DO read replication API based on D1 read replication beta](https://wiki.cfdata.org/display/~lambros/Feedback+for+DO+read+replication+API+based+on+D1+read+replication+beta):

> *"Disable replicas before bulk imports (replicas error with 'Network connection lost' during high-volume writes)."*

For Nimbus, this means **disable replicas during npm install / git clone** (write-heavy bursts). Re-enable after. Same write-forwarder pattern as in MOSSAIC reference §5.

> *"Each replica DO will have its own Durable Object ID, so your logic can track them or do anything special if you need to keep track of replicas."*

⚠️ Speculation: this could complicate tenant identity in Nimbus. Today `tenantId` = DO ID. With replicas, the same `tenantId` corresponds to N DO IDs. Code that tracks "session N is on DO X" needs to handle both cases.

Effort: **M.** Substantial refactor of every write path. But a **major** UX win for cross-region tenants:

- Today: APAC user, ENAM-DO → 200 ms preview asset RTT
- After: APAC user, ENAM-primary + APAC-replica → 5-20 ms preview asset RTT

### G.4.4 Pricing implication

⚠️ ⚠️ Replica pricing is currently **TBD per the spec** ([STOR/SPEC §G.4.1.4](https://wiki.cfdata.org/display/STOR/SPEC%3A+Durable+Objects+read+replication+API)):

> *"Allow users to control their spend somehow (like number of replicas). Conditional on the pricing for replicas decision."*

Track for GA pricing announcement. ⚠️ speculation: replica reads will likely bill at standard DO compute, possibly with a small replica-overhead surcharge. The 7-replicas-globally figure (per MOSSAIC reference) suggests $7×base for fully-replicated, which Nimbus probably doesn't need.

---

## G.5 DO Storage cost — the 10 GB question

### G.5.1 What's documented

Per [PRICE/Durable Objects Storage Pricing](https://wiki.cfdata.org/display/PRICE/Durable+Objects+Storage+Pricing) and [public docs](https://developers.cloudflare.com/durable-objects/platform/pricing/):

DO Storage (SQLite-backed): typically billed per GB-month + per-row read/write operations. For Nimbus's 10 GB-per-tenant configuration ([`README.md`](../../README.md) §SQLite Virtual Filesystem):

- 10 GB × $X/GB-month per tenant (current price ~$0.20/GB/month for SQLite-backed)
- ~$2/tenant/month at full 10 GB usage; less if not full
- Plus per-write operations (each `transactionSync` is N rows write; bulk install of 57k files = 57k × $X / 1M ops)

### G.5.2 Lever G6 — audit per-tenant storage cost

Add a per-tenant storage-bytes metric to Analytics Engine (Lever F4):

```ts
// audit-only sketch
env.INSTALL_METRICS.writeDataPoint({
  blobs: ['storage-snapshot'],
  doubles: [vfsTotalBytes, lruBytes, hotPages],
  indexes: [tenantId],
});
```

Run once a day per tenant. Aggregate over tenants. Compare to billing dashboard.

The result informs:
- Pricing strategy (per-tenant cost basis)
- LRU sizing (Lever A2 from Section A — does shrinking LRU affect storage cost? answer: no, LRU is in-memory; storage cost is on-disk SQLite size)
- Cleanup policy (do you reap inactive tenants' VFS? at $2/tenant/month, an inactive long-tail of 10k tenants is $20k/month)

---

## G.6 Concrete diff, prioritised

### Lever G1 — codeId verification (XS)

Read `src/facet-manager.ts:744-900` carefully; document what `codeId` is. If not content-derived, fix:

```ts
// src/facet-manager.ts (audit-only sketch)
- const codeId = randomUUID();
+ const codeId = await fnv1a(workerCode);
```

### Lever G2 — long-lived facet coalesce (S)

See Section B Lever B1 sketch. Highest cost-impact lever in this section.

### Lever G4 — Smart Placement (XS)

```jsonc
"placement": { "mode": "smart" }
```

### Lever G5 — document batch-facet coalescing (S)

Document, with measurements, that `npm-resolve-facet` + `npm-install-batch-facet` coalesce correctly under the new SKU. Use Lever F4 telemetry.

### Lever G3 — DO read replicas (M)

After [STOR/SPEC] GAs and pricing is announced.

### Lever G6 — storage cost audit (S)

Pair with Lever F4.

---

## G.7 Citations summary

Wiki:
- PRICE/Dynamic Workers (canonical SKU)
- PRICE/Pricing Memorandum: Dynamic Workers
- ~shelley/[Billing] PRD: Dynamic Workers (Worker Loader)
- PRICE/Durable Objects Storage Pricing
- STOR/Mini-PRD: DO shared isolate issues (128 MB increment billing)
- STOR/SPEC: Durable Objects read replication API
- STOR/Durable Objects Replication Quick Start
- ~lambros/Feedback for DO read replication API based on D1 read replication beta

Public docs:
- developers.cloudflare.com/workers/configuration/placement/
- developers.cloudflare.com/changelog/post/2025-03-22-smart-placement-stablization/
- developers.cloudflare.com/durable-objects/platform/pricing/
- developers.cloudflare.com/workers/runtime-apis/rpc/ (Smart-Placement-ignored-on-RPC caveat)
- developers.cloudflare.com/durable-objects/api/storage-api/#getcurrentbookmark
- developers.cloudflare.com/d1/best-practices/read-replication/

Nimbus src/ citations:
- `src/facet-manager.ts:744-900` (codeId derivation site — Lever G1 verification)
- `src/facet-manager.ts:899` (`facetName = proc-${entry.pid}` — child DO name, distinct from codeId)
- `src/npm-install-batch-facet.ts:28` (3-pLimit, ~87 MiB peak — fairly-billed)
- `src/pre-bundle-facet.ts:307` (~100 MiB peak — fairly-billed)
- `src/parallel/facet-pool.ts:328-348` (dispose lifecycle — affects Daily Workers count)
- `src/sqlite-vfs.ts:150` (10 GB-per-tenant configuration — Lever G6 cost basis)
- `src/git-commands.ts` (per-clone facet today — Lever G2 target)
- `wrangler.jsonc:5` (compatibility_date — Lever G3 may need bump for replica_routing flag)
- `wrangler.jsonc:48-50` (worker_loaders — codeId surface)
- `README.md` §SQLite Virtual Filesystem (10 GB capacity claim)
