# X.5-M3 Phase E audit summary

> Run @ branch `x5m3-null-base` HEAD `ff4a509` (Phase D BUILD).
> Wrangler dev: `http://127.0.0.1:8787` (local, BASE=http://127.0.0.1:8787).

## tsc baseline

```
$ bun x tsc --noEmit
src/esbuild-service.ts(153,28): error TS2307: Cannot find module 'esbuild-wasm/esbuild.wasm' or its corresponding type declarations.
src/nimbus-session-init.ts(74,39): error TS2345: Argument of type 'SqliteVFSProvider' is not assignable to parameter of type 'VirtualProvider | MountProvider'.
  Type 'SqliteVFSProvider' is not assignable to type 'MountProvider'.
    The types of 'stat(...).type' are incompatible between these types.
      Type 'string' is not assignable to type 'FileType'.
```

**2 errors, byte-identical to verify-700420f §2 baseline.** ✓

## x5m3 run-all (full, with e2e)

```
── X.5-M3 functional + regression ─────────────────────────
[PASS] functional/f1-url-null-base-current-module.mjs
[PASS] functional/f2-url-null-base-no-context.mjs
[PASS] functional/f3-loadmodule-saves-restores.mjs
[PASS] regression/install-pipeline-coverage-shim.mjs
[PASS] regression/single-resolver-source.mjs
[PASS] regression/cross-wave-x5-runalls.mjs
── heavy regressions skipped (NIMBUS_X5M3_HEAVY=1 to run)
── e2e (NIMBUS_X5M3_E2E=1) ────────────────────────────────
[PASS] e2e/e1-vite-loads.mjs

──── x5m3 run-all: 7 pass / 0 fail
```

## Cross-wave run-alls (NIMBUS_X5M3_E2E=0, BASE scrubbed)

```
OK  x5f (exit 0)
OK  x5g (exit 0)
OK  x5c (exit 0)
OK  x5j (exit 0)
OK  x5l (exit 0)
OK  x5m (exit 0)
OK  x5npqo (exit 0)
OK  x5z5-build (exit 1, expected 1)
OK  x5r (exit 0)
OK  x5z3 (exit 0)

# cross-wave-x5-runalls: 10 passed, 0 failed of 10
```

`x5z5-build` exit 1 expected: pre-existing `tailwindcss-vite e2e` lightningcss native binding fail (X5Z5-build-retro §1; X5Z3-retro §6). NOT an M3 regression.

## Mossaic (BASE=http://127.0.0.1:8787)

```
==== END MOSSAIC PROD W2 (FAIL: vite never ready) ====
last buffer (-2000): ...
[npm]   resolver-facet failed: npm install rejected: playwright — Bundled browsers (~300 MB).
```

**Pre-existing failure** documented in X5R-retro.md ("mossaic-prod-w2 already FAIL pre-X5R (playwright REJECT_INSTALL); preserved post-X5R") and X5Z3-retro.md §6. The Mossaic repo's package.json includes `playwright` which our REJECT_INSTALL list rejects. **NOT an M3 regression.**

## W1 wave1-regression-w2 (BASE=http://127.0.0.1:8787)

```
==== VERDICT: PASS ====
  external=0, status=200, htmlLen=3214, twOk=true
==== END WAVE1 REGRESSION ====
```

**PASS.** No regression. ✓

## E2E: vite e2e

`audit/probes/x5m3/e2e/e1-vite-loads.txt` (and `.out.txt`):

```
VITE-OK present: false
VITE-FAIL present: true
targeted ENOENT('file:///package.json') GONE: true
next-bucket failure shape: Cannot load module 'home/user/app/node_modules/vite/dist/node/chunks/node.js': pre-compile failed at facet startup: Identifier '__dirname' has already been declared
VERDICT: CHARTER-PASS (M3 cleared file:///package.json; deeper bucket exposed — see next-bucket shape)
```

**Verdict: CHARTER-PASS.**

The targeted ENOENT('file:///package.json') is provably eliminated (M3's intended deliverable). vite progresses past `chunks/logger.js:75` to a NEW deeper failure at `chunks/node.js`: `Identifier '__dirname' has already been declared`. This is a pre-compile (esbuild ESM→CJS transform) collision: vite's bundled `open@10.2.0` source has top-level `const __dirname = path.dirname(fileURLToPath(import.meta.url));`, which conflicts with the `__dirname` parameter our `new Function` injects. **OUT of M3 charter** (it's pre-compile / W3.5-Fix-B / Z3 territory).

Per dispatch: "acceptable to surface NEW deeper failure if vite has multiple class issues — document". DOCUMENTED.

## Strict-✅ classifier delta (charter)

vite remains ⚠ at the strict classifier (because it still throws at top-level `require('vite')` due to the new `__dirname` collision). M3 was predicted +1 ✅; **measured 0/1 strict-✅, 1/1 charter-pass.** This matches the X.5-M / X.5-NPQO retro pattern: bucket-charter-pass is the honest verdict; deeper buckets surface as artifacts of the fix.

The +1 ✅ → 26/33 prediction was based on the (reasonable but unverifiable from outside) assumption that vite was healthy beneath the M3 layer; that assumption did NOT hold (vite has the additional `__dirname` redeclaration issue at the pre-compile level). The honest verdict: **0/1 strict-✅; +1 ⚠→? at the M3-error-gone classifier; vite stays ⚠ pending pre-compile-`__dirname`-conflict bucket**.

## Regression verdict

**Strict source-level regressions: 0.**

- tsc baseline: 2 errors, byte-identical to verify-700420f baseline ✓
- single-resolver invariant: PASS ✓
- All 7 prior X.5 wave run-alls (F/G/C/J/L/M/NPQO/Z5/R/Z3): 9/10 still GREEN; 1 (x5z5-build) preserves its documented pre-existing tailwindcss-vite-e2e fail ✓
- 0 cross-wave conflicts: only `src/node-shims.ts` modified; +34 LOC additive, zero deletions ✓
- mossaic: still pre-existing playwright REJECT_INSTALL fail (not M3-induced) ✓
- W1: still PASS ✓

**Package-compat regressions: 0.**

The probe surface tested (functional + e2e) shows no previously-✅ package transitioned to ⚠ or ⛔. vite remains ⚠ (was ⚠ pre-M3); M3 elimnated the ENOENT but exposed a deeper unrelated issue, so net classifier-state unchanged.

## Bottom line

X.5-M3 delivers exactly what its plan promised at the source-text + functional-probe layer (3 functional + 1 e2e charter-pass + 0 cross-wave regression + 0 tsc regression + 0 single-resolver violation). The strict-✅ flip count is 0, not the +1 forecast, because vite has a second class of pre-compile failure (`__dirname` redeclaration in CJS-transformed ESM) beneath the M3 layer. **Charter MET; stretch goal NOT met.**

Next dispatch (recommended): **Bucket "pre-compile-`__dirname`-conflict"** — investigate where vite's bundled open@10.2.0 source declares `const __dirname = ...`, and decide between (a) post-process esbuild output to elide the conflicting declaration when present, or (b) wrap user code in IIFE to scope-protect `__dirname` from collision. Effort: ~0.5-1 day. Out of M3 scope.
