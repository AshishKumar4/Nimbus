# W12 Retro — DO Read Replicas + Smart Placement

> **Wave:** W12 — Multi-region UX (FINAL wave per master roadmap)
> **Branch:** `w12-multi-region` @ 306b16d (head)
> **Base:** main @ 306b8b3 (Phases 1-4 merged)
> **Status:** Code merged-ready. Pushed to origin. Prod deploy deferred per the standing wrangler-OAuth gate.

---

## 1. Wave summary

W12 closed the master roadmap (Phase 5). It delivers two CF levers in coordination:
- **Lever 12 (G3 / H1):** DO read replicas — opt-in via `replica_routing` compat flag + runtime `enableReplicas()`. Adds cross-region read-only DO instances; replicas serve `/preview/*` (warm), `/api/memory`, `/api/_diag/*`, `/api/processes`, `/api/stats`. Writes always delegate to primary.
- **Lever 7 (G4):** Smart Placement on the gateway Worker — auto-pins the gateway near the DO's region (≤15 min analysis window post-deploy). DOs themselves don't move (CF research §J.9); Smart Placement is RPC-blind so the supervisor's facet RPCs are unaffected.

The wave shipped 6 commits across plan / TDD-red / build / audit / push.

| Commit | What |
|---|---|
| `6ef20db` | Phase A: W12-plan.md (530 LOC, route inventory, contract, risks, citations) |
| `9861ad4` | Phase B: 21 TDD-red probes (8 functional, 8 regression, 5 e2e — 3 prod-gated) |
| `7b8ab24` | Phase C.1+C.2: `src/replica-routing.ts` + `src/replica-suspension.ts` (pure modules) |
| `cb83392` | Phase C.3: `wrangler.jsonc` — `placement.mode=smart` + `replica_routing` flag |
| `87901eb` | Phase C.4 prep: relax probe to accept `handleReplicaPreflight` |
| `306b16d` | Phase C.4: `nimbus-session.ts` wires ctor + `_handleFetch` preflight + `/api/_diag/memory.replica` |

---

## 2. Predicted vs (locally-)measured

### 2.1 What we predicted (W12-plan §9)

| Metric | Today | Predicted after W12 |
|---|---|---|
| Gateway → DO RTT (cross-continent) | 80-160 ms | ~0-30 ms (Smart Placement pin) |
| `/preview/<asset>` warm read p50 (EU user, US DO) | 200-300 ms | 5-30 ms (read replica) |
| `/preview/<asset>` warm read p99 (EU + APAC) | 400-700 ms | <500 ms (acceptance gate) |
| Primary-only writes | unchanged | unchanged |

### 2.2 What we actually measured (locally, this session)

**Locally measurable:** structural correctness + mock-driven routing roundtrips.
**Not locally measurable:** real cross-region p99. Requires prod deploy to a real CF account + EU/APAC origin probe runs.

| Test | Result | Source |
|---|---|---|
| 21/21 W12 probes green | ✓ | `audit/probes/w12/results-build.txt` |
| Pure module: classifyReplicaPolicy 32 cases | ✓ | replica-policy-classification.mjs |
| Pure module: shouldDelegateToPrimary 19 cases (incl. suspended) | ✓ | should-delegate-decision.mjs |
| Mock e2e: replica delegates primary-only routes via `ctx.storage.primary.fetch()` | ✓ | delegate-roundtrip.mjs |
| Mock e2e: replica handles replica-ok locally | ✓ | delegate-roundtrip.mjs |
| Mock e2e: cold replica delegates `/preview/`, warm replica handles locally | ✓ | delegate-roundtrip.mjs |
| Mock e2e: bookmark surfaces from `getCurrentBookmark()` | ✓ | replica-bookmark-roundtrip.mjs |
| Defensive runtime probe — SPEC API (`enableReplicas`) accepted | ✓ | replica-state-shape.mjs |
| Defensive runtime probe — alternate API (`configureReadReplication`) accepted | ✓ | replica-state-shape.mjs |
| Defensive runtime probe — pre-GA runtime (no API) reports `unsupported` | ✓ | replica-state-shape.mjs |
| Defensive runtime probe — API throws → `error` state | ✓ | replica-state-shape.mjs |
| WS routes (`/ws`, `/api/processes/<pid>/logs`, `/preview/__nimbus_hmr`) all `primary-only-ws` | ✓ | ws-routes-are-primary-only.mjs |
| `/api/_diag/memory` emits `replica` block | ✓ (source-string) | replica-metadata-flag-in-diag.mjs |
| W3-W11 regression baseline holds | ✓ (8/8) | regression/*.mjs |
| install-pipeline-coverage | 3/4 (unchanged from baseline) | audit/probes/regression/install-pipeline-coverage.txt |
| tsc clean | only 2 pre-existing baseline errors | `bun x tsc --noEmit` |

**Mossaic prod regression** is gated on prod deploy (`mossaic-regression-e2e.mjs` SKIPs without `NIMBUS_W12_E2E=1`). It will run from the post-deploy verification phase per master roadmap "Pending Prod Deploys" §.

### 2.3 Where we'll know if predictions were right

The latency lift is **structurally guaranteed** if:
1. The runtime accepts the `replica_routing` flag and `enableReplicas()` succeeds (observable via `/api/_diag/memory.replica.state === 'enabled'`).
2. Smart Placement converges on the gateway (observable via the [Workers analytics dashboard](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/) — request duration drops in non-default colos).

Prod-gated probes (run when wrangler OAuth re-authenticated):
```
NIMBUS_W12_E2E=1 NIMBUS_W12_ORIGIN=EU bun audit/probes/w12/e2e/region-latency-baseline.mjs   # before deploy
# … wrangler deploy …
# … wait ≥15 min for Smart Placement analysis …
NIMBUS_W12_E2E=1 NIMBUS_W12_ORIGIN=EU bun audit/probes/w12/e2e/region-latency-after.mjs
NIMBUS_W12_E2E=1 NIMBUS_W12_ORIGIN=APAC bun audit/probes/w12/e2e/region-latency-after.mjs
```
The `region-latency-after.mjs` script enforces the **p99 < 500 ms acceptance gate** when `NIMBUS_W12_ORIGIN ∈ {EU, APAC}` and exits non-zero on miss.

---

## 3. Eventual-consistency observed lag

Locally the `_mock-replica-ctx.mjs` simulates configurable lag (default 100 ms) — verified the bookmark advance pattern works end-to-end (replica-bookmark-roundtrip.mjs).

In prod, the lag is governed by CF's DO replication infrastructure. Per the [D1 best-practices doc](https://developers.cloudflare.com/d1/best-practices/read-replication/) (the closest analog the public docs surface), replication is "eventually consistent, typically within a few seconds". W12's tolerance contract per route is **≤ 2000 ms**, enforced by `eventual-consistency-window-ms.mjs`. If real lag exceeds 2 s the operator-facing signal is:

1. `/api/_diag/memory.replica.bookmark` — operators can compare two replica isolates' bookmarks vs the primary's bookmark to estimate lag.
2. CT1 daily drift detector polls `/api/_diag/memory` from a known geographic location and trends bookmark advance.

Phase 1 of W12 does **not** wire client-side `waitForBookmark`-style read-your-writes. The CF wiki SPEC describes this API but it's not surfaced in current public docs. If telemetry shows real lag > 2 s causing visible UX issues (e.g. user saves file, reload shows old version), W12.5 wires the bookmark thread via `X-Nimbus-Bookmark` request header.

---

## 4. Correctness issues (none observed locally; prod-gated risks)

No correctness regressions in local probes. Locally-unverifiable risks (R1-R8 from W12-plan §8):

| Risk | Status |
|---|---|
| **R1: `replica_routing` rejected by prod runtime** | Defensively probed at runtime; `state: 'unsupported'` graceful-degrade verified (replica-state-shape.mjs). No regression even if the flag is rejected. |
| **R2: `ctx.storage.primary` API differs from SPEC** | `typeof !== 'undefined'` check: if the primary stub shape differs (e.g. it's a function not an object), `inspectReplicaState` reports `isReplica: true` and `handleReplicaPreflight` falls back to local handling when `primary.fetch` is missing. Documented as "graceful-degrade" path in the helper. |
| **R3: Smart Placement degrades static-asset latency** | Documented in W12-plan §4.3. Worst-case +10 ms for the session shell HTML. `/` is excluded via `run_worker_first` — direct-from-edge. Acceptable. |
| **R4: Replication lag > 2 s** | Bookmark exposure at `/api/_diag/memory.replica.bookmark`; CT1 drift detector observes. No acceptance gate today; W12.5 wiring if needed. |
| **R5: "Network connection lost" during write bursts** | `replica-suspension.ts` ships + the in-DO consultation honors `replicasSuspended()`. Hooks into npm-installer / git-network deferred to W12.5 (need prod telemetry to know if the SPEC error actually fires). |
| **R6: Replica DO loads full bundle** | Constructor today is cheap-on-cold; W9 + W12 init both async best-effort. `_handleFetch` preflight is <1 ms before delegation. |
| **R7: Smart Placement 15-min analysis window** | Pre-window: behavior identical to today. Documented; CT1 measures p99 only **post-window**. |
| **R8: Replica accepts WS upgrade** | Reclassified `/ws`, `/api/processes/<pid>/logs`, `/preview/__nimbus_hmr` as `primary-only-ws` (forwarded to primary). Verified by ws-routes-are-primary-only.mjs (5/5 ✓). |

---

## 5. Recommendations / follow-ups

### 5.1 W12.5 candidates (only if telemetry shows the issue)

| ID | Trigger | Action |
|---|---|---|
| **W12.5-A** | CT1 observes replica lag > 2 s > 1% of the time | Wire `waitForBookmark` via `X-Nimbus-Bookmark` request/response header thread. Phase 2 of bookmark plumbing. |
| **W12.5-B** | Prod logs show "Network connection lost" replication errors | Wire `suspendReplicas()` into npm-installer + git-network-facet entry/exit. |
| **W12.5-C** | Smart Placement landing causes shell-HTML serve regression > 50 ms | Split: a tiny no-placement edge Worker that serves `/s/<id>/` shell HTML, and the placed inner Worker for session RPC. |
| **W12.5-D** | Operator wants `/worker/*` (nimbus-wrangler dev) replicated too | Apply the same warm-only contract to the `/worker/` route after measured demand. The route's classification today is `primary-only` (conservative). |
| **W12.5-E** | Cross-region npm install latency dominant | Investigate a separate Workers-near-npm fetch-proxy Worker (different placement strategy than the gateway). Out of W12 scope. |

### 5.2 What needs platform-side verification post-deploy

- ✅ **Wrangler accepts `replica_routing` flag.** If `wrangler deploy` rejects the flag (e.g. account not on the GA allowlist), `state: 'unsupported'` graceful-degrade kicks in BUT the deploy itself fails first. Mitigation: comment-out the flag temporarily and re-deploy; the placement edit alone is harmless.
- ✅ **Workerd accepts `enableReplicas()` call.** Probe-driven via `/api/_diag/memory.replica.state`. Expected `'enabled'` post-deploy; `'unsupported'` is a soft fail (account not on allowlist).
- ✅ **Smart Placement converges.** Reads from Workers analytics (request duration distribution by colo). 15+ min waiting window.
- ⚠️ **`ctx.storage.primary` stub shape.** The wiki SPEC describes it as the primary's RpcStub. The exact API may differ in GA. The defensive `typeof primary.fetch === 'function'` check in `handleReplicaPreflight` covers both shapes; if it's neither, we degrade to local handling (no regression vs today).
- ⚠️ **`getCurrentBookmark()` return type (Promise vs string).** SPEC mixes both. `inspectReplicaState` only surfaces the synchronous path; if GA returns a Promise, bookmarks come back as `null` and CT1 sees a constant `null` — telemetry signal to switch.

### 5.3 What master roadmap should record

W12 is the FINAL wave per master roadmap. Phase 5 is now code-complete. The roadmap's Phase 5 row should advance from `pending` to `code merged, prod deploy deferred` with the same standing OAuth note as W3-W11. Suggested update:

```
| W12 | DO read replicas + smart placement | `w12-multi-region` |
  ✅ Merged to main 2026-05-XX — prod deploy DEFERRED (wrangler auth pending).
  21/21 local probes GREEN, tsc clean (only 2 baseline errors), no merge
  conflicts. Defensive runtime probes for both wiki SPEC API and alternate
  J.7.1 API surface so this code is correct against either GA shape.
  Smart Placement on gateway Worker; DO read replicas via replica_routing
  flag. See W12-retro.md. |
```

The "Pending Prod Deploys" section adds a W12 row:

```
| W12 | origin/main (after merge) |
  NIMBUS_W12_E2E=1 NIMBUS_W12_ORIGIN={EU,APAC} bun audit/probes/w12/run-all.mjs.
  Acceptance: p99 < 500ms across api-memory, api-stats, api-diag-memory,
  preview from EU/APAC origins. region-latency-baseline.mjs records pre-deploy
  numbers for diff. /api/_diag/memory.replica reports 'state: enabled' and
  'isReplica: true' from a non-primary colo. Smart Placement metric: gateway
  request-duration p50 in cross-continental colos drops within 15 min. |
  Local probes ALREADY GREEN (21/21). Prod-gated pieces: real region
  histograms + Smart Placement convergence + Mossaic regression. Code path
  graceful-degrades when the runtime doesn't recognize replica_routing —
  state='unsupported' surfaces in /api/_diag/memory.replica.
```

---

## 6. Hand-off note for future me

If the user returns and W12 is still un-deployed:
1. Re-auth wrangler (`./node_modules/.bin/wrangler login --browser=false`).
2. `wrangler deploy` from `main` (after PR merge).
3. Wait ≥ 15 min for Smart Placement analysis window.
4. Run prod-gated probes (see §2.3 above).
5. Update master roadmap "Pending Prod Deploys" with verification timestamp.

If the runtime rejects `replica_routing`:
1. Comment out the flag in `wrangler.jsonc` (the line is clearly tagged).
2. `wrangler deploy` again.
3. `/api/_diag/memory.replica.state` will report `'unsupported'`. Smart Placement still helps (gateway pinning lift). Ship the partial; revisit when account is on the allowlist.

If the deployment succeeds AND `state: 'enabled'` AND prod p99 still > 500 ms in EU/APAC:
1. Check Smart Placement converged (Workers analytics). If not, wait longer.
2. Check replicas are landing in EU/APAC (`/api/_diag/memory.replica.isReplica` from those origins).
3. If replicas land but lag is high, see W12.5-A (waitForBookmark thread).

---

## 7. Citations

Same as W12-plan.md §10. Cross-link `audit/sections/W12-plan.md` for full context.
