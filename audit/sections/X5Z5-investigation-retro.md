# X5Z5 investigation — retrospective

> Branch: `x5z5-investigation`. Local main HEAD at start: `90993b3`.
> Mode: PLAN-ONLY audit. No src/ edits.

## 1. Outcome — concrete plans vs deferrals

| Pkg | Outcome | Concreteness |
|---|---|---|
| **express** | concrete plan, ~7 LOC, dispatchable post-X.5-NPQO | file:line for both defects, fix verified locally |
| **ts-jest** | concrete plan, ~3 LOC, dispatchable post-X.5-NPQO | file:line, fix verified locally |
| **tailwindcss-vite** | concrete plan, ~2 LOC, **dispatchable now** | file:line, fix verified locally with reproduction tests |
| **tailwindcss-oxide** | concrete plan (REJECT, not flip), ~6 LOC, dispatchable now | file:line, blocker traced to `node:wasi` upstream throw |

**0 deferrals.** All 4 packages got concrete dispatch-ready plans.
The tailwindcss-oxide plan is "REJECT" not "fix" because the
blocker is upstream (workerd's `node:wasi` stub) — that's still a
concrete dispatchable action, just one that improves install-time
honesty rather than runtime ✅ count.

## 2. Surprise findings

### 2.1 The W2.6b cap-eviction hypothesis for ts-jest was wrong

X5F-retro line 147 and X5G-retro line 210 both blamed ts-jest's
failure on the W2.6b cap evicting typescript.js (~9 MiB). The
verbatim runtime stack proves this wrong:

> `at getNodeSystem (eval at <anonymous> (runner.js:34:34), <anonymous>:8291:43)`

If typescript.js were evicted, the failure surface would be
`Cannot read module: .../typescript.js` from `__loadModule` at
`src/node-shims.ts:2129`. Reaching `getNodeSystem` proves
typescript IS loaded. The blocker is the missing `realpathSync`
shim, not the cap.

**Implication for W2.6b ROI:** the W2.6a-retro §5 "skip for now"
verdict still holds, but one of its motivating examples
(typescript drops out of install pipeline → ts-jest dies) was
mis-diagnosed. The actual cap pressure is real (typescript.js
encoded into the bundle is right at 22 MiB), but ts-jest is not
the canary the prior retros claimed.

### 2.2 looksLikeEsm regex has TWO blind spots, not one

I went in expecting a single relaxation (the leading anchor) would
do it. The reproduction script proved that BOTH the leading anchor
`(^|\n)` AND the body `\s+` are blind spots — the no-whitespace
form `import{compile as M}` is the dominant minified output, and
relaxing only the anchor doesn't help because `\s+` still rejects.

The fix is `(^|[\n;}])\s*import[\s{]` — both relaxations together.
A single-relaxation fix would have left the bug half-fixed and
silently failing on a slightly different minified shape.

### 2.3 The probes already existed; the value-add was correlation

verify-90993b3 already had stack-traced runtime probes for all 4
packages (line 70-94 in their respective .out.txt files). The
investigation's value-add was tying each runtime stack to:

- the verbatim file:line in upstream package source
- the verbatim file:line in our shim
- a 5-line reproduction script that throws the same error message

Without that correlation, "express fails at Object.create" is
information; with it, "the call site is readable-stream@2's
util.inherits(Writable, Stream) where Stream resolves to our
namespace object literal at src/streams.ts:380" is **a fix
target**.

## 3. Recommended dispatch order

Final form (also in X5Z5-plan.md §6):

```
Day 0  (parallel — no shared lock)
  ├── X.5-Z5b: tailwindcss-vite   [src/facet-manager.ts]   ~2 LOC
  └── X.5-Z5c: oxide REJECT       [src/wasm-swap-registry.ts]   ~6 LOC

After X.5-NPQO merges
  └── X.5-Z5a: shim-shape gaps    [src/streams.ts + src/node-shims.ts]   ~10 LOC
              (express + ts-jest, bundled — one rebase, two flips)
```

**Bundling rationale:** express and ts-jest both touch
`src/node-shims.ts` (or its sibling `src/streams.ts`), so they
share the X.5-NPQO conflict cost. Splitting them means two
rebases against whatever node-shims.ts shape X.5-NPQO produces.
Bundling means one rebase covers both.

**Healthy delta projection** on verify-90993b3 cohort
(starting from 25/33 cumulative ✅ post-X.5-J/L/M batch, per
VERIFY-90993B3.md §4):

| After | ✅ | ⛔ | Healthy total | % |
|---|---|---|---|---|
| Pre-X5Z5 (current 90993b3) | 25 | 0 (in Z5) | 25 | 76% |
| + X.5-Z5b (tw-vite) | 26 | 0 | 26 | 79% |
| + X.5-Z5c (oxide REJECT) | 26 | 1 | 27 | 82% |
| + X.5-Z5a (express+ts-jest) | 28 | 1 | 29 | **88%** |

The +3 ✅ +1 ⛔ reaches ~88% healthy on a 33-package sweep.
Compared to Bucket-K (rollup native-shard alias-after-swap, also
deferred from prior verifies): same effort tier, similar +1 ✅
delta. X.5-Z5b alone has the best ROI in the entire current
backlog (2 LOC, +1+ ✅).

## 4. Process retro — what worked, what didn't

### What worked

- **Reusing existing probes.** The verify-90993b3 packages-local
  probes were already exact stack traces. Re-running wrangler dev
  would have produced identical output. Reading those, then
  walking the stack to source — much faster path to file:line
  evidence.
- **Standalone reproduction script.** `run-checks.cjs` runs in 100ms,
  reproduces all 4 verbatim error messages with our shim
  semantics. Each fix was verified locally before being written
  into the plan. No "would this actually work?" hand-waving.
- **Disproving prior hypotheses.** The X5F/X5G claim about ts-jest
  + W2.6b was wrong; the verbatim stack shows it. Catching this
  early prevented us from waiting on W2.6b before fixing ts-jest.

### What didn't

- **First pass at the looksLikeEsm fix was incomplete.** I initially
  proposed only the `(^|[\n;}])` anchor relaxation, missed the
  `\s+` issue. The reproduction script caught it (test 6 failed
  on first run). Lesson: write the test BEFORE you write the
  proposed fix; let the test drive the fix.
- **Time spent reading audit history.** ~30 min walking
  W2.6a/X5F/X5G retros for prior context on each Z5 package. In
  retrospect this was warranted (it's how I caught the wrong
  hypothesis), but a "fast-path summary index" of which prior
  retros mentioned each package would have helped.

### Calibration

- Estimated 2-3 hours wall time. Actual ~1.5 hours.
- 4 concrete plans + 1 cross-cutting retro is the upper bound of
  this investigation's scope; bundling the dispatch into 3 waves
  (Day 0 parallel + post-NPQO bundle) is reasonable.

## 5. Anti-pattern check

- **NO src/ commits.** Verified clean — `git diff main..HEAD --
  src/` shows no diff (`bun install` regenerated two .generated.ts
  files which I reverted before commit).
- **NO files outside the worktree.** All outputs in
  `/workspace/worktrees/x5z5-investigation/audit/`.
- **Citations everywhere.** Every claim in X5Z5-plan.md has a
  file:line or probe-output cite.
- **No silent completion.** Progress logged at
  `audit/sessions/X5Z5-investigation-progress.md`.
- **No prod deploy attempt.**

## 6. Push status

```
$ git push origin x5z5-investigation
remote: Access denied: grant not approved
fatal: unable to access 'https://github.com/AshishKumar4/Nimbus.git/': The requested URL returned error: 403
```

Same 403 as the dispatch noted (push grant lapsed). Branch lives
locally at `c3d7e9f` on top of `90993b3`. When the grant is
restored, `git push origin x5z5-investigation` should work
unmodified.

## 7. Recommendations for the next run

1. **Dispatch X.5-Z5b (tailwindcss-vite) immediately.** Lowest
   risk, fastest wave, may surface bonus flips during e2e re-probe.
2. **Dispatch X.5-Z5c (oxide REJECT) in parallel with Z5b.**
   Different file, different surface area. No conflict.
3. **Wait for X.5-NPQO to merge before dispatching X.5-Z5a.** When
   ready, bundle express + ts-jest as one wave; the diffs are
   independent enough that they can be authored separately and
   committed sequentially in one PR.
4. **Re-baseline verify on origin/main before X.5-Z5a.** If
   X.5-NPQO's node-shims.ts rewrite changes anything in the
   express/ts-jest fix landing zones (line 580-638 for fs.* exports,
   line 689-714 for util.*), the plan's line citations need
   updating but not the architecture.
5. **Update W2.6b ROI doc** (W2.6a-retro.md §5). Specifically
   strike "ts-jest's typescript.js" from line 91's example column —
   ts-jest is not in W2.6b scope after this investigation.

## 8. Cross-references

- Plan: `audit/sections/X5Z5-plan.md`
- Per-package probes: `audit/probes/x5z5-investigation/*.probe.md`
- Reproduction script: `audit/probes/x5z5-investigation/run-checks.cjs`
- Reproduction output: `audit/probes/x5z5-investigation/run-checks.out.txt`
- Progress log: `audit/sessions/X5Z5-investigation-progress.md`
- Source bucket: `audit/sections/VERIFY-90993B3.md` §3 Bucket Z5
- Native-binding upstream block: `audit/sections/04-native-mitigation.md` §F1
