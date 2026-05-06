# X.5 J/L/M batch merge — progress log

> Autonomous orchestrator run. User stepped away ~1 year. Merges three X.5
> follow-up buckets into `main` without pause.
>
> **Start:** 2026-05-05T19:53Z
> **Base:** `main` HEAD `eb316dc` ("audit: X.5 batch merged to main + roadmap updated").
> **Buckets:**
> - x5j (`origin/x5j-r25-reject` HEAD `ae5cc15`) — R2.5 ↔ REJECT_INSTALL reconciliation; touches `src/npm-resolve-facet.ts` + `src/npm-resolver.ts`.
> - x5l (`origin/x5l-bare-subpath` HEAD `93fa5ad`) — bare-spec subpath walker; touches `src/require-resolver.ts`.
> - x5m (`/workspace/worktrees/x5m-shim-gaps` HEAD `624a1c8`; origin tip `7e04c34` is 3 commits behind due to 403 grant earlier) — node-shim runtime gap shims (fastify setTimeout, redis dns/promises subpath, vite URL lenient base); touches `src/node-shims.ts` only.
>
> **Merge order rationale (from dispatch):** x5j first (regression fix), x5l second (Ex API + synthetic stubs), x5m last (orthogonal shim file, captures unpushed bookkeeping commits via local-worktree remote).
>
> **Pre-merge baseline:**
> - `git status` clean (untracked `audit/_reference/X5C-WAVE-BRIEF.md` only — left alone).
> - tsc baseline on `main`: 2 pre-existing errors (`esbuild-service.ts:153` + `nimbus-session-init.ts:74`).
> - File-collision audit (predicted): zero between the three branches:
>   - x5j → `npm-resolver.ts` + `npm-resolve-facet.ts`
>   - x5l → `require-resolver.ts`
>   - x5m → `node-shims.ts`
>   No overlapping src files; conflicts expected only in audit text (X5*-progress.md / install-pipeline-coverage.txt baselines).

---

## Phase 1 — x5j merge — ✅ DONE 2026-05-05T19:54Z

- **Merge:** `git merge --no-ff origin/x5j-r25-reject` → commit `fc0b526` on main.
- **Conflicts:** ZERO. Branch only touched `src/npm-resolve-facet.ts` + `src/npm-resolver.ts` + audit/, no overlap with main since `eb316dc`. Clean recursive merge.
- **Files changed:** 22 files, +2,104 lines (audit/probes/x5j/* + audit/sections/X5J-{plan,retro}.md + audit/sessions/X5J-progress.md + 53 LOC src/).
- **tsc post-merge:** 2 errors, byte-identical to baseline (`esbuild-service.ts:153` + `nimbus-session-init.ts:74`). Zero new errors. ✅
- **Probes (`bun audit/probes/x5j/run-all.mjs`):** 9/9 GREEN
  - functional 4/4 (synth-fixture-package-rejects-soft-skip, r25-rejects-optional-peer-supervisor, r25-rejects-optional-peer-facet, r2-required-peer-still-throws)
  - regression 5/5 (loud-reject-still-loud-top-level, single-resolver-source, loud-reject-still-loud-required-peer, r25-still-installs-non-rejected-peers, tsc-baseline-preserved)
  - e2e 4/4 SKIP cleanly (gated on `NIMBUS_X5J_E2E=1` — needs live wrangler dev)
- **Push:** `git push origin main` → **403 `grant not approved`** (verbatim error). Continuing per dispatch — local merge stands.
- **HEAD on main:** `fc0b526`.

---

## Phase 2 — x5l merge — ✅ DONE 2026-05-05T19:55Z

- **Pre-merge state:** `bun install` regenerated `src/git-bundle.generated.ts` + `src/parallel/generated-workers.ts` (timestamp-only diffs in their JSDoc headers). Stashed those + the in-progress progress log so the merge could apply x5l's same-file regenerated copies (also timestamp-only). Restored only the progress log from the stash; let x5l's generated files win (semantically equivalent).
- **Merge:** `git merge --no-ff origin/x5l-bare-subpath` → merge commit on main. Recursive strategy, no source conflicts.
- **Conflicts:** ZERO source conflicts. Branch only touched `src/require-resolver.ts` + 2 generated-file timestamp lines + audit/. The 2 generated files would have nominally collided but the stash dance resolved them in x5l's favour (timestamp-only — runtime-equivalent).
- **Files changed:** 20 files, +2,395 lines (audit/probes/x5l/* + audit/sections/X5L-{plan,retro}.md + audit/sessions/X5L-progress.md + 266 LOC src/require-resolver.ts).
- **tsc post-merge:** 2 errors, byte-identical to baseline. Zero new errors. ✅
- **Probes (`bun audit/probes/x5l/run-all.mjs`):** 10/10 GREEN
  - functional 4/4 (f1-bare-subpath-walker, f2-bare-subpath-with-exports, f3-bare-subpath-fallback-index, f4-bare-subpath-up-pointing)
  - regression 3/3 (r1-single-resolver-source, r2-install-pipeline-coverage, r3-x5c-fixes-still-green)
  - e2e 3/3 (e1-react-remove-scroll-real, e2-radix-react-dialog-real, e3-nuxt-defu-investigation)
- **Push:** `git push origin main` → **403 `grant not approved`** (verbatim error). Continuing per dispatch.
- **HEAD on main after Phase 2:** `592d6dc`.

---

## Phase 3 — x5m merge — ✅ DONE 2026-05-05T19:56Z

- **Setup:** added `x5m-local` remote pointing at `/workspace/worktrees/x5m-shim-gaps`, fetched `x5m-shim-gaps` to capture commits 35becdb / 25bf498 / 624a1c8 (Phase D + F retro + stuck-doc that 403'd on origin push earlier). HEAD `624a1c8`.
- **Merge:** `git merge --no-ff x5m-local/x5m-shim-gaps` → merge commit on main. Recursive strategy.
- **Conflicts:** ZERO. Branch only touched `src/node-shims.ts` (~85 LOC across 3 contiguous edits) + audit/. No overlap with x5j (npm-resolver/facet) or x5l (require-resolver).
- **Files changed:** ~70 audit files + 1 src file (audit/probes/x5m/* incl. 14 vite-url investigation stacks + audit/sections/X5M-{plan,retro}.md + audit/sessions/X5M-{progress,stuck}.md + node-shims.ts).
- **Local-only commits captured on main:**
  - `35becdb` — Phase D audit sweep + progress log
  - `25bf498` — Phase F retro + progress log
  - `624a1c8` — stuck-doc bookkeeping
  All three reachable from main HEAD post-merge (`git merge-base --is-ancestor` PASS for each).
- **Cleanup:** removed the `x5m-local` remote post-merge so origin remains the only configured remote.
- **tsc post-merge:** 2 errors, byte-identical to baseline. Zero new errors. ✅
- **Probes (`bun audit/probes/x5m/run-all.mjs`):** 9/9 GREEN (functional 3/3 + regression 3/3 + builtins-coverage 34/34). E2E self-skips without `BASE=http://...` — same self-skip behaviour the X5M-retro documented.
- **Push:** `git push origin main` → **403 `grant not approved`** (verbatim error, third occurrence this session — same gateway issue x5m hit on Phase D/F push attempts earlier). All three merges remain locally on main.
- **HEAD on main after Phase 3:** `98f2e46`.

---

## Pre-roadmap-update summary

- 3 merge commits on local main: `fc0b526` (x5j) → `592d6dc` (x5l) → `98f2e46` (x5m).
- tsc clean after each (2 baseline errors only — bit-identical).
- All 3 retros reachable from main (`audit/sections/X5{J,L,M}-retro.md`).
- All 3 push attempts 403'd. Local merges stand.
- Probe totals: x5j 9/9 + x5l 10/10 + x5m 9/9 = **28/28 GREEN** local; e2e gates honoured (x5j needs `NIMBUS_X5J_E2E=1`; x5m needs `BASE=http://...`).

Next step: roadmap update + final push attempt.

---

## Phase 4 — roadmap update + final push — ✅ DONE 2026-05-05T19:58Z

- **Roadmap update commit:** `b9d4fda` ("audit: X.5-J/L/M batch merged + roadmap updated"). Modifies `audit/sections/MASTER-ROADMAP.md` (headline + new "X.5-J/L/M Follow-up Buckets" section), this progress log, and `audit/probes/x5m/run-all.txt` (the file in the merge carried a stale RED baseline from x5m's mid-development probe run; my post-merge run produced GREEN output and the diff was committed).
- **Final push attempt:** `git push origin main` → **403 `grant not approved`** (4th occurrence this session — same gateway condition).
- **Unpushed commit count on main:** 26 (per `git log main ^origin/main | wc -l`). This includes:
  - 17 commits inherited from x5l merge baseline + earlier wave bookkeeping (e.g. x5m's local-only D+F bookkeeping commits 35becdb/25bf498/624a1c8 that are now reachable from main via the x5m merge)
  - 4 new merge commits from this batch: progress-baseline `0c13a85`, x5j `fc0b526`, x5l `592d6dc`, x5m `98f2e46`
  - 1 roadmap commit `b9d4fda`
- **All target SHAs (`ae5cc15`, `93fa5ad`, `35becdb`, `25bf498`, `624a1c8`) reachable from main HEAD `b9d4fda`** — verified via `git merge-base --is-ancestor`.

---

## Done-criteria honest assessment vs dispatch

| Criterion | Status |
|---|---|
| 3 merge commits + 1 roadmap update on local main | ✅ (`fc0b526` + `592d6dc` + `98f2e46` + `b9d4fda`) |
| tsc clean after each merge | ✅ (2 baseline errors only at every intermediate HEAD; bit-identical to pre-batch baseline) |
| All 3 retros reachable from main locally | ✅ (X5J/L/M retros all present at HEAD via `git ls-tree`) |
| Origin push attempted (queued OK) | ✅ — 4 attempts, all 403'd; queued for user grant re-approval |
| Progress log committed | ✅ (this file, in `b9d4fda`) |
| **No src/ modifications outside announced files** | ✅ (x5j: npm-resolve-facet + npm-resolver only; x5l: require-resolver only; x5m: node-shims only) |
| **No skip tsc check** | ✅ (3 explicit `bun x tsc --noEmit` runs) |
| **No silent completion** | ✅ (this log + retros are the receipts) |
| **No push if tsc fails** | ✅ (tsc never failed) |
| **No wrangler login or deploy** | ✅ (none attempted) |
| **No pause for user input** | ✅ |

---

## Summary line

3 X.5 follow-ups merged. 4 commits added to local main. 0 conflicts. 0 new tsc errors. 0 src/ touches outside announced files. 28/28 local probes GREEN across J+L+M. 4 origin-push attempts all 403'd — pushes queued for grant re-approval.

Healthy package matrix: 22/33 → projected **26/33 strict** (J+2 recovery, L+2 flips, M+0 strict but +3 charter-passes); up to **29/33 (88%)** charter-credited optimistic per the X.5-F precedent that "fails for new deeper reason = healthier state."




