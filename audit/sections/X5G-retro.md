# X.5-G Retro — optional-dependencies cohort

> Wave window: 2026-05-05 single-session autonomous run.
> Branch: `x5g-optional-deps`. Base: `main` HEAD `c3d9f47`, then merged
> `x5f-resolve-miss` (which itself branched from `c3d9f47`) at commit
> `2501917` to obtain the post-X5F baseline. All X5G work sits ON TOP
> of X5F.
> Plan: `audit/sections/X5G-plan.md` (committed Phase A).
> Progress: `audit/sessions/X5G-progress.md` (per-phase appended).
>
> **Prompt's done criteria recap:**
> 1. ≥ 2 of 4 packages turn ✅ (be honest if root cause forces ⛔)
> 2. NO src/nimbus-session.ts edits
> 3. All x5g tests green locally + tsc clean + Mossaic regression unchanged
> 4. src/ pushed (or halted-on-grant)
> 5. X5G-progress.md all 6 phases ✓

---

## TL;DR

| Criterion | Result |
|---|---|
| Plan & retro committed | ✓ (X5G-plan.md, this file) |
| ≥ 2 of 4 ✅ flips | **✗ strict** (1 ✅ + 0 ⛔ = 1 healthy of 4) |
| NO src/nimbus-session.ts edits | ✓ verified by `git diff main..HEAD -- src/nimbus-session.ts` (empty) |
| All x5g tests green | ✓ 11/11 functional+regression pass; e2e gated |
| tsc baseline | ✓ unchanged (2 pre-existing errors, no new) |
| Mossaic regression | ✓ unchanged (pre-existing local-dev playwright reject) |
| install-pipeline-coverage | ✓ 4/4 PASS at X5F baseline (re-verified) |
| All 6 phases ✓ | ✓ |
| src/ pushed | ✓ branch `x5g-optional-deps` at HEAD `0955608+` |

**Honest call: only 1 of 4 packages strictly flipped ✅ (rollup, via
the new G2 swap). The other 3 (@radix-ui/react-dialog, ts-jest, nuxt)
have real blockers in DOWNSTREAM cohorts that X.5-G's optional-deps
charter doesn't address (X.5-C pre-bundler subpath miss for the first
two; W2.6b cap eviction for ts-jest). The plan documented this
prediction transparently in §10 before Phase B; the retro confirms it.**

The dispatch's framing ("the 4 packages share root cause: native optional-
deps don't install/resolve cleanly") was PARTIALLY correct: 2 of the 4
truly are optional-deps issues (rollup native shards; nuxt's
@parcel/watcher native shards). The other 2 fail at OTHER layers that
the X5F retro itself classified as different cohorts (X5F-retro.md
line 145-149).

---

## Per-package ❌→✅ flip table

Baseline: post-X5F state (the 4 ⚠ from the X5F flip table).

| Pkg | Pre-X5G state (post-X5F) | Post-X5G | Net |
|---|---|---|---|
| **rollup** | ⚠ `Cannot find module @rollup/rollup-linux-x64-gnu. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828).` | **✅** `npm install rollup` rewrites to `@rollup/wasm-node` via WASM_SWAPS. `require('rollup')` returns the @rollup/wasm-node exports (drop-in identical). | **G2 swap landed end-to-end.** |
| **@radix-ui/react-dialog** | ⚠ `Cannot find module './Combination' (from .../react-remove-scroll/dist/es2015)` | ⚠ unchanged. The X.5-C pre-bundler subpath miss is the runtime blocker. G1 silent-skip applies cleanly to optional-deps (none in this tree); G3 audit confirmed peer-meta-only logic was already correct post-X5F. | **Out of X.5-G charter (X.5-C cohort).** |
| **ts-jest** | ⚠ `Cannot read properties of undefined (reading 'native')` | ⚠ unchanged. The W2.6b cap evicts typescript.js (~9 MiB) from the prefetch bundle; ts-jest's runtime expects a `native` field on a typescript binding object. G3 confirmed the post-X5F R2 logic correctly excludes the peer-meta-only `esbuild` from auto-install. | **Out of X.5-G charter (W2.6b cohort).** |
| **nuxt** | ⚠ `Cannot find module './shared/pathe.BSlhyZSM.cjs' (from .../pathe/dist)` | ⚠ unchanged at the visible runtime. **Hygiene improved**: nuxt's transitive `@parcel/watcher` shards (linux-x64-glibc, etc.) are now silent-skipped via G1 instead of being attempted+failing. The pathe split-bundle blocker (X.5-C) is still the runtime gate. | **Out of X.5-G charter (X.5-C cohort).** |

### Summary table

| Outcome | Pre-X5G (post-X5F) | Post-X5G |
|---|---|---|
| ✅ require() succeeds | 2 (webpack, framer-motion from X5F) | **3** (+ rollup) |
| ⛔ loud-reject (W6 healthy) | 1 (parcel from X5F) | 1 (unchanged) |
| ⚠ install OK, runtime fail | 4 (rollup, radix-react-dialog, ts-jest, nuxt) | 3 (rollup → ✅) |
| ❌ OLD-SHAPE silent failure | 0 | 0 |
| **Healthy total (✅+⛔)** | **3/7 of the X5F cohort = 43%** | **4/7 = 57%** |

Re-using the verification doc's broader sweep (33 packages, 14
healthy at the post-Phase-5 baseline, 17 healthy after X5F): X5G adds
**+1 healthy** (rollup), bringing the matrix to **18/33 (55%)**. Below
the dispatch's ≥2 target — but the +1 is a clean strict ✅, not a ⛔
or a different-shape failure.

---

## Optional-deps semantic matrix — what's now correct

| Source field | npm-spec semantic | Implementation |
|---|---|---|
| `dependencies` | required, always install | unchanged (W2 default) |
| `peerDependencies` (no meta) | required peer, auto-install | X5F R2 |
| `peerDependencies` + `peerDependenciesMeta.X.optional` | optional peer, auto-install at top level (npm v7 default) | X5F R2.5 |
| `peerDependenciesMeta.X` only (NOT in `peerDependencies`) | feature-detect; never auto-install | X5F R2 already correct (`__allPeerDependencies` iterates peerDependencies only) — X5G G3 audit confirmed |
| `optionalDependencies` with `os`/`cpu`/`libc` constraint | platform-skip when host doesn't match | **X5G G1 (new)** |
| `optionalDependencies` with `.node` main | never auto-install in workerd | **X5G G1 (new)** |
| `optionalDependencies` matching native-shard glob (`@rollup/rollup-*`, `@parcel/watcher-*`, `@swc/core-*`, `@next/swc-*`, `@tailwindcss/oxide-*`, `@img/sharp-*`, `@napi-rs/canvas-*`, `@biomejs/cli-*`, `@esbuild/*`) | never auto-install | **X5G G1 (new)** |
| `optionalDependencies` fetch failure | swallow, do not fail parent | **X5G G1 (new) — `classifyInstallError`** |
| Top-level `npm install rollup` | swap to WASM build | **X5G G2 (new) — `rollup → @rollup/wasm-node` in WASM_SWAPS** |

The npm 4828 semantics are now substantively implemented, not just
documented.

---

## Single-resolver invariant verification

```
$ grep -rln 'function resolveExports' src/
src/_shared/exports-resolver.ts
src/real-vite-bundle.generated.ts
```

Same as X5F: one TS impl, one string-literal artifact in a generated
bundle. The X5G regression probe `audit/probes/x5g/regression/
single-resolver-source.mjs` PASSes at HEAD.

X5G touched the resolver wiring (added optional-deps silent-skip in
`resolveTree` + facet body) but did NOT introduce a 2nd impl. The
shared `_shared/exports-resolver.ts` is byte-identical to its X5F
state.

---

## What worked

1. **Self-challenge through registry packuments AGAIN.** Same pattern
   as X5F (sub-agent unavailable in this session — `ProviderModelNotFoundError`
   on the `general` agent). The 4 packuments fetched at plan time
   (rollup, @rollup/wasm-node, @rollup/rollup-linux-x64-gnu, nuxt,
   ts-jest, @radix-ui/react-dialog) were sufficient to pin down each
   package's exact `optionalDependencies` / `peerDependencies` /
   `peerDependenciesMeta` shape. Concrete data > assertions every time.

2. **Merging the X5F baseline as a deliberate Phase A decision.**
   The dispatch said "Main HEAD c3d9f47" — but the X5F retro's flip
   table assumes post-X5F state. Without the merge, X5G would have
   been working against a state where rollup is silently skipped, the
   peer-deps aren't enqueued, etc. — all 4 packages would be in
   OLD-shape ❌. Documenting this in plan §1 + creating the merge
   commit explicitly rather than rebasing made the baseline-shift
   visible and reviewable.

3. **The W6 no-conflict-with-skip probe caught the rollup SKIP/SWAP
   conflict immediately.** When I added `rollup → @rollup/wasm-node`
   to WASM_SWAPS without removing rollup from SKIP_PACKAGES, the W6
   probe failed at `[FAIL] functional/no-conflict-with-skip.mjs`. The
   invariant is exactly right: a name owned by WASM_SWAPS must not be
   in SKIP_PACKAGES because SKIP fires first at line 629 and would
   mask the swap at depth>0. W6 doing the architectural-invariant
   checking saved a partial-correctness landing.

4. **`isOptionalNativeBinding` is a small helper that does a lot.**
   Six conditions (os/cpu/libc/.node/9 known glob prefixes) covering
   all the platform-shard packages we've seen so far. The 2 carve-outs
   (@rollup/wasm-node and the parent-vs-shard distinction) prevent
   over-skip. ~30 LOC. Easy to extend with one more prefix when the
   next native-shard ecosystem appears.

5. **Facet-body symmetry was straightforward.** The X5F branch had
   already established the pattern (versionToResolved mirror for
   peerDeps). Adding `optionalDependencies` + os/cpu/libc to the
   facet's `versionToResolved` plus inlining `isOptionalNativeBindingFacet`
   as a local closure was a 30-line change that made supervisor and
   facet paths converge again.

---

## What surprised me

1. **3 of the 4 ⚠ packages were genuinely out of optional-deps charter.**
   I came in expecting all 4 to share root cause per the dispatch.
   By Phase A's end I'd traced 3 to other cohorts (radix-dialog and
   nuxt to X.5-C pre-bundler; ts-jest to W2.6b cap eviction). The
   plan's honest projection (1 of 4 ✅) held precisely. The dispatch's
   framing ("they share root cause") was partially right at the
   install-hygiene layer (where G1 cleans up 2 of the 4) but wrong at
   the runtime-blocker layer.

2. **The retro's blocker table (X5F-retro.md:145-149) was already
   correct about cohort assignment** — only rollup is X.5-G; the rest
   are X.5-C / W2.6b / meta. I'd planned to verify this claim
   empirically; it held.

3. **G3 was a no-op.** I'd planned `selectAutoInstallPeers` as a new
   helper to fix the ts-jest "auto-installed esbuild via R2.5"
   hypothesis. Reading the X5F R2.5 source carefully showed
   `__allPeerDependencies` iterates `vData.peerDependencies` (not
   `peerDependenciesMeta`) so peer-meta-only entries are NEVER
   auto-installed. The helper was added to the public API for future
   use + invariant probe coverage, but no existing call site needed
   to change. ts-jest's blocker is W2.6b cap, not optional-deps.

4. **Updating cross-cohort probes was unavoidable.** I'd hoped
   `src/`-only changes would leave probes untouched. But adding
   `rollup` to WASM_SWAPS materially changes the shape of swap output
   (`apply-swaps.mjs`, `transitive-swap-decision-rule.mjs`,
   `skip-set-curated.mjs`, `r1-toplevel-bypass.mjs`). 4 cross-cohort
   probes needed the new expectation. This is honestly a healthy
   sign — the W6 invariant tests caught the swap arrival at every
   layer they covered.

5. **rollup.exports IS byte-identical to @rollup/wasm-node.exports.**
   Verified at plan time via two `curl https://registry.npmjs.org/<x>/latest`
   calls. Both ship the same `exports`: `.`, `./loadConfigFile`,
   `./getLogFilter`, `./parseAst`, `./dist/*`, `./package.json`. Same
   `main: dist/rollup.js`. Same `module: dist/es/rollup.js`. The swap
   is genuinely drop-in — users can do `import { rollup } from 'rollup'`
   and not even notice.

---

## What's left honestly blocked

| Blocker | Cohort | Notes |
|---|---|---|
| react-remove-scroll subpath miss `./Combination` | X.5-C | Pre-bundler doesn't include the ESM-only sibling chunk. Same blocker as X5F retro line 146. |
| ts-jest `undefined.native` | W2.6b | typescript.js is ~9 MiB; greedy oversample evicts it; ts-jest's runtime expects a `native` field on a typescript binding object. Same blocker as X5F retro line 147. |
| pathe split-bundle hash chunks | X.5-C | unbuild's chunk-naming convention writes sibling files with hashed names; the static-prefetch regex catches the require() but the file isn't emitted into the bundle. Same blocker as X5F retro line 148. |
| Mossaic local-dev playwright reject | meta | Pre-existing, not X.5-G-caused. Same blocker as X5F retro line 149. |
| W3/W3.5 fs.promises + crypto failures | meta | Pre-existing on x5f baseline. Verified by running the same probes against `x5f-resolve-miss` directly — same failures. NOT caused by X5G. |
| Lockfile not invalidated | nimbus internal | Tenants with pre-X.5-G lockfiles continue using stale resolution until `npm install` something new. Acceptable per plan §6.4 (deliberate scope decision); fresh tenants get the fix immediately. W6.6 follow-up: bump lockfile sentinel. |

None of these are in X.5-G's charter. Recommendation for the next
wave-runner: X.5-H should pick the largest unlock, which is X.5-C
(unblocks 2 of the 4 packages: radix-react-dialog and nuxt). W2.6b
unblocks 1 (ts-jest).

---

## Mistakes & corrections

1. **Initial plan over-stated G3's impact.** The first plan draft
   claimed G3 would flip ts-jest to ✅ by excluding the over-installed
   `esbuild`. Reading the X5F R2.5 source carefully showed the
   exclusion was already there. Plan was rewritten in §4 with a no-op
   verdict; G3 became an audit/regression probe rather than a code
   change. Caught DURING plan writing, not after.

2. **Forgot the SKIP_PACKAGES / WASM_SWAPS conflict.** First C.2
   commit added rollup to WASM_SWAPS but left it in SKIP_PACKAGES.
   `audit/probes/w6/functional/no-conflict-with-skip.mjs` failed
   immediately. C.4 commit removed rollup from SKIP_PACKAGES and the
   preamble mirror; W6 returned to green. Caught by W6 invariants in
   ~5 minutes — the kind of architectural test that pays for itself.

3. **X5F R1 probe regressed when X5G's swap fired.** The X5F
   `r1-toplevel-bypass.mjs` asserts `resolved.has('rollup')`. After
   X5G's swap, `resolved.has('@rollup/wasm-node')` is true but
   `'rollup'` is false — the X5F probe failed. Updated the probe to
   accept either name (or any known swap target), with a small inline
   `SWAP_TARGETS` map. Cross-wave tests must compose with downstream
   changes.

4. **`registryCacheToResolved` not extended.** Per plan §6.4, the
   cache schema (`npm-cache.ts`) is out of charter. Result: cache-hit
   ResolvedPackages have `optionalDependencies = undefined` and skip
   the G1 enqueue. New packument fetches use the new fields. This is
   a partial-coverage gap: tenants with pre-X.5-G cache entries may
   continue attempting native-shard installs from optional deps until
   the packument cache rolls over. Acceptable per scope; W6.6
   follow-up.

5. **Sub-agent review unavailable (again).** Same as X5F. Self-
   challenge via registry packuments + cross-reading the X5F retro at
   each ⚠ entry. NOT a substitute for an actual review — if a 2nd
   agent had been available, the G3 no-op realization might have
   surfaced at plan time instead of mid-Phase-C.

---

## Citations

- All Phase A citations stand (X5G-plan.md §11)
- E2E results: `audit/probes/x5g/e2e/*.mjs` (gated behind
  `NIMBUS_X5G_E2E=1`; require BASE=http://127.0.0.1:8787)
- Functional probe outputs: `audit/probes/x5g/functional/*.mjs`
  (11/11 in `audit/probes/x5g/run-all.txt`)
- Regression probe outputs: `audit/probes/x5g/regression/*.mjs`
- W6 cross-cohort: `audit/probes/w6/run-all.mjs` (ALL pass)
- W6.5 cross-cohort: `audit/probes/w6.5/run-all.mjs` (ALL pass)
- X5F regression: `audit/probes/x5f/run-all.mjs` (7/7 pass)
- Source diff: `git diff main...HEAD -- src/` shows changes in
  `src/wasm-swap-registry.ts` (+184 LOC: 3 helpers + 1 swap entry +
  preamble parity), `src/npm-resolver.ts` (+~85 LOC: ResolvedPackage
  extension + optional-deps tracking), `src/npm-resolve-facet.ts`
  (+~80 LOC: facet symmetry), `src/parallel/npm-resolve-preamble.ts`
  (+5 LOC: preamble swap mirror).
- Branch: `x5g-optional-deps` at GitHub
  `https://github.com/AshishKumar4/Nimbus/tree/x5g-optional-deps`.

---

## Recommendations for X.5-H

1. **X.5-H should be the X.5-C pre-bundler wave** — it's the highest-
   leverage next step. Unblocks 2 of the 4 X.5-G ⚠ packages
   (@radix-ui/react-dialog via react-remove-scroll subpath emit; nuxt
   via pathe hash-chunk emit). Likely scope: extend
   `buildPrefetchBundle`'s greedy oversample to walk SIBLING files
   alongside the regex-detected target (handles unbuild's hashed
   chunk pattern + react-remove-scroll's `./Combination` ESM-only
   sibling).

2. **W2.6b cap eviction** — unblocks ts-jest (and likely others
   touching typescript.js). Scope: either lift the per-file cap from
   ~3 MiB to ~10 MiB for known-large standard-library packages, or
   add a special-case "always include in bundle" list for typescript.

3. **W6.6 npm-alias parsing** — would let bcrypt → bcryptjs,
   argon2 → hash-wasm, sass, grpc-js, swc-wasm-web, all flip from
   REJECT to SWAP. Listed as #1 in W6 retro §5; pre-X.5-G priority.

4. **W6.6 lockfile bump for X.5-G** — invalidate stale tenant
   lockfiles so existing installs benefit from G1+G2 without manual
   re-resolve. ~5 LOC sentinel bump.

5. **X.5-G expansion** — add transitively-relevant native-shard
   prefixes as they appear (`@biomejs/cli-`, `@esbuild/` already
   added). Maintain the carve-out list (`@rollup/wasm-node` is the
   only one today) when the WASM build of a native-shard ecosystem
   ships.

---

*Retro v1, Phase F final.*
