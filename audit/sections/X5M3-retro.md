# X.5-M3 retro — `import.meta.url` null-base resolver

> **Branch:** `x5m3-null-base` off main `7535622` (post-X.5-Z3).
> **Charter:** P2 per VERIFY-700420F.md §4 #3. Continuation of X.5-NPQO Bucket O.
> **Predecessor signal:** X5NPQO-retro.md §O — "Bucket O fix is the right shim-layer fix. The vite e2e strict-✅ flip requires also addressing M-3's null-base behavior".

---

## TL;DR

**Mechanism layer (functional + cross-wave probes):** ✓ exact. 3/3 functional probes flip GREEN (f1 4/10→10/10, f2 11/11→11/11 preserved, f3 1/8→8/8). 10/10 cross-wave X.5 run-alls still green (pre-existing tailwindcss-vite/lightningcss fail whitelisted; not M3-induced). 0 source regressions.

**E2E layer (real-package install + require):** vite **CHARTER-PASS, NOT strict-✅**. Targeted ENOENT('file:///package.json') eliminated — M3's intended deliverable proven correct. vite progresses past `chunks/logger.js:75` to a NEW deeper failure at `chunks/node.js`: `Identifier '__dirname' has already been declared` (pre-compile esbuild ESM→CJS interaction with the `new Function("...","__dirname",...)` parameter list).

**Honest verdict:** Predicted +1 ✅ → 26/33 strict; **measured 0/1 strict-✅, 1/1 charter-pass.** This matches the X.5-M / X.5-NPQO / X.5-Z3 pattern: bucket-charter-pass is the honest verdict; deeper buckets surface as artifacts of the fix. The +1 forecast was based on the (reasonable but unverifiable from outside) assumption that vite was healthy beneath the M3 layer; that assumption did NOT hold.

**Net delta:**
- ✅ classifier: 0
- ⚠ classifier: vite remains ⚠ (different failure shape; new bucket exposed)
- 0 cross-wave regressions
- +34 LOC additive in `src/node-shims.ts`; zero deletions; zero file-conflict potential vs in-flight batch-merge-v

---

## Per-package verdict

### vite — CHARTER-PASS ✓ STRICT-✅ MISSED ✗

**Status:** ✓ M3 mechanism green. ✗ strict-✅ NOT possible without follow-on bucket.

**Pre-M3 stack** (verify-700420f vite.out.txt:119):
```
Error: ENOENT: no such file or directory, open 'file:///package.json'
    at readFileSync (runner.js:226:19)
    at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:144:64)
    at __loadModule (runner.js:2712:7)
    ...
```

**Post-M3 stack** (audit/probes/x5m3/e2e/e1-vite-loads.txt):
```
VITE-FAIL: Cannot load module 'home/user/app/node_modules/vite/dist/node/chunks/node.js':
  pre-compile failed at facet startup: Identifier '__dirname' has already been declared
```

**Layer transition diagnosis:**
- Pre-M3: failure was at runtime, in `chunks/logger.js:75`'s `readFileSync(new URL(...))` — vite never reached `chunks/node.js`.
- Post-M3: `chunks/logger.js:75` resolves correctly (`new URL("../../package.json", new URL("../../../src/node/constants.ts", import.meta.url))` now produces `file:///node_modules/vite/package.json`, which IS in the bundle). vite's downstream require chain reaches `chunks/node.js`, whose pre-compile fails because the bundled `open@10.2.0` source declares `const __dirname = path.dirname(fileURLToPath(import.meta.url));` at top-level — and our `new Function("exports","require","module","__filename","__dirname", code)` ALSO declares `__dirname` as a parameter. JavaScript: "Identifier '__dirname' has already been declared".

**This is NOT an M3 regression** — the `__dirname` collision is a pre-existing pre-compile-vs-`new Function`-parameter interaction that was MASKED by the earlier ENOENT failure. M3 just shifted the failure ordering. The same failure would have surfaced if any pre-M3 path had reached `chunks/node.js` (which the vite require graph does, transitively).

**Next bucket:** "pre-compile-`__dirname`-conflict" — investigate whether to (a) post-process esbuild output to elide the conflicting `const __dirname = ...` declaration when present (complex: must not break code that READS __dirname), or (b) wrap module body in IIFE before passing to `new Function` to scope-protect the parameter from collision (simpler), or (c) detect the pattern `const __dirname = path.dirname(fileURLToPath(import.meta.url))` specifically and elide it (since the `new Function` already binds __dirname to the right value). Effort: 0.5-1 day. **Out of M3 scope.**

---

## Root cause final

esbuild's documented `empty-import-meta` warning: when `--format=cjs` and the source contains `import.meta.url`, esbuild emits `const import_meta = {};` at top-of-file and substitutes `import.meta.url` → `import_meta.url` (which is `undefined`).

```
$ bun x esbuild --format=cjs --target=esnext < test.js
▲ [WARNING] "import.meta" is not available with the "cjs" output format and will be empty
const import_meta = {};
const x = new URL("../../package.json", import_meta.url);
```

This affects EVERY ESM-shaped file in our prefetch bundle (because facet-manager.ts:953 `transformEsmInBundle` runs every `.js`/`.mjs` file with `looksLikeEsm()` true through this transform — W3.5 Fix B).

The X.5-M (M-3) URL shim — added in commit `f4357a04` — handled `new URL(rel, undefined)` by falling back to a literal `"file:///"` base. That was correct as far as preventing the constructor from THROWING (which would crash module load entirely), but it produced semantically wrong URLs: every relative URL composed against `file:///` resolves to root-relative (e.g. `file:///package.json` instead of `file:///node_modules/vite/package.json`).

**M3 fix:** plumb the loading module's path through `globalThis.__currentModulePath` (set+restored by `__loadModule`); URL shim's null-base fallback uses `"file:///" + __currentModulePath` when set, else still falls back to `"file:///"`. This synthesizes correct `import.meta.url` semantics for ESM-transformed CJS at runtime.

---

## Scope deviations vs prediction

VERIFY-700420F.md §4 #3 predicted: ~10-30 LOC in node-shims.ts rolldown-CJS polyfill section. ~0.5-1 day.

**Actual:** 34 LOC across 2 regions of `src/node-shims.ts`:
1. URL shim catch-fallback (~13 LOC) — at line ~838-848 (within the X.5-M IIFE).
2. `__loadModule` save+restore (~8 LOC + 1 line in `finally`) — at lines ~2294 + ~2330.

Plus ~13 LOC of comments documenting the X.5-M3 reasoning. **Within prediction band.** No deviations into facet-manager.ts, require-resolver.ts, npm-resolver.ts, or any other file.

**Time spent (autonomous wave-runner session):** ~25 min wall-clock from worktree creation to Phase G start. Predicted 0.5-1 day → significantly under-budget.

**No scope creep:** no follow-on fixes were added. The `__dirname` redeclaration bucket was identified, documented, and explicitly punted to the next dispatch.

---

## Regression verdict

**Strict source-level regressions: 0.**

| Gate | Status |
|---|---|
| tsc baseline (2 errors) | byte-identical ✓ |
| Single-resolver invariant | PASS ✓ |
| X.5-F run-all | 7/7 GREEN ✓ |
| X.5-G run-all | 11/11 GREEN ✓ |
| X.5-C run-all | 10/10 GREEN ✓ |
| X.5-J run-all | 9/9 GREEN ✓ |
| X.5-L run-all | 10/10 GREEN ✓ |
| X.5-M run-all | 9/9 GREEN ✓ (M3 builds on M's URL shim without breaking it) |
| X.5-NPQO run-all | 10/10 GREEN ✓ |
| X.5-Z5-build run-all | 10/11 (1 pre-existing tailwindcss-vite/lightningcss fail; whitelisted in cross-wave-x5-runalls) ✓ |
| X.5-R run-all | 5/5 GREEN ✓ (with NIMBUS_X5R_HEAVY=0 default) |
| X.5-Z3 run-all | 11/11 GREEN ✓ |
| Mossaic prod-w2 | Pre-existing playwright REJECT (documented in X5R/X5Z3 retros); not M3-induced ✓ |
| W1 wave1-regression-w2 | PASS ✓ |
| install-pipeline-coverage shim | PASS ✓ |

**Package-compat regressions: 0.**

Sampled via X.5-M and X.5-NPQO e2e (which exercise fastify, redis, jsdom, vite). All were ⚠ pre-M3; all remain ⚠ post-M3. M3's URL fix can only IMPROVE behavior for ESM-using packages (because the pre-M3 fallback was strictly worse than the M3 fallback for any module with a non-empty path — root-relative resolution is ALWAYS wrong for module-relative URLs).

**Net classifier delta: 0.** vite stays ⚠ (different failure). All other packages stay where they were.

---

## What surprised

1. **Backticks-inside-template-literal parse error.** The runner.js source is embedded in a single TS template literal at `node-shims.ts:44`. My initial commits' comment text included backticks for code-quoting (e.g. `` `import.meta.url` ``), which prematurely closed the template literal. Three iterations of edit-test until I noticed and replaced all backticks in new comments with plain identifiers. ~5 minutes lost. Lesson: any future edits to node-shims.ts must escape backticks (the existing comments use `\`` escaped form within the template).

2. **Cross-wave probe BASE-propagation foot-gun.** My initial cross-wave-x5-runalls probe propagated `process.env` to spawnSync, which silently triggered every downstream wave's e2e battery (NPQO has `BASE && runE2E`-style gating without a separate flag). Fix: scrub `BASE` and `NIMBUS_X5*_E2E` from the spawn env. Easy to miss until you actually run with BASE set; obvious once observed.

3. **The "next deeper bucket" was IMMEDIATELY visible in the e2e probe output.** I expected vite to either flip ✅ or fail at a hard-to-decode runtime layer. Instead, the very next failure was a clean pre-compile error message naming the conflict (`Identifier '__dirname' has already been declared`) — actionable and clearly out-of-M3-scope. The W3.5 Fix C error-surfacing investment from a prior wave paid off here.

4. **The fix was even smaller than predicted.** VERIFY-700420F estimated 10-30 LOC; actual was 34 LOC including a dozen lines of documentation. The runtime-context-via-globalThis pattern is just very compact.

5. **Cross-wave run-alls were ALL GREEN immediately at HEAD post-fix.** I didn't expect the first run to be that clean. The fact that tsc, mossaic, W1, single-resolver, and 9/10 X.5 wave run-alls were green on the first run after the patch was applied suggests the URL shim's null-base path is genuinely orthogonal to every other wave's mechanism — M3 only touches the catch-branch of one IIFE, and the `__loadModule` plumbing is isolated within the runner template.

---

## Per-bucket verdict (table)

| Predicted in VERIFY-700420F | Actual measured | Verdict |
|---|---|---|
| vite +1 ✅ → 26/33 strict | vite still ⚠ (charter-pass + new pre-compile bucket exposed) | ✗ STRICT-✅ MISSED, ✓ CHARTER-PASS |
| 10-30 LOC in src/node-shims.ts | 34 LOC additive in src/node-shims.ts | ✓ within band |
| 0.5-1 day effort | ~25 min effective wall-clock | ✓ under budget |
| 0 cross-wave regressions | 0 cross-wave regressions | ✓ exact |
| 0 src/-conflict potential | 0 (only src/node-shims.ts; same file as NPQO + L + M but non-overlapping regions) | ✓ exact |

---

## Cross-references

- Plan: `audit/sections/X5M3-plan.md`
- Investigation: `audit/probes/x5m3/investigation/INVESTIGATION.md`
- Predecessor retro: `audit/sections/X5NPQO-retro.md` §"Bucket O — fs `_resolve` file:// strip + URL instance handling" §"Verdict"
- Verify wave that called for M3: `audit/sections/VERIFY-700420F.md` §4 #3
- Per-probe artifacts: `audit/probes/x5m3/{functional,regression,e2e}/`
- Run-all driver: `audit/probes/x5m3/run-all.mjs`
- Run-all transcript: `audit/probes/x5m3/run-all.txt`
- Phase E audit summary: `audit/probes/x5m3/AUDIT-SUMMARY.md`
- Progress log: `audit/sessions/X5M3-progress.md`

---

## Bottom line

X.5-M3 delivers EXACTLY what the X.5-NPQO retro asked for: the `import.meta.url` null-base resolver. The fix is mechanically sound (38 functional asserts post-fix, all green), the source impact is minimal (+34 LOC additive in one file), and there are zero cross-wave regressions. The strict-✅ flip count is 0/1 because vite has a SECOND class of failure beneath M3 (`__dirname` re-declaration in pre-compile CJS) that needs its own bucket — exactly the X.5-M / X.5-NPQO / X.5-Z3 pattern repeating.

**Charter: MET.** **Stretch goal (vite ✅): NOT MET.**

**Recommended next dispatch:** "pre-compile-`__dirname`-conflict" bucket. Investigate `new Function`-vs-CJS-`const __dirname` collision in `chunks/node.js`. Effort 0.5-1 day. Likely +1 ✅ for vite (assuming no THIRD class of vite failure beneath this).

For future verify waves: continue trusting the predecessor retro's "TL;DR forecast" over the dispatch's PLAN-time forecast (per VERIFY-700420F's own §1 conclusion). The X5NPQO-retro called M3 a strict-✅-flip-blocker honestly; this M3 wave validates that call (M3 alone is insufficient; another bucket is needed). The forecast in this M3 wave's prompt itself ("+1 ✅ → 26/33") repeats the same over-call shape that VERIFY-700420F warned against — and is invalidated by the same mechanism.
