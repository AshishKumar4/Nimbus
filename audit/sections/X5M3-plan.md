# X.5-M3 plan — `import.meta.url` null-base resolver

> **Branch:** `x5m3-null-base` off main `7535622` (post-X.5-Z3).
> **Charter source:** VERIFY-700420F.md §4 #3 (P2: bucket O-continuation).
> **Predecessor:** X.5-NPQO O-bucket retro §"Verdict" — "Bucket O fix is the right shim-layer fix. The vite e2e strict-✅ flip requires also addressing M-3's null-base behavior". This plan IS that addressing.
> **Predicted delta:** +1 ✅ (vite) → 26/33 strict (76% → 79%).

---

## TL;DR

esbuild's ESM→CJS transform emits literal `const import_meta = {};` for every transformed file. Downstream code that reads `import.meta.url` (most notably `vite/dist/node/chunks/logger.js:75`) sees `undefined`, hits `new URL(rel, undefined)`, falls through our X.5-M URL shim's `"file:///"` fallback, and ends up reading `file:///package.json` instead of the actual vite package.json — ENOENT.

**Fix:** Track the currently-loading module's path via `globalThis.__currentModulePath` (set by `__loadModule`, save+restore for recursion); the URL shim's null-base fallback uses `"file:///" + __currentModulePath` instead of `"file:///"`, so relative URLs resolve against the loading module's path (which is what `import.meta.url` would have been in real ESM).

**Scope:** Single file (`src/node-shims.ts`); ~15 LOC at two regions (URL shim + `__loadModule` body). Anti-requirement compliant (no facet-manager.ts, no require-resolver.ts, no npm-resolver.ts, no facet/supervisor split touch).

---

## 1. Investigation summary

(Full transcript: `audit/probes/x5m3/investigation/INVESTIGATION.md`.)

The failing line in vite is:

```js
// node_modules/vite/dist/node/chunks/logger.js:75
const { version } = JSON.parse(
  readFileSync(
    new URL("../../package.json",
            new URL("../../../src/node/constants.ts", import.meta.url))
  ).toString()
);
```

facet-manager.ts's `transformEsmInBundle` (line 953-993) runs every ESM-shaped `.js`/`.mjs` file in the prefetch bundle through `esbuild.transform({ format: 'cjs' })`. Confirmed esbuild output:

```
$ bun x esbuild --format=cjs --target=esnext < logger-fragment.js
▲ [WARNING] "import.meta" is not available with the "cjs" output format and will be empty
const import_meta = {};
const x = new URL("../../package.json", new URL("../../../src/node/constants.ts", import_meta.url));
```

Runtime trace at `__loadModule(node_modules/vite/dist/node/chunks/logger.js)`:

1. `import_meta.url` evaluates to `undefined` (empty object property).
2. Inner `new URL("../../../src/node/constants.ts", undefined)` enters X.5-M URL shim at `node-shims.ts:818-839`. Branch `base == null && typeof input === "string"` triggers; `super(input)` throws (relative path is not an absolute URL); falls through to `super(input, "file:///")`.
3. URL parses to `file:///src/node/constants.ts` (relative `../../../` from root → root).
4. Outer `new URL("../../package.json", <inner URL>)` — base is now a valid URL instance; resolves to `file:///package.json` (relative `../../` from `/src/node/constants.ts` → `/`).
5. `readFileSync(<that URL>)` → fs `_resolve` strips `file://` → `/package.json` → `_bundleLookup('/package.json')` returns undefined → ENOENT.
6. Error message echoes the original arg: `'file:///package.json'` (verify-700420f stack matches exactly).

## 2. Root cause final

esbuild's CJS output substitutes `import.meta` with an empty object `{}`. Our X.5-M URL shim's fallback base `"file:///"` (from `node-shims.ts:824`) is correct for the bare-`import_meta.url`-is-undefined case where the module's own location is unknown — but the loading module's location IS knowable at runtime (it's exactly the `__filename` argument we pass to `new Function`). The shim just doesn't have access to it.

The fix injects that knowledge via a single global variable, set+restored around each `__loadModule` invocation.

## 3. Fix sketch (file:line)

### Region 1 — URL shim, `src/node-shims.ts:818-839`

Current:

```js
(() => {
  const _Orig = globalThis.URL;
  class _Shim extends _Orig {
    constructor(input, base) {
      if (base == null && typeof input === "string") {
        try { super(input); return; }
        catch { super(input, "file:///"); return; }
      }
      super(input, base);
    }
  }
  ...
  globalThis.URL = _Shim;
})();
```

Proposed:

```js
(() => {
  const _Orig = globalThis.URL;
  class _Shim extends _Orig {
    constructor(input, base) {
      if (base == null && typeof input === "string") {
        try { super(input); return; }
        catch {
          // X.5-M3: prefer the currently-loading module's path as the
          // synthetic base so `new URL(rel, import.meta.url)` resolves
          // against the real on-VFS location of the loading module.
          // Falls back to "file:///" only when no module is loading
          // (top-level user code, etc.).
          const cur = globalThis.__currentModulePath;
          const fallback = (typeof cur === "string" && cur.length > 0)
            ? "file:///" + cur.replace(/^\\/+/, "")
            : "file:///";
          super(input, fallback); return;
        }
      }
      super(input, base);
    }
  }
  ...
})();
```

### Region 2 — `__loadModule` body, `src/node-shims.ts:2271-2303`

Current (excerpt):

```js
try {
  const normalizedPath = resolvedPath.replace(/^\/+/, "");
  const precompiled = __compiledModules.get(normalizedPath) || __compiledModules.get(resolvedPath);
  if (precompiled) {
    precompiled(mod.exports, scopedRequire, mod, "/" + resolvedPath, "/" + modDir);
  } else {
    ...
    const fn = new Function("exports", "require", "module", "__filename", "__dirname", code);
    fn(mod.exports, scopedRequire, mod, "/" + resolvedPath, "/" + modDir);
    ...
  }
} catch (e) {
  __moduleCache.delete(resolvedPath);
  throw e;
}
```

Proposed (delta only):

```js
// X.5-M3: thread the currently-loading module path through globalThis
// so the URL shim's null-base fallback can compose relative URLs
// against the real module location. Save+restore is necessary for
// recursive __loadModule calls (which is the common case — every
// require() call enters __loadModule).
const __prevModulePath = globalThis.__currentModulePath;
globalThis.__currentModulePath = resolvedPath;
try {
  const normalizedPath = resolvedPath.replace(/^\\/+/, "");
  const precompiled = __compiledModules.get(normalizedPath) || __compiledModules.get(resolvedPath);
  ...
  // (existing body unchanged)
} catch (e) {
  __moduleCache.delete(resolvedPath);
  throw e;
} finally {
  globalThis.__currentModulePath = __prevModulePath;
}
```

Total diff: ~18 LOC additive (no deletions) in `src/node-shims.ts`.

## 4. Regression matrix

| Suite / probe | Coverage | Acceptance |
|---|---|---|
| **X.5-M3 functional** (NEW, this wave) | `f-url-null-base-current-module.mjs`: simulate the vite call shape with a known `__currentModulePath`; assert URL composes correctly. | All asserts PASS post-fix. |
| **X.5-M3 functional** (NEW) | `f-url-null-base-no-context.mjs`: simulate URL constructor when `__currentModulePath` is absent; assert fallback is still `"file:///"` (preserves X.5-M behavior). | PASS pre AND post fix (compatibility). |
| **X.5-M3 functional** (NEW) | `f-loadmodule-saves-restores.mjs`: synth a precompiled module that recursively requires another; assert `__currentModulePath` is correct in the inner scope and restored to the outer's path on exit. | PASS post-fix. |
| **X.5-M3 e2e** (NEW) | `e1-vite-loads.mjs` via local wrangler dev: `npm install vite` + `require('vite')`; assert no `ENOENT(file:///package.json)`; ✅ if a top-level vite export is reachable. | RED pre-fix; GREEN post-fix. |
| **X.5-M regression** | `audit/probes/x5m/run-all.mjs` (9/9 baseline). The shim's prior behavior is preserved when `__currentModulePath` is unset. | 9/9 GREEN post-fix. |
| **X.5-NPQO regression** | `audit/probes/x5npqo/functional/o-fs-url.mjs` (8/8 baseline). URL shim's primary path (file:// strip + URL instance unwrap) is unchanged. | 8/8 GREEN post-fix. |
| **install-pipeline-coverage** | `audit/probes/x5f/regression/install-pipeline-coverage-shim.mjs`. node-shims.ts editor regression guard. | GREEN. |
| **mossaic prod-w2** | `audit/probes/run-mossaic-prod-w2.mjs`. Heavy cross-wave smoke. | GREEN (preserve). |
| **W1 wave1-regression-w2** | `audit/probes/run-wave1-regression-w2.mjs`. | GREEN (preserve). |
| **single-resolver invariant** | `audit/probes/x5f/regression/single-resolver-source.mjs`. | PASS (no resolver touch). |
| **X.5 prior wave run-alls (F/G/C/J/L/M/NPQO/Z5/R/Z3)** | All 10 prior X.5 run-alls. | All run-alls per-wave green (with previously-known pre-existing fails noted but unchanged). |
| **tsc baseline** | `bunx tsc --noEmit`. 2 errors expected, byte-identical. | UNCHANGED. |

## 5. Self-review TL;DR

**Why this fix is correct:**
- The ESM `import.meta.url` semantics are: "the URL of the current module". In a CJS facet loaded via `new Function`, the equivalent is `"file:///" + __filename`. The fix binds those two together via a thread-of-execution global.
- Save+restore around `__loadModule` matches the exact lifetime of "the current module". When `__loadModule` returns, control returns to the caller's module, and `__currentModulePath` correctly reverts.
- The fix is **additive only** for the URL shim: existing `super(input, base)` (non-null base) unchanged; existing `super(input)` (input-is-already-absolute-URL) unchanged; `super(input, "file:///")` (no `__currentModulePath`) unchanged. ONLY the case `base == null && input is relative AND __currentModulePath is set` changes — and that case was previously broken.

**Why this fix is small enough:**
- 2 surgical regions in 1 file. ~18 LOC. Zero deletions.
- Doesn't touch any forbidden file (facet-manager.ts, require-resolver.ts, npm-resolver.ts, npm-resolve-facet.ts, _shared/exports-resolver.ts, parallel/*).
- Single-resolver invariant trivially preserved.

**Why this fix is correctly-targeted:**
- Mirrors what real Node.js does: in real Node ESM, `import.meta.url` IS `"file:///" + __filename` essentially. The fix synthesizes that runtime-correct value precisely when esbuild has substituted away the real one.

**Possible deeper failures vite may surface (acceptable per dispatch):**
- After URL composes correctly, `readFileSync` reads `home/user/app/node_modules/vite/package.json` from VFS — which IS in the bundle because `addStaticReadFileAssets` (X.5-Z3) covers static `path.resolve(__dirname, "...")` shapes. URL-based reads were not in Z3's regex set, but the bundle's tree-include should cover package.json regardless.
- If vite progresses past line 75 to line 165 (`fileURLToPath(new URL(...constants.ts, import.meta.url))`), that's also handled — the URL composes to the real path, fileURLToPath strips file://, returns real path.
- If vite progresses to a NEW class of error past line 165 (e.g., a missing native binding or a different require-resolver gap), document and surface — acceptable per dispatch text.

## 6. Relationship to NPQO Bucket O

X.5-NPQO Bucket O fixed `_resolve` to strip `file://` and unwrap URL instances on fs paths (commit a65c994). That fix is mechanically necessary AND correct — but it converts the URL `file:///package.json` to the path `/package.json`, which is still wrong because the URL shouldn't have been `file:///package.json` in the first place. Bucket O fixes the symptom (path corruption); X.5-M3 fixes the underlying cause (wrong base URL for relative resolution). **They compose:** Bucket O still runs first on every fs URL input; X.5-M3 ensures the URL that reaches `_resolve` is a correctly-composed real-VFS path. The two together close the O-bucket charter completely (X.5-NPQO retro §O verdict).

## 7. Anti-requirement compliance

| Anti-req | Compliance |
|---|---|
| NO src/ change without green-turning test | Phase C will author 3 functional + 3 regression + 1 e2e probe BEFORE the src/ edit; each src/ edit references its probe in the commit message. |
| NO files outside worktree | All paths in `/workspace/worktrees/x5m3-null-base/`. |
| NO push to main | Only `x5m3-null-base` branch. |
| NO unreviewed commits | Each commit self-reviewed against this plan. |
| DO NOT pause for user input | Autonomous execution. |
| DO NOT touch src/facet-manager.ts | Confirmed: fix lives in `src/node-shims.ts` only. |
| DO NOT touch src/require-resolver.ts | Confirmed: not on the patch path. |
| DO NOT touch src/npm-resolver.ts / npm-resolve-facet.ts | Confirmed: not on the patch path. |
| DO NOT attempt prod deploy | Confirmed: local-only. |
| NO silent completion | Progress log + retro at completion. |

## 8. Phases

- **A. Investigate** ✓ (complete; commit `e80cb93`).
- **B. Plan** (this document).
- **C. TDD-red** — author probes; verify they fail (or pass for regression guards) on current HEAD before the fix.
- **D. Build** — apply the diff to `src/node-shims.ts`; commit referencing probes.
- **E. Audit** — run all run-alls + Mossaic + W1 + tsc; record results.
- **F. Push** — `git push origin x5m3-null-base`. 403 → log + continue.
- **G. Retro** — `audit/sections/X5M3-retro.md`: per-package verdict, root-cause final, scope deviations vs prediction, regression verdict, surprise list.
