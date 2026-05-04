# W7 progress log

Wave: W7 — Streams over RPC (bypass 32 MiB structured-clone wall).
Branch: `w7-rpc-streams` off `main` @ 7a835ed.
Mode: autonomous, sub-agents unavailable per CT3.

## Phase A — 2026-05-04T22:50:00Z
- Status: ✓
- Commit: 8b4488a
- Notes: W7-plan.md written and committed; frame format, RPC contract,
  per-call breakage assessment, risks, code-diff sketches, test plan
  and heap-peak harness all enumerated. Self-review pass complete.

## Phase B — 2026-05-04T23:05:00Z
- Status: ✓ (TDD red verified)
- Commit: 007c888
- Notes: 15 probes committed under audit/probes/w7/.
  * 8 functional (01-frame-roundtrip ... 08-writestream-on-vfs)
  * 4 regression (install-pipeline-coverage, legacy-writeBatch-still-works,
    mossaic-shape, rpc-contracts-additive)
  * 3 e2e (synthetic-50mb-tarball, heap-peak-during-install,
    install-batch-facet-streams)
  Initial run: 12 fail (red as required) + 3 pass (regression probes that
  validate legacy code paths still being intact — they pass pre-build,
  must continue to pass post-build). Pushed to origin.

## Phase C — 2026-05-04T23:25:00Z
- Status: ✓
- Commits: 7f1294b (C1 frame), 2d87055 (C2 vfs), 5578f63 (C3 RPC), e96043a (C4 facet)
- Notes:
  C1: src/_shared/w7-frame.ts encoder + decoder. type:'bytes' source,
      pull-based backpressure, lazy chunk iterator. Probes 1-7 GREEN.
  C2: SqliteVFS.writeStream (spool-then-commit v1; multi-segment
      deferred). Probe 8 GREEN. writeBatch path untouched.
  C3: SupervisorRPC.writeBatchStream + NimbusSession._rpcWriteBatchStream.
      Additive only — legacy writeBatch unchanged. RPC-contracts
      regression GREEN.
  C4: scripts/bundle-facet-workers.mjs extended to bundle w7-frame
      into a second preamble; npm-installer.ts concatenates both
      preambles in the batch-facet pool; npm-install-batch-facet.ts
      env type declares writeBatchStream optional + flush() typeof-
      gates the streaming call with legacy fallback.

  Final w7 suite: 15/15 GREEN.

## Phase D — 2026-05-04T23:35:00Z
- Status: ✓
- Commit: 23a166d
- Notes: tsc --noEmit clean for W7 changes (2 pre-existing main
  errors remain, both verified unrelated). Cross-wave regression:
  w5 7/7, w6 17/17, w8 21/21, w9 6/6, w4 6/6 all GREEN. Wave 1
  contract PASS, external=0. Mossaic prod regression: same shape as
  main (W7 not yet deployed).

## Phase E — 2026-05-04T23:40:00Z
- Status: ✓
- Notes: All 8 commits pushed to origin/w7-rpc-streams cleanly.
  Push grant alive throughout the session.

## Phase F — 2026-05-04T23:50:00Z
- Status: ✓
- Notes: W7-retro.md written. Master roadmap §Phase 3 status
  flipped to branch-complete. Heap-peak target (30 MiB) was
  exceeded by 16× — observed peak 0.23 MiB. Multi-segment
  supervisor-side commit deferred to a follow-up wave; W7 v1
  is spool-then-commit on the supervisor.

# W7 — DONE
