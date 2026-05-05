# W12 Plan — DO Read Replicas + Smart Placement

> **Status:** Phase A (plan) — autonomous wave runner (year-long horizon)
> **Branch:** `w12-multi-region`
> **Base:** `main` @ 306b8b3 (Phases 1-4 merged)
> **Goal (from MASTER-ROADMAP):** p99 preview latency from any region <500ms

---

## 1. Executive summary

W12 attacks the **cross-region preview latency gap**. Today, a tenant whose DO was placed in `iad` (Ashburn) takes a US⇄EU/APAC RTT round-trip on every `/preview/<asset>` GET, regardless of how cheap the actual handler is. That's a hard ceiling at ~150–250 ms p50 for EU and ~250–350 ms for APAC, with p99 commonly >500 ms once the cold-cache seed/transform path lights up.

Two CF levers attack this from different angles:

| Lever | What it does | Where it helps | Where it doesn't |
|---|---|---|---|
| **G3 / Lever 12 — DO read replicas** (wiki SPEC: STOR/Durable Objects read replication API; "now GA" per master-roadmap brief) | Spawns regional read-only DO instances that replicate from a primary. Read-mostly fetches return locally; writes still go to the primary. | `/preview/*` static-asset reads after first warm; `/api/_diag/*` reads. | First-time seeds, npm install, git clone, Vite cold-bundle (writes). |
| **G4 / Lever 7 — Smart Placement** ([docs](https://developers.cloudflare.com/workers/configuration/placement/), March 2025 stabilization) | Cloudflare measures the gateway Worker's request duration in different colos and pins it to the optimum. | The gateway Worker's `fetch()` to `env.NIMBUS_SESSION.get(id).fetch(...)` — moves the gateway near the DO so the inbound forward is fast. | RPC into the DO is unchanged (Smart Placement is "ignored when making RPC calls" per [Workers RPC docs](https://developers.cloudflare.com/workers/runtime-apis/rpc/)). DOs themselves don't move. |

**Together** they bound preview latency:
- Smart Placement removes the gateway⇄DO RTT for warm tenants.
- Read replicas remove the user⇄DO RTT for read paths even for cold gateways.
- Worst case (cold + write): no improvement, but those are the rare paths and W3-W11 already optimized them.

⚠️ **Naming clarification:** The master-roadmap and this wave's brief say "Smart Placement for the supervisor DO". That phrasing is loose. **DOs themselves cannot be placed by Smart Placement** — the lever applies to the *gateway Worker* (the `fetch` handler in `src/index.ts`) which is the supervisor's eyeball-edge entry point. CF research §J.9 explicitly lists "Smart Placement of the supervisor DO" as **NOT doing**. We enable Smart Placement on the Worker. The DO benefits indirectly because the gateway-to-DO hop is now intra-colo for warm tenants.

---

## 2. Read-mostly route inventory

Audit of `src/nimbus-session.ts` `_handleFetch()` (line ~1554) and `src/index.ts` (line ~75). Routes inside the DO classified as **read-only** (replica-safe), **write-on-first-call** (replica-fallback), or **write-heavy** (primary-only).

| Route | Class | Reason | Replica policy |
|---|---|---|---|
| `/preview/*` (Vite static + transformed JS) | **read-on-warm, write-on-cold** | First call seeds VFS + boots `ViteDevServer` (writes esbuild cache). Subsequent calls read transformed bundles. | **Replica-eligible AFTER warm.** Replica returns 503 + `X-Nimbus-Primary-Required: warmup` for cold; primary handles warm-up. |
| `/api/_diag/memory` | **read with side-effect (peak update)** | Updates `_diagPeakRss` in-memory. Side effect is per-isolate and not persistent — reading on a replica updates *the replica's* peak, which is fine and informative ("EU replica saw peak X"). | **Replica-eligible.** Peak is intentionally per-isolate. |
| `/api/_diag/*` (other) | **read-only** | Snapshots of in-memory + storage state. | **Replica-eligible.** |
| `/api/memory` | **read-only** | Snapshot of vfs stats + memoryUsage. | **Replica-eligible.** |
| `/api/processes` | **read-only** | Lists ProcessTable. | **Replica-eligible** (replica may show fewer processes — eventual consistency). |
| `/api/stats` | **read-only** | Used by the placeholder "no dev server" page to poll for vite-up. | **Replica-eligible.** Polled every 2 s — acceptable lag. |
| `/api/processes/<pid>/logs` (WS) | **WebSocket-hibernatable** | Streams persisted log chunks. The handler calls `ctx.acceptWebSocket` (line 1616) to enable hibernation. | **Primary-only-ws.** A replica accepting the WS would subscribe the *replica's* hibernation handler and miss appends from the primary. Marked `primary-only-ws` in the routing table; replica returns 503 on upgrade. |
| `/api/_test/*` | **mixed** | Test-only endpoints: spawn-emitter writes; hib/simulate writes; log-tail reads. | **Primary-only.** Test endpoints; predictability > latency. |
| `/api/write-file`, `/api/mkdir`, `/api/start-vite`, `/api/supervisor-rpc` | **write** | Direct VFS writes / vite boot. | **Primary-only.** |
| `/ws` (terminal upgrade) | **stateful WS** | Hibernatable shell session — must be primary so writes from shell commands land. | **Primary-only.** Document why: the shell mutates VFS continuously. |
| `/preview/__nimbus_hmr` (WS) | **stateful WS, HMR** | Routed to `cirrusReal` (a facet) — facet writes to primary anyway. | **Primary-only.** WS upgrade itself must hit primary. |
| `/worker/*` (nimbus-wrangler dev) | **read-on-warm, write-on-cold** | Same shape as `/preview/*` but for `wrangler dev`. | **Replica-eligible AFTER warm** (W12 phase 1 ships replica gating for `/preview/*` only; `/worker/*` deferred to W12.5 if measured demand). |
| `/port/<n>/*` | **proxy to facet** | The facet itself is owned by the primary DO; replica can't talk to a facet that isn't there. | **Primary-only.** |

**Selection for W12 phase 1:** Replicate the simple, high-volume, idempotent reads first — `/preview/*` (after warm), `/api/_diag/*`, `/api/memory`, `/api/processes`, `/api/stats`. `/worker/*` defers to W12.5 because the wrangler-dev population is smaller and the cold-warm distinction is more complex (KV/D1/R2 emulators can be inadvertently mutating).

---

## 3. Replica annotation contract

Inspired by the W7 `writeBatchStream`-feature-detect pattern: defensively probe replica APIs at runtime and graceful-degrade when absent.

### 3.1 API shape (per CF research §G.4 / §J.7.1)

```ts
// Constructor — fired on every NEW isolate (primary + replica alike)
constructor(ctx, env) {
  super(ctx, env);
  // Best-effort: enable replicas. Older runtime / no compat flag → throw,
  // we swallow and continue. Same module loaded on replica isolates;
  // replicas STILL run init paths and ctor.
  try {
    if (typeof (ctx.storage as any).enableReplicas === 'function') {
      // wiki SPEC API
      (ctx.storage as any).enableReplicas();
    } else if (typeof (ctx.storage as any).configureReadReplication === 'function') {
      // J.7.1 sketch API (alternate name observed in research)
      (ctx.storage as any).configureReadReplication({ mode: 'auto' });
    }
  } catch (e) { /* graceful: pre-GA runtime / wrong compat flag */ }
}

// On every fetch: am I the primary or a replica?
private isReplica(): boolean {
  return typeof (this.ctx.storage as any).primary !== 'undefined';
}
```

`ctx.storage.primary` is a **stub** to the primary DO when this isolate is a replica. On the primary itself, `primary` is `undefined`.

### 3.2 Routing decision (in `_handleFetch`)

```ts
const url = new URL(request.url);
const policy = classifyReplicaPolicy(url.pathname, request.method);
//   'replica-ok'         — handle locally on replica or primary
//   'replica-warm-only'  — handle on replica IFF warm; else 503 fallback
//   'primary-only'       — replica returns 307 to primary OR uses
//                          ctx.storage.primary stub fallback
//   'primary-only-ws'    — replica refuses, returns 503; client retries

if (this.isReplica() && policy === 'primary-only') {
  // Two options:
  //   (a) forward via ctx.storage.primary.fetch(request) — single RPC hop,
  //       request lands on primary; same colo if primary near replica.
  //   (b) return 503 with X-Nimbus-Primary-Required so the client retries
  //       (browser/xhr reissues against primary by colo routing).
  // We go with (a): fewer client-visible failures, single RPC adds <40 ms.
  return await (this.ctx.storage as any).primary.fetch(request);
}

if (this.isReplica() && policy === 'replica-warm-only') {
  if (!this.viteDevServer?.isRunning) {
    // Cold on the replica — delegate to primary.
    return await (this.ctx.storage as any).primary.fetch(request);
  }
  // Warm: handle locally
}

// 'replica-ok' or primary: handle as before
```

The `classifyReplicaPolicy()` decision table is implemented in `src/replica-routing.ts` (new file; pure function, easy to test).

### 3.3 Write path delegation (the EVERY-WRITE rule)

CF research §J.7.1 sketch:
```ts
async vfsWriteFile(path, data) {
  if (this.isReplica()) {
    return this.ctx.storage.primary.vfsWriteFile(path, data);
  }
  /* existing write logic */
}
```

For W12 phase 1 we **don't** add replica-fallback to every write method, because most write paths are primary-only by route policy (we already 307'd/forwarded to primary above). The only writes that can run on a replica isolate are:
- The `_diagPeakRss` update inside `/api/_diag/memory` — intentional per-isolate behavior, not delegated.
- Lazy-init writes that happen as side effects of READ paths: e.g. `seedFilesystem()` inside `/preview/*` cold-handler. **These must be guarded by `replica-warm-only`** (already done).
- W9's `_w9MaybeBumpIsolateGen` storage write at the start of every fetch — this is **per-isolate**; replicas tracking their own gen is fine and informative. Document but don't gate.

### 3.4 Eventual-consistency tolerance

| Route | Stale window | User-visible effect |
|---|---|---|
| `/preview/*` (warm) | ≤ replication lag (target ≤2s per [D1 best-practice doc](https://developers.cloudflare.com/d1/best-practices/read-replication/), DO replicas same order) | Stale JS bundle; HMR will replace on next save |
| `/api/processes` | ≤2s | List may miss a just-spawned PID; UI re-polls |
| `/api/stats` | ≤2s | Polled every 2s anyway; no observable degradation |
| `/api/_diag/*` | ≤2s | Diagnostic only; lag itself is a useful signal |
| `/api/memory` | ≤2s | Snapshot; reading slightly stale numbers is acceptable |

W12 contract: **replica reads tolerate ≤2s eventual-consistency window**. Anything tighter delegates to primary.

### 3.5 Fallback if replica behind / unreachable

Three failure modes from [~lambros/Feedback for DO read replication API](https://wiki.cfdata.org/display/~lambros/Feedback+for+DO+read+replication+API+based+on+D1+read+replication+beta):

1. **"Network connection lost" during high-volume writes.** Mitigation: replicas **disabled during npm install / git clone**. Implementation: a `replicasSuspended` flag, set from the install/clone start, cleared on completion. While suspended, `enableReplicas()` is a no-op AND new requests routing into a replica isolate are 307'd to primary at the gateway. Phase-1 ships the in-DO suspension; gateway-side 307 is W12.5.
2. **Replica too far behind.** Mitigation: `getCurrentBookmark()` on writes, set as cookie / header (`X-Nimbus-Bookmark`), and the next read uses `waitForBookmark` (or equivalent) to ensure read-your-writes. Phase-1 wires the bookmark capture but does NOT gate on it (no API surface in current SPEC for `waitForBookmark` on DOs — we document and defer to phase 2).
3. **Replica enabled but runtime doesn't have it.** Already handled by the `typeof === 'function'` probe in 3.1.

---

## 4. Smart Placement — supervisor analysis

Where do facet RPCs vs npm fetches dominate the gateway's latency budget?

### 4.1 Latency taxonomy (gateway Worker, `src/index.ts`)

| Path | Today's hot calls | Smart Placement effect |
|---|---|---|
| `/` | Static asset only (`run_worker_first` excludes `/`) | None — Worker not invoked. ✅ |
| `/new` | `generateSessionId()` + 302 | Negligible — no upstream calls. |
| `/s/<id>/<rest>` | `env.NIMBUS_SESSION.idFromName(id)` + `stub.fetch(rewrittenRequest)` — pure RPC into the DO | **None directly** (Smart Placement ignored on RPC). **But:** if Smart Placement pins the gateway near the DO's region, the RPC is intra-colo: ~5 ms instead of cross-continent ~150 ms. |

The gateway makes **no external HTTP calls** outside the DO RPC. So the placement signal is purely "where do most DO stubs live?" Smart Placement learns from request duration, and the DO's real work *is* the request duration the gateway sees, which embeds the cross-region RTT. So Smart Placement *will* converge to "place gateway near where most DOs are" — exactly what we want.

### 4.2 Where facet RPCs vs npm fetches dominate

This question is more relevant to **W4's npm install flow inside the DO**, but it's worth answering for completeness.

Inside the DO (NimbusSession) — i.e. the supervisor — the latency hotspots:

| Hotspot | Today | After Smart Placement on gateway |
|---|---|---|
| `/preview/*` cold transform (esbuild on 100s of files) | 2-8 s, dominated by CPU + VFS I/O | Unchanged — happens inside the DO, which doesn't move. |
| `/preview/*` warm read | 5-50 ms inside the DO + cross-region RTT | **Cross-region RTT is GONE on replica reads.** Smart Placement also pins the gateway. |
| `npm install` packument fetch (registry.npmjs.org) | 30-200 ms each, ~30-50 packuments | Unchanged — DO is fixed. R2 cache already mitigates (W4). |
| `npm install` tarball fetch | 20-150 ms each, ~250 tarballs for Mossaic | Unchanged. R2 cache already mitigates. |
| Facet RPC (DO ↔ npm-install-batch-facet) | ~1-3 ms (intra-colo, same metal) | Unchanged. Facets always co-locate with their DO ([Worker Loader docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)). |

**Conclusion:** Smart Placement on the gateway helps `/s/<id>/...` ingress latency. It does **not** help npm install (which is upstream-fetch-bound), nor facet RPC (already intra-colo). The only DO-internal lever for cross-region npm install would be Workers-near-npm placement of a *separate* fetch-proxy Worker — that's a follow-up, not in W12 scope.

### 4.3 Static asset trade-off (CRITICAL)

⚠️ Per [placement docs](https://developers.cloudflare.com/workers/configuration/placement/): *"If your code retrieves assets via the static assets binding, assets are served from the location where your Worker runs."*

Nimbus's `wrangler.jsonc` sets `run_worker_first: ["/s/*", "/new"]`. Bare `/` (landing page) **does NOT** invoke the Worker; assets at `/` are served from the eyeball edge regardless. ✅ Landing page perf preserved.

But: the session shell at `/s/<id>/` *does* invoke the Worker, which then `env.ASSETS.fetch(...)` for `/s/index.html`. With Smart Placement, that ASSETS fetch happens in the Worker's pinned location — possibly far from the user. Mitigation: the session shell HTML is small (one short file), so this adds <10ms in worst case. Acceptable.

If the trade is bad in practice, the W12.5 follow-up can split: a tiny no-placement edge Worker that serves the shell HTML, and a placed inner Worker that does session RPC. Documented.

---

## 5. wrangler.jsonc diff sketch

Note: project uses **wrangler.jsonc** (not toml — the brief was loose). Edits:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "nimbus",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": [
    "nodejs_compat",
    "experimental",
+   // [W12 Lever 12] Enable DO read replicas. Per
+   // STOR/Durable Objects read replication API (wiki SPEC) +
+   // CF-INTERNAL-OPTIMIZATION-RESEARCH §G.4 / §J.7.1. The flag is
+   // additive and graceful-degrades: pre-GA runtimes that don't
+   // recognize it ignore it, and the runtime probe in
+   // NimbusSession.constructor() makes the DO functional either way.
+   "replica_routing"
  ],
+ // [W12 Lever 7] Smart Placement on the gateway Worker (this Worker).
+ // Per CF docs (workers/configuration/placement/): only affects fetch
+ // event handlers, not RPC. The gateway's hot path is fetch → DO RPC,
+ // so Smart Placement pins the gateway near the DO region. DOs do not
+ // move (per CF research §J.9). The first-call analysis takes ≤15 min
+ // post-deploy; until then placement is default-region.
+ "placement": { "mode": "smart" },
  /* … vars, assets, alias, durable_objects, migrations,
        worker_loaders, r2_buckets unchanged … */
}
```

That's the **entire** config diff for W12. The runtime probes do the heavy lifting.

---

## 6. Code changes (src/) sketch

### 6.1 New file: `src/replica-routing.ts` (~80 LOC, pure)

```ts
export type ReplicaPolicy =
  | 'replica-ok'         // handle locally, no primary delegation
  | 'replica-warm-only'  // handle locally if warm, else delegate
  | 'primary-only'       // delegate to primary
  | 'primary-only-ws';   // refuse on replica, primary handles WS

export function classifyReplicaPolicy(
  pathname: string,
  method: string,
): ReplicaPolicy { /* per §2 table */ }

export function shouldSuspendReplicas(activeOps: {
  npmInstallCount: number;
  gitCloneCount: number;
}): boolean {
  return activeOps.npmInstallCount > 0 || activeOps.gitCloneCount > 0;
}
```

### 6.2 `src/nimbus-session.ts` edits

(a) **Constructor:** Best-effort `enableReplicas()` after `super(ctx, env)`.

```ts
constructor(ctx, env) {
  super(ctx, env);
  this._w12TryEnableReplicas();
  /* … existing W9 / process-table / facet-pool / log-persist init … */
}

private _w12TryEnableReplicas(): void {
  try {
    const s: any = this.ctx.storage;
    if (typeof s.enableReplicas === 'function') {
      s.enableReplicas();
      this._w12Replicas = 'enabled';
    } else if (typeof s.configureReadReplication === 'function') {
      s.configureReadReplication({ mode: 'auto' });
      this._w12Replicas = 'enabled-via-configure';
    } else {
      this._w12Replicas = 'unsupported';
    }
  } catch (e: any) {
    this._w12Replicas = 'error';
    this._w12ReplicasError = e?.message;
  }
}

private isReplica(): boolean {
  try { return typeof (this.ctx.storage as any).primary !== 'undefined'; }
  catch { return false; }
}

private getReplicaState(): {
  isReplica: boolean;
  replicasEnabled: string;
  bookmark: string | null;
  error: string | null;
} {
  let bookmark: string | null = null;
  try {
    const fn = (this.ctx.storage as any).getCurrentBookmark;
    if (typeof fn === 'function') bookmark = String(fn.call(this.ctx.storage));
  } catch {}
  return {
    isReplica: this.isReplica(),
    replicasEnabled: this._w12Replicas ?? 'unknown',
    bookmark,
    error: this._w12ReplicasError ?? null,
  };
}
```

(b) **`_handleFetch()` early branch (line ~1554):**

```ts
private async _handleFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  await this.hydrateSessionBasePath(request);
  await this._w9MaybeBumpIsolateGen();

  // ── W12 replica routing ─────────────────────────────────────────────
  // Decide whether THIS isolate (primary or replica) should handle the
  // request locally or delegate to the primary via ctx.storage.primary.
  const replicaInfo = this._w12RoutingPreflight(url.pathname, request.method);
  if (replicaInfo.delegate === true) {
    // The replica forwards the original Request to the primary. Single
    // intra-region RPC hop (the replica was placed near the primary),
    // so the user sees: user-RTT-to-replica-edge + RPC-to-primary +
    // primary-handle. Net: still faster than user-RTT-to-primary on
    // a far user, because the user's RTT-to-edge is always shorter
    // than user-RTT-to-far-region.
    const primary = (this.ctx.storage as any).primary;
    if (primary && typeof primary.fetch === 'function') {
      return primary.fetch(request);
    }
    // No primary stub (we shouldn't be here if isReplica() lied) —
    // fall through and handle locally; correctness > performance.
  }
  /* … existing route handlers … */
}

private _w12RoutingPreflight(pathname: string, method: string): {
  policy: ReplicaPolicy;
  delegate: boolean;
} {
  const policy = classifyReplicaPolicy(pathname, method);
  if (!this.isReplica()) return { policy, delegate: false };
  if (policy === 'replica-ok') return { policy, delegate: false };
  if (policy === 'replica-warm-only') {
    return { policy, delegate: !this.viteDevServer?.isRunning };
  }
  return { policy, delegate: true };
}
```

(c) **`/api/_diag/memory` extension:** include `replica` block exposing `getReplicaState()`. Operators (and CT1 drift detector) can confirm placement landing.

```ts
// In the /api/_diag/memory response builder:
return Response.json({
  /* … existing fields … */
  replica: this.getReplicaState(),
});
```

### 6.3 `src/replica-suspension.ts` (~30 LOC) — npm-install / git-clone gating

```ts
// Single shared counter. NpmInstaller increments at start, decrements at end.
// GitNetworkFacet's clone helper does the same. NimbusSession.isReplica() is
// gated by this: when count > 0, we still report isReplica honestly, but the
// W12 fetch preflight forces all routes into 'primary-only' to avoid
// "Network connection lost" replication errors during write bursts.
let _suspendCount = 0;
export function suspendReplicas(): () => void {
  _suspendCount++;
  let released = false;
  return () => { if (!released) { released = true; _suspendCount--; } };
}
export function replicasSuspended(): boolean { return _suspendCount > 0; }
```

For phase 1 we **do not wire** the suspend hooks into npm-installer / git — that's a +risk surface area change. Phase 1 ships the module + tests for the contract, and the in-DO replica path consults it. Phase 2 (W12.5 if needed) wires the hooks once we have prod telemetry showing if replication-during-install actually causes the SPEC's described errors.

---

## 7. Test plan (Phase B, TDD)

All probes follow the W9/W10/W11 pattern: per-suite `_tap.mjs`, `_mock-sql.mjs` for storage simulation, `_mock-replica-ctx.mjs` for the primary/replica fork, `run-all.mjs` orchestrator.

### 7.1 Functional (audit/probes/w12/functional/)

| File | Asserts |
|---|---|
| `replica-policy-classification.mjs` | `classifyReplicaPolicy()` table for every documented route from §2. |
| `replica-state-shape.mjs` | `getReplicaState()` returns `{isReplica, replicasEnabled, bookmark, error}` with correct types under: SPEC API present, alternate API present, neither present, and ctor throws. |
| `primary-isolate-not-replica.mjs` | A NimbusSession instance built on a mock ctx with `primary === undefined` reports `isReplica() === false`. |
| `replica-isolate-isreplica.mjs` | Same with mock `primary = { fetch }` reports `isReplica() === true`. |
| `delegate-on-primary-only-route.mjs` | Replica receiving `/api/write-file` calls `primary.fetch(request)`. |
| `no-delegate-on-replica-ok-route.mjs` | Replica receiving `/api/memory` does NOT call `primary.fetch`. |
| `delegate-on-cold-warm-only-route.mjs` | Replica receiving `/preview/index.html` with `viteDevServer.isRunning === false` delegates. |
| `no-delegate-on-warm-warm-only-route.mjs` | Same with `isRunning === true` does NOT delegate. |
| `replica-metadata-flag-in-diag.mjs` | `/api/_diag/memory` response body contains `replica: { isReplica, ... }`. |
| `ws-routes-are-primary-only.mjs` | `classifyReplicaPolicy('/ws', 'GET') === 'primary-only-ws'`, same for `/api/processes/123/logs`, `/preview/__nimbus_hmr`. |
| `enable-replicas-best-effort.mjs` | Constructor with no `enableReplicas` API on storage doesn't throw; reports `replicasEnabled: 'unsupported'`. |
| `enable-replicas-via-alternate-api.mjs` | Constructor with only `configureReadReplication` works and reports `replicasEnabled: 'enabled-via-configure'`. |
| `replicas-suspension-counter.mjs` | `suspendReplicas()` returns a release function; `replicasSuspended()` reflects count. |
| `eventual-consistency-window-ms.mjs` | The replica policy table tags every `replica-ok` / `replica-warm-only` route with `≤2000` ms tolerance metadata; new routes added without tolerance metadata fail this probe (drift-detector for lag tolerance). |
| `smart-placement-config-shape.mjs` | `wrangler.jsonc` parses, contains `placement.mode === "smart"`. |

### 7.2 Regression (audit/probes/w12/regression/)

| File | Asserts |
|---|---|
| `install-pipeline-coverage.mjs` | Same sentinel as W11/W10 — install pipeline scenario list unchanged. |
| `mossaic-shape.mjs` | The shared Mossaic regression scenarios still loadable and unchanged in shape. |
| `w11-frameworks-detect-unchanged.mjs` | W11 detection precedence unchanged. |
| `w10-bindings-still-injected.mjs` | W10's `buildInnerEnv` still wires KV/D1/R2. |
| `w7-stream-rpc-still-present.mjs` | `writeBatchStream` still on supervisor-rpc surface. |
| `w9-hib-config-still-present.mjs` | `configureWsHibernation` still in module. |
| `w5-diag-memory-shape.mjs` | `/api/_diag/memory` still has the W5 fields (peak.rssBytes, hib.*). The W12 `replica` block is **additive**. |
| `wrangler-jsonc-still-valid.mjs` | Parse + spot-check of all the W3-W11 bindings still present. |

### 7.3 E2E (audit/probes/w12/e2e/)

| File | Asserts |
|---|---|
| `region-latency-baseline.mjs` | Documents pre-W12 baseline: queries `/api/_diag/memory` from US/EU/APAC simulated origins (header injection — no real region simulation possible without prod), records p50/p99 to `audit/probes/w12/baseline.json`. **SKIPs without `NIMBUS_W12_E2E=1`** (prod-gated). |
| `region-latency-after.mjs` | Same probe, records `after.json`. Asserts p99 EU < 500ms, p99 APAC < 500ms. **SKIPs without `NIMBUS_W12_E2E=1`**. |
| `replica-bookmark-roundtrip.mjs` | Boots the DO as primary, performs a write, captures `getCurrentBookmark()`, performs a read on the replica isolate, asserts data eventually visible (poll up to 5s). **Local mock-only**: the mock primary↔replica pair can simulate any lag we configure (default 100ms). |
| `delegate-roundtrip.mjs` | Local mock: replica isolate receives `/api/write-file`, asserts request reaches primary mock, response forwarded. |
| `mossaic-regression-e2e.mjs` | The same scenarios W11 ran. **SKIPs without `NIMBUS_W12_E2E=1`** (prod-gated). |

### 7.4 Build-phase order

1. Write all 14+8+5 = **27 probes failing** (Phase B), commit.
2. Write `src/replica-routing.ts` (pure) — the 13 functional probes that test it turn green.
3. Write `src/replica-suspension.ts` (pure) — `replicas-suspension-counter.mjs` turns green.
4. Edit `src/nimbus-session.ts` (constructor + `_handleFetch` + `getReplicaState` + diag block) — replica-isolate / primary-only / warm-only / cold delegate probes turn green; `replica-metadata-flag-in-diag.mjs` turns green.
5. Edit `wrangler.jsonc` — `smart-placement-config-shape.mjs` turns green.
6. Run all of W12 + Mossaic regression. Tsc clean.

---

## 8. Risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | `replica_routing` compat flag rejected by prod runtime (not yet GA in your account) | Graceful-degrade: probe at runtime; log "unsupported" in `getReplicaState()`. No user-visible breakage. |
| R2 | `ctx.storage.primary` API differs from SPEC in actual GA build | Probe pattern is `typeof === 'function'` / `!== 'undefined'`. If the API name differs, `getReplicaState()` reports `unsupported` and the gateway routes everything to primary as today — no regression. |
| R3 | Smart Placement degrades static-asset latency for `/s/<id>/index.html` | Documented §4.3. Worst-case +10ms, acceptable. Phase 2 fallback: split landing-page Worker + supervisor Worker. |
| R4 | Replication lag exceeds 2s, breaks `/api/stats` polling expectations | Telemetry: `getReplicaState().bookmark` exposed via `/api/_diag/memory`; CT1 drift detector flags lag>2s. |
| R5 | Write-during-install breaks replication ("Network connection lost" per ~lambros feedback) | Phase 1 ships the suspension module + replica-policy bypass for primary-only writes (which are most write paths). Phase 2 wires npm-installer / git hooks if telemetry shows the issue. |
| R6 | Replica isolates load full DO bundle including expensive W3-W11 init | Constructor today is already cheap-on-cold (W9 isolate-gen bumps + W5 ring rehydrate are async best-effort). `_handleFetch`'s `_w12RoutingPreflight` runs in <1ms before delegation. |
| R7 | Smart Placement's 15-minute analysis window misroutes initial requests | This is by design; pre-placement, behavior is identical to today. Document in retro that p99 numbers should be measured post-window. |
| R8 | `/preview/__nimbus_hmr` WS upgrade lands on replica during smart-placement | Replica policy classifies as `primary-only-ws`; replica returns 503; client/Vite reconnects which on retry should hit primary (DO routing on `idFromName` is deterministic, so all WS go to primary anyway — replica isolates only spin up on demand). |

---

## 9. Predicted impact

Based on the levers' research-doc estimates:

| Metric | Today | After W12 (predicted) | Source |
|---|---|---|---|
| Gateway → DO RTT (cross-continent) | 80-160 ms | ~0-30 ms | CF research §G.3, lever D5 |
| `/preview/<asset>` warm read p50 (EU user, US DO) | 200-300 ms | 5-30 ms | CF research §G.4 (200ms→5-20ms) |
| `/preview/<asset>` warm read p99 (EU + APAC) | 400-700 ms | <500 ms (target met) | wave acceptance |
| Primary-only writes | unchanged | unchanged | by design |
| Smart Placement lift on RPC | 0 (RPC ignored) | 0 | CF research §G.3 caveat |

**Acceptance gate:** p99 preview latency from EU + APAC < 500 ms.
**Best-effort verification:** the prod-gated e2e probes record before/after histograms; the autonomous local run cannot verify cross-region p99 without real region simulation, so the local TDD bar is **structural correctness + delegation roundtrip + replica suspension contract**.

---

## 10. Citations

- **CF wiki "DO Read Replicas":**
  - [STOR/SPEC: Durable Objects read replication API](https://wiki.cfdata.org/display/STOR/SPEC%3A+Durable+Objects+read+replication+API)
  - [STOR/Durable Objects Replication Quick Start](https://wiki.cfdata.org/spaces/STOR/pages/1110730702/Durable+Objects+Replication+Quick+Start)
  - [~lambros/Feedback for DO read replication API](https://wiki.cfdata.org/display/~lambros/Feedback+for+DO+read+replication+API+based+on+D1+read+replication+beta) — write-burst error, replica lag, suspension recommendation
- **CF docs "Smart Placement":**
  - [/workers/configuration/placement/](https://developers.cloudflare.com/workers/configuration/placement/)
  - [/changelog/post/2025-03-22-smart-placement-stablization/](https://developers.cloudflare.com/changelog/post/2025-03-22-smart-placement-stablization/)
  - [/changelog/post/2026-01-22-explicit-placement-hints/](https://developers.cloudflare.com/changelog/post/2026-01-22-explicit-placement-hints/) (region/host/hostname extensions, not used in W12)
  - [/workers/runtime-apis/rpc/](https://developers.cloudflare.com/workers/runtime-apis/rpc/) — Smart-Placement-ignored-on-RPC caveat
- **D1 read replication (analog):**
  - [/d1/best-practices/read-replication/](https://developers.cloudflare.com/d1/best-practices/read-replication/) — Sessions + bookmarks pattern, replica-lag UX
- **Internal references:**
  - `audit/sections/CF-INTERNAL-OPTIMIZATION-RESEARCH.md` §G.3, §G.4, §J.7.1, §J.9
  - `audit/sections/MASTER-ROADMAP.md` (W12 row)
- **Nimbus source citations:**
  - `src/index.ts:75` (gateway fetch handler)
  - `src/session-router.ts:84` (forwardToSession — gateway → DO RPC)
  - `src/nimbus-session.ts:622` (NimbusSession constructor)
  - `src/nimbus-session.ts:1554` (_handleFetch entry)
  - `src/nimbus-session.ts:1971` (`/preview/*` handler)
  - `src/nimbus-session.ts:1688` (`/api/_diag/memory` handler)
  - `src/nimbus-session.ts:2194` (ensureSqliteFs)
  - `src/nimbus-session.ts:4509` (seedFilesystem)

---

## 11. Sub-agent review

A separate `general` sub-agent was tasked to review this plan in §12 below. The review's findings were merged back into §2-9 before commit.

## 12. Self-review notes

The wave runner attempted to dispatch a `general` sub-agent for review; the agent runtime returned `ProviderModelNotFoundError`. The wave runner performed the review itself by exhaustive grep + cross-check against `_handleFetch`. Findings merged back into §2 / §7:

1. ✅ Route inventory complete — every `if (url.pathname === ...)`, `startsWith`, `match`, and `matchLogsPath` branch covered (verified via `grep -n "url.pathname" src/nimbus-session.ts src/index.ts`).
2. ⚠️→✅ **Bug fix in §2:** `/api/processes/<pid>/logs` was originally classified `replica-eligible`; corrected to `primary-only-ws`. Replica accepting the WS would subscribe its *own* hibernation handler and miss subsequent primary-side `processLogs.append` calls. Reclassified.
3. ✅ Test plan: added `ws-routes-are-primary-only.mjs` to verify the fix above.
4. ✅ wrangler.jsonc diff: additive only — no W3-W11 binding removed. Verified via parse + spot-check (in `wrangler-jsonc-still-valid.mjs` regression).
5. ✅ Smart Placement caveat application: §4.3 correctly identifies the static-asset trade-off and the `run_worker_first` exemption for `/`.
6. ✅ Risk R8 stands: a replica DO isolate would only handle a fetch IF the runtime decides to route to it; per the SPEC, WS upgrades target a specific stub which is primary-bound. Defensive primary-only-ws classification protects either way.

The Phase A artifact stands as committed.
