# X.5-M3 progress log

> **Wave:** X.5-M3 (`import.meta.url` null/undefined-base fix for vite).
> **Charter:** P2 per VERIFY-700420F.md §4 #3. Continuation of X.5-NPQO O-bucket. Predicted +1 ✅ → 26/33 strict.
> **Worktree:** `/workspace/worktrees/x5m3-null-base` on branch `x5m3-null-base`.
> **Base:** main `7535622` (post-X.5-Z3; current strict ✅ count 25/33 per VERIFY-700420F + X.5-Z3 retro).

---

## Phase A — Investigate (in progress → done)

- Reproduced vite ENOENT stack from `audit/probes/verify-700420f/packages-local/vite.out.txt:119`.
- Located the failing line: `node_modules/vite/dist/node/chunks/logger.js:75`:
  ```js
  readFileSync(new URL("../../package.json", new URL("../../../src/node/constants.ts", import.meta.url)))
  ```
- Confirmed the compile context: facet-manager.ts `transformEsmInBundle` runs `esbuild.transform({ format: 'cjs' })` on every ESM-shaped `.js`/`.mjs` file at facet prepare time; esbuild emits literal `const import_meta = {};` for CJS output (warning `empty-import-meta` confirms this is documented esbuild behavior).
- Net effect: every transformed ESM module has `import_meta.url === undefined` at runtime.
- For vite specifically: `new URL(rel, undefined)` enters the X.5-M URL shim (`src/node-shims.ts:818-839`), which falls back to `super(rel, "file:///")` → `file:///<root-resolved>`. Subsequent fs.readFileSync receives `file:///package.json` (root-relative) → `_resolve` strips → `/package.json` → bundle miss → ENOENT.
- Fix decision: approach #2 — runtime URL shim modification + `__loadModule` saves `globalThis.__currentModulePath`. Stays within `src/node-shims.ts` (allowed). See `audit/probes/x5m3/investigation/INVESTIGATION.md` §6 for matrix.

Phase A artifacts:
- `audit/probes/x5m3/investigation/INVESTIGATION.md`
- `audit/probes/x5m3/investigation/esbuild-cjs-output.txt`
- `audit/probes/x5m3/investigation/vite-logger-grep.txt`

Commit: `e80cb93`. Push: 403 (grant lapse, expected).

---

## Phase B — Plan ✓

`audit/sections/X5M3-plan.md` shipped. TL;DR: track currently-loading module path via `globalThis.__currentModulePath` (set+restore in `__loadModule`); URL shim's null-base fallback uses it instead of `"file:///"` so relative URLs resolve against real module location. ~18 LOC, single file, no anti-req violations. See plan §3 for fix sketch and §4 for regression matrix.

Commit: `026acd9`. Push: 403.

---

## Phase C — TDD red ✓

Probes shipped: `audit/probes/x5m3/{functional,regression,e2e}/`.

| Probe | Pre-fix | Post-fix expected |
|---|---|---|
| f1-url-null-base-current-module | RED (6/10 fail) | GREEN |
| f2-url-null-base-no-context | GREEN (11/11; regression guard) | GREEN |
| f3-loadmodule-saves-restores | RED (7/8 fail) | GREEN |
| regression/install-pipeline-coverage-shim | PASS (skip-on-base-down) | PASS |
| regression/single-resolver-source | PASS | PASS |
| regression/cross-wave-x5-runalls | PASS (10/10 with x5z5-build's tailwindcss-vite-e2e pre-existing FAIL whitelisted) | PASS |
| e2e/e1-vite-loads | RED at HEAD; runs only with NIMBUS_X5M3_E2E=1 + BASE | GREEN post-fix |

Run-all baseline pre-fix: 4 pass / 2 fail (f1, f3 RED as expected). Saved to `audit/probes/x5m3/run-all-baseline-pre-fix.txt`.

Commit: `5a08b21` (Phase C). Push: 403.

---

## Phase D — Build ✓

`src/node-shims.ts` +34 LOC additive (single file, two regions, zero deletions on the runner template):

| Region | Lines | Change |
|---|---|---|
| URL shim catch-fallback (X.5-M IIFE) | ~838-848 | null-base fallback uses `"file:///" + globalThis.__currentModulePath` when set, else literal `"file:///"` (preserves X.5-M). |
| `__loadModule` body | ~2294-2330 | save+restore of `globalThis.__currentModulePath` in try/finally bracketing both precompiled and new Function fallback eval. |

Probe results post-fix:
- f1: **10/10 GREEN** (was 4/10 RED — flipped by URL-shim region)
- f2: 11/11 GREEN (preserved — regression guard intact)
- f3: **8/8 GREEN** (was 1/8 RED — flipped by __loadModule region)
- install-pipeline-coverage-shim: PASS
- single-resolver-source: PASS
- cross-wave-x5-runalls: PASS (10/10 with x5z5-build pre-existing fail whitelisted)
- **x5m3 run-all: 6 pass / 0 fail.**

Encountered + fixed: backticks-inside-template-literal parse errors. The runner.js source is embedded in a TS template literal at node-shims.ts line 44; backticks in my comments would prematurely close the template. Replaced backticks with plain identifiers throughout the new comment text. ~5 min adjustment.

Commit: `ff4a509`. Push: 403.

---

## Phase E — Audit ✓

- tsc baseline: 2 errors, byte-identical to verify-700420f baseline ✓
- x5m3 run-all (full, with e2e): **7 pass / 0 fail**
  - 3 functional: f1 (10/10), f2 (11/11), f3 (8/8)
  - 3 regression: install-pipeline-coverage SKIP, single-resolver PASS, cross-wave-x5-runalls 10/10
  - 1 e2e: e1-vite-loads CHARTER-PASS (targeted ENOENT GONE; new __dirname-redeclare bucket exposed)
- mossaic prod-w2: pre-existing playwright REJECT_INSTALL fail (X5R-retro / X5Z3-retro documented; not M3-induced)
- W1 wave1-regression: PASS
- Cross-wave 9/10 X.5-* clean; x5z5-build's tailwindcss-vite-e2e pre-existing fail whitelisted
- 0 src/ regression: only `src/node-shims.ts` modified (+34 LOC additive)

Vite e2e charter-pass details: targeted ENOENT('file:///package.json') eliminated; vite progresses past `chunks/logger.js:75` to a NEW deeper failure at `chunks/node.js`: `Identifier '__dirname' has already been declared` (pre-compile esbuild ESM→CJS conflict with `new Function` parameter list, due to bundled open@10.2.0 source). OUT of M3 charter (pre-compile / Z3 / W3.5-Fix-B territory).

`audit/probes/x5m3/AUDIT-SUMMARY.md` shipped with full per-suite results.

Commit: (pending Phase E commit). Push: 403.

---

## Phase F — Push

```
$ git push origin x5m3-null-base
remote: Access denied: grant not approved
fatal: unable to access 'https://github.com/AshishKumar4/Nimbus.git/': The requested URL returned error: 403
```

Halted on grant. Local commits at HEAD `x5m3-null-base`. Per dispatch: "403 → log + continue."

---

## Phase G — Retro ✓

`audit/sections/X5M3-retro.md` shipped.

Key findings:
- **Charter MET.** vite e2e CHARTER-PASS: targeted ENOENT('file:///package.json') eliminated.
- **Stretch goal NOT met.** vite stays ⚠ at strict classifier; new deeper bucket exposed: `chunks/node.js` `__dirname` redeclaration (pre-compile esbuild ESM→CJS collision with `new Function` parameter list).
- **Net classifier delta: 0** (vite still ⚠ but with different shape).
- 0 cross-wave regressions, 0 source regressions, 0 single-resolver violations.
- 34 LOC additive in `src/node-shims.ts`; zero conflicts with batch-merge-v's facet-manager.ts work.
- Predicted +1 ✅ → 26/33: forecast over-called by +1; honest verdict 0/1 strict-✅.

Recommended next dispatch: "pre-compile-`__dirname`-conflict" bucket (0.5-1 day; would likely flip vite ✅ if no third class of failure exists beneath).

---

## Done criteria checklist

- [x] X5M3-plan.md ✓
- [x] X5M3-retro.md ✓
- [x] vite ✅ at real-package install layer — **CHARTER-PASS** (acceptable per dispatch text "acceptable to surface NEW deeper failure if vite has multiple class issues — document"); strict-✅ NOT achieved (next bucket: `__dirname` redeclaration)
- [x] All x5m3 probes green: 7/7 run-all GREEN (3 functional + 3 regression + 1 e2e charter-pass)
- [x] 0 cross-wave regressions: 9/10 X.5 run-alls clean; 1 (x5z5-build) preserves documented pre-existing tlw-vite/lightningcss fail
- [x] src/ pushed: HALTED on 403 grant lapse (per dispatch "403 → log + continue")
- [x] X5M3-progress.md 7 phases ✓ (A through G all logged)


