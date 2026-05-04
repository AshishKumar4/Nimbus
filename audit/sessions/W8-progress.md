# W8 progress log

## Phase A — Plan — 2026-05-04T11:30:00Z
- Status: ✓ (sub-agent reviewed; revisions in §8.5 of plan)
- Commits: afb2d0c (initial), a4aa32d (post-review revisions)
- Notes: Plan committed at audit/sections/W8-plan.md. Architecture: supervisor-as-broker
  facet-as-process design reusing ProcessTable + FacetManager + ProcessLogStore.
  Sub-agent review surfaced 3 BLOCKERs (read-loop draining, builtin recursion deadlock,
  kill ordering) and 6 MAJORs (spawnSync, git resolution, real-workerd probes, stream
  shape, fork IPC, postinstall basket honesty). All addressed in plan §8.5. IPC
  contract reduced from 9 to 7 RPC methods (cpRunBuiltinCommand and cpResolveCommand
  removed; cpDrainOutput added).

## Phase B — TDD red — 2026-05-04T11:55:00Z
- Status: ✓ (correctly red)
- Commit: 2785e34
- Notes: 21 probes scaffolded across functional/regression/e2e. 20/21 fail
  because src/facet-process.js doesn't exist yet (TDD red expected). The 1
  passing probe is `regression/install-pipeline-coverage.mjs` which is a
  static-file check that doesn't depend on our impl.

## Phase C — Build — 2026-05-04T13:00:00Z
- Status: ✓
- Commits: 2547a04 (FacetProcessManager), 0691a02 (parent-side shim +
  streams.push fix), dda0d2e (SupervisorRPC + nimbus-session wiring)
- Notes: All 21 W8 probes green. tsc baseline unchanged (2 pre-existing
  errors). W5 regression suite: 7/7 still green.

  Notable surprises during Build:
    1. `streams.ts Readable.push()` had a latent bug — `push(null)` after
       `push(chunk)` deferred 'end' but never re-emitted it from the
       flowing-drain microtask. Exposed by exec/spawnSync waiting on
       'close'. Fixed in streams.ts (1-line patch). All other consumers
       of __streamMod (http, fs.createReadStream, etc.) benefit.
    2. Nimbus's __streamMod.Readable doesn't auto-resume on
       addListener('data') the way real Node does. Patched at the cp
       shim layer (per-instance on/addListener wrap) so the rest of the
       codebase isn't affected. Documented in node-shims.ts.
    3. stdio: 'inherit' / 'ignore' — child.stdout/stderr is null in
       these modes (Node-doc semantics). _stdoutEnded/_stderrEnded
       auto-flagged so 'close' fires after 'exit' without waiting on
       end events that never come. Required for cross-spawn 'inherit'
       which is the most common spawn pattern in CI scripts.

## Phase D — Audit — 2026-05-04T13:30:00Z
- Status: ✓
- Commits: 4aca069 (7 MAJOR fixes from sub-agent review)
- Notes: Sub-agent code review identified 8 MAJORs. 7 fixed (registry
  consultation, __cpChildren leak, kill-after-exit, spawnSync eager
  population, fork IPC envelope, streams.ts duplicate-end guard,
  cpReadOutput backoff). 1 accepted as Phase 1 simplification with
  retro callout (facet-direct runs inline in supervisor isolate
  rather than minting a fresh facet — see W8-retro §6 / Phase 1.5).
  All 21 W8 probes still green. W5 regression: 7/7 green. tsc:
  baseline unchanged.

## Phase E — Push — 2026-05-04T14:00:00Z
- Status: ✓
- Commits: pushed afb2d0c..7a48d9a (8 commits) to origin/w8-child-process.
- Notes: GitHub PR URL emitted by remote: pull/new/w8-child-process.
  Ready for workspace-agent review + merge per master roadmap §PR strategy.

## Phase F — Retro — 2026-05-04T14:15:00Z
- Status: ✓
- Commit: 23f485b
- Notes: audit/sections/W8-retro.md ships with: outcome-vs-predicted,
  APIs that work, APIs that fall short, postinstall success rate
  (100% should-pass), surprises, and 5 W8.5 recommendations + Phase 2
  gated on SHIP-10537. Wave done.
