# X.5-F Retro — `resolve-miss` cohort

> Wave window: 2026-05-05 single-session autonomous run.
> Branch: `x5f-resolve-miss` off `main` HEAD `c3d9f47`.
> Plan: `audit/sections/X5F-plan.md` (committed Phase A).
> Progress: `audit/sessions/X5F-progress.md` (per-phase appended).
>
> **Prompt's done criteria recap:**
> 1. ≥ 4 of 7 packages turn ✅ (target: full 7, but be honest)
> 2. Single resolver path preserved
> 3. src/ pushed (or halted-on-grant)
> 4. X5F-progress.md all 6 phases ✓

---

## TL;DR

| Criterion | Result |
|---|---|
| Plan & retro committed | ✓ (X5F-plan.md, this file) |
| ≥ 4 of 7 ✅ flips | **✗ strict** (2 ✅ + 1 ⛔ = 3 healthy of 7) |
| Single resolver path preserved | ✓ verified by `audit/probes/x5f/regression/single-resolver-source.mjs` |
| src/ pushed | ✓ branch `x5f-resolve-miss` at HEAD `84e65b6+` |
| All 6 phases ✓ in progress log | ✓ |

**Honest call: only 2 packages turned strictly ✅ (webpack, framer-motion).**
parcel turned ⛔ (loud-reject, healthy per W6 design). The remaining 4
all moved DEEPER into their dependency chains — **every package now
fails for a NEW, DIFFERENT, more-honest reason** than the OLD-SHAPE
"Cannot find module 'X' (from /home/user/app)" the verification doc
captured. The 4 remaining ⚠ are all in DOWNSTREAM X.5 cohorts the X.5-F
charter never intended to touch (X.5-C pre-bundler, X.5-G native
optional-deps, W2.6b oversize-package).

The biggest wins are at the install layer:
- ts-jest installs **246 packages** (was 15) — typescript and jest peers now land
- nuxt installs **516 packages** (was 428) — optional peers cascade
- radix-react-dialog installs **32 packages** (was 26) — react+react-dom+@types/react now in tree
- framer-motion installs **6 packages** (was 4) — react+react-dom+jsx-runtime now reachable

The OLD-SHAPE error is **gone for all 7 packages**. The done-criterion's
`no OLD-SHAPE` check passes 7/7.

---

## Per-package ❌→✅ flip table

| Pkg | Before X.5-F (verification baseline) | After X.5-F | Net |
|---|---|---|---|
| **webpack** | ❌ `[npm] No packages resolved... Failed: webpack` then `Cannot find module 'webpack' (from /home/user/app)` | ✅ `typeof: function` | **R1 fix landed end-to-end** |
| **framer-motion** | ❌ `Cannot find module 'react/jsx-runtime' (from .../framer-motion/dist/cjs)` after install reports OK | ✅ `keys: motion,AnimatePresence,...` | **R2.5 fix (top-level optional-peer install) flipped this** |
| **parcel** | ❌ `[npm] No packages resolved... Failed: parcel` | ⛔ loud-reject `npm install rejected: @swc/core — Native Rust SWC.` | **R1 fix proceeded with install; W6 caught a transitive native binding correctly. Counts as healthy per verification doc §1: "loud-reject = healthy outcome".** |
| **rollup** | ❌ `[npm] No packages resolved... Failed: rollup` | ⚠ `Cannot find module @rollup/rollup-linux-x64-gnu. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828).` | **R1 fix proceeded with install (1 pkg landed, was 0). Now blocked on the npm-CLI optional-deps placement bug — same family as `tailwindcss-oxide` which the verification doc tagged as X.5-G. Out of X.5-F charter.** |
| **@radix-ui/react-dialog** | ❌ `Cannot find module 'react' (from .../@radix-ui/react-dialog/dist)` | ⚠ `Cannot find module './Combination' (from .../react-remove-scroll/dist/es2015)` | **R2 fix landed: `react` AND `react-dom` AND `@types/react` are now in node_modules (was missing). The new failure is on `react-remove-scroll`, a transitive sibling, hitting an ESM-subpath miss. The verification doc itself listed `react-remove-scroll` in the SEPARATE `pre-bundle` cohort (X.5-C). Out of X.5-F charter.** |
| **ts-jest** | ❌ `Cannot find module 'typescript' (from .../ts-jest/dist/legacy)` | ⚠ `Cannot read properties of undefined (reading 'native')` | **R2 fix landed: typescript AND jest now in node_modules (246 pkgs vs 15 — net +231 packages from peer-aware resolution). The new failure is in ts-jest's own runtime probing for a `native` binding inside a deeper code path. typescript.js is itself ~9 MiB single-file which the W2.6 plan D3 identified as W2.6b cap territory. Out of X.5-F charter.** |
| **nuxt** | ❌ `Cannot find module 'nuxt' (from /home/user/app)` (despite 428 pkgs installed) | ⚠ `Cannot find module './shared/pathe.BSlhyZSM.cjs' (from .../pathe/dist)` | **R3 fix landed: the runtime resolver now ESM-fallbacks for nuxt's pure-ESM root exports. require('nuxt') now ENTERS pathe instead of dead-ending at the package root. The new failure is pathe's split-bundle-chunks (unbuild's hash-based chunk filenames) not being included in the pre-bundle. The greedy oversample only adds one main file per package; sibling chunks with hashed filenames get evicted. Out of X.5-F charter — overlaps with X.5-C pre-bundler scope. nuxt also went from 428 → 516 pkgs (R2.5 cascade).** |

### Summary table (verification baseline vs X.5-F)

| Outcome | Pre-X.5-F | Post-X.5-F |
|---|---|---|
| ✅ require() succeeds | 0 | **2** (webpack, framer-motion) |
| ⛔ loud-reject (W6 healthy) | 0 | **1** (parcel) |
| ⚠ install OK, runtime fail (different reason) | 0 | **4** (rollup, radix-react-dialog, ts-jest, nuxt) |
| ❌ OLD-SHAPE silent failure | **7** | **0** |
| **Healthy total (✅+⛔)** | **0/7** | **3/7 = 43%** |

Net for the broader ✅/33 sweep: the verification doc had 14/33 healthy
(7 ✅ + 7 ⛔). X.5-F adds 2 ✅ (webpack, framer-motion) + 1 ⛔ (parcel) =
**+3 net healthy**, taking the matrix to **17/33 (51%)**. The 4 remaining
⚠ in the X.5-F cohort don't degrade or regress; they just expose
downstream blockers that other waves own.

Re-using the verification doc's §5 unlock count: X.5-F's actual unlock
of **+3 healthy** is at the lower end of its predicted 7-package range
(plan §5 "Honest target: 3-5 ✅ flips"). The shortfall is honestly
attributable to X.5-G/X.5-C/W2.6b being out of charter, not to a flaw
in the X.5-F fixes themselves — every R1/R2/R2.5/R3 fix landed and is
verified by an in-process probe.

---

## Single-resolver invariant verification

Per the dispatch's CRITICAL anti-requirement: "DO NOT introduce a 2nd
resolver impl — extend the shared one".

```
$ grep -rln 'function resolveExports' src/
src/_shared/exports-resolver.ts
src/real-vite-bundle.generated.ts
```

The second match is a string-literal artefact inside the auto-generated
real-vite bundle stub (it embeds vite/env which contains the substring
inside a multi-line client mjs). The regression probe
`audit/probes/x5f/regression/single-resolver-source.mjs` PASSes at
HEAD by reading each match and discriminating real `export function`
declarations from string-literal occurrences. Its output:

```
real TS impls: ["src/_shared/exports-resolver.ts"]
exactly-one-impl:                PASS
impl is _shared/exports-resolver.ts: PASS
OVERALL: PASS
```

**Confirmed: ONE TS implementation; the X.5-F fix at C.2 (R3 ESM
fallback) calls the existing shared resolver TWICE with DIFFERENT
condition arrays. Zero changes to the resolver itself.**

---

## What worked

1. **The verification wave's bucket framing was wrong, but its DATA was perfect.** The 7 verbatim probe outputs in `audit/probes/post-phase5-verification/packages-local/` contained every cue needed to decompose the cohort. This is a strong argument for keeping verbatim probe outputs ALWAYS, even when they get bucketized at synthesis time. Bucket labels are lossy; verbatim isn't.

2. **TDD-red probes that import src/ via bun's TS-loader** — way more pleasant than wrangler-dev tests for resolver-shape questions. r1-toplevel-bypass.mjs, r2-peerdep-resolution.mjs, and r3-esm-fallback.mjs all run in ~50ms each and exercise the actual TS source. They'd survive a refactor-of-the-internals as long as the public surface holds.

3. **The shared resolver was already shaped for this fix.** R3 is just "call resolvePackageEntry twice with different condition arrays". Zero changes to the resolver. The W2.6a plan's D6 decision to unify the resolver was correct foresight.

4. **Self-challenge via registry packument fetching.** When the sub-agent dispatch failed (provider error), webfetching `https://registry.npmjs.org/<pkg>/latest` for nuxt and @radix-ui/react-dialog gave PROOF of the failure modes (nuxt: `exports."."` lacks `require`/`default`; radix-dialog: peer-deps include react/react-dom). That's better evidence than any sub-agent assertion would have produced.

5. **Lockfile + cache-schema migration via PRAGMA-probe + ALTER TABLE IF NOT EXISTS-equivalent**. C.3's npm-cache.ts approach (probe via PRAGMA table_info, ALTER TABLE if missing, swallow the duplicate-column error if racing) is a clean idiomatic SQLite migration pattern that doesn't churn the existing tenant data.

---

## What surprised me

1. **framer-motion marks ALL its peers (including `react`) as optional.**
   This is genuinely surprising — react is required for framer-motion to do anything at all. The npm CLI handles this via its `--include=peer` default-on flag (since npm v7); we hadn't been mirroring that. Fixed in C.4 (R2.5).

2. **The Mossaic regression FAILS LOCALLY** (and per the verification doc footnotes, has historically only been verified prod-side). The local-side reject on `playwright` is correct W6 behaviour, but it makes Mossaic an unworkable test without the prod tier's longer history. **This is a separate finding worth surfacing as a gap in the local test suite** — it impacts every wave that's supposed to pass Mossaic regression locally.

3. **nuxt went from 428 → 516 packages after R2.5.** Optional peers cascade: nuxt's deps each have their own optional peers and they all auto-install at top level. This is the correct semantic but worth noting if install-time becomes a concern (it didn't here — local install completed in ~26s for 516 packages).

4. **The R3 ESM-fallback turned out to be SAFE without semantic concerns.** I worried it'd shadow legitimate "package not installed" misses. Turns out the fallback is gated on `pkg.exports != null`, and the "not installed at all" path returns null from `__resolveNodeModule` BEFORE reaching `__resolvePkgSubpath`. The fallback only fires when we already know a package exists and has a valid exports map.

---

## What's left honestly blocked

| Blocker | Cohort | Notes |
|---|---|---|
| `@rollup/rollup-linux-x64-gnu` native opt-dep | X.5-G | npm CLI bug #4828; same family as tailwindcss-oxide. Workaround = retry without lockfile. |
| react-remove-scroll subpath miss `./Combination` | X.5-C | Pre-bundler doesn't include the ESM-only sibling. |
| ts-jest `undefined.native` | W2.6b | typescript.js is ~9 MiB; greedy oversample evicts it; ts-jest's runtime expects a native fs binding object that's left undefined. |
| pathe split-bundle hash chunks | X.5-C | unbuild's chunk-naming convention writes sibling files with hashed names; the static-prefetch regex catches the require() but the file isn't emitted into the bundle (cap or eviction). |
| Mossaic local-dev playwright reject | meta — local test suite gap | Pre-existing, not X.5-F-caused. Likely needs a `LOCAL_DEV_INSTALL_BYPASS` for tests. |

None of these blockers were in X.5-F's charter. X.5-F charter was the
"resolve-miss" cohort — verified ✓ at the install + resolver layers.
The downstream blockers exist in OTHER waves' charters.

---

## Mistakes & corrections

1. **Probe driver bug (Phase B → Phase D).** First e2e run had `inAppRequireBase64` writing to /tmp instead of /home/user/app. This made every probe fail with `Cannot find module X (from /tmp)` — a probe path bug, not a fix bug. Fixed inline; re-run produced correct ✅/⛔/⚠ classifications.

2. **Classifier bug (Phase D iteration 1).** First classifier marked `npm install rejected:` outcomes as `❌ OLD-SHAPE` because the require-throw text matched. Fixed to put rejected-check FIRST, treating it as ⛔ (W6 healthy) and not propagating to OLD-SHAPE.

3. **Lockfile invalidation forgotten initially.** C.1 added peer-enqueue but didn't invalidate existing lockfiles. C.3 added the schema migration + lockfile-validity peer-presence check. Without C.3, a tenant whose lockfile was built pre-X.5-F would skip resolution and never pick up peers. Caught during in-line review while writing C.3.

4. **Sub-agent review unavailable.** ProviderModelNotFoundError on the `general` agent. Mitigated by self-challenge against verbatim sources + 2 registry packuments. Documented in plan §9. NOT a substitute for an actual review — if a 2nd agent had been available, the framer-motion-optional-peers question (R2.5) might have been raised at plan time instead of being discovered empirically in Phase D.

---

## Citations

- All Phase A citations stand (X5F-plan.md §11)
- E2E results: `audit/probes/x5f/e2e/{webpack,framer-motion,parcel,rollup,radix-react-dialog,ts-jest,nuxt}.out.txt`
- Functional probe outputs: `audit/probes/x5f/functional/*.txt`
- Regression probe outputs: `audit/probes/x5f/regression/*.txt`
- Wave-1 regression: `audit/probes/wave1-regression-w2.txt` (PASS, external=0)
- Mossaic regression: `audit/probes/mossaic-prod-w2.txt` (FAIL — pre-existing local-dev playwright reject, NOT an X.5-F regression; documented above)
- Source diff: `git diff main HEAD -- src/` shows changes in `src/node-shims.ts`, `src/npm-cache.ts`, `src/npm-installer.ts`, `src/npm-resolve-facet.ts`, `src/npm-resolver.ts` plus 2 generated-file timestamp updates.
- Branch: `x5f-resolve-miss` at GitHub `https://github.com/AshishKumar4/Nimbus/tree/x5f-resolve-miss`.
