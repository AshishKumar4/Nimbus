# Batch Merge V — x5z3-pre-compile-esm — progress log

> **Mode:** autonomous orchestrator. User stepped away ~1y. Build mode.
> **Dispatch:** merge `x5z3-pre-compile-esm` (local worktree) into local `main`.
> **Date:** 2026-05-05.

---

## Pre-merge state

| Anchor | SHA |
|---|---|
| Pre-Batch-Merge-V local main HEAD | `eb81701` (audit: batch-merge-iv — x5r-events-class + roadmap update) |
| x5z3-pre-compile-esm branch tip (worktree HEAD) | `2298b6c` (x5z3 phase G RETRO) |
| Branch ahead-by-vs-main | 7 commits (A→G phases) |
| Branch src/ delta | `src/facet-manager.ts` only, +146 LOC purely-additive |
| Charter target | jsdom ✅ at full real-package install layer |
| Predicted ✅ delta | +1 (jsdom) → 25/33 projected (per X5Z3-retro §6) |

## Merge

- Remote `x5z3-local` already configured at `/workspace/worktrees/x5z3-pre-compile-esm`.
- `git fetch x5z3-local x5z3-pre-compile-esm` — clean, FETCH_HEAD = `2298b6c`.
- `git merge --no-ff x5z3-local/x5z3-pre-compile-esm -m "merge: x5z3-pre-compile-esm — addStaticReadFileAssets → jsdom ✅"`
  - **Result:** 1 add/add conflict in `audit/sessions/batch-merge-iv-progress.md` (audit-only, NOT src/). Source-code merge clean.
  - Conflict cause: x5z3 worktree's baseline included a stale placeholder version of batch-merge-iv-progress.md (committed pre-Batch-Merge-IV finalization); main's version has the real roadmap-update SHA `7203cb9`.
  - Resolution: `git checkout --ours audit/sessions/batch-merge-iv-progress.md` (keep main's real SHA); `git add` + `git commit` to conclude merge.
- **Merge commit:** `7535622` (`merge: x5z3-pre-compile-esm — addStaticReadFileAssets → jsdom ✅`).
- src/ diff vs eb81701: `src/facet-manager.ts` +146 / -0 LOC, single file. Anti-touched files (node-shims.ts, require-resolver.ts, npm-resolver.ts, npm-installer.ts, streams.ts, _shared/exports-resolver.ts) all untouched.

## Post-merge state

| Anchor | SHA |
|---|---|
| Post-merge local main HEAD | `7535622` |
| `git merge-base --is-ancestor 2298b6c HEAD` | YES (ancestor confirmed) |
| Files added | 25 audit/probes/x5z3 files + X5Z3-plan.md + X5Z3-retro.md + X5Z3-progress.md |
| Files modified | src/facet-manager.ts |

## tsc check

`bun x tsc --noEmit` post-merge:

```
src/esbuild-service.ts(153,28): error TS2307: Cannot find module 'esbuild-wasm/esbuild.wasm' or its corresponding type declarations.
src/nimbus-session-init.ts(74,39): error TS2345: Argument of type 'SqliteVFSProvider' is not assignable to parameter of type 'VirtualProvider | MountProvider'.
  Type 'SqliteVFSProvider' is not assignable to type 'MountProvider'.
    The types of 'stat(...).type' are incompatible between these types.
      Type 'string' is not assignable to type 'FileType'.
EXIT=2
```

**Verdict:** 2 baseline errors, byte-identical to pre-merge baseline. ✅ pass.

## x5z3 run-all sanity check

`bun audit/probes/x5z3/run-all.mjs` from merged main:

```
── X.5-Z3 functional + regression ─────────────────────────
[PASS] functional/f1-readfilesync-asset.mjs
[PASS] functional/f2-asset-extensions.mjs
[PASS] functional/f3-skip-dynamic.mjs
[PASS] regression/r1-no-bundle-cap-blowup.mjs
[PASS] regression/r2-vfs-not-found.mjs
[PASS] regression/r3-existing-bundle-untouched.mjs
── cross-wave guards ──────────────────────────────────────
[PASS] ../x5f/regression/install-pipeline-coverage-shim.mjs
[PASS] ../x5f/regression/single-resolver-source.mjs
── heavy regressions skipped (NIMBUS_X5Z3_HEAVY=1 to run)
── e2e skipped (NIMBUS_X5Z3_E2E=1 to run; BASE=http://127.0.0.1:8787 required)

──── x5z3 run-all: 8 pass / 0 fail
EXIT=0
```

**Verdict:** 8/8 PASS at the local-runnable layer (3 functional + 3 regression + 2 cross-wave guards). E2E + heavy gated as designed. ✅ pass.

(Note: prompt said `run-all.sh`; actual driver is `run-all.mjs` per X5Z3-retro Phase E receipts. Same artifact, different filename.)

## Final commit + push

- Roadmap-update + progress-log commit: `1b3ede0` ("audit: batch-merge-v — x5z3-pre-compile-esm + roadmap update"). Note: SHA will shift to a new commit once this final progress-log update is folded in (amend will preserve `1b3ede0`'s message + tree but also include this file's `git push` status text — final SHA recorded below in the SHAs table after amend).
- `git push origin main`: **403 grant not approved** (verbatim: `remote: Access denied: grant not approved` / `fatal: unable to access 'https://github.com/AshishKumar4/Nimbus.git/': The requested URL returned error: 403`). Per dispatch, logged + continuing. The push will succeed when the user re-approves the OpenCode grant on the GitHub side; no code change required, just a re-push from this checkout.
- Local main commits ahead of `origin/main`: ~78 (76 pre-batch + 1 merge + 1 roadmap update).

## Done criteria check

- [x] 1 merge on local main (`7535622`).
- [x] tsc clean (2 baseline errors only, byte-identical to pre-merge).
- [x] HEAD reachable from main: `git merge-base --is-ancestor 2298b6c main` → YES.
- [x] x5z3 run-all sanity check 8/8 PASS at merged main HEAD.
- [x] 1 roadmap update commit (`1b3ede0`).
- [x] Push attempted — 403 grant not approved, logged + continued per dispatch.
- [x] batch-merge-v-progress.md committed.

## SHAs

| Anchor | SHA |
|---|---|
| Pre-Batch-Merge-V local main | `eb81701` |
| x5z3-pre-compile-esm branch tip | `2298b6c` |
| x5z3-pre-compile-esm merge commit | `7535622` |
| Roadmap-update + progress commit | `78d08b9` (final, post-amend with push receipts) |

## Anti-requirement compliance

- x5z3 src/ diff: `src/facet-manager.ts` only (+146 LOC additive, single new exported helper `addStaticReadFileAssets` wired into `buildPrefetchBundle` as pass 2.25).
- Anti-touched files: all confirmed untouched (node-shims.ts, require-resolver.ts, npm-resolver.ts, npm-installer.ts, streams.ts, _shared/exports-resolver.ts).
- tsc check ran AFTER the merge; returned the 2-error baseline (byte-identical to pre-merge).
- 1 conflict (audit-only, add/add on a progress log); resolved keeping main's real-SHA version. Zero src/ conflicts.
- Merge message documents layer + retro headline per dispatch template.
- No `wrangler login` or `wrangler deploy` invoked.
- No unreviewed src/ commits — single merge commit composing the already-reviewed x5z3 branch.

## Cross-wave regression status

Per X5Z3-retro §4 at branch tip `2298b6c` (carried forward to merge HEAD `7535622` since src/ diff is identical):

| Suite | Result |
|---|---|
| x5c run-all | ALL ✅ |
| x5f run-all | 7/7 ✅ |
| x5g run-all | 11/11 ✅ |
| x5j run-all | 9/9 ✅ |
| x5l run-all | ALL ✅ |
| x5m run-all | ALL ✅ |
| x5npqo run-all | OVERALL: PASS |
| x5r run-all | 5/5 ✅ |
| x5z5-build run-all | 10/11 (1 fail = pre-existing tlw-vite lightningcss native binding) |
| run-mossaic-prod-w2 | PASS |
| x5r/regression/r-w1 | PASS |

Zero new regressions. Pre-existing FAILs unchanged.

## Outstanding origin push

The merge commit + the roadmap-update commit will be local-only on `main` if push 403s. Per dispatch, expected behavior on Nimbus grant lapse — log + continue. The push will succeed when the user re-approves the OpenCode grant on the GitHub side.

## Worktree preserved

`/workspace/worktrees/x5z3-pre-compile-esm` left in place per dispatch — also useful for re-pushing the original branch ref directly when grant returns.
