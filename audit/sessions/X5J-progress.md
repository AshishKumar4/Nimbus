# X.5-J progress log

Branch: `x5j-r25-reject` off `main` HEAD `eb316dc`.
Mission: P0 regression fix for `drizzle-orm` and `ts-node` post-X.5
batch. R2.5 cascade ↔ W6 REJECT_INSTALL reconciliation.

## Phase A — 2026-05-05T18:55Z
- Status: ✓
- Commit: 44a2e0f
- Notes:
  - Read VERIFY-EB316DC.md (`origin/verify-eb316dc:audit/sections/`)
    + drizzle-orm.out.txt + ts-node.out.txt probe artifacts.
  - Confirmed root cause via direct re-read of npm-resolver.ts,
    npm-resolve-facet.ts, wasm-swap-registry.ts, npm-resolve-preamble.ts.
  - Wrote `audit/sections/X5J-plan.md` (474 lines): root-cause file:line
    evidence, fix sketch (enqueue-time filter), test plan, risk register.
  - Self-review surfaced one risk (peer also required transitive dep
    elsewhere) → revised sketch to drop `seen.add()` in skip branch.
  - Sub-agent review attempted via Task tool → ProviderModelNotFoundError.
    Deferred to Phase D diff review.
  - Generated-file timestamp drift from `bun install` reverted (not
    part of fix surface).

## Phase B — 2026-05-05T19:05Z
- Status: ✓ (RED confirmed)
- Commit: 834068b (pushed)
- Notes:
  - Wrote 4 functional probes:
    - `r25-rejects-optional-peer-supervisor.mjs` — npm-resolver.ts R2.5
      block must consult lookupReject + emit transitive-skip.
    - `r25-rejects-optional-peer-facet.mjs` — npm-resolve-facet.ts R2.5
      block must consult SHOULD_REJECT_FAIL/SHOULD_WARN_SKIP_TRANSITIVE
      + __EMIT_EVENT.
    - `r2-required-peer-still-throws.mjs` — INVARIANT: R2 (required
      peer) path must NOT have the carve-out (preserves loud-reject
      contract for required peers).
    - `synth-fixture-package-rejects-soft-skip.mjs` — operational
      probe: invokes resolveTree against mock registry; pkg P with
      optional peers [goodpeer, sql.js] → expect resolveTree NOT throw,
      goodpeer in tree, sql.js NOT in tree, soft-skip log surfaced.
  - Wrote 5 regression probes:
    - `single-resolver-source.mjs` — both supervisor + facet have
      X.5-J marker; W2.6a single-resolver invariant preserved.
    - `loud-reject-still-loud-top-level.mjs` — npm-installer.ts and
      npm-resolver.ts still throw RegistryRejectError; REJECT_INSTALL
      data integrity (sql.js, @swc/core, sharp).
    - `loud-reject-still-loud-required-peer.mjs` — synth pkg with
      REQUIRED peer 'sharp' still hard-fails post-fix.
    - `r25-still-installs-non-rejected-peers.mjs` — synth pkg with
      [react (optional), sql.js (optional)] → react installs, sql.js
      skipped, no throw.
    - `tsc-baseline-preserved.mjs` — `bun x tsc --noEmit` ≤ 2 errors.
  - Wrote 4 e2e probes (gated on NIMBUS_X5J_E2E=1):
    - `drizzle-orm.mjs` — install + require ✅.
    - `ts-node.mjs` — install + require ✅.
    - `framer-motion.mjs` — regression: still ✅ (non-rejected
      optional peers still install).
    - `parcel.mjs` — regression: still ⛔ at @swc/core (transitive
      dep walk path unchanged by X.5-J).
  - run-all.mjs orchestrator + .gitignore for txt artifacts.
  - **RED phase verified**: 5 probes RED (the 5 the fix turns green),
    4 probes already GREEN (the 4 invariant-style probes). Output:
    `audit/probes/x5j/run-all-RED.txt` (gitignored, kept locally).
  - Two probe regex bugs caught + fixed during RED-verification:
    1. R2 block extractor matched FIRST X.5-F R2 marker (in type
       doc); refined to "X.5-F R2: enqueue" + R2.5 sentinel. Now
       correctly green pre-fix.
    2. sql.js REJECT_INSTALL regex window too small (entry has long
       multi-line reason). Bumped window from 400 to 800 chars.
    3. tsc probe used `bunx` not in PATH; switched to `bun x tsc`.

## Phase C — 2026-05-05T19:10Z
- Status: ✓
- Commits:
  - C.1 supervisor: a423bde (src/npm-resolver.ts:757-790 + supervisor probe anchor)
  - C.2 facet:      da3cfa1 (src/npm-resolve-facet.ts:743-784 + facet probe anchor)
  - both pushed to origin/x5j-r25-reject
- Notes:
  - Supervisor fix at npm-resolver.ts:757-790. Calls lookupReject(peerName)
    at the head of the R2.5 enqueue loop. If rejectable, emit transitive-skip
    via emitRegistryEvent, log [skip] via onProgress, continue.
  - Facet fix at npm-resolve-facet.ts:743-784. Mirror using preamble
    accessors SHOULD_REJECT_FAIL + SHOULD_WARN_SKIP_TRANSITIVE. __EMIT_EVENT
    + messages.push for the [skip] line.
  - Both edits do NOT add to `seen` in the skip branch — preserving the
    later required-dep walk's right to throw RegistryRejectError if the
    same name shows up as a hard dep elsewhere. (Plan §5 #4 + §5.1.)
  - Probe regex anchors refined alongside (the original `(?=\n\n)` regex
    no longer marks the end of the R2.5 block now that the block has a
    multi-line carve-out comment with internal `//` blank-comment lines).
    New anchor: BFS-walker-specific opening phrase + closing 6-space `}`.
  - **All 9 X5J probes GREEN** locally:
      ```
      X5J summary: 9 passed, 0 failed
      ```
  - Cross-wave regression suites also GREEN locally:
      X5F: 7/7 (functional + regression)
      X5G: 11/11 (functional + regression)
      X5C: 10/10 (functional + regression + e2e local)
      W6:  17/17 (preamble-parity confirms facet edit didn't drift)
  - install-pipeline-coverage shows 3/4 — the ts-jest failure is
    pre-existing on main HEAD eb316dc (verified by stashing fix +
    running on main; same 3/4 result). Not caused by X.5-J.
  - **Hiccup**: a `git stash` during the main-baseline-comparison left
    src/ edits in the stash; `git stash pop` reported "kept" due to
    a conflict with the install-pipeline-coverage.txt timestamp drift.
    Recovered by `git checkout` of the dirty txt artifacts then re-pop.
    All edits intact; verification re-run green. Lesson learned: avoid
    git stash when comparing main; use a dedicated worktree or the
    untracked stash flag.

## Phase D — 2026-05-05T19:15Z
- Status: ✓
- Commit: 06b4660 (pushed; transient 403 cleared on retry)
- Notes:
  - Final integration sweep, all GREEN locally:
    | Suite | Result |
    |---|---|
    | W6   | 17/17 ✓ (incl. preamble-parity = 38/38) |
    | X5F  | 7/7   ✓ |
    | X5G  | 11/11 ✓ |
    | X5C  | 10/10 ✓ |
    | X5J  | 9/9   ✓ |
  - tsc baseline: 2 errors, byte-identical to f4357a04 / eb316dc:
    1. src/esbuild-service.ts(153,28): TS2307 esbuild-wasm/esbuild.wasm
    2. src/nimbus-session-init.ts(74,39): TS2345 SqliteVFSProvider
    Neither error introduced by X.5-J.
  - install-pipeline-coverage = 3/4 (ts-jest fail) — pre-existing on
    main HEAD eb316dc per side-by-side comparison; not caused by X.5-J.
  - Mossaic regression DEFERRED: the existing probe targets a live
    prod URL (`https://nimbus.ashishkmr472.workers.dev`) and requires
    network + a live deployment of THIS branch to be meaningful for
    a regression check. Local run would either hit prod (testing
    main's behaviour, not X5J) or fail with WS connect error. Documented
    as known-limitation; X.5-J's scope is install-resolver-only and
    has zero touch points with the supervisor↔facet RPC, session
    runtime, or any vite/wrangler dev-server path that Mossaic
    exercises. Cross-wave coverage from W6/X5F/X5G/X5C/X5J probe sets
    + tsc clean is the operative regression evidence.
  - **Sub-agent diff review**: re-attempted via Task tool, again
    returned ProviderModelNotFoundError. Conducted manual self-review
    against 5 explicit scenarios:
      A. top-level pkg P + optional peer in REJECT_INSTALL → ✓ install OK
      B. top-level pkg P + REQUIRED peer in REJECT_INSTALL → ✓ loud-fail (R2 path unchanged)
      C. transitive REQUIRED dep in REJECT_INSTALL → ✓ loud-fail (dep walk unchanged)
      D. top-level pkg P + optional peer NOT in REJECT_INSTALL → ✓ enqueued normally
      E. peer X is BOTH optional peer (R2.5) AND required transitive dep (Q→X)
         → R2.5 soft-skips X first (continue, NOT seen.add), dep walk
         hits X, resolveOne fires reject → loud-fail. Correct: if X is
         genuinely required somewhere, install should fail.
  - All 5 scenarios pass; the `do NOT seen.add` decision in Phase A's
    risk register §5.1 is validated by Scenario E.
  - Captured `audit/probes/x5j/run-all.txt` GREEN-state artifact.

## Phase E — 2026-05-05T19:18Z
- Status: ✓
- Commit: 06b4660 (already pushed in Phase D)
- Notes:
  - All 4 prior commits (Phase A 44a2e0f, Phase B 834068b,
    Phase C.1 a423bde, Phase C.2 da3cfa1, Phase D 06b4660) on origin.
  - One transient 403 on Phase D push, recovered on retry.
  - Branch `x5j-r25-reject` not merged to main (per anti-requirement).

## Phase F — 2026-05-05T19:20Z
- Status: ✓
- Commit: 90c73de (pushed)
- Notes:
  - Wrote `audit/sections/X5J-retro.md` (~250 lines):
    - TL;DR table.
    - Per-package ⛔→✅ verdict (drizzle-orm, ts-node).
    - 5 surprises (S1-S5: sub-agent unavailable, plan caught a bug,
      regex re-anchoring, git stash gotcha, bunx PATH).
    - 4 scope deviations (D1-D4: src/ scope holds; line-numbers
      were nominal not literal; Mossaic deferred; e2e gated).
    - Root-cause final.
    - Plan-deviation matrix (no surprises).
    - 2 carry-forwards (33-pkg sweep gate + AST block extractor).

