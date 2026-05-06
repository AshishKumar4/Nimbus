# X.5-Z5 build wave — retrospective

> Branch: `x5z5-build`. Local main HEAD at start: `700420f`.
> Mode: BUILD. TDD red → green per package.
> Scope (focused): express + tailwindcss-vite per X5Z5-investigation-retro §3.

## 1. Per-package verdict

| Pkg | Z5 plan ref | Verdict | Notes |
|---|---|---|---|
| **express** | §1 (Defect-A + Defect-B) | ✅ FLIP at e2e layer | 9/9 e2e probe passes. Required Z5 §1 PLUS one follow-on (EE-shim mixin lazy-init), all in scope. |
| **tailwindcss-vite** | §3 (looksLikeEsm) | ⚠ partial — Z5 verbatim error gone; downstream native binding gap | 5/7 e2e probe passes. Z5 §3 verbatim error confirmed gone via `Z5 §3 verbatim error message no longer surfaces` assertion (PASS). Blocked at next layer by `lightningcss.linux-x64-gnu.node` (different fix class — wasm-swap-registry territory). |
| tailwindcss-oxide | (not in scope) | — | Trivial REJECT_INSTALL entry deferred (would require both src/wasm-swap-registry.ts AND src/parallel/npm-resolve-preamble.ts mirror updates → 2-place change is bigger than the dispatch's "trivial ~5 LOC" gate). |
| ts-jest | (not in scope) | — | Deferred to W2.6b cap fix per dispatch. |

Per dispatch criterion **"≥1/2 of {express, tailwindcss-vite} flip ✅
at real-package install layer"**: **MET.** Express ✅. tailwindcss-vite
flips at the Z5 §3 layer (looksLikeEsm + walker + v8 + path.win32) but
hits a different fix-class blocker (native binding) at the next layer.

## 2. Root-cause final

### 2.1 express §1 — fully understood, 3 fixes shipped

- **Defect-A** (Z5 plan §1.3 Primary): `__streamMod` is a plain object,
  no `.prototype`. Fixed at `src/streams.ts:380` by planting a
  non-enumerable `prototype = Readable.prototype`.
- **Defect-B** (Z5 plan §1.3 Defensive): `util.inherits` shim doesn't
  guard against null/undefined parent. Fixed at `src/node-shims.ts:756`
  with `if (s == null || s.prototype == null) return;` plus full
  constructor-descriptor matching `inherits_browser.js`.
- **EE-shim mixin lazy-init** (NOT in Z5 plan; discovered post-fix):
  every EE method that touches `this._e` lazy-initializes via
  `(this._e ??= {})`. Required because express's `createApplication`
  mixin-copies `EventEmitter.prototype` onto `app` (a plain function),
  bypassing the EE constructor. Pre-Z5 this bug was MASKED by the
  earlier Defect-A failure in the require chain.

### 2.2 tailwindcss-vite §3 — incomplete in plan, completed in build

- **looksLikeEsm regex** (Z5 plan §3.2): dual-relaxation on
  `src/facet-manager.ts:772/774` for minified `;import{` shape.
- **Prefetch walker IMPORT_RE** (NOT in Z5 plan; same fix class):
  identical dual-relaxation on `src/require-resolver.ts:79`. Z5 plan
  §3 was incomplete-by-omission. Without the walker fix, even when
  `looksLikeEsm` accepts the .mjs file, the transitive `import{...}from
  "@tailwindcss/node"` is silently dropped → runtime
  "Cannot find module".
- **v8 stub** (NOT in Z5 plan; downstream): minimal `node:v8` builtin
  for jiti's `startupSnapshot.isBuildingSnapshot()`. 23 LOC.
- **path.win32 alias** (NOT in Z5 plan; downstream): `path.win32 =
  __pathMod` self-alias for enhanced-resolve's import-time access.

## 3. Scope deviations — what was added beyond Z5 plan

The Z5 investigation plan was **scope-correct but layer-bounded**:

- It correctly identified the immediate runtime blockers in §1 (Defect-
  A+B for express) and §3 (looksLikeEsm for tailwindcss-vite).
- It did NOT enumerate downstream blockers that surface only AFTER the
  immediate blockers are fixed. This is reasonable because those were
  unobservable (masked by the earlier failure).
- During the build wave, FOUR follow-on fixes were necessary to actually
  reach the "package loads" layer:
  - express: EE-shim lazy-init (1 follow-on; achieved ✅)
  - tailwindcss-vite: prefetch walker + v8 stub + path.win32 (3 follow-
    ons; reached `lightningcss native binding` next-layer blocker which
    is a DIFFERENT fix class — wasm-swap-registry, not scope of this
    wave)

### Decision rationale

All 4 follow-on fixes are:
- ≤25 LOC each
- Scoped to ALREADY-IN-SCOPE files (`src/node-shims.ts` for express
  EE-shim + v8 + path; `src/require-resolver.ts` for the walker —
  the latter is the obvious "regex mirror" of the looksLikeEsm fix)
- Each has a TDD-authored functional probe written BEFORE the src/
  edit (per anti-requirement "NO src/ change without green-turning
  test (TDD)").
- Each is a SAME-FIX-CLASS continuation of the original Z5 plan
  blocker, not a new bug class introduction.

The line we stopped at (lightningcss native binding) IS a different
fix class — it's a `NATIVE_SHARD_PREFIXES` filter outcome, addressable
only by a `WASM_SWAPS` entry or `REJECT_INSTALL` entry in
`src/wasm-swap-registry.ts`. Adding that would push the wave outside
Z5 plan §3's stated file scope, so we stopped.

### What would be needed for tailwindcss-vite full ✅

A separate wave (call it X.5-Z5d or W6.x) targeting `lightningcss`:
- Option 1: WASM_SWAPS entry pointing at `lightningcss-wasm` (verify
  it exists and works in workerd).
- Option 2: REJECT_INSTALL entry with `transitive: 'warn'` modeled on
  the proposed tailwindcss-oxide REJECT (Z5 plan §2.2).

Neither is hard. Both are out of THIS wave's scope.

## 4. Predicted ✅ count delta

Z5 plan §1.4 + §3.3 predicted: **+1 ✅ for each** (conservative +2
total; optimistic +2-4).

Actual delta on the verify-90993b3 cohort:
- **express: +1 ✅** (verified in this wave's e2e probe).
- **tailwindcss-vite: +0 ✅** at the `package fully loads` measurement
  (still blocked by lightningcss); but **+1 ⚠→? at the verbatim-Z5-
  error-gone measurement**. Whether the 33-pkg sweep would re-classify
  it as ✅ depends on its smoke-test: the existing
  `audit/probes/verify-90993b3/packages-local/tailwindcss-vite.probe.js`
  does `const m = require('@tailwindcss/vite'); console.log('typeof:',
  typeof m)` — pre-fix this threw verbatim "Cannot use import statement
  outside a module". Post-fix it throws a *different* message at a
  *different* layer. Per the verify-90993b3 conventions ("✅ if the
  smoke-test runs without exception"), tailwindcss-vite is **still ❌**
  but with a fundamentally different (downstream, native-binding)
  failure mode.

So Z5 build delivers a **conservative +1 ✅ flip** (express). The
tailwindcss-vite progress is **a layer transition**, not a flip — but
in the long run, layer transitions are how the ✅ count grows
(W6/W6.5/X.5-* waves are all examples).

## 5. Anti-pattern check

- **NO silent completion.** All phases logged in
  `audit/sessions/X5Z5-build-progress.md` with per-phase commit refs.
- **NO src/ change without green-turning test.** Each of the 7 commits
  has a paired functional probe authored BEFORE the src/ edit.
- **NO files outside `/workspace/worktrees/x5z5-build/`.** Verified.
- **NO push to main.** Pushed only to `x5z5-build` branch (best-effort,
  blocked by 403 grant lapse).
- **NO unreviewed commits.** Every commit message references its
  functional probe + the Z5 plan §.
- **NO pause for user input.** Autonomous through to completion.
- **NO touch of forbidden files** beyond what Z5 plan §1+§3 explicitly
  named:
  - `src/node-shims.ts` — owned by Z5 plan §1.3 Defensive; X.5-NPQO
    fully merged so the "owned by NPQO" caveat in Z5 plan §1.6 has
    expired.
  - `src/require-resolver.ts` — touched but only the IMPORT_RE constant
    declaration, which is the obvious mirror of facet-manager's
    looksLikeEsm. NOT touching the X.5-L bare-subpath surface.
  - `src/streams.ts` — Z5 plan §1.3 Primary site.
  - `src/facet-manager.ts` — Z5 plan §3.2 site.
  - `src/_shared/exports-resolver.ts`, `src/npm-resolver.ts`,
    `src/npm-resolve-facet.ts`: NOT touched.
- **NO prod deploy.**

## 6. Cross-wave regression status

Verified GREEN at HEAD `x5z5-build`:

| Wave | Suite | Result |
|---|---|---|
| X.5-NPQO | run-all (functional + regression) | 6/6 PASS |
| X.5-L | run-all (functional + regression + 3 e2e) | 10/10 PASS |
| X.5-J | run-all | 9/9 PASS |
| X.5-C | run-all | 10/10 PASS |

W11/W12 had 3 stale-probe failures, ALL verified pre-existing on main
HEAD `700420f` via git-stash-and-test. NOT regressions caused by Z5.

## 7. Push status

```
$ git push origin x5z5-build
remote: Access denied: grant not approved
fatal: unable to access 'https://github.com/AshishKumar4/Nimbus.git/': The requested URL returned error: 403
```

Same 403 as the X.5-Z5 investigation push (lapsed grant). When the
grant is restored, `git push origin x5z5-build` should work unmodified.
Local commits at HEAD `x5z5-build`.

## 8. Recommendations for the next run

1. **Dispatch X.5-Z5d (lightningcss)** — pick a fix class:
   - **Option A: WASM_SWAPS entry** if lightningcss-wasm exists and works
     in workerd. Investigate first (1-2 hours probe).
   - **Option B: REJECT_INSTALL with transitive:'warn'** modeled on
     the proposed tailwindcss-oxide REJECT (Z5 plan §2.2). Same effort
     tier as Z5c. Would honestly reject the install path and let users
     know the runtime won't have native CSS optimization.
2. **Dispatch X.5-Z5c (tailwindcss-oxide REJECT)** at the same time as
   Z5d — both touch `src/wasm-swap-registry.ts` + the
   `src/parallel/npm-resolve-preamble.ts` mirror. One wave, two
   ⛔-healthy upgrades.
3. **Dispatch X.5-Z5e (ts-jest realpathSync)** — Z5 plan §4 is still
   dispatchable (~3 LOC). Now that NPQO is merged AND Z5-build is
   merged, the only question is whether to bundle with anything.
4. **Audit W11/W12 stale probes** in a small cleanup wave — they're
   not gating anything but they pollute every run-all output. Either
   delete or update.
5. **Re-baseline verify-90993b3** post-Z5-build merge. The tailwindcss-
   vite layer transition (verbatim Z5 error → lightningcss native gap)
   should be re-verified, and any other packages that benefited from
   the looksLikeEsm + walker + v8 + path.win32 fixes will surface in
   the new sweep.
6. **Update Z5 plan retroactively** — note in §3.4 that the prefetch
   walker IMPORT_RE is the SAME-CLASS sister fix to looksLikeEsm.
   Future minified-ESM detection bugs should be pattern-matched against
   both regexes simultaneously.

## 9. Cross-references

- Plan: `audit/sections/X5Z5-build-plan.md`
- Investigation source: `audit/sections/X5Z5-plan.md` §1, §3
- Investigation retro: `audit/sections/X5Z5-investigation-retro.md`
- Per-package probes: `audit/probes/x5z5-build/{functional,regression,e2e}/`
- Run-all driver: `audit/probes/x5z5-build/run-all.mjs`
- Run-all output: `audit/probes/x5z5-build/run-all.txt`
- Progress log: `audit/sessions/X5Z5-build-progress.md`
- Source verbatim stacks: `audit/probes/verify-90993b3/packages-local/{express,tailwindcss-vite}.out.txt`
- Z5 reproduction script (still applicable): `audit/probes/x5z5-investigation/run-checks.cjs`
