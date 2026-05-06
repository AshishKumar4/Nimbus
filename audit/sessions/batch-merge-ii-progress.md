# Batch Merge II — Progress Log

> Started 2026-05-05T21:15Z (autonomous build mode; user away ~1 year)
> Base: local `main` @ `90993b3` (ahead of origin by 26 commits — origin push pending Nimbus grant)

## Scope

Five local-only branches to merge sequentially into local `main`:

1. **x5npqo-node-shims** `70d1731` — P+Q+O node-shim runtime fixes (only branch with `src/` delta — `src/node-shims.ts`)
2. **x5z5-investigation** `0ccebc4` — audit-only (X5Z5 plan + retro + 4 sub-investigations)
3. **verify-90993b3** `e62cefc` — audit-only (33-package matrix re-measure on `90993b3`)
4. **w115-e2-plan** `4644c45` — audit-only (W11.5-E2 webpack-in-facet substrate plan + R0-R3 investigations)
5. **w115-e1-research** `6650442` — audit-only (W11.5-E1 V8-IPC fork viability research + stuck doc)

## Collision pre-flight

`git diff --name-only 90993b3..HEAD` per branch — confirmed file disjoint:

| Branch | src/ files | audit/probes/ namespace | audit/sections/ files | audit/sessions/ files |
|---|---|---|---|---|
| x5npqo-node-shims | `src/node-shims.ts` | `audit/probes/x5npqo/**` (+ refresh of `x5f/**.txt`, `x5m/**.txt`) | `X5NPQO-plan.md`, `X5NPQO-retro.md` | `X5NPQO-progress.md` |
| x5z5-investigation | (none) | `audit/probes/x5z5-investigation/**` | `X5Z5-plan.md`, `X5Z5-investigation-retro.md` | `X5Z5-investigation-progress.md` |
| verify-90993b3 | (none) | `audit/probes/verify-90993b3/**` | `VERIFY-90993B3.md`, `VERIFY-90993B3-retro.md` | `verify-90993b3-progress.md` |
| w115-e2-plan | (none) | `audit/probes/w115-e2-investigation/**` | `W11.5-E2-plan.md` | `w115-e2-plan-progress.md` |
| w115-e1-research | (none) | (none) | `W11.5-E1-RESEARCH.md` | `W11.5-E1-research-stuck.md` |

**No two branches modify any common file.** The `x5f/**.txt` + `x5m/**.txt` artifacts in x5npqo are re-run captures of existing files; only x5npqo touches them in this batch.

## tsc baseline (pre-merge, on `main` @ 90993b3)

```
src/esbuild-service.ts(153,28): error TS2307: Cannot find module 'esbuild-wasm/esbuild.wasm' or its corresponding type declarations.
src/nimbus-session-init.ts(74,39): error TS2345: Argument of type 'SqliteVFSProvider' is not assignable to parameter of type 'VirtualProvider | MountProvider'.
  ...
```

2 pre-existing baseline errors. tsc exit 0 (errors are reported but tsc returns 0 in this repo's config — the baseline contract is "byte-identical output to pre-merge").

## Merge order rationale

x5npqo first (only `src/` change — gets the package-flip onto main early before tsc check), then audit-only branches in dispatch-specified order. None of the audit-only merges should require tsc re-run (zero `src/` delta), but tsc will be re-run anyway after x5npqo to enforce baseline.

---

## Per-merge log

### Merge 1 — x5npqo-node-shims @ `70d1731` → merge `c1a5ede`

- Strategy: `git merge --no-ff x5npqo-local/x5npqo-node-shims`
- Conflicts: **0**
- Files changed: 39 (1 src/ + 38 audit/)
- src/ delta: `src/node-shims.ts` only (P + Q + O shim fixes)
- tsc post-merge: 2 baseline errors only — byte-identical to pre-merge baseline
  - `src/esbuild-service.ts(153,28)` esbuild-wasm.wasm types (pre-existing)
  - `src/nimbus-session-init.ts(74,39)` SqliteVFSProvider.stat().type narrowing (pre-existing)
- Push attempt: `403 Access denied: grant not approved` — logged + continue per dispatch
- Branch HEAD ancestor of main: ✅ `git merge-base --is-ancestor 70d1731 main` returns 0

### Merge 2 — x5z5-investigation @ `0ccebc4` → merge `a3df3a9`

- Strategy: `git merge --no-ff x5z5-local/x5z5-investigation`
- Conflicts: **0**
- Files changed: 9 (audit-only — Z5 plan + retro + 4 sub-investigations + progress log)
- src/ delta: **none** — tsc re-run skipped per dispatch ("skip ONLY if a non-x5npqo merge has zero src/ delta")
- Push: deferred — batched after all 5 merges + roadmap update
- Branch HEAD ancestor of main: ✅

### Merge 3 — verify-90993b3 @ `e62cefc` → merge `8472d1c`

- Strategy: `git merge --no-ff verify-local/verify-90993b3`
- Conflicts: **0**
- Files changed: 71 (audit-only — 33-package matrix re-measure on `90993b3` with classify-packages-local + 33 .probe.js + 33 .out.txt artifacts + retro + progress)
- src/ delta: **none** — tsc skipped
- Headline measure: **23/33 strict ✅** at `90993b3` (per VERIFY-90993B3.md baseline). Note: roadmap Phase 3.5 had previously cited 22/33; the verify wave's re-measure landed 23/33 after the X.5-J/L/M merge sequence. (X.5-J retro projected 24/33 best-case; the +1 short is the X.5-L flip not surfacing in the local-runnable matrix because the verify probes test a different code path than X.5-L's e1+e2 real-package suite. Documented in VERIFY-90993B3.md.)
- Branch HEAD ancestor of main: ✅

### Merge 4 — w115-e2-plan @ `4644c45` → merge `2b33590`

- Strategy: `git merge --no-ff w115e2-local/w115-e2-plan`
- Conflicts: **0**
- Files changed: 8 (audit-only — W11.5-E2 plan + R0-R3 investigation probes + README + next-dev-probe-attempted note + progress log)
- src/ delta: **none** — tsc skipped
- Branch HEAD ancestor of main: ✅

### Merge 5 — w115-e1-research @ `6650442` → merge `bbfb6bd`

- Strategy: `git merge --no-ff w115e1-local/w115-e1-research`
- Conflicts: **0**
- Files changed: 2 (audit-only — W11.5-E1-RESEARCH.md V8-IPC fork viability research, ~1512 LOC + W11.5-E1-research-stuck.md)
- src/ delta: **none** — tsc skipped
- Branch HEAD ancestor of main: ✅

---

## Final state

- 5 merges + 1 progress-baseline commit + 1 roadmap-update commit (pending) on local `main`.
- src/ delta from `90993b3` baseline: `src/node-shims.ts` only (x5npqo). All other 4 branches were audit-only.
- tsc post-final-merge: 2 baseline errors only, byte-identical output to post-x5npqo state. **Gate: PASS.**
- All 5 branch HEADs reachable from local `main`:
  - x5npqo `70d1731` ✅
  - x5z5 `0ccebc4` ✅
  - verify-90993b3 `e62cefc` ✅
  - w115-e2 `4644c45` ✅
  - w115-e1 `6650442` ✅
- Origin push: **deferred** — `403 grant not approved` on first attempt after merge 1. Local main is now 31 commits ahead of `origin/main`. Push will succeed once the user re-approves the OpenCode grant on GitHub; no code change required, just a re-push from this checkout.
- Projected ✅ count post-merge:
  - Strict (X.5-NPQO not yet measured): **23/33** (verify-90993b3 measure on `90993b3` baseline; this batch's roadmap headline)
  - With X.5-NPQO predicted +4: **27/33** projected at next verify wave (X.5-NPQO retro per-bucket-verdict claim — actual measurement deferred to next wave)

