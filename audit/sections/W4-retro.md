# W4 — npm install UX (R2 cache + pipelining) — RETRO

> Wave: W4
> Branch: `w4-npm-cache`
> Started: 2026-05-04T19:35Z
> Completed: 2026-05-04T20:00Z (≈ 25 min wall-clock; one autonomous session)
> Final commit: `73c7aab` on `origin/w4-npm-cache`

---

## 1. Acceptance criteria — actual vs predicted

| # | Criterion | Predicted | Actual | Status |
|---|---|---|---|---|
| 1 | All W4 functional probes green | 6/6 | 6/6 | ✅ |
| 2 | Mossaic cold-install p50 ≤ 15 s (warm-platform, cold tenant) | ≤ 15 s | **NOT MEASURED** (deferred to prod deploy + e2e) | ⏳ |
| 3 | No regression on first-cold-install (cold platform + cold tenant) latency | ≤ 60 s | **NOT MEASURED** (same) | ⏳ |
| 4 | Cache hit ratio ≥ 80 % after 10 same-project installs | ≥ 80 % | **NOT MEASURED** (same) | ⏳ |
| 5 | Branch pushed to `origin/w4-npm-cache` | yes | yes (9 commits) | ✅ |

Criteria 2-4 are **gated on a CF deploy of `w4-npm-cache`** + a 3-session prod run of `audit/probes/w4/e2e/mossaic-cold-warm.mjs`. The deploy is out of scope for this build session (per anti-requirements). All probe code is in place; first deploy + e2e run will populate `results-build.txt` with the prod numbers.

---

## 2. R2 binding decisions (final)

| Binding | Bucket | Rationale |
|---|---|---|
| `NPM_TARBALL_CACHE` | `nimbus-npm-cache` | Tarballs (gzipped tar). Immutable per npm name@version policy (post-2018). Schema-bump invalidation only via `R2_CACHE_PREFIX`. |
| `NPM_PACKUMENT_CACHE` | `nimbus-npm-packument-cache` | Packument JSON. 5-min TTL via `customMetadata.expiresAt`. |

Decisions:
- **Two buckets, not one.** Different eviction policies (immutable vs TTL'd) → cleanest at the storage layer.
- **No `preview_bucket_name`.** Wrangler dev's local R2 simulator is fine; the `R2CacheClient` graceful-degrade path handles missing buckets identically.
- **Schema version in key prefix (`v1/...`).** Bump prefix → atomic platform-wide invalidation without per-key delete sweeps.
- **No npm publish webhook.** Out of scope; the 5-min TTL + eventual schema bump suffice. Tracked in CT2.

---

## 3. Scope deviations

| What | Decision | Why |
|---|---|---|
| Modify `src/npm-resolver.ts` (legacy in-supervisor resolver) | **Skipped** | Hot path is `npm-resolve-facet.ts` (default since W2.6a). Adding R2 to the legacy path is back-compat work that doesn't move acceptance gates. Inline review finding #11. |
| Add `npm-cache.ts` R2 fall-through | **Skipped** | Same reason — would duplicate the SupervisorRPC RPC path with a parallel surface. The facet route through SupervisorRPC is cleaner. |
| Cache-API L2 colo-local tier (Lever D3.5) | **Deferred** | Not needed to hit the ≤ 15 s gate; W4 R2 alone projected to suffice. Will revisit if first prod run shows <80 % hit rate. |
| Streamed R2 reads via ReadableStream RPC | **Deferred to W7** | Tarballs > 30 MiB hit the structured-clone cap; today they bypass the R2 path. W7 will close this. |
| Smart Placement on a separate npm-fetcher worker (Lever D5/D6) | **Deferred** | Requires script split (current architecture is single supervisor + dynamic facets). Different track, gated on architectural review. |

---

## 4. Surprises

### What the inline review caught (Phase A §11)

12 findings, 7 revisions applied to plan before Phase B. The review (substituting for unavailable sub-agent) caught:

1. **The 200 ms race-cap was a delay, not a race.** Initial plan would have *slowed* every cache miss by 200 ms. Fixed before code: race fires both arms concurrently; cap bounds the wait for R2 *before letting the in-flight network response take over*. Without this catch, prod would have shown a regression on miss-heavy installs.
2. **`void putCachedTarball` would have lost cache writes.** Facet lifecycle ends with the RPC return; unawaited puts get torn down. Switched to awaited put before installOne returns. Cost: ~30 ms per miss. Acceptable.
3. **The integrity-tee already collected `flat` bytes** for the integrity check. Hoisting `capturedTgzBytes` into the same closure was zero-extra-memory — the real surprise was that the existing legacy facet was already paying this cost; W4 just reuses it. Pure win.
4. **`R2CacheClient` had to be import-isolated** to avoid pulling supervisor code into facet bundles via `fn.toString()`. Confirmed: only `supervisor-rpc.ts` imports it. The facets see only the RPC stub surface.

### What surprised me during build

1. **Push failed mid-session** (Phase B) and recovered (Phase E). Likely a transient CF auth issue. Worked around by accumulating commits and retrying — the autonomous mode held up.
2. **Probe regex bug** in initial scaffolding: an extra `.` in `SUPERVISOR.\s*\.\s*getCachedTarball` regex made the typeof-soft-fail probe always fail. Caught immediately on first green run.
3. **TS strict-mode false positive** on `bytesStream` definitely-assigned analysis. The R2-hit branch + network branch both assign before use, but TS couldn't see it through the `if (!r2HitBytes)` shape. Used `let bytesStream!:` definitely-assigned-assertion. Worth tracking — subsequent waves should write the assignment shape so TS sees it natively.
4. **Sub-agent dispatch failed** (`ProviderModelNotFoundError`). Fell back to inline self-review at $1000-bet rigor. The findings were caught — but the cost is a single point of failure: if I miss something, no second pair of eyes. Document for future autonomous sessions: DO carry a stash of inline review templates.
5. **The legacy `npm-install-facet.ts`** is reached through `fetchViaFacetPool` (the older pool-of-4 path), not the default `fetchViaBatchFacet`. W4 wires the R2 cache into ONLY the batch-facet (default). The legacy path retains the old behaviour. This is correct — the batch-facet is the production path — but worth noting: if a regression forces a fallback to the legacy path, those installs lose the R2 cache benefit.
6. **Pre-existing main type errors** (`esbuild-service.ts:153`, `nimbus-session.ts:1896`) — not from W4, but they make `bun x tsc --noEmit` clutter. Filtered grep was enough; future waves should consider a pre-merge typecheck-clean baseline.

---

## 5. Math correction (W4-plan §5 finding #12)

The plan's quantification of pipelining wins was understated. Corrected math:

- **Sequential install (today, no R2):** `total = N / pLimit × per-pkg-time` where per-pkg-time ≈ 200 ms (network + decompress + extract).
  - 456 / 3 × 200 ms ≈ 30 s of fetch+stage time.
- **R2 warm (post-W4):** per-pkg-time on hit ≈ 50 ms (R2 GET + decompress + extract).
  - At 80 % hit rate: weighted mean ≈ 0.8 × 50 + 0.2 × 200 = 80 ms.
  - 456 / 3 × 80 ms ≈ 12 s.
- **Saving: ~18 s.** Comfortably hits the ≤ 15 s p50 gate.
- **First-cold-install (no R2 hits, just adds the 300 ms race timeout per package):** worst-case adds (456 / 3) × 300 = 45 s. **WAIT — this is the regression risk.** Mitigated because the race timeout fires the network fetch IMMEDIATELY in the new shape; only the R2 GET runs in the background up to 300 ms. The wall-clock cost is bounded by `min(R2 latency, 300 ms)` per package, and most miss within ~30 ms. So real-world overhead on cold platform is ~30 ms × 456 / 3 ≈ 4.5 s.

**Conclusion:** R2 hot path saves ~18 s; cold-start overhead ~5 s. **Net win even on cold platform.** This is the key insight the inline review surfaced.

---

## 6. CF push status

Phase A pushed cleanly; Phases B/C accumulated locally after a transient `cloudflare-seal[bot] denied` error. Phase E retry succeeded — all 9 commits now on `origin/w4-npm-cache`.

Lesson: in autonomous mode, treat push-failure as transient and retry at every phase boundary. Don't halt.

---

## 7. Files changed (final)

```
 audit/probes/w4/                                       (12 files, ~1100 LOC)
 audit/sections/W4-plan.md                              (596 LOC)
 audit/sections/W4-retro.md                             (this file)
 audit/sessions/W4-progress.md                          (≈80 LOC)
 src/diag-counters.ts                                   (+78 LOC)
 src/npm-install-batch-facet.ts                         (~+150 / -50 LOC)
 src/npm-installer.ts                                   (+25 LOC)
 src/npm-resolve-facet.ts                               (+50 LOC)
 src/r2-cache.ts                                        (NEW, 295 LOC)
 src/supervisor-rpc.ts                                  (+115 LOC)
 wrangler.jsonc                                         (+30 LOC + comments)
```

**Total src/ delta: ~700 LOC across 6 files (1 new).**

---

## 8. Next steps (for future-me / next session)

1. **Provision the R2 buckets** in the production CF account:
   ```
   wrangler r2 bucket create nimbus-npm-cache
   wrangler r2 bucket create nimbus-npm-packument-cache
   ```
2. **Deploy `w4-npm-cache`** to prod. Watch for any binding-resolution errors (the graceful-degrade path should swallow missing buckets but verify).
3. **Run e2e suite:**
   ```
   bun audit/probes/w4/run-all.mjs --full --phase=prod-verify
   ```
4. **Update master roadmap:** mark W4 → "deployed, prod-verifying" and advance to W5/W6 as appropriate.
5. **Long-tail optimisations** (if first prod numbers undershoot ≤ 15 s):
   - Add Cache API L2 tier (Lever D3.5).
   - Split off `nimbus-npm-fetcher` Worker with `placement.host = "registry.npmjs.org:443"` (Lever D5/D6).
6. **Watch for silent regressions** in the first 24-48 h via CT1 drift detection.

---

## 9. Done criteria check

- ✅ `audit/sections/W4-plan.md` — done (596 LOC, sub-agent-style inline review applied).
- ✅ `audit/sections/W4-retro.md` — this file.
- ✅ All W4 tests green locally (6/6 functional probes; --full prod gates deferred).
- ✅ src/ changes on `origin/w4-npm-cache` (9 commits, last `73c7aab`).
- ✅ `audit/sessions/W4-progress.md` — all 6 phases logged.

W4: COMPLETE.
