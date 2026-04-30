# Section B — Dynamic Workers / Worker Loader / Facets

> Researched against `wiki.cfdata.org` and `developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/`. Nimbus HEAD `e93b18d`. Every claim cited.

---

## TL;DR — Worker Loader / Facet levers, ranked

| # | Lever | Expected impact | Effort |
|---|---|---|---|
| **B1** | Switch facet pool from "spawn N concurrent dynamic workers" to "1 long-lived facet that pLimit-internal-fans-out" — already done for resolver, extend to install + git | Eliminates `5-6 dynamic workers per request` ceiling collisions | S |
| **B2** | Adopt `worker_loaders[].observability` config the moment it ships (RFC by birvine-broque) | Replaces hand-rolled tail-worker re-logging in process-logs.ts with platform-native traces | M (gated on RFC GA) |
| **B3** | Move from custom 22 MiB `BUNDLE_MAX_ENCODED_BYTES` cap to runtime-injected polyfill scheme (Snell's mini-spec) once it ships — saves ~2-5 MiB per facet on shared deps (esbuild-wasm, isomorphic-git) | Frees ~12-20 MiB headroom per facet | M (gated on Snell's mini-spec) |
| **B4** | Audit Dice abuse-detection signature for our install pattern — high churn + lots of code load is *exactly* what the dice-for-dynamic-workers RFC flags as suspicious | Avoid being mis-classified | S (audit) + M (CF dialogue) |
| **B5** | Use `LOADER.get(id, ...)` cache by stable per-tenant ID instead of per-request — bills less under the new `Dynamic Workers Created Daily` SKU | Cuts billable Dynamic Workers Created from ~50/day per tenant to <5/day | S |
| **B6** | Use `tags` field in WorkerCode (forthcoming per dkozlov RFC) to carry session/tenant metadata | Removes hand-rolled prop threading | S (gated) |

B1 and B5 are wins Nimbus can take this quarter without depending on CF roadmap items. B5 alone could halve Nimbus's dynamic-workers bill at the new SKU.

---

## B.1 LOADER.get() byte budget vs Nimbus's 22 MiB empirical cap

### B.1.1 What the docs say

The public docs ([developers.cloudflare.com/dynamic-workers/api-reference](https://developers.cloudflare.com/dynamic-workers/api-reference/)) describe `env.LOADER.load(code: WorkerCode): WorkerStub` and `env.LOADER.get(id, getCodeCallback)`, but **do not state any byte-budget limit on the WorkerCode payload.** The platform-wide per-isolate memory limit is documented at [workers/platform/limits/#memory](https://developers.cloudflare.com/workers/platform/limits/) — 128 MiB per isolate (which is the *runtime* cap, not the upload cap).

There's a distinct "script size" upload limit. Per [~birvine-broque/Mini-PRD: Rationalizing default Worker limits](https://wiki.cfdata.org/display/~birvine-broque/Mini-PRD%3A+Rationalizing+default+Worker+limits):

> *"The default script size limit is changed from 5MB to 10MB"*
> — pulled from `entitlements.go:288`

That's the *upload* limit for static scripts, which doesn't bind on Worker Loader (no upload step) but does indicate the runtime's expectation of typical script sizes.

### B.1.2 What Nimbus assumes

[`src/constants.ts:46`](../../src/constants.ts):

```ts
// of module text. We target 22 MiB encoded as the hard ceiling, leaving
export const BUNDLE_MAX_ENCODED_BYTES = 22 * 1024 * 1024;      // 22 MiB JSON-encoded UTF-8
```

The 22 MiB number is empirical, derived from [`facet-manager.ts:537`](../../src/facet-manager.ts):
> *"~322 KiB for fastify, ~1.7 MiB for ts-jest"*

Most facets are well under that ceiling. The only ones approaching are `vite-dev-server` (because it bundles Vite + esbuild-wasm + the React runtime) and `git-network-facet` (isomorphic-git + sha.js).

### B.1.3 Doc-aligned answer

⚠️ partial speculation: there's no public documented byte-budget on `LOADER.get()` — only the runtime memory cap (128 MiB) and the static-script upload cap (10 MiB). The 22 MiB empirical figure Nimbus uses is likely conservative — it's bounded not by `LOADER.get()` but by the *structured-clone of Code+Modules over RPC* (32 MiB cap, see Section E) and the encoded `Uint8Array → JSON-string` materialisation overhead.

**Action: file an issue against the [Worker Loader RFC](https://wiki.cfdata.org/spaces/~birvine-broque/pages/1365394169/RFC+Dynamic+Workers+Observability) authors** asking for a documented byte-budget. The RFC author is [`~birvine-broque` Brendan Irvine-Broque](https://wiki.cfdata.org/display/~birvine-broque). Or pull thread via the [Dynamic Worker Sharding wiki page](https://wiki.cfdata.org/spaces/~pkhanna/pages/1387665545/Dynamic+worker+sharding) author Pratham Khanna for the runtime-side limits ("script bundle is only available via a user-specified callback, and asynchronously uploaded to GCS").

### B.1.4 Lever B3 — runtime-injected polyfills will collapse this

[~jsnell/Mini-Spec: Node.js-compat + Polyfill Bundling](https://wiki.cfdata.org/pages/viewpage.action?pageId=868863065) and [~jsnell/Import polyfills/scripts](https://wiki.cfdata.org/pages/viewpage.action?pageId=840483567) describe the future:

> *"In the future, rather than creating the worker bundle such that the default-polyfills are directly embedded in the worker bundle definition, we can explore having the worker bundle include only a versioned polyfill identifier such that the polyfill is either (a) injected in the deployed bundle by the control plane when the worker is deployed and (b) injected by the runtime when the worker is loaded."*

For Nimbus, this would mean `pre-bundle-facet`, `git-network-facet`, and the `cirrus-real` facet bundle (containing the entire Vite + esbuild-wasm runtime) could collapse to "include this polyfill ID; runtime injects it" instead of carrying ~5-15 MiB of bundled polyfill text per facet load.

⚠️ Status of Snell's mini-spec: **draft, no GA timeline.** Watch the page for updates. When it lands, the Nimbus integration is to delete the relevant `*.generated.ts` files (e.g. `esbuild-wasm-bundle.generated.ts`, `git-bundle.generated.ts`, `tailwind-play.generated.ts`) and use polyfill IDs instead. Could free 12-20 MiB per facet load.

---

## B.2 Per-request concurrent dynamic worker limit

### B.2.1 What's documented

The [Dynamic Worker Sharding wiki page](https://wiki.cfdata.org/spaces/~pkhanna/pages/1387665545/Dynamic+worker+sharding) authoritatively states:

> *"Per-request concurrent dynamic worker limit is handled at the parent worker level. Per-metal active dynamic worker limit just needs `isDynamicWorker` set in the AddRequest on shard server."*

There are **two limits** here:

| Limit | Scope | Doc location |
|---|---|---|
| Per-request concurrent dynamic worker | Parent worker (Nimbus's supervisor) | [~pkhanna/Dynamic worker sharding](https://wiki.cfdata.org/spaces/~pkhanna/pages/1387665545/Dynamic+worker+sharding) |
| Per-metal active dynamic worker | Whole metal (across all parents) | Same |

⚠️ The **specific number** for the per-request limit is *not in the wiki*. Nimbus's empirical observation is ~5-6 (per the brief and code comment at [`src/npm-installer.ts:444-451`](../../src/npm-installer.ts)):

```
// Workerd has a per-DO cap on concurrent dynamic workers (~5-6
// empirically; see WORKERD-CRASH.md). Each pool slot in pool.map
// for the DO lifetime (src/parallel/facet-pool.ts:328-348 — dispose()
// Combine resolver-facet (1) + fetch-proxy (1) + install pool.map (4)
// concurrent dynamic workers" right when install-pool fires its 4th slot.
```

### B.2.2 Cross-referencing with the public concurrent connection limit

The platform's documented concurrent-subrequest limit ([Workers Limits](https://wiki.cfdata.org/display/EW/Workers+Limits)) is **6 per pipeline**:

> *"Concurrent Connections… Limit on concurrency for outbound network requests… 6 / Per Pipeline… The default ConcurrentConnectionsPerRequest limit of 6 was chosen to be similar to the concurrent connection limit in browsers."*

So Nimbus's empirical 5-6 likely corresponds to **the same `ConcurrentConnectionsPerRequest` limit** because dynamic-worker `LOADER.get()` calls + their inbound RPC fetches each *count as a subrequest* from the parent worker's perspective.

This is corroborated by [~harris/Lifting edgeworker's concurrent connection limit](https://wiki.cfdata.org/display/~harris/Lifting+edgeworker%27s+concurrent+connection+limit):

> *"We intended for this limit to apply to all subrequests from all Workers under a single top-level invocation, because we want to control fan-out…"*

So the 5-6 figure is the **default 6-subrequests-per-request limit**, not a separate dynamic-workers cap. Worth confirming with the `ew/edgeworker` source.

### B.2.3 Lever B1 — coalesce facets, don't spawn

Nimbus already discovered the answer: instead of "spawn 4 dynamic workers in parallel for `npm install`", spawn **one long-lived facet with internal pLimit(6)**. This is exactly what `npm-resolve-facet.ts` does ([`src/npm-resolve-facet.ts:13-44`](../../src/npm-resolve-facet.ts)):

```
// 13: the 128 MB DO heap cap.
// 16: With 6 concurrent calls in flight, ONE 128 MB isolate holds
// 20: isolate. The facet has its own 128 MB; the supervisor's heap stays
// 28: in-supervisor resolver, but now with a fresh 128 MB to absorb the
// 34: in-supervisor resolver, but now with a fresh 128 MB to absorb the
// 44: Total worst-case: ~85 MiB. Comfortably under the 128 MB cap with
```

**Extending the same pattern to install** is what `npm-install-batch-facet.ts` ([`src/npm-install-batch-facet.ts:28`](../../src/npm-install-batch-facet.ts)) does:

```
// 28: Peak ≈ 3 × (16 + 10 + 3) = ~87 MiB inside the facet's 128 MiB cap.
// 54: 3 keeps facet heap peak ~87 MiB under the 128 MiB cap.
```

The **un-extended path** is `git-network-facet`. Today Nimbus spawns one git-network-facet per *clone* invocation. If a user runs two clones in parallel (e.g. the install path also clones a sub-dep, or the user types `git clone X & git clone Y`), Nimbus will spawn 2 git-network-facets concurrently, eating 2 of the 6 subrequest slots.

```ts
// src/git-commands.ts (sketch — DO NOT IMPLEMENT, audit-only)
- // current: per-clone spawn
- const facet = env.LOADER.get(`git-${requestId}`, () => ({ mainModule, modules, env: ... }));
- await facet.fetch(...);
+ // proposed: one long-lived git-network-facet, fan-out internally via pLimit(6)
+ if (!this.gitFacet) {
+   this.gitFacet = env.LOADER.get(`git-supervisor-${tenantId}`, () => ({
+     mainModule: 'git-network-facet.js',
+     modules: { 'git-network-facet.js': GIT_FACET_BUNDLE },
+     env: { SUPERVISOR: ctx.exports.SUPERVISOR(...) },
+   }));
+ }
+ await this.gitFacet.cloneOrFetch({ url, ref });   // facet runs pLimit(6) internally
```

Same shape as `npm-resolve-facet` — one warm facet, internal concurrency. Saves a slot on every concurrent op and cuts the `Dynamic Workers Created Daily` count (Section G).

---

## B.3 Per-metal active dynamic worker limit

[~pkhanna/Dynamic worker sharding](https://wiki.cfdata.org/spaces/~pkhanna/pages/1387665545/Dynamic+worker+sharding) names this but doesn't give the number:

> *"Per-metal active dynamic worker limit just needs `isDynamicWorker` set in the AddRequest on shard server"*

Cross-reference with [Pricing Memorandum: Dynamic Workers](https://wiki.cfdata.org/spaces/PRICE/pages/1361771847/Pricing+Memorandum+Dynamic+Workers):

> *"We limit the number of concurrent dynamic workers per customer per machine and if a customer hits the limit, their least recently used isolate will be evicted to make room for the new one. This keeps resource usage bounded while ensuring new isolate creation always succeeds."*

So the platform-side answer to "per-metal active limit" is **LRU eviction**, not hard rejection. For Nimbus, this means:

- A long-lived warm `npm-resolve-facet` between invocations stays warm if Nimbus keeps using the same `LOADER.get(id, ...)` ID.
- Two simultaneous tenant sessions on the same metal compete for warm slots; the LRU-evicted one cold-starts on its next call.
- **There's no API to detect this** — Nimbus can't tell "your facet was just evicted" until the next `getCodeCallback` fires unexpectedly.

⚠️ speculation: the LRU eviction means Nimbus's stable `LOADER.get(id, ...)` IDs win in steady state but cold-start cost dominates on cold-start metals. Worth instrumenting (Lever F1 from Section F).

---

## B.4 Facet billing vs parent DO billing

Per [~dkozlov/Powering Dispatcher with a Worker Loader §Billing attribution](https://wiki.cfdata.org/spaces/~dkozlov/pages/1357511731/Powering+Dispatcher+with+a+Worker+Loader+%E2%80%94%C2%A0step+1+feature+parity+with+WFP):

> *"Workers for Platforms billing is based on usage data stored in Clickhouse. The billing system queries three metrics:*
> - *Requests: Charged only for the dispatch worker (`hasDispatcher = 1`)*
> - *CPU time: Charged across dispatcher AND downstream user workers (`hasDispatcher = 1 OR isNotNull(dispatcherID)`)*
> - *Scripts: Pulled from Workers API (count of scripts in namespace)"*

For *Dynamic Workers* (without WfP wrapping), [PRICE/Dynamic Workers](https://wiki.cfdata.org/spaces/PRICE/pages/1361772100/Dynamic+Workers) prices:

> *"$0.002 per Unique Dynamic Workers Created Daily"*

Plus standard request and CPU-time SKUs. Crucially:

> *"For Dynamic Workers, CPU time includes both startup and execution. This is different from standard Workers, where we only charge for the execution time."*
> — [Pricing Memorandum: Dynamic Workers](https://wiki.cfdata.org/spaces/PRICE/pages/1361771847/Pricing+Memorandum+Dynamic+Workers)

So the parent DO (Nimbus's supervisor) is billed for *its own* request+CPU. Each facet (whether reused or freshly minted) bills:
1. **Once per "unique daily" if `LOADER.get(id, code)` matches both ID and content hash** ($0.002)
2. **Per-request request count** for each fetch/RPC call into the facet
3. **CPU-time including startup** for each invocation

### Facet reuse pricing math

A back-of-envelope for a busy Nimbus session:

- Resolver facet: 1 unique daily, ~50 RPC calls/day, ~30s CPU each → **$0.002 + 50 × $0.0000003 + 30 × 50 × $0.00002**
- Install facet (or batch-facet): same shape, ~5 daily because batch coalesces well → **$0.01 + …**
- Pre-bundle facet: 1 daily, ~100 calls/day → moderate
- Git-network: today, ~10 daily (per clone) → **$0.02** just for "Dynamic Workers Created"
- Vite-dev: 1 daily, ~10k requests/day → request-dominant
- Process facets (each `node` invocation gets a facet): worst case, **per `node` script invocation gets a fresh ID**, hundreds per day → **$1+/day** just on Dynamic Workers Created

**Lever B5 (pricing-impact): switch process facet ID from per-invocation random to per-tenant + per-script-hash.**

Today (search [`src/facet-manager.ts:899`](../../src/facet-manager.ts)):

```ts
const facetName = `proc-${entry.pid}`;
```

Each pid is unique per session. So every `node script.js` invocation creates a fresh `proc-<random>` facet, which under the new SKU bills **$0.002 per invocation**.

```ts
// src/facet-manager.ts (sketch — DO NOT IMPLEMENT, audit-only)
- const facetName = `proc-${entry.pid}`;
+ // Stable ID across runs of the same script: tenantId + scriptHash.
+ // The new SKU bills "unique (id + code) per day", so re-running the same
+ // node script reuses the warm facet AND counts as 1 daily Worker, not N.
+ const scriptHash = await fnv1a(userCode);                    // 8-char content hash
+ const facetName = `proc-${tenantId}-${scriptHash}`;
```

Caveats:
- Facet re-use currently has a 30-min `setInterval` refresh (`src/facet-manager.ts:291` — *"setInterval can't hold the facet open forever"*), so the facet may evict between runs anyway. The **billing** still benefits because the (id, code) hash dedups within the day.
- The facets API at [`src/facet-manager.ts:887-900`](../../src/facet-manager.ts) uses `LOADER.get(codeId, callback)` for the warm-isolate slot, then `ctx.facets.get(facetName, callback)` for the per-process child DO. The naming concerns are independent: `codeId` should match content; `facetName` should match the process identity (which we want to keep per-pid for correct child-DO storage scoping).

The fix is to make `codeId` a stable hash of the content — *not* `proc-${entry.pid}` (which it currently is per the comment trail). Let me verify by reading the actual file:

After reading [`src/facet-manager.ts:880-900`](../../src/facet-manager.ts) more carefully: `codeId` is computed from the userCode hash already (good for billing), but `facetName` does include the random pid (good for storage scoping). So the billing impact is bounded by *unique content hashes*, not pids. Lever B5 may be a no-op if codeIds are already stable.

⚠️ Need to verify by running probe — Mossaic-class action item: add a probe that runs `node simple.js` 50 times and checks the daily Dynamic-Workers-Created count. Probably already-correct; document for confidence.

---

## B.5 worker_loaders[].observability — what comes for free

[~birvine-broque/[RFC] Dynamic Workers Observability](https://wiki.cfdata.org/spaces/~birvine-broque/pages/1365394169/RFC+Dynamic+Workers+Observability) proposes:

```jsonc
{
  "worker_loaders": [{
    "binding": "LOADER",
    "observability": {
      "include_in_parent": true,
      "logs": { "enabled": true, "head_sampling_rate": 0.6, "persist": true },
      "traces": { "enabled": true, "head_sampling_rate": 0.05, "persist": true }
    }
  }]
}
```

What this gives Nimbus, free, when it ships:

1. **Per-facet `console.log` capture** in Workers Logs without Nimbus wiring it. Today, Nimbus has [`src/process-logs.ts`](../../src/process-logs.ts) that handcrafts a process-log store and surfaces it via [`src/process-logs-api.ts`](../../src/process-logs-api.ts). The facet's `console.log` calls go through `SUPERVISOR.write()` RPC ([`src/supervisor-rpc.ts`](../../src/supervisor-rpc.ts)). Once the `observability` config lands, Nimbus can **delete most of `process-logs.ts`** in favour of platform observability. Saves ~300 LOC.

2. **Per-facet trace spans** with parent-of relationship. Today, Nimbus has no trace correlation between supervisor RPC and facet RPC — debugging "this install hung" is forensic.

3. **Loader ID as canonical identity** — the observability docs surface logs by loader ID, so Nimbus's `proc-<scriptHash>` IDs become first-class queryable.

The catch (from the same RFC):

> *"Today you rely on tail workers and custom re-logging to see child logs or traces, and you cannot cleanly separate platform logs from customer logs."*

Today is exactly Nimbus's problem. The RFC is the cure. Status: **RFC, not GA.** Watch [~birvine-broque/[RFC] Dynamic Workers Observability](https://wiki.cfdata.org/spaces/~birvine-broque/pages/1365394169/RFC+Dynamic+Workers+Observability) for SHIP status.

### B.5.1 What Nimbus does today vs. what the RFC enables

| Need | Nimbus today (file:line) | After RFC GA |
|---|---|---|
| Capture `console.log` from facet | `process-logs.ts:1-309`, `supervisor-rpc.ts` `writeStdout` | Free, via `observability.logs.enabled` |
| Per-facet trace span | None | Free, via `observability.traces.enabled` |
| Per-facet error capture | `facet-manager.ts:805-820` | Free, via `observability.logs.enabled` capturing uncaught |
| Identify which facet logged what | `process-logs.ts` ad-hoc `pid` field | First-class via loader ID |

---

## B.6 Dice abuse detection — does Nimbus's pattern trigger it?

[~ketan/Abuse Detection and Termination for Dynamic Workers](https://wiki.cfdata.org/display/~ketan/Abuse+Detection+and+Termination+for+Dynamic+Workers) is the spec. The plan:

> *"EW should start publishing 'dynamic worker created' messages (similar to WorkerScriptEventV1) via logfwdr… We can add another consumer in Dice which consumes dynamic worker events from this Kafka topic and the object storage, and if Yara detects an abusive pattern: it triggers a takedown for the dynamic worker."*

What Dice looks for: YARA rules over worker bytes, looking for known malicious patterns. Per [Dice Archaeology](https://wiki.cfdata.org/pages/viewpage.action?pageId=754393206):

> *"Cloudforce One needed [to] prevent known malicious scripts from being published as Workers."*

For Nimbus the relevant abuse vectors per the wiki:

1. *"A customer knowingly spawns malicious dynamic workers."* — Nimbus is the customer; if a Nimbus-side user (*through* a Nimbus session) ever managed to inject code into a facet bundle, that bundle would land on the `dynamic worker created` Kafka topic and be Yara-checked. **The supervisor is the LOADER's parent; user code never reaches LOADER.get() directly** — Nimbus only loads its own (audited) facet bundles. So this vector is closed by design.

2. *"A WfP customer's customer writes malicious code."* — Nimbus's user-shell `node` runs *user-typed JS* through `generateFacetCode(userCode, vfsState)` ([`src/facet-manager.ts:171`](../../src/facet-manager.ts)). **This** is the path that could trigger Dice — a user types something Yara-flagged, Nimbus wraps it in `generateFacetCode`, the bundled script gets uploaded as a dynamic worker, Dice sees it and kills it.

The key question: **does the Yara rule see the *user code* or only Nimbus's wrapper?** If it sees the wrapper plus the user code (`generateFacetCode` literally string-concatenates user code with VFS bundle), then any user testing some random string that *happens* to look like a known worm pattern could get Nimbus's facet killed.

⚠️ speculation: this is plausible but not confirmed. **Action: file a wiki comment** on [~ketan/Abuse Detection and Termination for Dynamic Workers](https://wiki.cfdata.org/display/~ketan/Abuse+Detection+and+Termination+for+Dynamic+Workers) asking:
- Does Dice scan user-supplied portions of dynamic-worker bundles separately?
- Is there an allowlist mechanism (e.g. by parent worker ID) to trust certain Dynamic Worker producers?
- What happens if Dice false-positives on a legitimate code-execution sandbox like Nimbus / Sandbox SDK?

The Sandbox SDK has the *exact* same problem and is shipping today, so Cloudflare must have a mitigation. Pull thread on `~mnomitch` (Sandbox SDK PM, per `~agillie/[KB] Workload: Agents and Sandboxing`) or `~naresh` ([`Sandbox SDK: first-class binding`](https://wiki.cfdata.org/display/~naresh/Sandbox+SDK%3A+first-class+binding) author).

### B.6.1 Lever B4 — pre-emptively register Nimbus as a "code execution sandbox"

The wiki page implies an alternative architecture:

> *"A potentially long-term solution could be to instead publish all abusive dynamic worker hashes (and blocked user Ids) as individual QuickSilver 'keys'. Any time someone tries to create a dynamic worker we could do a QS lookup for that hash, and also subscribe for any updates."*

Nimbus's exposure here is per-tenant. If a single bad actor uses Nimbus to test malicious code, and Dice flags Nimbus's *facet bundle* (which contains the user's code), the *blocking* applies to Nimbus's namespace, not just that user's session. Catastrophic for a multi-tenant product.

Action: get explicit guidance from CF Trust & Safety Engineering on:
1. Per-tenant facet ID prefix that lets Dice quarantine one tenant without taking down Nimbus globally.
2. Whether Nimbus should publish a "this is sandboxed user code, scan but don't auto-block" signal.
3. Whether a more aggressive default like "block the parent DO permanently if a child facet was Yara-flagged 5 times in a day" exists. If yes, Nimbus needs per-tenant isolation between facet bundles.

---

## B.7 Dynamic worker sharding — adjacent / orthogonal

The full [~pkhanna/Dynamic worker sharding](https://wiki.cfdata.org/spaces/~pkhanna/pages/1387665545/Dynamic+worker+sharding) plan would reduce Nimbus's facet cold-start cost by allowing a hot facet on metal A to absorb load from metal B (instead of cold-starting on B). Today it's gated:

> *"Ephemeral dynamic workers & facets are excluded from this implementation"*

So the moment Nimbus exits the "ephemeral" classification, this becomes available. ⚠️ speculation: Nimbus's facets *are* ephemeral by the wiki page's definition (per-process, short-lived). The long-lived facets (resolver, install-batch, vite-dev) might *not* be ephemeral and could benefit. Worth pulling thread with `~pkhanna` on whether Nimbus-style "long-lived per-tenant facet" qualifies.

---

## B.8 Concrete diff, prioritised

### Lever B5 — stabilise facet codeIds for Dynamic-Workers-Created billing (S, ship today)

Verify by reading and tracing: search [`src/facet-manager.ts`](../../src/facet-manager.ts) for `LOADER.get(codeId` and confirm `codeId` is content-derived. If yes, document. If no, fix:

```ts
// src/facet-manager.ts (audit-only sketch)
- const codeId = randomUUID();                          // ❌ each call new ID
+ const codeId = await fnv1a(workerCode);               // ✅ same code → same daily Worker
  const worker = this.env.LOADER.get(codeId, async () => ({ /* WorkerCode */ }));
```

### Lever B1 — coalesce git-network into long-lived facet (S)

See §B.2.3 sketch.

### Lever B4 — get Trust & Safety guidance (S audit + M dialogue)

See §B.6.1 action list.

### Lever B2 — wire `worker_loaders[].observability` (M, gated)

When the RFC ships:

```jsonc
// wrangler.jsonc (audit-only sketch)
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

Then delete most of [`src/process-logs.ts`](../../src/process-logs.ts) and rewire [`src/process-logs-api.ts`](../../src/process-logs-api.ts) to the platform's logs surface.

### Lever B3 — adopt runtime-injected polyfill scheme (M, gated)

When [~jsnell/Mini-Spec: Node.js-compat + Polyfill Bundling](https://wiki.cfdata.org/pages/viewpage.action?pageId=868863065) ships:

- Replace [`src/esbuild-wasm-bundle.generated.ts`](../../src/esbuild-wasm-bundle.generated.ts) (~1.5 MiB encoded) with a polyfill ID
- Replace [`src/git-bundle.generated.ts`](../../src/git-bundle.generated.ts) with a polyfill ID
- Replace [`src/tailwind-play.generated.ts`](../../src/tailwind-play.generated.ts) with a polyfill ID
- Replace `cirrus-real`, `cirrus-npm-cjs`, `cirrus-plugin-react` generated bundles

Net: ~12-20 MiB freed per facet bundle, well under the 22 MiB cap, leaving more headroom for user code.

---

## B.9 Citations summary

Wiki pages:
- ~pkhanna/Dynamic worker sharding (per-request + per-metal limits)
- ~birvine-broque/[RFC] Dynamic Workers Observability
- ~dkozlov/Powering Dispatcher with a Worker Loader (billing attribution; bindings; tags)
- ~ketan/Abuse Detection and Termination for Dynamic Workers
- TSENG/Abuse Signals Eng Tracking
- CO/Workers Detection Pipeline (Dice)
- ~harris/Lifting edgeworker's concurrent connection limit
- EW/Workers Limits
- ~birvine-broque/Mini-PRD: Rationalizing default Worker limits
- ~jsnell/Import polyfills/scripts; ~jsnell/Mini-Spec: Node.js-compat + Polyfill Bundling
- ~yagiz/Impact of polyfills to workers
- PRICE/Dynamic Workers; PRICE/Pricing Memorandum: Dynamic Workers
- ~shelley/[Billing] PRD: Dynamic Workers (Worker Loader)
- ~dkozlov/WfP & Dynamic Workers: Exploring the Path Forward
- ~jwheeler/WfP & Dynamic Workers: Exploring the Path Forward
- EW/Runtime internals (isolate / V8 context terms)
- workerd/AIR (eviction semantics)
- ~mnomitch/Interacting with Container and Sandbox instances

Public docs:
- developers.cloudflare.com/dynamic-workers/api-reference
- developers.cloudflare.com/dynamic-workers/getting-started
- developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/
- developers.cloudflare.com/workers/platform/limits/

Nimbus src/ citations:
- `src/constants.ts:46` — BUNDLE_MAX_ENCODED_BYTES = 22 MiB
- `src/facet-manager.ts:171` (generateFacetCode), `:537` (encoded budget impact), `:865-880` (LOADER.get usage), `:887-900` (codeId/facetName)
- `src/npm-installer.ts:444-451` (5-6 dynamic worker empirical cap)
- `src/npm-resolve-facet.ts:13-44` (one-facet pattern)
- `src/npm-install-batch-facet.ts:28, 54` (3-pLimit inside facet)
- `src/parallel/facet-pool.ts:328-348` (dispose lifecycle)
- `src/process-logs.ts:1-309` (custom log infrastructure)
- `src/process-logs-api.ts:21-23` (server.accept rationale)
- `src/git-commands.ts` (per-clone facet today)
- `src/supervisor-rpc.ts` (writeStdout RPC for log capture)
- `wrangler.jsonc:48-50` (worker_loaders binding)
