# X.5-26b cap-fix — retro

> Branch: `x526b-cap-fix` off `origin/main` @ `23417c5`.
> Final HEAD: `d4c611d` (post Phase E AUDIT commit + push).
> Worktree: `/workspace/worktrees/x526b-cap-fix`.
> Phases A-G complete. Pushed to `origin/x526b-cap-fix`.

## §1 TL;DR

Dispatched as "P0 cap-fix" against ts-jest + tailwindcss-oxide +
lightningcss based on VERIFY-23417C5.md §4 #2 hypothesis (typescript.js
~9 MiB single-file cap-evicted). Phase A investigation **definitively
disproved** the cap-eviction hypothesis for all 3 packages. Pivoted
to the X.5-Z5c/Z5d pattern (REJECT_INSTALL adds in
`src/wasm-swap-registry.ts` + mirror in
`src/parallel/npm-resolve-preamble.ts`). Shipped:

- **2 src/ commits** (a7ab5f3 + 896c2f0) — 32 LOC additive, zero deletions.
- **+2 healthy classifier flips** in 33-pkg cohort (tailwindcss-oxide
  direct + tailwindcss-vite transitive). Cohort: **27/33 → 29/33 (+2)**.
- **+0 strict-✅ flips** (anti-req constraints make all 3 dispatched
  packages structurally unreachable for ✅).
- **0 cross-wave regressions** (3 cross-wave runalls failures all
  pre-existing on main).
- **8/8 X.5-26b probes GREEN** (66 sub-asserts, 0 fail).

The dispatch's literal "≥1/3 of {ts-jest, tailwindcss-oxide,
lightningcss} flip ✅" criterion is **mechanically unreachable**
within the anti-requirement set — see §3.

## §2 Per-package verdict

| Pkg | Pre | Post | Net | Root cause | Architecture |
|---|---|---|---|---|---|
| **ts-jest** | ⚠ | ⚠ | 0 | Missing `_fs.realpathSync.native` shim in `__fsMod` (per X.5-Z5 plan §4) | OUT OF SCOPE — fix is in `src/node-shims.ts`, anti-req X.5-S file lock |
| **tailwindcss-oxide** | ⚠ | ⛔ | **+1 healthy** | Native binding fallthrough at `index.js:561` (npm-4828 message); no JS fallback because all platform shards are skipped + workerd has no `node:wasi` | REJECT_INSTALL `transitive: 'fail'` in `src/wasm-swap-registry.ts` |
| **tailwindcss-vite** (transitive) | ⚠ | ⛔ | **+1 healthy** | Transitively pulls `tailwindcss@^4` which depends on `@tailwindcss/oxide`; same root | Same — `transitive: 'fail'` propagates |
| **lightningcss** | (out of cohort) | (out of cohort) | 0 in cohort | `detect-libc.familySync` calls `child_process.execSync` which returns `undefined` in workerd → `out.split is not iterable`; even if libc detected, native bindings can't dlopen + `lightningcss-wasm` is wasm32-cpu-only AND workerd has no `node:wasi` | REJECT_INSTALL `transitive: 'fail'` (hygiene + future-cohort coverage) |

**Net cohort delta**: 27/33 → **29/33 healthy (+2, 88%)**.
**Strict-✅ delta**: 16/33 → 16/33 (no change).

## §3 Architecture rationale

The dispatch's two architectural options were:
1. Lift cap for typescript-class large pkgs.
2. Shift typescript out of prefetch into runtime VFS-on-demand.

Phase A investigation showed both are **mechanically irrelevant**
because none of the 3 dispatched packages is cap-evicted:

- **ts-jest**: stack `getNodeSystem … 8291:43` is INSIDE the loaded
  typescript module body. Cap-eviction surface is `Cannot read
  module: <path>` at `src/node-shims.ts:2129` — different shape.
- **tailwindcss-oxide**: 4-file install (24 KiB total). Off the
  22 MiB cap by 3 orders of magnitude.
- **lightningcss**: 22 files, 0.1 MiB total. Same — orders off the cap.

The X.5-Z5 plan §4 had already corrected the cap-eviction hypothesis
for ts-jest at the investigation phase. VERIFY-23417C5.md §4 #2 was
written before X.5-Z5 plan was authored, so it carried forward the
prior (wrong) speculation. The dispatch inherited that speculation.

Once cap-eviction was excluded, the next-most-economical architecture
for the achievable subset (oxide + lightningcss) was already
documented in `X5Z5-build-retro.md §8` as the proposed Z5c/Z5d
follow-on dispatches. X.5-26b is effectively **a re-dispatch of Z5c
+ Z5d under a different branch label**, with the cap-fix framing
discarded.

### §3.1 Why ts-jest can't flip ✅ in this wave

The X.5-Z5 plan §4.3 prescribed a 3-LOC fix in `src/node-shims.ts`:

```ts
function realpathSync(p, opts) { return _resolve(String(p)); }
realpathSync.native = realpathSync;
// + add `realpathSync` to the return-object word at line 581.
```

The X.5-26b dispatch's anti-requirement explicitly forbids touching
`src/node-shims.ts`:

> DO NOT touch src/node-shims.ts runner-template OR pre-compile
> banner (X.5-S).

Adding to `__fsMod`'s return object is a runner-template change.
Therefore ts-jest is intentionally deferred to a future X.5-Z5e
wave (per X5Z5-build-retro §8 #3 recommendation).

### §3.2 Why oxide and lightningcss can't flip ✅

Both packages exist solely to provide native CSS-engine bindings.
Their published artifacts:

- `@tailwindcss/oxide`: `.node` bindings for 12 platforms + a
  `wasm32-wasi` shard that requires `node:wasi`.
- `lightningcss`: `.node` bindings for 13+ platforms + a separate
  `lightningcss-wasm` package that's `cpu: ["wasm32"]`-only on npm
  (refuses x64 install) AND requires `node:wasi`.

workerd has no `node:wasi` per `audit/sections/07-workerd-hard-limits.md`
(W6.5 hard limit). `.node` bindings cannot dlopen. There is no
JS-implemented fallback shipped by either upstream. Therefore the
upstream surface offers no path to a working ✅ — only honest ⛔.

### §3.3 Strict-✅ unreachability vs dispatch criterion

Dispatch "Done" criterion §1:

> ≥1/3 of {ts-jest, tailwindcss-oxide, lightningcss} flip ✅;
> others honestly diagnosed

Mechanically met **0/3** flip ✅. All 3 honestly diagnosed (Phase A
evidence per pkg, root cause documented, architectural fork
explicit). Dispatch outcome metric §"Predicted: +2-3 ✅ → 30-31/33"
maps to the healthy-classifier axis (which collapses ✅ + ⛔). On
that axis we delivered +2/+3 expected → 29/33 (88%). On the strict
✅ axis, the +2-3 prediction was conditioned on the cap-eviction
hypothesis and is unreachable in its absence.

This is documented up-front in plan §6.3 + §8 #1. Honest verdict
per dispatch language "others honestly diagnosed".

## §4 Deviations from dispatch

### §4.1 Architecture pivot (cap-fix → REJECT_INSTALL)

**Dispatch said**: "Two architectural options: lift cap … OR shift
typescript out of prefetch into runtime VFS-on-demand (preferred)".

**We did**: Neither. Phase A excluded cap-eviction for all 3 pkgs.
Pivoted to REJECT_INSTALL data-only adds in
`src/wasm-swap-registry.ts` + `src/parallel/npm-resolve-preamble.ts`.

**Why**: Architectural fork was conditioned on a wrong hypothesis.
Doing cap-fix work would be no-op (no package is actually evicted).
Doing the runtime-VFS-on-demand shift for typescript would also be
moot because typescript is loading fine — the issue is a missing
`fs.realpathSync.native` symbol, which is unrelated to where
typescript bytes come from.

**Impact**: Lower LOC (32 add vs the 100+ LOC predicted by the
dispatch's "lift cap" / "VFS-on-demand" options); zero risk of
introducing cap-logic regressions; same +2 healthy outcome.

### §4.2 Synth-pkg-with-9MiB functional probe NOT shipped

**Dispatch said**: "Functional: synth pkg with single >9 MiB file,
expect runtime load works."

**We did**: Replaced with 3 data-shape probes
(`oxide-rejected.mjs`, `lightningcss-rejected.mjs`,
`preamble-mirror-sync.mjs`).

**Why**: The synth-9MiB probe assumes cap-eviction is the failure
mode. Phase A excluded that. A passing synth-9MiB probe wouldn't
prove anything about the actual root causes. The 3 shipped
functional probes assert the actual fix shape (registry data
correctness + preamble mirror sync).

**Impact**: Probe coverage is tighter to the real fix; honest
assertion shape; documented in plan §7.1.

### §4.3 lightningcss is out-of-cohort

**Dispatch said**: It's one of the 3 P0 packages.

**Reality**: lightningcss is NOT in the 33-pkg verify cohort.
Adding it to REJECT_INSTALL contributes 0 to the 33-pkg classifier
delta but does cover 1 of 3 dispatched packages and is correct
hygiene for any future cohort expansion.

**Impact**: Honest +0 cohort delta for lightningcss specifically.
Total cohort delta is +2 driven by oxide (direct) +
tailwindcss-vite (transitive).

### §4.4 e2e probe assertion adjustment

**Initial assertion**: `txt.includes('❌ @tailwindcss/oxide')` for
the transitive reject path (tailwindcss-vite).

**Corrected to**: `txt.includes('npm install rejected: @tailwindcss/oxide')`.

**Why**: The transitive reject path in `src/npm-resolve-facet.ts:525`
throws a single-line error message:
```js
new Error(`npm install rejected: ${__fail.from} — ${__fail.reason}`)
```
…without the `❌` prefix that's only added by `formatRejectError`'s
multi-line head (used on supervisor-side direct rejects via
`RegistryRejectError`). Both paths are loud rejects; the difference
is purely cosmetic.

**Impact**: e2e probe correctly asserts the transitive path's
actual output shape. Regression of behavior — none; the message
format has always been single-line for transitive rejects since
W6.

## §5 What worked

1. **Investigation-first cadence**: Phase A immediately disproved
   the dispatch hypothesis. Without it we'd have spent days writing
   cap-fix code that fixed nothing. The 3 probe outputs in
   `audit/probes/x526b/investigation/` are now persisted evidence
   that future X.5 dispatches against these 3 packages should not
   re-attempt the cap-fix framing.
2. **REJECT_INSTALL data-only adds**: 2 commits, 32 LOC, zero
   logic changes. Surface area for review is tiny; no chance of
   subtle bug introduction. The pattern was already established
   by all 22 prior REJECT_INSTALL entries.
3. **Preamble-mirror-sync probe**: The `preamble-mirror-sync.mjs`
   functional probe asserts EVERY prior fail-tier entry from the
   canonical registry is also in the preamble mirror. This catches
   any future divergence between the two files at probe time
   instead of at install time. It's a permanent invariant that
   should be inherited by future REJECT_INSTALL adds.
4. **Wrangler-dev `setsid` discovery**: Recorded in progress
   log §A.5. Cloudchamber containers reap nohup-detached children
   on parent shell exit; `setsid -f` is the right detach incantation.
   Saved in progress log so future autonomous waves don't
   rediscover it.
5. **Wrangler hot-reload through D1+D2**: Each src commit triggered
   `Reloading local server… Local server updated and ready` in
   the wrangler log; no manual restart between commits. e2e probes
   ran against fresh code immediately after each commit.

## §6 What didn't work / loose ends

1. **Strict-✅ unreachability**: The dispatch's literal "flip ✅"
   criterion was set without account for the realpathSync prerequisite
   (which X.5-Z5 plan had already documented). A future dispatch
   re-orchestration should query plan-state before locking in ✅
   targets — particularly when anti-requirements are tight.
2. **VERIFY-23417C5.md §4 #2 lineage**: The cap-fix hypothesis was
   already disproved by X.5-Z5 plan §4 at the time VERIFY-23417C5
   was authored, but the verify report still cited the W2.6b cap
   speculation. Recommend a one-line correction to
   VERIFY-23417C5.md §4 #2 noting the X.5-Z5 plan §4 disprove
   (out of scope for this wave; would require touching the verify
   branch).
3. **lightningcss is out-of-cohort but in-dispatch**: covers 1/3
   dispatched packages without contributing to the 33-pkg metric.
   If future verify cohorts grow to include lightningcss, the
   REJECT_INSTALL entry will already be in place.
4. **x5z5-build/e2e/tailwindcss-vite remains FAIL**: pre-existing,
   verified against pristine main. The in-process fixture path
   (`getOrInstallFixture`) bypasses the supervisor's resolver and
   so doesn't see our REJECT entry. A separate cleanup wave could
   either delete the now-stale x5z5-build e2e probe or update it
   to assert the new ⛔ outcome (out of X.5-26b scope).

## §7 Files touched

| File | Δ LOC | Change kind |
|---|---:|---|
| `src/wasm-swap-registry.ts` | +28 | data add (REJECT_INSTALL × 2 entries) |
| `src/parallel/npm-resolve-preamble.ts` | +4 | data add (mirror) |
| `audit/probes/x526b/investigation/run-3pkg.mjs` | +148 | new |
| `audit/probes/x526b/investigation/{ts-jest,tailwindcss-oxide,lightningcss}.{out.txt,probe.js}` | (probes + outputs) | new |
| `audit/probes/x526b/functional/{oxide,lightningcss}-rejected.mjs` | +35 / +33 | new |
| `audit/probes/x526b/functional/preamble-mirror-sync.mjs` | +57 | new |
| `audit/probes/x526b/regression/{single-resolver-source,install-pipeline-coverage-shim,cross-wave-runalls}.mjs` | +18 / +18 / +88 | new |
| `audit/probes/x526b/e2e/{oxide,lightningcss,tailwindcss-vite-transitive}-e2e.mjs` | +44 / +37 / +47 | new |
| `audit/probes/x526b/run-all.mjs` | +71 | new |
| `audit/probes/x526b/AUDIT-SUMMARY.md` | +130 | new |
| `audit/sections/X526b-plan.md` | +378 | new |
| `audit/sections/X526b-retro.md` | (this file) | new |
| `audit/sessions/X526b-progress.md` | +180 | new (7 phases) |

**src/ delta: 32 LOC, 2 files. Zero deletions. Zero edits to
forbidden files.**

## §8 Cross-references

- Plan: `audit/sections/X526b-plan.md`
- Audit summary: `audit/probes/x526b/AUDIT-SUMMARY.md`
- Progress log: `audit/sessions/X526b-progress.md` (7 phases A-G)
- Investigation evidence: `audit/probes/x526b/investigation/`
- Probes (all GREEN post Phase D): `audit/probes/x526b/{functional,regression,e2e}/`
- Run-all driver: `audit/probes/x526b/run-all.mjs`
- Prior plan flagging this work: `audit/sections/X5Z5-plan.md` §4
  (ts-jest realpathSync — out of scope here),
  `audit/sections/X5Z5-build-retro.md` §8 #1-2 (Z5c oxide / Z5d
  lightningcss recommendations — adopted).
- Verify report: `audit/sections/VERIFY-23417C5.md` §4 #2 (dispatch
  source; cap-fix hypothesis disproved by X.5-26b Phase A).

## §9 Recommendations for the next run

1. **Re-baseline the 33-pkg cohort** at HEAD `d4c611d` post-X.5-26b
   merge. Expected: 16 ✅ + 13 ⛔ = 29/33 healthy (88%). The 2
   pkgs flipping are oxide + tailwindcss-vite. Other ✅ unchanged.
2. **Dispatch X.5-Z5e (ts-jest realpathSync)** as a separate wave
   to clear the strict-✅ axis on ts-jest. ~3 LOC in
   `src/node-shims.ts` per X.5-Z5 plan §4.3. Should be a fast wave
   (~half day). Note that this requires lifting the X.5-S
   anti-requirement on node-shims.ts edits.
3. **Audit `audit/probes/x5z5-build/e2e/tailwindcss-vite.mjs`**:
   either delete (now-stale; the package is loud-rejected at
   install) or update to assert `npm install rejected:
   @tailwindcss/oxide` instead of the now-impossible runtime
   smoke. Out of X.5-26b scope.
4. **Update VERIFY-23417C5.md §4 #2** (separate audit-cleanup wave)
   to note the cap-eviction hypothesis was disproved by X.5-26b
   Phase A; future verifies should not re-cite it for ts-jest.
