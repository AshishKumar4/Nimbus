# X.5-Z3 audit summary (Phase E)

> Branch: `x5z3-pre-compile-esm`
> HEAD: `5aba05d` (Phase D)
> Wrangler dev needed for e2e: yes (port 8787, post fresh restart after V8 OOM mid-audit).

## 1. x5z3 run-all (final)

`audit/probes/x5z3/run-all-GREEN-post-fix.txt`:

```
[PASS] functional/f1-readfilesync-asset.mjs
[PASS] functional/f2-asset-extensions.mjs
[PASS] functional/f3-skip-dynamic.mjs
[PASS] regression/r1-no-bundle-cap-blowup.mjs
[PASS] regression/r2-vfs-not-found.mjs
[PASS] regression/r3-existing-bundle-untouched.mjs
[PASS] ../x5f/regression/install-pipeline-coverage-shim.mjs
[PASS] ../x5f/regression/single-resolver-source.mjs
[PASS] e2e/e1-jsdom-loads.mjs            ← jsdom ✅ FLIP (done-criterion)
[PASS] e2e/e2-jsdom-window.mjs           ← deeper smoke confirms .css consumed
[PASS] e2e/e3-tailwindcss-vite-pre-existing-fail.mjs  ← TLW still pre-existing-fails

──── 11/11 PASS
```

## 2. Cross-wave regression (X.5-* run-alls, all clean env)

| Wave | Result |
|---|---|
| x5c | ALL ✅ (4/4 functional + regression + 3 e2e) |
| x5f | 7/7 ✅ |
| x5g | 11/11 ✅ |
| x5j | 9/9 ✅ |
| x5l | ALL ✅ (functional + regression + 3 e2e) |
| x5m | ALL ✅ |
| x5npqo | OVERALL: PASS |
| x5r | 5/5 ✅ |
| x5z5-build | 10/11 (the 1 fail = `tailwindcss-vite e2e`, **pre-existing** lightningcss native binding gap, see X5Z5-build-retro §"What would be needed for tailwindcss-vite full ✅"; pre-fix transcript at `audit/probes/x5z5-build/run-all.txt` confirms identical fail SIGNATURE → not a regression) |

**Verdict: 0 cross-wave regressions caused by X.5-Z3.**

## 3. Heavy regressions

- `audit/probes/run-mossaic-prod-w2.mjs` — **PASS**
  (`status=200, htmlLen=2874, external=0, alive=true, viteRunning=true`)
- `audit/probes/x5r/regression/r-w1.mjs` (W1 prod-style smoke) — **PASS**
  (`external=0, status=200, htmlLen=3202, twOk=true`)

## 4. tsc baseline

```
$ bun x tsc --noEmit
src/esbuild-service.ts(153,28): error TS2307: Cannot find module 'esbuild-wasm/esbuild.wasm' or its corresponding type declarations.
src/nimbus-session-init.ts(74,39): error TS2345: Argument of type 'SqliteVFSProvider' is not assignable to parameter of type 'VirtualProvider | MountProvider'.
  Type 'SqliteVFSProvider' is not assignable to type 'MountProvider'.
    The types of 'stat(...).type' are incompatible between these types.
      Type 'string' is not assignable to type 'FileType'.
```

**2 errors, byte-identical to pre-X5Z3 baseline.** No new errors introduced.

## 5. src/ diff stat

```
src/facet-manager.ts | +146 / -0 (purely additive)
```

Single new exported helper `addStaticReadFileAssets` + 1 call-site
inside existing `buildPrefetchBundle` at numbered pass 2.25.

## 6. Done-criterion check

| Criterion | Result |
|---|---|
| `jsdom ✅ at real-package install layer` | ✅ — e1-jsdom-loads e2e prints `JSDOM-OK keys: ["JSDOM","VirtualConsole","CookieJar","requestInterceptor","toughCookie"]` |
| `All x5z3 probes green + 0 cross-wave regressions` | ✅ — 11/11 + 0 cross-wave regressions caused |
| `src/ pushed (or halted-on-grant)` | Pending Phase F (expect 403, log + continue) |
| `X5Z3-progress.md 7 phases ✓` | Pending Phase G |

## 7. Mid-audit incident: wrangler V8 OOM

Wrangler dev (workerd) hit a V8 fatal "JavaScript heap out of memory"
mid-Phase-E around 23:36Z, after running 8 cross-wave run-alls
sequentially in the same DO. Same environmental issue documented in
X.5-NPQO retro and earlier waves — sandbox 512 MiB heap cap on
sequential-installs. Restarted wrangler; e2e probes ran cleanly
afterwards. Recovery: `bun run dev` (auto-rebuilds + reboots
workerd). NOT a defect of this wave.
