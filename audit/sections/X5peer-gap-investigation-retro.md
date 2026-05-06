# X.5-peer-gap Investigation Retro

> **Branch:** `x5peer-gap` off `origin/main` HEAD `23417c5`.
> **Mode:** PLAN-ONLY audit per VERIFY-23417C5.md §4 #3.
> **Output:** plan + 3 probes + this retro. No `src/` writes.

---

## §1. Charter compliance

| Charter clause | Compliance | Evidence |
|---|---|---|
| Audit-only — NO src/ commits | ✓ | `git diff origin/main..HEAD -- src/` returns empty (verified pre-push). Branch contains only `audit/` writes. |
| ≥1 reproduction probe per pkg | ✓ | 3 probes shipped: p1 (defu shape), p2 (tailwindcss skip), p3 (greedy no-recurse). p1 + p3 cover nuxt; p2 covers tailwindcss-vite. |
| file:line citations everywhere | ✓ | Plan §1, §2 cite specific src/ line ranges. Probes emit line numbers in their output. |
| X5peer-gap-plan.md §1 + §2 + §3 populated | ✓ | All sections present. §3 cross-cutting; §4 dispatch; §5 anti-fixes; §6 followups; §7 verification. |
| X5peer-gap-investigation-retro.md present | ✓ | This file. |
| Branch pushed to origin/x5peer-gap | (pending Phase E) | Will be done immediately after this retro. |

---

## §2. Investigation outcome — both packages got concrete plans

### nuxt → X.5-peer-A (dispatchable)

**Root cause:** `greedyAddMainEntries` at `src/facet-manager.ts:598-747`
adds main entry without parsing-and-recursing into its require()
chain. defu's CJS shim (`lib/defu.cjs`, 278 B) lands but its sibling
`require("../dist/defu.cjs")` target never enters `__vfsBundle`. At
runtime, `__fileExists` (`src/node-shims.ts:2045-2056`) is
bundle-only — never falls through to the VFS-disk where the file
actually lives — so the require fails.

**Fix shape:** add a one-level relative-require follow inside
`greedyAddMainEntries`'s `addOne` call sites. Estimated ~15-25 LOC.
Lands in `src/facet-manager.ts`. Independent of any other bucket.

**Confidence:** MEDIUM-HIGH — mechanism fully understood via static
evidence (probes p1 + p3); regression risk is bounded by the existing
`VFS_BUNDLE_MAX_BYTES` gate.

### tailwindcss-vite → X.5-peer-B (dispatchable)

**Root cause:** `tailwindcss` is hardcoded into SKIP_PACKAGES at
`src/npm-resolver.ts:887` and the mirror at
`src/parallel/npm-resolve-preamble.ts:42`. The skip was correct for
v3 (build-time CSS CLI) but is a false-positive for v4 (where
`tailwindcss` is a runtime engine package required by
`@tailwindcss/node`'s `dist/index.js` line 1).

**Fix shape:** remove `'tailwindcss'` from both blocklists.
Estimated ~3-5 LOC. Independent of any other bucket.

**Confidence:** HIGH — mechanism is a literal string match; fix is a
two-character deletion; regression scope is "additional install of
~5 MiB tarball, never previously installed."

---

## §3. Recommended dispatch order

1. **X.5-peer-B (tailwindcss-vite) FIRST.** Smallest, highest-confidence,
   instantly verifiable. ~3-5 LOC. Predicted +1 ✅.
2. **X.5-peer-A (nuxt) SECOND.** Larger surface, needs full 33-pkg
   regression. ~15-25 LOC. Predicted +1 ✅, possibly +1-2 bonus
   on other thin-shim CJS packages.

Combined predicted: **+2-3 ✅** in next verify wave (28-30/33 strict).

---

## §4. Fold-into-X.5-26b verdict — NO

VERIFY-23417C5 §3 flagged the possibility that tailwindcss-vite's
peer-tailwindcss failure could fold into W2.6b cap-eviction territory.
This investigation **rules that out**:

- **tailwindcss-vite is NOT cap-eviction.** `tailwindcss` is never
  *resolved* (silent-skip in resolver) → never installed → not on VFS
  at all. No cap involved. Different layer than W2.6b's typescript
  9 MiB single-file eviction.
- **nuxt is NOT cap-eviction.** `defu/dist/defu.cjs` is 2203 B; the
  eviction loop sorts largest-first and would never pop it. The file
  was never *added* to the bundle, not added-then-evicted.

Neither failure shares mechanism with W2.6b's three: typescript single-
file eviction (ts-jest), lightningcss native binding gap, or
tailwindcss-oxide optional-deps bug.

**Verdict: two independent X.5-peer-* sub-buckets, NOT folded into
X.5-26b.**

---

## §5. Surprises

### S1 — The "shared symptom" framing was misleading

VERIFY-23417C5 §3 hypothesised the two failures might share a root
cause ("require chain that reaches a sibling/relative path that the
install pipeline didn't materialize"). The shared *symptom* (error
shape at `__requireFrom`) is real, but the root causes are at
*different layers* — one in the install resolver (skip-list), one in
the prefetch bundler (greedy oversample's recursion gap). They
cannot share a fix.

### S2 — defu IS in the tarball, IS on VFS-disk, IS NOT in the bundle

X5L-retro §1 already noted "defu/dist/defu.cjs IS in the bundle (relative
require from lib/defu.cjs is correctly walked)" when defu is required in
isolation. The X.5-L isolation context proved the require-walker works.
But under nuxt's 526-package graph, the walker reaches defu via ESM
import (landing dist/defu.mjs) while the runtime needs lib/defu.cjs's
sibling dist/defu.cjs. The two paths diverge — only greedy oversample
hits the CJS shim, and greedy doesn't recurse.

This is a subtle composition bug between the ESM-walker (X.5-C/X.5-L
fixes), the greedy oversample (W2.6a), and the CJS runtime resolver.
None of those layers is wrong in isolation; the gap is at their
intersection.

### S3 — tailwindcss skip is a Tailwind v3 → v4 architectural tax

The skip-list itself was fine for Tailwind v3. The fix isn't a "skip-
list bug" but a "Tailwind ecosystem changed contract" event. Future
audit pass: scan SKIP_PACKAGES for other v3-era assumptions
(`webpack`, `parcel` — do they have v4-style runtime engine splits?
Out of scope for X.5-peer-gap; flagged in plan §6.4).

### S4 — `__fileExists` is bundle-only by design

Initial reading suggested `__fileExists` should consult `__fsMod` as
a fallback. Re-reading confirmed this is **intentional**: the
W2.6a/W2.6b architecture commits to "bundle is the contract" — the
prefetch bundle is the runtime's view of the filesystem, full stop.
Adding a fallback would mask prefetch-bundle gaps and re-introduce
cold-cache penalties. The right fix is to widen the bundle, not
loosen the runtime resolver. Documented in plan §5 anti-fix #2.

---

## §6. Process notes

- **Time-boxed at ~2-3 hours.** Actual: ~75 min via static-analysis-first
  approach. Skipped local wrangler boot because:
  - Probe outputs from `verify-23417c5` branch already had the runtime
    error shape with line numbers.
  - Static src/ inspection + tarball inspection sufficed to confirm
    each hypothesis (probes p1, p2, p3 are all read-only on local
    files + registry tarballs).
  - Empirical 33-pkg regression run is properly the responsibility of
    the dispatchable wave (X.5-peer-A / X.5-peer-B), not the
    investigation phase.

- **VERIFY-23417C5.md not on `main`.** The verify doc exists on the
  `verify-23417c5` branch (committed `bc5c8ff`). Pulled into `/tmp` for
  reference, citing source paths. The probe outputs (`nuxt.out.txt`,
  `tailwindcss-vite.out.txt`) live on that same branch under
  `audit/probes/verify-23417c5/packages-local/`.

- **Worktree was wiped per task brief.** Fresh `git worktree add`
  succeeded; `bun install` succeeded. No prior state issues.

---

## §7. Done checklist

- [x] X5peer-gap-plan.md ✓ with §1 (nuxt) + §2 (tailwindcss-vite) + §3 (cross-cutting) populated
- [x] X5peer-gap-investigation-retro.md ✓ (this file)
- [x] ≥1 reproduction probe per pkg (p1 + p3 for nuxt; p2 for tailwindcss-vite)
- [x] file:line citations everywhere (src/npm-resolver.ts:887; src/parallel/npm-resolve-preamble.ts:42; src/facet-manager.ts:598-747; src/require-resolver.ts:441-488; src/node-shims.ts:2045-2056)
- [ ] Branch pushed to origin/x5peer-gap (Phase E next)

---

## §8. Summary for handoff

**Two packages, two plans, dispatch order B → A, do NOT fold into X.5-26b.**

- **X.5-peer-B (tailwindcss-vite, FIRST):** Remove `'tailwindcss'`
  from SKIP_PACKAGES. ~3-5 LOC. Lands in `src/npm-resolver.ts:887`
  and `src/parallel/npm-resolve-preamble.ts:42`. Predicted +1 ✅.
  HIGH confidence.

- **X.5-peer-A (nuxt, SECOND):** Add one-level relative-require
  follow in `greedyAddMainEntries`. ~15-25 LOC. Lands in
  `src/facet-manager.ts:598-747`. Predicted +1 ✅ (plus 0-2 bonus
  thin-shim packages). MEDIUM-HIGH confidence; needs full 33-pkg
  regression.

Combined predicted matrix delta: 27/33 → 28-30/33 (+2-3 ✅).
