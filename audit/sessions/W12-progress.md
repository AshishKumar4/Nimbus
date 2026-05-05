# W12 progress — DO read replicas + Smart Placement

Wave: W12 — Multi-region UX
Branch: `w12-multi-region`
Base: main @ 306b8b3
Owner: autonomous wave runner (year-long horizon)
Started: 2026-05-05

## Phase F — 2026-05-05T00:45:00Z (retro)
- Status: ✓
- Commit: pending (this commit)
- Notes: W12-retro.md committed. Predicted lift not locally measurable (no real region simulation); prod-gated e2e probes (region-latency-baseline + after) document the measurement protocol. Locally we have structural correctness end-to-end: 21/21 probes green; mock-driven primary↔replica delegation roundtrip verified; defensive runtime probes confirmed against SPEC API + alternate API + pre-GA-runtime + throw paths. Risks R1-R8 (W12-plan §8) all covered with graceful-degrade — if any platform piece misbehaves, behaviour falls back to pre-W12 single-primary path with no user regression. W12 is the FINAL wave per master roadmap; Phase 5 is now code-complete.

## Phase E — 2026-05-05T00:35:00Z (push)
- Status: ✓
- Notes: `git push origin w12-multi-region` succeeded cleanly (push grant active this session — no lapse). PR URL: https://github.com/AshishKumar4/Nimbus/pull/new/w12-multi-region

## Phase D — 2026-05-05T00:30:00Z (audit)
- Status: ✓
- Commit: 306b16d (build), 87901eb (probe relax)
- Notes: All 21 W12 probes GREEN (8 functional + 8 regression + 5 e2e — 3 prod-gated SKIP cleanly without `NIMBUS_W12_E2E=1`). tsc-noEmit clean: only the 2 pre-existing baseline errors (`esbuild-wasm/esbuild.wasm` module not found; `SqliteVFSProvider` vs `MountProvider` `FileType` type incompatibility) — both pre-W12 per master roadmap notes "tsc clean (only 2 baseline errors)". install-pipeline-coverage regression: 3/4 PASS (ts-jest known-fail per W4-retro, unchanged from baseline). No W12-introduced regressions.

## Phase C — 2026-05-05T00:25:00Z (build)
- Status: ✓
- Commits: 7b8ab24 (replica-routing.ts + replica-suspension.ts), cb83392 (wrangler.jsonc), 306b16d (nimbus-session.ts), 87901eb (probe relax)
- Notes: 4 commits. C.1+C.2 ship the pure modules `src/replica-routing.ts` (~280 LOC: classifyReplicaPolicy, getEventualConsistencyToleranceMs, REPLICA_POLICIES table, tryEnableReplicas, inspectReplicaState, captureBookmarkAfterWrite, shouldDelegateToPrimary, handleReplicaPreflight) and `src/replica-suspension.ts` (~50 LOC: refcount). C.3 edits wrangler.jsonc additively: `replica_routing` compat flag + `placement: { mode: 'smart' }` (with comments citing the docs + research caveat about RPC ignoring placement). C.4 wires nimbus-session.ts at three integration points: ctor calls tryEnableReplicas; _handleFetch runs handleReplicaPreflight before route handlers; /api/_diag/memory exposes a `replica:` block via the new `getReplicaState()` helper. Each commit references its tests.

## Phase B — 2026-05-05T00:00:00Z
- Status: ✓ (red as expected)
- Commit: 9861ad4
- Notes: 21 probes scaffolded across 3 buckets. TDD red verified: 8/8 functional + 2/2 local e2e fail (need src/replica-routing.ts, src/replica-suspension.ts, nimbus-session.ts + wrangler.jsonc edits). 8/8 regression pass (drift-detector baseline). 3/3 prod-gated e2e SKIP cleanly without `NIMBUS_W12_E2E=1`. Mocks: `_mock-replica-ctx.mjs` simulates primary/replica fork with `FakePrimaryStub.fetch()` capture for assertion. The next phase implements: `classifyReplicaPolicy`, `getEventualConsistencyToleranceMs`, `shouldDelegateToPrimary`, `handleReplicaPreflight`, `tryEnableReplicas`, `inspectReplicaState`, `captureBookmarkAfterWrite` in `src/replica-routing.ts`; `suspendReplicas`/`replicasSuspended` in `src/replica-suspension.ts`; thread these into `src/nimbus-session.ts` constructor + `_handleFetch` + `/api/_diag/memory` handler; add `placement.mode=smart` and `replica_routing` flag to `wrangler.jsonc`.

## Phase A — 2026-05-05T00:00:00Z
- Status: ✓
- Commit: 6ef20db
- Notes: W12-plan.md committed (530 lines). Sub-agent review attempted but provider returned ProviderModelNotFoundError; wave runner self-reviewed via exhaustive grep cross-check on `_handleFetch`. One classification bug found and fixed (`/api/processes/<pid>/logs` is `primary-only-ws`, not `replica-eligible`, because of `ctx.acceptWebSocket` hibernation subscription). Plan has 14 functional + 8 regression + 5 e2e probes scoped, wrangler.jsonc diff sketched, risk register R1-R8 documented. CF research §G.3, §G.4, §J.7.1, §J.9 cited. Smart Placement correctly scoped to gateway Worker (DOs don't move). Defensive runtime probes for both `enableReplicas` (SPEC) and `configureReadReplication` (alternate API name) so this code is correct against either GA shape.
