# W4 — npm install UX (R2 cache + pipelining) — Progress Log

> Wave: W4
> Branch: `w4-npm-cache`
> Worktree: `/workspace/worktrees/w4-npm-cache`
> Started: 2026-05-04
> Mode: AUTONOMOUS (user away ~1 year)

Append after each phase.

---

## Phase A — 2026-05-04T19:40:00Z
- Status: ✓
- Commit: 61b222f
- Plan: audit/sections/W4-plan.md (596 lines)
- Sub-agent dispatch failed (ProviderModelNotFoundError); inline self-review
  applied at $1000-bet rigor, 12 findings logged, 7 revisions applied to plan
  before commit.
- Key revisions vs initial draft:
  1. Race semantics fixed (R2 + network start concurrently; cap is wait-for-R2-before-committing-to-network, not delay-network).
  2. R2-write-back lifecycle: capture compressed bytes via existing integrity tee, await put before installOne returns.
  3. Drop `preview_bucket_name` (single bucket; null-check + graceful-degrade).
  4. Bumped R2 race caps (250 ms packument, 300 ms tarball).
  5. Narrow scope: skip in-supervisor resolver mod (legacy path); resolver-facet only.
  6. Backwards-compat soft-fail via `typeof env.SUPERVISOR.getCachedTarball === 'function'`.
  7. Counter increments must live in SupervisorRPC methods (supervisor isolate), not facet.
- Push: deferred to Phase E batch.

---

## Phase B — 2026-05-04T19:50:00Z
- Status: ✓ (TDD red — all functional probes failing as expected)
- Commit: 80f85d4
- Probes added: 6 functional + 3 regression + 1 e2e + run-all driver
- Verification:
  - `bun audit/probes/w4/run-all.mjs --phase=B-tdd-red` → 0/6 pass (intended).
  - All failures cite missing src/r2-cache.ts / SupervisorRPC.getCached* / facet wiring.
- Push to origin: FAILED (`Permission to AshishKumar4/Nimbus.git denied to cloudflare-seal[bot]`).
  Phase A push succeeded earlier in same session; mid-session token revocation
  suspected. Per anti-requirements ("best-effort"), continuing locally.
  Will retry at Phase E.
- Push status: origin lags by 1 commit (80f85d4 not on origin).

---

## Phase C — 2026-05-04T19:58:00Z
- Status: ✓
- Commits: 8067a0f (r2-cache.ts), b2420d4 (SupervisorRPC + diag), 29a0b32 (batch-facet pipelining), 16b3f36 (resolve-facet + wrangler)
- 6/6 functional probes green.
- Type-check: clean for W4 modules. Pre-existing main errors
  (esbuild-service.ts:153, nimbus-session.ts:1896) unchanged.
- Files modified:
  - src/r2-cache.ts (NEW, 295 LOC) — L3 cache, two buckets, graceful degrade.
  - src/diag-counters.ts (+78 LOC) — r2 block + setters + race-counter folder.
  - src/supervisor-rpc.ts (+115 LOC) — 6 new RPC methods (4 read/write + 2 admin).
  - src/npm-install-batch-facet.ts (~+150 LOC, ~-50 LOC) — pipelined race,
    R2 hit path, capturedTgzBytes write-back, awaited put.
  - src/npm-resolve-facet.ts (+50 LOC) — packument R2 race + write-back.
  - src/npm-installer.ts (+25 LOC) — counter folds + log surface.
  - wrangler.jsonc (+30 LOC config + commentary).
  - Lifecycle correctness (W4-plan §11 finding #2): verified — both
    putCachedTarball and putCachedPackument are AWAITED before the
    facet returns; no `void`-fired RPC.

---

## Phase D — 2026-05-04T19:59:30Z
- Status: ✓
- Commit: 73c7aab
- 6/6 functional probes green locally.
- Inline review verified: integrity-on-hit shape, capturedTgzBytes
  lifecycle, structured-clone cap, bundle isolation, race-counter folds,
  npm-scope key safety, graceful-degrade, soft-fail typeof checks.
- Prod-hitting probes (--full) gated to Phase E + deploy.
- audit/probes/w4/results-build.txt populated.

---

## Phase E — 2026-05-04T20:00:00Z
- Status: ✓ (push recovered; auth back)
- Commit: 73c7aab on origin/w4-npm-cache
- 9 commits now on origin (Phases A → D, all there).
- Mid-session token issue (Phases B-C) resolved by accumulating local
  commits and retrying at phase boundary; lesson logged in retro §6.

---

## Phase F — 2026-05-04T20:01:00Z
- Status: ✓
- audit/sections/W4-retro.md (350+ LOC).
- W4 done. Ready for prod deploy + e2e verify.

---

## Done summary
- All 6 phases ✓
- 9 commits on origin/w4-npm-cache
- ~700 LOC src/ delta + ~1100 LOC test/probe
- 6/6 functional probes green; prod e2e gated on deploy
- See W4-retro.md §1 for acceptance-criteria status (3/5 done locally;
  remaining 2 require prod deploy)
